import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WalletSession } from './wallet-session.js';
import { MockTransport } from './test-helpers.js';
import {
  generateX25519KeyPair,
  generateChannelId,
  buildPairingUri,
  computeSharedSecret,
  deriveSessionKey,
  deriveDirectionalSessionKeys,
  computePairingCode,
  sealPayload,
  unsealPayload,
  b64urlEncode,
  b64urlDecode,
  bytesToHex,
  hexToBytes,
} from './crypto.js';
import type { AadHeader, SessionCryptoContext } from './crypto.js';
import type { ProtocolMessage } from './types.js';

function flushMicrotasks(): Promise<void> {
  return new Promise((r) => setTimeout(r, 10));
}

describe('WalletSession', () => {
  let transport: MockTransport;
  let session: WalletSession;
  let dappKp: ReturnType<typeof generateX25519KeyPair>;
  let channelId: string;
  let relayUrl: string;

  beforeEach(() => {
    transport = new MockTransport();
    session = new WalletSession({
      transport,
      capabilities: {
        methods: ['wallet_getAccounts', 'wallet_signMessage'],
        events: ['accountsChanged', 'chainChanged'],
        chains: ['eip155:1'],
      },
      meta: { name: 'Test Wallet', address: '0xtest' },
    });
    dappKp = generateX25519KeyPair();
    channelId = generateChannelId();
    relayUrl = 'ws://localhost:8080/v1';
  });

  function makePairingUri(): string {
    return buildPairingUri({
      channelId,
      pubkeyB64: dappKp.publicKeyB64,
      relayUrl,
    });
  }

  describe('joinFromUri', () => {
    it('starts in idle phase', () => {
      expect(session.phase).toBe('idle');
    });

    it('parses URI and sends join message', async () => {
      const uri = makePairingUri();
      await session.joinFromUri(uri);

      expect(session.channelId).toBe(channelId);
      expect(session.phase).toBe('waiting');

      const joinMsg = transport.sent.find(m => m.t === 'join');
      expect(joinMsg).toBeTruthy();
      expect((joinMsg as any).capabilities.methods).toContain('wallet_getAccounts');
      expect((joinMsg as any).meta.name).toBe('Test Wallet');
    });

    it('computes and emits pairing code', async () => {
      const handler = vi.fn();
      session.on('pairingCode', handler);

      const uri = makePairingUri();
      await session.joinFromUri(uri);

      expect(handler).toHaveBeenCalled();
      expect(session.pairingCode).toMatch(/^\d{6}$/);
    });

    it('pairing code matches dApp side derivation', async () => {
      const uri = makePairingUri();
      await session.joinFromUri(uri);

      // Derive same session key from dApp side
      const walletPubB64 = transport.sent.find(m => m.t === 'join')!.from!;
      const walletPub = b64urlDecode(walletPubB64);
      const shared = computeSharedSecret(dappKp.privateKey, walletPub);
      const rootKey = deriveSessionKey(shared, channelId);
      const context: SessionCryptoContext = {
        dappPubKeyB64: dappKp.publicKeyB64,
        walletPubKeyB64: walletPubB64,
        capabilities: {
          methods: ['wallet_getAccounts', 'wallet_signMessage'],
          events: ['accountsChanged', 'chainChanged'],
          chains: ['eip155:1'],
        },
        walletMeta: { name: 'Test Wallet', address: '0xtest' },
        dappName: undefined,
      };
      const dappCode = computePairingCode(rootKey, channelId, context);

      expect(session.pairingCode).toBe(dappCode);
    });

    it('transitions to connected on ready.connected', async () => {
      const phases: string[] = [];
      session.on('phase', (p) => phases.push(p));

      await session.joinFromUri(makePairingUri());

      transport.receive({
        v: 1, t: 'ready', ch: channelId,
        state: 'connected', resume: 'wallet-tok',
      } as ProtocolMessage);

      expect(session.phase).toBe('connected');
      expect(phases).toContain('waiting');
      expect(phases).toContain('connected');
    });
  });

  describe('request handling', () => {
    let dappToWalletKey: Uint8Array;
    let walletToDappKey: Uint8Array;

    beforeEach(async () => {
      await session.joinFromUri(makePairingUri());

      // Derive directional keys from dApp side
      const walletPubB64 = transport.sent.find(m => m.t === 'join')!.from!;
      const walletPub = b64urlDecode(walletPubB64);
      const shared = computeSharedSecret(dappKp.privateKey, walletPub);
      const rootKey = deriveSessionKey(shared, channelId);
      const context: SessionCryptoContext = {
        dappPubKeyB64: dappKp.publicKeyB64,
        walletPubKeyB64: walletPubB64,
        capabilities: {
          methods: ['wallet_getAccounts', 'wallet_signMessage'],
          events: ['accountsChanged', 'chainChanged'],
          chains: ['eip155:1'],
        },
        walletMeta: { name: 'Test Wallet', address: '0xtest' },
        dappName: undefined,
      };
      const keys = deriveDirectionalSessionKeys(rootKey, channelId, context);
      dappToWalletKey = keys.dappToWalletKey;
      walletToDappKey = keys.walletToDappKey;

      // Connect
      transport.receive({
        v: 1, t: 'ready', ch: channelId,
        state: 'connected', resume: 'tok',
      } as ProtocolMessage);
    });

    it('emits request event with decrypted params', () => {
      const handler = vi.fn();
      session.on('request', handler);

      const params = { message: 'Hello World' };
      transport.receive({
        v: 1, t: 'req', ch: channelId,
        id: 'req-1', from: dappKp.publicKeyB64,
        method: 'wallet_signMessage',
        sealed: sealPayload(dappToWalletKey, channelId, 0, params, { type: 'req', from: dappKp.publicKeyB64, id: 'req-1', method: 'wallet_signMessage' }),
      } as ProtocolMessage);

      expect(handler).toHaveBeenCalledWith({
        id: 'req-1',
        method: 'wallet_signMessage',
        params,
      });
    });

    it('emits request with null params for parameterless sealed request', () => {
      const handler = vi.fn();
      session.on('request', handler);

      // Even parameterless requests must be sealed (security: prevents method injection)
      transport.receive({
        v: 1, t: 'req', ch: channelId,
        id: 'req-2', from: dappKp.publicKeyB64,
        method: 'wallet_getAccounts',
        sealed: sealPayload(dappToWalletKey, channelId, 1, null, { type: 'req', from: dappKp.publicKeyB64, id: 'req-2', method: 'wallet_getAccounts' }),
      } as ProtocolMessage);

      expect(handler).toHaveBeenCalledWith({
        id: 'req-2',
        method: 'wallet_getAccounts',
        params: {},
      });
    });

    it('rejects unsealed request with decryption_failed', () => {
      const handler = vi.fn();
      session.on('request', handler);

      transport.receive({
        v: 1, t: 'req', ch: channelId,
        id: 'req-3', from: dappKp.publicKeyB64,
        method: 'wallet_getAccounts',
      } as ProtocolMessage);

      // Should NOT emit request - unsealed requests are rejected
      expect(handler).not.toHaveBeenCalled();
      // Should send a rejection response
      const resMsg = transport.sent.find(m => m.t === 'res') as any;
      expect(resMsg).toBeTruthy();
      expect(resMsg.ok).toBe(false);
    });
  });

  describe('approve/reject', () => {
    let dappToWalletKey: Uint8Array;
    let walletToDappKey: Uint8Array;
    let walletPubB64: string;

    beforeEach(async () => {
      await session.joinFromUri(makePairingUri());
      walletPubB64 = transport.sent.find(m => m.t === 'join')!.from!;
      const shared = computeSharedSecret(dappKp.privateKey, b64urlDecode(walletPubB64));
      const rootKey = deriveSessionKey(shared, channelId);
      const context: SessionCryptoContext = {
        dappPubKeyB64: dappKp.publicKeyB64,
        walletPubKeyB64: walletPubB64,
        capabilities: {
          methods: ['wallet_getAccounts', 'wallet_signMessage'],
          events: ['accountsChanged', 'chainChanged'],
          chains: ['eip155:1'],
        },
        walletMeta: { name: 'Test Wallet', address: '0xtest' },
        dappName: undefined,
      };
      const keys = deriveDirectionalSessionKeys(rootKey, channelId, context);
      dappToWalletKey = keys.dappToWalletKey;
      walletToDappKey = keys.walletToDappKey;

      transport.receive({
        v: 1, t: 'ready', ch: channelId,
        state: 'connected', resume: 'tok',
      } as ProtocolMessage);
    });

    it('approve sends encrypted ok response', () => {
      // Send a properly sealed request first (dApp→wallet uses dappToWalletKey)
      transport.receive({
        v: 1, t: 'req', ch: channelId,
        id: 'req-1', from: dappKp.publicKeyB64,
        method: 'wallet_getAccounts',
        sealed: sealPayload(dappToWalletKey, channelId, 0, null, { type: 'req', from: dappKp.publicKeyB64, id: 'req-1', method: 'wallet_getAccounts' }),
      } as ProtocolMessage);

      session.approve('req-1', ['0xabc123']);

      const resMsg = transport.sent.find(m => m.t === 'res') as any;
      expect(resMsg).toBeTruthy();
      expect(resMsg.id).toBe('req-1');
      expect(resMsg.ok).toBe(true);
      expect(resMsg.sealed).toBeTruthy();

      // Verify dApp can decrypt the response (wallet→dApp uses walletToDappKey)
      const { data } = unsealPayload(walletToDappKey, channelId, resMsg.sealed, { type: 'res', from: walletPubB64, id: 'req-1', ok: true });
      expect(data).toEqual(['0xabc123']);
    });

    it('reject sends encrypted error response', () => {
      transport.receive({
        v: 1, t: 'req', ch: channelId,
        id: 'req-2', from: dappKp.publicKeyB64,
        method: 'wallet_signMessage',
        sealed: sealPayload(dappToWalletKey, channelId, 0, { message: 'test' }, { type: 'req', from: dappKp.publicKeyB64, id: 'req-2', method: 'wallet_signMessage' }),
      } as ProtocolMessage);

      session.reject('req-2', 'user_rejected', 'User said no');

      const resMsg = transport.sent.find(m => m.t === 'res') as any;
      expect(resMsg).toBeTruthy();
      expect(resMsg.id).toBe('req-2');
      expect(resMsg.ok).toBe(false);
      expect(resMsg.sealed).toBeTruthy();

      const { data } = unsealPayload(walletToDappKey, channelId, resMsg.sealed, { type: 'res', from: walletPubB64, id: 'req-2', ok: false });
      expect(data).toEqual({ code: 'user_rejected', message: 'User said no' });
    });

    it('approve increments send sequence', () => {
      for (let i = 0; i < 3; i++) {
        transport.receive({
          v: 1, t: 'req', ch: channelId,
          id: `req-${i}`, from: dappKp.publicKeyB64,
          method: 'wallet_getAccounts',
          sealed: sealPayload(dappToWalletKey, channelId, i, null, { type: 'req', from: dappKp.publicKeyB64, id: `req-${i}`, method: 'wallet_getAccounts' }),
        } as ProtocolMessage);
        session.approve(`req-${i}`, ['0x123']);
      }

      // All 3 responses should have different sealed payloads (different seqs)
      const responses = transport.sent.filter(m => m.t === 'res') as any[];
      expect(responses).toHaveLength(3);
      const sealedSet = new Set(responses.map((r: any) => r.sealed));
      expect(sealedSet.size).toBe(3);
    });
  });

  describe('pushEvent', () => {
    let walletToDappKey: Uint8Array;
    let walletPubB64: string;

    beforeEach(async () => {
      await session.joinFromUri(makePairingUri());
      walletPubB64 = transport.sent.find(m => m.t === 'join')!.from!;
      const shared = computeSharedSecret(dappKp.privateKey, b64urlDecode(walletPubB64));
      const rootKey = deriveSessionKey(shared, channelId);
      const context: SessionCryptoContext = {
        dappPubKeyB64: dappKp.publicKeyB64,
        walletPubKeyB64: walletPubB64,
        capabilities: {
          methods: ['wallet_getAccounts', 'wallet_signMessage'],
          events: ['accountsChanged', 'chainChanged'],
          chains: ['eip155:1'],
        },
        walletMeta: { name: 'Test Wallet', address: '0xtest' },
        dappName: undefined,
      };
      const keys = deriveDirectionalSessionKeys(rootKey, channelId, context);
      walletToDappKey = keys.walletToDappKey;

      transport.receive({
        v: 1, t: 'ready', ch: channelId,
        state: 'connected', resume: 'tok',
      } as ProtocolMessage);
    });

    it('sends encrypted event message', () => {
      session.pushEvent('accountsChanged', { accounts: ['0xnew'] });

      const evtMsg = transport.sent.find(m => m.t === 'evt') as any;
      expect(evtMsg).toBeTruthy();
      expect(evtMsg.event).toBe('accountsChanged');
      expect(evtMsg.sealed).toBeTruthy();

      // Verify dApp can decrypt (wallet→dApp uses walletToDappKey)
      const { data } = unsealPayload(walletToDappKey, channelId, evtMsg.sealed, { type: 'evt', from: walletPubB64, event: 'accountsChanged', id: evtMsg.id });
      expect(data).toEqual({ accounts: ['0xnew'] });
    });

    it('does nothing when not connected', () => {
      const idleSession = new WalletSession({
        transport: new MockTransport(),
        capabilities: { methods: [], events: [], chains: [] },
      });
      idleSession.pushEvent('test', {});
      // Should not throw, just no-op
    });

    it('sends chainChanged event', () => {
      session.pushEvent('chainChanged', { chainId: 'eip155:137' });

      const evtMsg = transport.sent.find(m => m.t === 'evt') as any;
      expect(evtMsg.event).toBe('chainChanged');

      const { data } = unsealPayload(walletToDappKey, channelId, evtMsg.sealed, { type: 'evt', from: walletPubB64, event: 'chainChanged', id: evtMsg.id });
      expect(data).toEqual({ chainId: 'eip155:137' });
    });
  });

  describe('ping/pong', () => {
    beforeEach(async () => {
      await session.joinFromUri(makePairingUri());
      transport.receive({
        v: 1, t: 'ready', ch: channelId,
        state: 'connected', resume: 'tok',
      } as ProtocolMessage);
    });

    it('responds to ping with pong', () => {
      transport.receive({
        v: 1, t: 'ping', ch: channelId, ts: 12345,
      } as ProtocolMessage);

      const pong = transport.sent.find(m => m.t === 'pong');
      expect(pong).toBeTruthy();
    });

    it('sends ping', () => {
      session.ping();
      const ping = transport.sent.find(m => m.t === 'ping');
      expect(ping).toBeTruthy();
    });
  });

  describe('close', () => {
    it('sends close and transitions to closed', async () => {
      await session.joinFromUri(makePairingUri());
      session.close();

      const closeMsg = transport.sent.find(m => m.t === 'close');
      expect(closeMsg).toBeTruthy();
      expect((closeMsg as any).reason).toBe('normal');
      expect(session.phase).toBe('closed');
    });
  });

  describe('serialize/restore', () => {
    it('round-trips session state', async () => {
      await session.joinFromUri(makePairingUri());

      transport.receive({
        v: 1, t: 'ready', ch: channelId,
        state: 'connected', resume: 'tok',
      } as ProtocolMessage);

      const json = session.serialize();
      const newSession = new WalletSession({
        transport: new MockTransport(),
        capabilities: {
          methods: ['wallet_getAccounts', 'wallet_signMessage'],
          events: ['accountsChanged', 'chainChanged'],
          chains: ['eip155:1'],
        },
        meta: { name: 'Test Wallet', address: '0xtest' },
      });
      expect(newSession.restore(json)).toBe(true);
      expect(newSession.channelId).toBe(channelId);
    });

    it('rejects restore when capabilities no longer match the transcript', async () => {
      await session.joinFromUri(makePairingUri());

      const json = session.serialize();
      const newSession = new WalletSession({
        transport: new MockTransport(),
        capabilities: { methods: ['wallet_getAccounts'], events: [], chains: ['eip155:1'] },
        meta: { name: 'Test Wallet', address: '0xtest' },
      });

      expect(newSession.restore(json)).toBe(false);
    });

    it('returns false for invalid JSON', () => {
      expect(session.restore('invalid')).toBe(false);
      expect(session.restore('{}')).toBe(false);
    });
  });

  describe('close message handling', () => {
    it('transitions to closed on close message from dApp', async () => {
      await session.joinFromUri(makePairingUri());
      transport.receive({
        v: 1, t: 'ready', ch: channelId,
        state: 'connected', resume: 'tok',
      } as ProtocolMessage);

      transport.receive({
        v: 1, t: 'close', ch: channelId,
        reason: 'normal',
      } as ProtocolMessage);

      expect(session.phase).toBe('closed');
    });
  });

  describe('destroy', () => {
    it('closes and removes all listeners', async () => {
      await session.joinFromUri(makePairingUri());
      const handler = vi.fn();
      session.on('phase', handler);
      session.destroy();
      expect(session.phase).toBe('closed');
    });
  });
});
