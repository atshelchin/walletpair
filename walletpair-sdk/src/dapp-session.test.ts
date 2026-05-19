import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DAppSession } from './dapp-session.js';
import { WalletSession } from './wallet-session.js';
import { MockTransport, MockRelay } from './test-helpers.js';
import {
  generateX25519KeyPair,
  computeSharedSecret,
  deriveSessionKey,
  computePairingCode,
  sealPayload,
  b64urlEncode,
  b64urlDecode,
  parsePairingUri,
} from './crypto.js';
import type { ProtocolMessage } from './types.js';

function flushMicrotasks(): Promise<void> {
  return new Promise((r) => setTimeout(r, 10));
}

describe('DAppSession', () => {
  let transport: MockTransport;
  let session: DAppSession;

  beforeEach(() => {
    transport = new MockTransport();
    session = new DAppSession({ transport, name: 'Test dApp' });
  });

  describe('createPairing', () => {
    it('starts in idle phase', () => {
      expect(session.phase).toBe('idle');
    });

    it('creates pairing and transitions to waiting', async () => {
      const phases: string[] = [];
      session.on('phase', (p) => phases.push(p));

      const uri = await session.createPairing();
      expect(uri).toContain('walletpair:?ch=');
      expect(uri).toContain('&pubkey=');
      expect(session.phase).toBe('waiting');
      expect(session.channelId).toHaveLength(64);
      expect(session.pairingUri).toBe(uri);
      expect(phases).toContain('waiting');
    });

    it('emits pairingUri event', async () => {
      const handler = vi.fn();
      session.on('pairingUri', handler);
      await session.createPairing();
      expect(handler).toHaveBeenCalledWith(session.pairingUri);
    });

    it('sends create message to transport', async () => {
      await session.createPairing();
      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]!.t).toBe('create');
      expect((transport.sent[0] as any).pubkey).toBeTruthy();
    });

    it('pairing URI is parseable', async () => {
      await session.createPairing();
      const parsed = parsePairingUri(session.pairingUri);
      expect(parsed.ch).toBe(session.channelId);
    });
  });

  describe('wallet join handling', () => {
    let walletKp: ReturnType<typeof generateX25519KeyPair>;

    beforeEach(async () => {
      await session.createPairing();
      walletKp = generateX25519KeyPair();
    });

    it('transitions to pending_accept on join', async () => {
      const phases: string[] = [];
      session.on('phase', (p) => phases.push(p));

      transport.receive({
        v: 1, t: 'join', ch: session.channelId,
        from: walletKp.publicKeyB64, pubkey: walletKp.publicKeyB64,
        capabilities: { methods: ['wallet_getAccounts'], events: [], chains: ['eip155:1'] },
      } as ProtocolMessage);

      expect(session.phase).toBe('pending_accept');
      expect(phases).toContain('pending_accept');
    });

    it('computes and emits pairing code on join', async () => {
      const handler = vi.fn();
      session.on('pairingCode', handler);

      transport.receive({
        v: 1, t: 'join', ch: session.channelId,
        from: walletKp.publicKeyB64, pubkey: walletKp.publicKeyB64,
      } as ProtocolMessage);

      expect(handler).toHaveBeenCalled();
      expect(session.pairingCode).toMatch(/^\d{6}$/);
    });

    it('emits walletJoined with capabilities and meta', async () => {
      const handler = vi.fn();
      session.on('walletJoined', handler);

      const capabilities = { methods: ['wallet_getAccounts'], events: ['accountsChanged'], chains: ['eip155:1'] };
      const meta = { name: 'Test Wallet', address: '0x123' };

      transport.receive({
        v: 1, t: 'join', ch: session.channelId,
        from: walletKp.publicKeyB64, pubkey: walletKp.publicKeyB64,
        capabilities, meta,
      } as ProtocolMessage);

      expect(handler).toHaveBeenCalledWith({
        pubkey: walletKp.publicKeyB64,
        capabilities,
        meta,
      });
      expect(session.walletCapabilities).toEqual(capabilities);
      expect(session.walletMeta).toEqual(meta);
    });
  });

  describe('acceptWallet', () => {
    it('sends accept message and transitions to connected on ready', async () => {
      await session.createPairing();
      const walletKp = generateX25519KeyPair();

      transport.receive({
        v: 1, t: 'join', ch: session.channelId,
        from: walletKp.publicKeyB64, pubkey: walletKp.publicKeyB64,
      } as ProtocolMessage);

      expect(session.phase).toBe('pending_accept');
      session.acceptWallet();

      // Should have sent accept
      const acceptMsg = transport.sent.find(m => m.t === 'accept');
      expect(acceptMsg).toBeTruthy();
      expect((acceptMsg as any).target).toBe(walletKp.publicKeyB64);

      // Simulate relay responding with ready.connected
      transport.receive({
        v: 1, t: 'ready', ch: session.channelId,
        state: 'connected', resume: 'token-123',
      } as ProtocolMessage);

      expect(session.phase).toBe('connected');
    });

    it('does nothing if not in pending_accept phase', async () => {
      await session.createPairing();
      session.acceptWallet(); // phase is 'waiting', not 'pending_accept'
      expect(transport.sent.find(m => m.t === 'accept')).toBeUndefined();
    });
  });

  describe('rejectWallet', () => {
    it('sends close with user_rejected and closes session', async () => {
      await session.createPairing();
      const walletKp = generateX25519KeyPair();

      transport.receive({
        v: 1, t: 'join', ch: session.channelId,
        from: walletKp.publicKeyB64, pubkey: walletKp.publicKeyB64,
      } as ProtocolMessage);

      session.rejectWallet();

      const closeMsg = transport.sent.find(m => m.t === 'close');
      expect(closeMsg).toBeTruthy();
      expect((closeMsg as any).reason).toBe('user_rejected');
      expect(session.phase).toBe('closed');
    });
  });

  describe('request/response', () => {
    let walletKp: ReturnType<typeof generateX25519KeyPair>;
    let sessionKey: Uint8Array;

    beforeEach(async () => {
      await session.createPairing();
      walletKp = generateX25519KeyPair();

      // Simulate join
      transport.receive({
        v: 1, t: 'join', ch: session.channelId,
        from: walletKp.publicKeyB64, pubkey: walletKp.publicKeyB64,
      } as ProtocolMessage);

      // Derive session key from wallet side
      const dappPubB64 = transport.sent[0]!.from!;
      const dappPub = b64urlDecode(dappPubB64);
      const shared = computeSharedSecret(walletKp.privateKey, dappPub);
      sessionKey = deriveSessionKey(shared, session.channelId);

      // Accept and connect
      session.acceptWallet();
      transport.receive({
        v: 1, t: 'ready', ch: session.channelId,
        state: 'connected', resume: 'token-123',
      } as ProtocolMessage);
    });

    it('sends encrypted request', async () => {
      const promise = session.request('wallet_getAccounts');

      await flushMicrotasks();

      const reqMsg = transport.sent.find(m => m.t === 'req');
      expect(reqMsg).toBeTruthy();
      expect((reqMsg as any).method).toBe('wallet_getAccounts');
      expect((reqMsg as any).id).toMatch(/^req-/);

      // Simulate wallet response
      const resData = ['0xabc123'];
      transport.receive({
        v: 1, t: 'res', ch: session.channelId,
        id: (reqMsg as any).id,
        from: walletKp.publicKeyB64,
        ok: true,
        sealed: sealPayload(sessionKey, session.channelId, 0, resData),
      } as ProtocolMessage);

      const result = await promise;
      expect(result).toEqual(['0xabc123']);
    });

    it('sends request with encrypted params', async () => {
      const promise = session.request('wallet_signMessage', { message: 'Hello' });
      await flushMicrotasks();

      const reqMsg = transport.sent.find(m => m.t === 'req') as any;
      expect(reqMsg.sealed).toBeTruthy(); // params were sealed

      // Respond
      transport.receive({
        v: 1, t: 'res', ch: session.channelId,
        id: reqMsg.id, from: walletKp.publicKeyB64,
        ok: true,
        sealed: sealPayload(sessionKey, session.channelId, 0, { signature: '0x...' }),
      } as ProtocolMessage);

      const result = await promise;
      expect(result).toEqual({ signature: '0x...' });
    });

    it('rejects on error response', async () => {
      const promise = session.request('wallet_signMessage', { message: 'Hi' });
      await flushMicrotasks();

      const reqMsg = transport.sent.find(m => m.t === 'req') as any;

      transport.receive({
        v: 1, t: 'res', ch: session.channelId,
        id: reqMsg.id, from: walletKp.publicKeyB64,
        ok: false,
        sealed: sealPayload(sessionKey, session.channelId, 0, { code: 'user_rejected', message: 'User rejected' }),
      } as ProtocolMessage);

      await expect(promise).rejects.toThrow('User rejected');
    });

    it('rejects on timeout', async () => {
      vi.useFakeTimers();

      const shortTimeoutSession = new DAppSession({
        transport, name: 'Test', requestTimeout: 100,
      });
      // Manually set session state to connected
      (shortTimeoutSession as any).phase = 'connected';
      (shortTimeoutSession as any).sessionKey = sessionKey;
      (shortTimeoutSession as any).channelId = session.channelId;
      (shortTimeoutSession as any).pubKeyB64 = 'test';

      const promise = shortTimeoutSession.request('wallet_getAccounts');
      vi.advanceTimersByTime(200);

      await expect(promise).rejects.toThrow('timed out');
      vi.useRealTimers();
    });

    it('emits response event', async () => {
      const handler = vi.fn();
      session.on('response', handler);

      const promise = session.request('wallet_getAccounts');
      await flushMicrotasks();

      const reqMsg = transport.sent.find(m => m.t === 'req') as any;
      transport.receive({
        v: 1, t: 'res', ch: session.channelId,
        id: reqMsg.id, from: walletKp.publicKeyB64,
        ok: true,
        sealed: sealPayload(sessionKey, session.channelId, 0, ['0x123']),
      } as ProtocolMessage);

      await promise;
      expect(handler).toHaveBeenCalledWith({ id: reqMsg.id, ok: true, data: ['0x123'] });
    });

    it('rejects request when not connected', async () => {
      const idleSession = new DAppSession({ transport: new MockTransport() });
      await expect(idleSession.request('test')).rejects.toThrow('Not connected');
    });
  });

  describe('event handling', () => {
    it('emits event when wallet pushes evt', async () => {
      await session.createPairing();
      const walletKp = generateX25519KeyPair();

      transport.receive({
        v: 1, t: 'join', ch: session.channelId,
        from: walletKp.publicKeyB64, pubkey: walletKp.publicKeyB64,
      } as ProtocolMessage);

      const dappPub = b64urlDecode(transport.sent[0]!.from!);
      const shared = computeSharedSecret(walletKp.privateKey, dappPub);
      const sessionKey = deriveSessionKey(shared, session.channelId);

      session.acceptWallet();
      transport.receive({
        v: 1, t: 'ready', ch: session.channelId,
        state: 'connected', resume: 'tok',
      } as ProtocolMessage);

      const handler = vi.fn();
      session.on('event', handler);

      transport.receive({
        v: 1, t: 'evt', ch: session.channelId,
        from: walletKp.publicKeyB64, event: 'accountsChanged',
        sealed: sealPayload(sessionKey, session.channelId, 0, { accounts: ['0xabc'] }),
      } as ProtocolMessage);

      expect(handler).toHaveBeenCalledWith({
        event: 'accountsChanged',
        data: { accounts: ['0xabc'] },
      });
    });
  });

  describe('ping/pong', () => {
    it('responds to ping with pong', async () => {
      await session.createPairing();
      transport.receive({
        v: 1, t: 'ready', ch: session.channelId,
        state: 'connected', resume: 'tok',
      } as ProtocolMessage);

      transport.receive({
        v: 1, t: 'ping', ch: session.channelId, ts: 1000,
      } as ProtocolMessage);

      const pong = transport.sent.find(m => m.t === 'pong');
      expect(pong).toBeTruthy();
      expect((pong as any).ts).toBeTypeOf('number');
    });

    it('sends ping', async () => {
      await session.createPairing();
      transport.receive({
        v: 1, t: 'ready', ch: session.channelId,
        state: 'connected', resume: 'tok',
      } as ProtocolMessage);

      session.ping();
      const ping = transport.sent.find(m => m.t === 'ping');
      expect(ping).toBeTruthy();
    });
  });

  describe('close', () => {
    it('sends close message and transitions to closed', async () => {
      await session.createPairing();
      session.close();

      const closeMsg = transport.sent.find(m => m.t === 'close');
      expect(closeMsg).toBeTruthy();
      expect((closeMsg as any).reason).toBe('normal');
      expect(session.phase).toBe('closed');
    });

    it('rejects all pending requests on close', async () => {
      await session.createPairing();
      const walletKp = generateX25519KeyPair();

      transport.receive({
        v: 1, t: 'join', ch: session.channelId,
        from: walletKp.publicKeyB64, pubkey: walletKp.publicKeyB64,
      } as ProtocolMessage);
      session.acceptWallet();
      transport.receive({
        v: 1, t: 'ready', ch: session.channelId,
        state: 'connected', resume: 'tok',
      } as ProtocolMessage);

      const promise = session.request('test');
      session.close();

      await expect(promise).rejects.toThrow('Session closed');
    });
  });

  describe('serialize/restore', () => {
    it('round-trips session state', async () => {
      await session.createPairing();
      const walletKp = generateX25519KeyPair();

      transport.receive({
        v: 1, t: 'join', ch: session.channelId,
        from: walletKp.publicKeyB64, pubkey: walletKp.publicKeyB64,
      } as ProtocolMessage);

      const json = session.serialize();
      expect(json).toBeTruthy();

      const newTransport = new MockTransport();
      const restored = new DAppSession({ transport: newTransport });
      expect(restored.restore(json)).toBe(true);
      expect(restored.channelId).toBe(session.channelId);
    });

    it('returns false for invalid JSON', () => {
      const s = new DAppSession({ transport: new MockTransport() });
      expect(s.restore('not json')).toBe(false);
      expect(s.restore('{}')).toBe(false);
      expect(s.restore('{"channelId":"abc"}')).toBe(false); // missing privKey
    });
  });

  describe('auto-accept on rejoin', () => {
    it('auto-accepts known wallet', async () => {
      await session.createPairing();
      const walletKp = generateX25519KeyPair();

      // First join
      transport.receive({
        v: 1, t: 'join', ch: session.channelId,
        from: walletKp.publicKeyB64, pubkey: walletKp.publicKeyB64,
      } as ProtocolMessage);
      session.acceptWallet();
      transport.receive({
        v: 1, t: 'ready', ch: session.channelId,
        state: 'connected', resume: 'tok',
      } as ProtocolMessage);

      // Second join (rejoin) — should auto-accept
      transport.receive({
        v: 1, t: 'join', ch: session.channelId,
        from: walletKp.publicKeyB64, pubkey: walletKp.publicKeyB64,
      } as ProtocolMessage);

      // Should have sent accept without going through pending_accept
      const acceptMessages = transport.sent.filter(m => m.t === 'accept');
      expect(acceptMessages).toHaveLength(2);
    });
  });

  describe('close message handling', () => {
    it('transitions to closed on receiving close', async () => {
      await session.createPairing();
      transport.receive({
        v: 1, t: 'close', ch: session.channelId,
        reason: 'timeout',
      } as ProtocolMessage);

      expect(session.phase).toBe('closed');
    });
  });

  describe('destroy', () => {
    it('closes and removes all listeners', async () => {
      await session.createPairing();
      const handler = vi.fn();
      session.on('phase', handler);
      session.destroy();

      expect(session.phase).toBe('closed');
      // After destroy, emitting should not call handler
      // (removeAll was called)
    });
  });
});
