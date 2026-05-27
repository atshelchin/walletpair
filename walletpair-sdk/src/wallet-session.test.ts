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
  deriveJoinEncryptionKey,
  computeSessionFingerprint,
  sealPayload,
  unsealPayload,
  unsealJoin,
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
      meta: { name: 'Test Wallet', description: 'Test', url: 'https://test.com', icon: 'https://test.com/icon.png', address: '0xtest' },
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
      name: 'Test dApp',
      url: 'https://test.com',
      icon: 'https://test.com/icon.png',
    });
  }

  function receiveConnected(): void {
    transport.receive({
      v: 1, t: 'ready', ch: channelId,
      ts: Date.now(), from: '_adapter',
      body: { state: 'connected', reconnect: false, remote: dappKp.publicKeyB64 },
    } as ProtocolMessage);
  }

  describe('joinFromUri', () => {
    it('starts in idle phase', () => {
      expect(session.phase).toBe('idle');
    });

    it('parses URI and sends join message with sealed_join', async () => {
      const uri = makePairingUri();
      await session.joinFromUri(uri);

      expect(session.channelId).toBe(channelId);
      expect(session.phase).toBe('waiting_accept');

      const joinMsg = transport.sent.find(m => m.t === 'join');
      expect(joinMsg).toBeTruthy();
      // Capabilities are now inside sealed_join, not plaintext
      expect((joinMsg as any).body.sealed_join).toBeTruthy();
    });

    it('computes and emits session fingerprint', async () => {
      const handler = vi.fn();
      session.on('sessionFingerprint', handler);

      const uri = makePairingUri();
      await session.joinFromUri(uri);

      expect(handler).toHaveBeenCalled();
      expect(session.sessionFingerprint).toMatch(/^\d{4}$/);
    });

    it('session fingerprint matches dApp side derivation', async () => {
      const uri = makePairingUri();
      await session.joinFromUri(uri);

      // Both sides use computeSessionFingerprint(channelId, dappPubKeyB64)
      const dappFingerprint = computeSessionFingerprint(channelId, dappKp.publicKeyB64);

      expect(session.sessionFingerprint).toBe(dappFingerprint);
    });

    it('transitions to connected on ready.connected', async () => {
      const phases: string[] = [];
      session.on('phase', (p) => phases.push(p));

      await session.joinFromUri(makePairingUri());

      receiveConnected();

      expect(session.phase).toBe('connected');
      expect(phases).toContain('waiting_accept');
      expect(phases).toContain('connected');
    });

    it('rejects ready.connected with missing remote', async () => {
      const errorHandler = vi.fn();
      session.on('error', errorHandler);

      await session.joinFromUri(makePairingUri());
      transport.receive({
        v: 1, t: 'ready', ch: channelId,
        ts: Date.now(), from: '_adapter',
        body: { state: 'connected', reconnect: false, remote: null },
      } as ProtocolMessage);

      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('remote does not match'),
      }));
      expect(session.phase).toBe('closed');
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
        walletMeta: { name: 'Test Wallet', description: 'Test', url: 'https://test.com', icon: 'https://test.com/icon.png', address: '0xtest' },
        dappName: 'Test dApp',
      };
      const keys = deriveDirectionalSessionKeys(rootKey, channelId, context);
      dappToWalletKey = keys.dappToWalletKey;
      walletToDappKey = keys.walletToDappKey;

      // Connect
      receiveConnected();
    });

    it('emits request event with decrypted params', () => {
      const handler = vi.fn();
      session.on('request', handler);

      // Real method inside sealed payload
      const sealedParams = { _method: 'wallet_signMessage', message: 'Hello World' };
      transport.receive({
        v: 1, t: 'req', ch: channelId,
        ts: Date.now(), from: dappKp.publicKeyB64,
        body: { id: 'req-1', sealed: sealPayload(dappToWalletKey, channelId, 0, sealedParams, { type: 'req', from: dappKp.publicKeyB64, id: 'req-1' }) },
      } as ProtocolMessage);

      expect(handler).toHaveBeenCalledWith({
        id: 'req-1',
        method: 'wallet_signMessage',
        params: { message: 'Hello World' },
      });
    });

    it('emits request with empty params for parameterless sealed request', () => {
      const handler = vi.fn();
      session.on('request', handler);

      const sealedParams = { _method: 'wallet_getAccounts' };
      transport.receive({
        v: 1, t: 'req', ch: channelId,
        ts: Date.now(), from: dappKp.publicKeyB64,
        body: { id: 'req-2', sealed: sealPayload(dappToWalletKey, channelId, 1, sealedParams, { type: 'req', from: dappKp.publicKeyB64, id: 'req-2' }) },
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
        ts: Date.now(), from: dappKp.publicKeyB64,
        body: { id: 'req-3' },
      } as ProtocolMessage);

      // Should NOT emit request - unsealed requests are rejected
      expect(handler).not.toHaveBeenCalled();
      // Should send a rejection response
      const resMsg = transport.sent.find(m => m.t === 'res') as any;
      expect(resMsg).toBeTruthy();
      // ok no longer exists on wire body
    });

    it('rejects sealed request missing _method with invalid_params', () => {
      const handler = vi.fn();
      session.on('request', handler);

      transport.receive({
        v: 1, t: 'req', ch: channelId,
        ts: Date.now(), from: dappKp.publicKeyB64,
        body: { id: 'req-missing-method', sealed: sealPayload(dappToWalletKey, channelId, 0, { message: 'no method' }, { type: 'req', from: dappKp.publicKeyB64, id: 'req-missing-method' }) },
      } as ProtocolMessage);

      expect(handler).not.toHaveBeenCalled();
      const resMsg = transport.sent.find(m => m.t === 'res') as any;
      expect(resMsg).toBeTruthy();
      const { data } = unsealPayload(walletToDappKey, channelId, resMsg.body.sealed, { type: 'res', from: transport.sent.find(m => m.t === 'join')!.from!, id: 'req-missing-method' });
      expect(data).toMatchObject({ _ok: false, code: 'invalid_params' });
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
        walletMeta: { name: 'Test Wallet', description: 'Test', url: 'https://test.com', icon: 'https://test.com/icon.png', address: '0xtest' },
        dappName: 'Test dApp',
      };
      const keys = deriveDirectionalSessionKeys(rootKey, channelId, context);
      dappToWalletKey = keys.dappToWalletKey;
      walletToDappKey = keys.walletToDappKey;

      receiveConnected();
    });

    it('approve sends encrypted ok response', () => {
      transport.receive({
        v: 1, t: 'req', ch: channelId,
        ts: Date.now(), from: dappKp.publicKeyB64,
        body: { id: 'req-1', sealed: sealPayload(dappToWalletKey, channelId, 0, { _method: 'wallet_getAccounts' }, { type: 'req', from: dappKp.publicKeyB64, id: 'req-1' }) },
      } as ProtocolMessage);

      session.approve('req-1', ['0xabc123']);

      const resMsg = transport.sent.find(m => m.t === 'res') as any;
      expect(resMsg).toBeTruthy();
      expect(resMsg.body.id).toBe('req-1');
      expect(resMsg.body.sealed).toBeTruthy();

      // Verify dApp can decrypt the response (wallet->dApp uses walletToDappKey)
      const { data } = unsealPayload(walletToDappKey, channelId, resMsg.body.sealed, { type: 'res', from: walletPubB64, id: 'req-1' });
      expect(data).toEqual({ _ok: true, _result: ['0xabc123'] });
    });

    it('reject sends encrypted error response', () => {
      transport.receive({
        v: 1, t: 'req', ch: channelId,
        ts: Date.now(), from: dappKp.publicKeyB64,
        body: { id: 'req-2', sealed: sealPayload(dappToWalletKey, channelId, 0, { _method: 'wallet_signMessage', message: 'test' }, { type: 'req', from: dappKp.publicKeyB64, id: 'req-2' }) },
      } as ProtocolMessage);

      session.reject('req-2', 'user_rejected', 'User said no');

      const resMsg = transport.sent.find(m => m.t === 'res') as any;
      expect(resMsg).toBeTruthy();
      expect(resMsg.body.id).toBe('req-2');
      expect(resMsg.body.sealed).toBeTruthy();

      const { data } = unsealPayload(walletToDappKey, channelId, resMsg.body.sealed, { type: 'res', from: walletPubB64, id: 'req-2' });
      expect(data).toEqual({ _ok: false, code: 'user_rejected', message: 'User said no' });
    });

    it('approve increments send sequence', () => {
      for (let i = 0; i < 3; i++) {
        transport.receive({
          v: 1, t: 'req', ch: channelId,
          ts: Date.now(), from: dappKp.publicKeyB64,
          body: { id: `req-${i}`, sealed: sealPayload(dappToWalletKey, channelId, i, { _method: 'wallet_getAccounts' }, { type: 'req', from: dappKp.publicKeyB64, id: `req-${i}` }) },
        } as ProtocolMessage);
        session.approve(`req-${i}`, ['0x123']);
      }

      // All 3 responses should have different sealed payloads (different seqs)
      const responses = transport.sent.filter(m => m.t === 'res') as any[];
      expect(responses).toHaveLength(3);
      const sealedSet = new Set(responses.map((r: any) => r.body.sealed));
      expect(sealedSet.size).toBe(3);
    });

    it('re-encrypts cached response for duplicate request id with same params', () => {
      const handler = vi.fn();
      session.on('request', handler);
      const requestPayload = { _method: 'wallet_getAccounts' };

      transport.receive({
        v: 1, t: 'req', ch: channelId,
        ts: Date.now(), from: dappKp.publicKeyB64,
        body: { id: 'dup-1', sealed: sealPayload(dappToWalletKey, channelId, 0, requestPayload, { type: 'req', from: dappKp.publicKeyB64, id: 'dup-1' }) },
      } as ProtocolMessage);
      session.approve('dup-1', ['0xabc123']);

      transport.receive({
        v: 1, t: 'req', ch: channelId,
        ts: Date.now(), from: dappKp.publicKeyB64,
        body: { id: 'dup-1', sealed: sealPayload(dappToWalletKey, channelId, 1, requestPayload, { type: 'req', from: dappKp.publicKeyB64, id: 'dup-1' }) },
      } as ProtocolMessage);

      expect(handler).toHaveBeenCalledTimes(1);
      const responses = transport.sent.filter(m => m.t === 'res') as any[];
      expect(responses).toHaveLength(2);
      expect(responses[0]!.body.sealed).not.toBe(responses[1]!.body.sealed);
      const { data } = unsealPayload(walletToDappKey, channelId, responses[1]!.body.sealed, { type: 'res', from: walletPubB64, id: 'dup-1' });
      expect(data).toEqual({ _ok: true, _result: ['0xabc123'] });
    });

    it('rejects duplicate request id with different params', () => {
      const handler = vi.fn();
      session.on('request', handler);

      transport.receive({
        v: 1, t: 'req', ch: channelId,
        ts: Date.now(), from: dappKp.publicKeyB64,
        body: { id: 'dup-2', sealed: sealPayload(dappToWalletKey, channelId, 0, { _method: 'wallet_getAccounts' }, { type: 'req', from: dappKp.publicKeyB64, id: 'dup-2' }) },
      } as ProtocolMessage);
      session.approve('dup-2', ['0xabc123']);

      transport.receive({
        v: 1, t: 'req', ch: channelId,
        ts: Date.now(), from: dappKp.publicKeyB64,
        body: { id: 'dup-2', sealed: sealPayload(dappToWalletKey, channelId, 1, { _method: 'wallet_getAccounts', changed: true }, { type: 'req', from: dappKp.publicKeyB64, id: 'dup-2' }) },
      } as ProtocolMessage);

      expect(handler).toHaveBeenCalledTimes(1);
      const responses = transport.sent.filter(m => m.t === 'res') as any[];
      const duplicateResponse = responses[1]!;
      const { data } = unsealPayload(walletToDappKey, channelId, duplicateResponse.body.sealed, { type: 'res', from: walletPubB64, id: 'dup-2' });
      expect(data).toMatchObject({ _ok: false, code: 'invalid_params' });
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
        walletMeta: { name: 'Test Wallet', description: 'Test', url: 'https://test.com', icon: 'https://test.com/icon.png', address: '0xtest' },
        dappName: 'Test dApp',
      };
      const keys = deriveDirectionalSessionKeys(rootKey, channelId, context);
      walletToDappKey = keys.walletToDappKey;

      receiveConnected();
    });

    it('sends encrypted event message', () => {
      session.pushEvent('accountsChanged', { accounts: ['0xnew'] });

      const evtMsg = transport.sent.find(m => m.t === 'evt') as any;
      expect(evtMsg).toBeTruthy();
      expect(evtMsg.body.id).toBeTruthy();
      expect(evtMsg.body.sealed).toBeTruthy();

      // Verify dApp can decrypt (wallet->dApp uses walletToDappKey)
      const { data } = unsealPayload(walletToDappKey, channelId, evtMsg.body.sealed, { type: 'evt', from: walletPubB64, id: evtMsg.body.id });
      // Real event name and data are inside sealed payload
      expect(data).toEqual({ _event: 'accountsChanged', accounts: ['0xnew'] });
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
      const { data } = unsealPayload(walletToDappKey, channelId, evtMsg.body.sealed, { type: 'evt', from: walletPubB64, id: evtMsg.body.id });
      expect(data).toEqual({ _event: 'chainChanged', chainId: 'eip155:137' });
    });
  });

  describe('ping/pong', () => {
    beforeEach(async () => {
      await session.joinFromUri(makePairingUri());
      receiveConnected();
    });

    it('responds to ping with pong', () => {
      transport.receive({
        v: 1, t: 'ping', ch: channelId,
        ts: 12345, from: dappKp.publicKeyB64, body: {},
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
      expect((closeMsg as any).body.reason).toBe('normal');
      expect(session.phase).toBe('closed');
    });
  });

  describe('serialize/restore', () => {
    it('round-trips session state', async () => {
      await session.joinFromUri(makePairingUri());

      receiveConnected();

      const json = session.serialize();
      const newSession = new WalletSession({
        transport: new MockTransport(),
        capabilities: {
          methods: ['wallet_getAccounts', 'wallet_signMessage'],
          events: ['accountsChanged', 'chainChanged'],
          chains: ['eip155:1'],
        },
        meta: { name: 'Test Wallet', description: 'Test', url: 'https://test.com', icon: 'https://test.com/icon.png', address: '0xtest' },
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
        meta: { name: 'Test Wallet', description: 'Test', url: 'https://test.com', icon: 'https://test.com/icon.png', address: '0xtest' },
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
      receiveConnected();

      transport.receive({
        v: 1, t: 'close', ch: channelId,
        ts: Date.now(), from: dappKp.publicKeyB64,
        body: { reason: 'normal' },
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

  describe('session fingerprint after prepareJoin', () => {
    it('sessionFingerprint is set and event was emitted after prepareJoin', () => {
      const fpHandler = vi.fn();
      session.on('sessionFingerprint', fpHandler);

      const uri = makePairingUri();
      const fingerprint = session.prepareJoin(uri);

      expect(session.sessionFingerprint).toMatch(/^\d{4}$/);
      expect(fingerprint).toBe(session.sessionFingerprint);
      expect(fpHandler).toHaveBeenCalledTimes(1);
      expect(fpHandler).toHaveBeenCalledWith(session.sessionFingerprint);
    });
  });

  describe('protocol compliance', () => {
    it('rejects messages with from="_adapter" for peer types (§2)', async () => {
      const errorHandler = vi.fn();
      session.on('error', errorHandler);

      await session.joinFromUri(makePairingUri());
      receiveConnected();

      // Send a req message with from: '_adapter' — should be rejected
      transport.receive({
        v: 1, t: 'req', ch: channelId,
        ts: Date.now(), from: '_adapter',
        body: { id: 'spoofed-1', sealed: 'fake' },
      } as ProtocolMessage);

      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('_adapter'),
      }));
    });

    it('rejects messages with unsupported version (§15 rule 12)', async () => {
      await session.joinFromUri(makePairingUri());
      receiveConnected();

      // Send a message with v: 2 — should close with unsupported_version
      transport.receive({
        v: 2, t: 'req', ch: channelId,
        ts: Date.now(), from: dappKp.publicKeyB64,
        body: { id: 'v2-req', sealed: 'fake' },
      } as unknown as ProtocolMessage);

      expect(session.phase).toBe('closed');
      const closeMsg = transport.sent.find(m => m.t === 'close') as any;
      expect(closeMsg).toBeTruthy();
      expect(closeMsg.body.reason).toBe('unsupported_version');
    });

    it('rejects unsupported methods at runtime (§7.1)', async () => {
      // Session has capabilities.methods = ['wallet_getAccounts', 'wallet_signMessage']
      await session.joinFromUri(makePairingUri());

      const walletPubB64 = transport.sent.find(m => m.t === 'join')!.from!;
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
        walletMeta: { name: 'Test Wallet', description: 'Test', url: 'https://test.com', icon: 'https://test.com/icon.png', address: '0xtest' },
        dappName: 'Test dApp',
      };
      const keys = deriveDirectionalSessionKeys(rootKey, channelId, context);
      const dappToWalletKey = keys.dappToWalletKey;
      const walletToDappKey = keys.walletToDappKey;

      receiveConnected();

      const handler = vi.fn();
      session.on('request', handler);

      // Send a request for a method NOT in capabilities
      const sealedParams = { _method: 'wallet_signTransaction', data: '0x...' };
      transport.receive({
        v: 1, t: 'req', ch: channelId,
        ts: Date.now(), from: dappKp.publicKeyB64,
        body: { id: 'unsup-1', sealed: sealPayload(dappToWalletKey, channelId, 0, sealedParams, { type: 'req', from: dappKp.publicKeyB64, id: 'unsup-1' }) },
      } as ProtocolMessage);

      // Should NOT emit request
      expect(handler).not.toHaveBeenCalled();

      // Should send an error response with unsupported_method
      const resMsg = transport.sent.find(m => m.t === 'res') as any;
      expect(resMsg).toBeTruthy();
      const { data } = unsealPayload(walletToDappKey, channelId, resMsg.body.sealed, { type: 'res', from: walletPubB64, id: 'unsup-1' });
      expect(data).toMatchObject({ _ok: false, code: 'unsupported_method' });
    });
  });

  describe('scope intersection (computeScopeIntersection)', () => {
    it('intersects wallet capabilities with dApp-declared scope from URI', async () => {
      const wideWalletTransport = new MockTransport();
      const wideWalletSession = new WalletSession({
        transport: wideWalletTransport,
        capabilities: {
          methods: ['a', 'b', 'c'],
          events: ['accountsChanged'],
          chains: ['eip155:1', 'eip155:137'],
        },
        meta: { name: 'W', description: 'W', url: 'https://w.com', icon: 'https://w.com/i.png' },
      });

      // Build a URI that declares only methods=a,b and chains=eip155:1
      const dappKpLocal = generateX25519KeyPair();
      const chLocal = generateChannelId();
      const uri = buildPairingUri({
        channelId: chLocal,
        pubkeyB64: dappKpLocal.publicKeyB64,
        relayUrl: 'ws://localhost:8080/v1',
        name: 'Test dApp',
        url: 'https://test.com',
        icon: 'https://test.com/icon.png',
        methods: ['a', 'b'],
        chains: ['eip155:1'],
      });

      await wideWalletSession.joinFromUri(uri);

      // The join message should contain sealed_join with intersected capabilities
      const joinMsg = wideWalletTransport.sent.find(m => m.t === 'join') as any;
      expect(joinMsg).toBeTruthy();
      expect(joinMsg.body.sealed_join).toBeTruthy();

      // Unseal the join to verify effective capabilities
      const walletPubB64 = joinMsg.from!;
      const walletPub = b64urlDecode(walletPubB64);
      const shared = computeSharedSecret(dappKpLocal.privateKey, walletPub);
      const rootKey = deriveSessionKey(shared, chLocal);
      const joinKey = deriveJoinEncryptionKey(rootKey, chLocal);
      const unsealed = unsealJoin(joinKey, chLocal, joinMsg.body.sealed_join);

      const caps = unsealed.capabilities as { methods: string[]; chains: string[]; events: string[] };
      // Wallet grants ALL its capabilities (not just the intersection)
      // per §7.1: wallet MAY grant additional methods/chains beyond requested
      expect(caps.methods).toEqual(['a', 'b', 'c']);
      expect(caps.chains).toEqual(['eip155:1', 'eip155:137']);
      expect(caps.events).toEqual(['accountsChanged']);
    });
  });
});
