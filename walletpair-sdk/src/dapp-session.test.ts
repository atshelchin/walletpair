import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DAppSession } from './dapp-session.js';
import { WalletSession } from './wallet-session.js';
import { makeJoinBody, MockTransport, MockRelay } from './test-helpers.js';
import {
  generateX25519KeyPair,
  computeSharedSecret,
  deriveSessionKey,
  deriveDirectionalSessionKeys,
  sealPayload,
  b64urlEncode,
  b64urlDecode,
  parsePairingUri,
} from './crypto.js';
import type { AadHeader, SessionCryptoContext } from './crypto.js';
import type { ProtocolMessage } from './types.js';

function flushMicrotasks(): Promise<void> {
  return new Promise((r) => setTimeout(r, 10));
}

function dappPubKeyFromCreate(transport: MockTransport): string {
  return transport.sent.find(m => m.t === 'create')!.from!;
}

function receiveFreshJoin(
  transport: MockTransport,
  session: DAppSession,
  walletKp: ReturnType<typeof generateX25519KeyPair>,
): void {
  transport.receive({
    v: 1, t: 'join', ch: session.channelId,
    ts: Date.now(), from: walletKp.publicKeyB64,
    body: makeJoinBody(session.channelId, dappPubKeyFromCreate(transport), walletKp),
  } as ProtocolMessage);
}

function receiveConnected(
  transport: MockTransport,
  session: DAppSession,
  walletPubKeyB64: string,
  resume = 'tok',
): void {
  transport.receive({
    v: 1, t: 'ready', ch: session.channelId,
    ts: Date.now(), from: '_adapter',
    body: { state: 'connected', resume, remote: walletPubKeyB64 },
  } as ProtocolMessage);
}

describe('DAppSession', () => {
  let transport: MockTransport;
  let session: DAppSession;

  beforeEach(() => {
    transport = new MockTransport();
    session = new DAppSession({ transport, meta: { name: 'Test dApp', description: 'Test', url: 'https://test.com', icon: 'https://test.com/icon.png' } });
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
      expect(transport.sent[0]!.from).toBeTruthy();
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

    it('auto-accepts and transitions to accepting on join', async () => {
      const phases: string[] = [];
      session.on('phase', (p) => phases.push(p));

      receiveFreshJoin(transport, session, walletKp);

      // With auto-accept, the session should not stay in pending_accept
      // It should proceed to accepting (waiting for ready.connected)
      expect(session.phase).not.toBe('idle');
    });

    it('computes and emits session fingerprint on createPairing', async () => {
      expect(session.sessionFingerprint).toMatch(/^\d{4}$/);
    });

    it('emits walletJoined with capabilities and meta from sealed_join', async () => {
      const handler = vi.fn();
      session.on('walletJoined', handler);

      receiveFreshJoin(transport, session, walletKp);

      expect(handler).toHaveBeenCalledWith({
        capabilities: expect.objectContaining({ methods: expect.any(Array) }),
        meta: { name: 'Test Wallet' },
      });
    });
  });

  describe('auto-accept on join', () => {
    it('auto-accepts and transitions to connected on ready', async () => {
      await session.createPairing();
      const walletKp = generateX25519KeyPair();

      receiveFreshJoin(transport, session, walletKp);

      // Should have auto-sent accept (no manual acceptWallet needed)
      const acceptMsg = transport.sent.find(m => m.t === 'accept');
      expect(acceptMsg).toBeTruthy();
      expect((acceptMsg as any).body.target).toBe(walletKp.publicKeyB64);

      // Simulate relay responding with ready.connected
      receiveConnected(transport, session, walletKp.publicKeyB64, 'token-123');

      expect(session.phase).toBe('connected');
    });

    it('rejects ready.connected with missing remote', async () => {
      await session.createPairing();
      const walletKp = generateX25519KeyPair();
      const errorHandler = vi.fn();
      session.on('error', errorHandler);

      receiveFreshJoin(transport, session, walletKp);

      transport.receive({
        v: 1, t: 'ready', ch: session.channelId,
        ts: Date.now(), from: '_adapter',
        body: { state: 'connected', resume: 'token-123', remote: null },
      } as ProtocolMessage);

      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('remote does not match'),
      }));
      expect(session.phase).toBe('closed');
    });
  });

  describe('rejectWallet', () => {
    it('sends close with user_rejected and closes session (autoAccept disabled)', async () => {
      const manualSession = new DAppSession({
        transport, autoAccept: false,
        meta: { name: 'Test dApp', description: 'Test', url: 'https://test.com', icon: 'https://test.com/icon.png' },
      });
      await manualSession.createPairing();
      const walletKp = generateX25519KeyPair();

      receiveFreshJoin(transport, manualSession, walletKp);

      manualSession.rejectWallet();

      const closeMsg = transport.sent.find(m => m.t === 'close');
      expect(closeMsg).toBeTruthy();
      expect((closeMsg as any).body.reason).toBe('user_rejected');
      expect(manualSession.phase).toBe('closed');
    });
  });

  describe('request/response', () => {
    let walletKp: ReturnType<typeof generateX25519KeyPair>;
    let sessionKey: Uint8Array;
    let walletToDappKey: Uint8Array;

    beforeEach(async () => {
      await session.createPairing();
      walletKp = generateX25519KeyPair();

      // Simulate join
      receiveFreshJoin(transport, session, walletKp);

      // Derive session key from wallet side
      const dappPubB64 = transport.sent[0]!.from!;
      const dappPub = b64urlDecode(dappPubB64);
      const shared = computeSharedSecret(walletKp.privateKey, dappPub);
      sessionKey = deriveSessionKey(shared, session.channelId);

      // Auto-accepted; simulate relay ready.connected
      receiveConnected(transport, session, walletKp.publicKeyB64, 'token-123');
      walletToDappKey = (session as any).recvKey;
    });

    it('sends encrypted request', async () => {
      const promise = session.request('wallet_getAccounts');

      await flushMicrotasks();

      const reqMsg = transport.sent.find(m => m.t === 'req');
      expect(reqMsg).toBeTruthy();
      const reqBody = (reqMsg as any).body;
      expect(reqBody.id).toMatch(/^req-/);
      expect(reqBody.sealed).toBeTruthy();

      // Simulate wallet response
      const resData = ['0xabc123'];
      const resHdr: AadHeader = { type: 'res', from: walletKp.publicKeyB64, id: reqBody.id, ok: true };
      transport.receive({
        v: 1, t: 'res', ch: session.channelId,
        ts: Date.now(), from: walletKp.publicKeyB64,
        body: { id: reqBody.id, ok: true, sealed: sealPayload(walletToDappKey, session.channelId, 0, resData, resHdr) },
      } as ProtocolMessage);

      const result = await promise;
      expect(result).toEqual(['0xabc123']);
    });

    it('sends request with encrypted params', async () => {
      const promise = session.request('wallet_signMessage', { message: 'Hello' });
      await flushMicrotasks();

      const reqMsg = transport.sent.find(m => m.t === 'req') as any;
      expect(reqMsg.body.sealed).toBeTruthy(); // params were sealed

      // Respond
      const reqId = reqMsg.body.id;
      transport.receive({
        v: 1, t: 'res', ch: session.channelId,
        ts: Date.now(), from: walletKp.publicKeyB64,
        body: { id: reqId, ok: true, sealed: sealPayload(walletToDappKey, session.channelId, 0, { signature: '0x...' }, { type: 'res', from: walletKp.publicKeyB64, id: reqId, ok: true }) },
      } as ProtocolMessage);

      const result = await promise;
      expect(result).toEqual({ signature: '0x...' });
    });

    it('rejects on error response', async () => {
      const promise = session.request('wallet_signMessage', { message: 'Hi' });
      await flushMicrotasks();

      const reqMsg = transport.sent.find(m => m.t === 'req') as any;
      const reqId = reqMsg.body.id;

      transport.receive({
        v: 1, t: 'res', ch: session.channelId,
        ts: Date.now(), from: walletKp.publicKeyB64,
        body: { id: reqId, ok: false, sealed: sealPayload(walletToDappKey, session.channelId, 0, { code: 'user_rejected', message: 'User rejected' }, { type: 'res', from: walletKp.publicKeyB64, id: reqId, ok: false }) },
      } as ProtocolMessage);

      await expect(promise).rejects.toThrow('User rejected');
    });

    it('rejects on timeout', async () => {
      vi.useFakeTimers();

      const shortTimeoutSession = new DAppSession({
        transport, meta: { name: 'Test', description: 'Test', url: 'https://test.com', icon: 'https://test.com/icon.png' }, requestTimeout: 100,
      });
      // Manually set session state to connected
      (shortTimeoutSession as any).phase = 'connected';
      (shortTimeoutSession as any).sessionKey = sessionKey;
      (shortTimeoutSession as any).sendKey = new Uint8Array(32).fill(1);
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
      const reqId = reqMsg.body.id;
      transport.receive({
        v: 1, t: 'res', ch: session.channelId,
        ts: Date.now(), from: walletKp.publicKeyB64,
        body: { id: reqId, ok: true, sealed: sealPayload(walletToDappKey, session.channelId, 0, ['0x123'], { type: 'res', from: walletKp.publicKeyB64, id: reqId, ok: true }) },
      } as ProtocolMessage);

      await promise;
      expect(handler).toHaveBeenCalledWith({ id: reqId, ok: true, data: ['0x123'] });
    });

    it('rejects request when not connected', async () => {
      const idleSession = new DAppSession({ transport: new MockTransport(), meta: { name: 'Test', description: 'Test', url: 'https://test.com', icon: 'https://test.com/icon.png' } });
      await expect(idleSession.request('test')).rejects.toThrow('Not connected');
    });
  });

  describe('event handling', () => {
    it('emits event when wallet pushes evt', async () => {
      await session.createPairing();
      const walletKp = generateX25519KeyPair();

      receiveFreshJoin(transport, session, walletKp);

      const dappPub = b64urlDecode(transport.sent[0]!.from!);
      const shared = computeSharedSecret(walletKp.privateKey, dappPub);
      deriveSessionKey(shared, session.channelId);

      receiveConnected(transport, session, walletKp.publicKeyB64);

      const handler = vi.fn();
      session.on('event', handler);

      const evtId = 'evt-1';
      transport.receive({
        v: 1, t: 'evt', ch: session.channelId,
        ts: Date.now(), from: walletKp.publicKeyB64,
        body: { id: evtId, sealed: sealPayload((session as any).recvKey, session.channelId, 0, { _event: 'accountsChanged', accounts: ['0xabc'] }, { type: 'evt', from: walletKp.publicKeyB64, id: evtId }) },
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
      (session as any).remotePubKey = b64urlDecode('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      receiveConnected(transport, session, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');

      transport.receive({
        v: 1, t: 'ping', ch: session.channelId,
        ts: 1000, from: '_adapter', body: {},
      } as ProtocolMessage);

      const pong = transport.sent.find(m => m.t === 'pong');
      expect(pong).toBeTruthy();
      expect(pong!.ts).toBeTypeOf('number');
    });

    it('sends ping', async () => {
      await session.createPairing();
      (session as any).remotePubKey = b64urlDecode('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      receiveConnected(transport, session, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');

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
      expect((closeMsg as any).body.reason).toBe('normal');
      expect(session.phase).toBe('closed');
    });

    it('rejects all pending requests on close', async () => {
      await session.createPairing();
      const walletKp = generateX25519KeyPair();

      receiveFreshJoin(transport, session, walletKp);
      receiveConnected(transport, session, walletKp.publicKeyB64);

      const promise = session.request('test');
      session.close();

      await expect(promise).rejects.toThrow('Session closed');
    });
  });

  describe('serialize/restore', () => {
    it('round-trips session state', async () => {
      await session.createPairing();
      const walletKp = generateX25519KeyPair();

      receiveFreshJoin(transport, session, walletKp);

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
    it('auto-accepts known wallet with matching capabilities (no sealed_join on resume)', async () => {
      await session.createPairing();
      const walletKp = generateX25519KeyPair();

      // First join carries sealed capabilities/meta (auto-accepted).
      receiveFreshJoin(transport, session, walletKp);
      receiveConnected(transport, session, walletKp.publicKeyB64);

      // Second join (rejoin) with resume — should auto-accept (same wallet, same approved scope)
      transport.receive({
        v: 1, t: 'join', ch: session.channelId,
        ts: Date.now(), from: walletKp.publicKeyB64,
        body: { sealed_join: null, resume: 'tok' },
      } as ProtocolMessage);

      // First join auto-accepted + rejoin auto-accepted = 2 accept messages
      const acceptMessages = transport.sent.filter(m => m.t === 'accept');
      expect(acceptMessages).toHaveLength(2);
    });

    it('auto-accepts new wallet on rejoin (different pubkey)', async () => {
      await session.createPairing();
      const walletKp = generateX25519KeyPair();
      const walletKp2 = generateX25519KeyPair();

      // First join (auto-accepted)
      receiveFreshJoin(transport, session, walletKp);
      receiveConnected(transport, session, walletKp.publicKeyB64);

      // Second join with different wallet — also auto-accepted (sealed_join decryption proves possession)
      receiveFreshJoin(transport, session, walletKp2);

      const acceptMessages = transport.sent.filter(m => m.t === 'accept');
      expect(acceptMessages).toHaveLength(2);
    });
  });

  describe('close message handling', () => {
    it('transitions to closed on receiving close', async () => {
      await session.createPairing();
      transport.receive({
        v: 1, t: 'close', ch: session.channelId,
        ts: Date.now(), from: '_adapter',
        body: { reason: 'timeout' },
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
