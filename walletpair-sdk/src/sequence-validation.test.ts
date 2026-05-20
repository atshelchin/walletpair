/**
 * Sequence number validation tests for DAppSession and WalletSession.
 *
 * Covers: replay rejection, sequence gaps, persistence of recvSeq,
 * send sequence overflow, pending accept timeout, and capabilities validation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DAppSession } from './dapp-session.js';
import { WalletSession } from './wallet-session.js';
import { MockTransport, MockRelay } from './test-helpers.js';
import {
  generateX25519KeyPair,
  generateChannelId,
  buildPairingUri,
  computeSharedSecret,
  deriveSessionKey,
  computePairingCode,
  sealPayload,
  unsealPayload,
  b64urlEncode,
  b64urlDecode,
} from './crypto.js';
import type { AadHeader } from './crypto.js';
import type { ProtocolMessage } from './types.js';

function wait(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Helpers to set up connected DApp + Wallet sessions
// ---------------------------------------------------------------------------

interface ConnectedPair {
  dappSession: DAppSession;
  walletSession: WalletSession;
  dappTransport: MockTransport;
  walletTransport: MockTransport;
  /** Session key derived from the dApp side (same key both sides share). */
  sessionKey: Uint8Array;
  /** The wallet's key pair (for crafting raw messages from wallet side). */
  walletKp: ReturnType<typeof generateX25519KeyPair>;
  /** The dApp's key pair (for crafting raw messages from dApp side). */
  dappKp: { publicKeyB64: string };
  channelId: string;
}

async function setupConnectedPair(): Promise<ConnectedPair> {
  const dappTransport = new MockTransport();
  const walletTransport = new MockTransport();
  const _relay = new MockRelay(dappTransport, walletTransport);

  const dappSession = new DAppSession({ transport: dappTransport, name: 'Test dApp' });
  const walletSession = new WalletSession({
    transport: walletTransport,
    capabilities: {
      methods: ['wallet_getAccounts', 'wallet_signMessage'],
      events: ['accountsChanged'],
      chains: ['eip155:1'],
    },
    meta: { name: 'Test Wallet' },
  });

  const uri = await dappSession.createPairing();
  await walletSession.joinFromUri(uri);
  await wait();

  dappSession.acceptWallet();
  await wait();

  // Derive session key from the dApp side perspective.
  // We need the wallet's pubkey and dApp's private key — but those are internal.
  // Instead, we extract from what the relay forwarded.
  // The walletTransport.sent has the join message with from = wallet pubkey.
  const walletJoinMsg = walletTransport.sent.find(m => m.t === 'join')!;
  const walletPubB64 = walletJoinMsg.from!;
  // The dappTransport.sent has the create message with from = dApp pubkey.
  const dappCreateMsg = dappTransport.sent.find(m => m.t === 'create')!;
  const dappPubB64 = dappCreateMsg.from!;

  return {
    dappSession,
    walletSession,
    dappTransport,
    walletTransport,
    sessionKey: null as any, // We use sessions directly; raw key only needed for manual message tests
    walletKp: null as any,
    dappKp: { publicKeyB64: dappPubB64 },
    channelId: dappSession.channelId,
  };
}

/**
 * Set up a DAppSession with a direct MockTransport (no relay), manually
 * driving the handshake so we can craft raw messages with specific seq numbers.
 */
function setupDAppWithManualWallet() {
  const transport = new MockTransport();
  const session = new DAppSession({ transport, name: 'Test dApp' });
  const walletKp = generateX25519KeyPair();

  return { transport, session, walletKp };
}

async function connectDAppManually(ctx: ReturnType<typeof setupDAppWithManualWallet>) {
  const { transport, session, walletKp } = ctx;
  await session.createPairing();

  // Simulate wallet join
  transport.receive({
    v: 1, t: 'join', ch: session.channelId,
    from: walletKp.publicKeyB64, pubkey: walletKp.publicKeyB64,
    capabilities: { methods: ['wallet_getAccounts'], events: [], chains: ['eip155:1'] },
  } as ProtocolMessage);

  // Derive session key from wallet side
  const dappPubB64 = transport.sent[0]!.from!;
  const dappPub = b64urlDecode(dappPubB64);
  const shared = computeSharedSecret(walletKp.privateKey, dappPub);
  const sessionKey = deriveSessionKey(shared, session.channelId);

  // Accept and connect
  session.acceptWallet();
  transport.receive({
    v: 1, t: 'ready', ch: session.channelId,
    state: 'connected', resume: 'tok',
  } as ProtocolMessage);

  return { sessionKey, dappPubB64 };
}

/**
 * Set up a WalletSession with a direct MockTransport, manually driving the handshake.
 */
function setupWalletWithManualDApp() {
  const transport = new MockTransport();
  const dappKp = generateX25519KeyPair();
  const channelId = generateChannelId();

  const session = new WalletSession({
    transport,
    capabilities: {
      methods: ['wallet_getAccounts'],
      events: [],
      chains: ['eip155:1'],
    },
  });

  return { transport, session, dappKp, channelId };
}

async function connectWalletManually(ctx: ReturnType<typeof setupWalletWithManualDApp>) {
  const { transport, session, dappKp, channelId } = ctx;

  const uri = buildPairingUri({
    channelId,
    pubkeyB64: dappKp.publicKeyB64,
    relayUrl: 'ws://localhost:8080/v1',
  });

  await session.joinFromUri(uri);

  // Derive session key from dApp side
  const walletPubB64 = transport.sent.find(m => m.t === 'join')!.from!;
  const walletPub = b64urlDecode(walletPubB64);
  const shared = computeSharedSecret(dappKp.privateKey, walletPub);
  const sessionKey = deriveSessionKey(shared, channelId);

  // Connect
  transport.receive({
    v: 1, t: 'ready', ch: channelId,
    state: 'connected', resume: 'tok',
  } as ProtocolMessage);

  return { sessionKey, walletPubB64 };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Sequence validation', () => {

  // -----------------------------------------------------------------------
  // 1. Replay rejection on DAppSession
  // -----------------------------------------------------------------------
  describe('replay rejection on DAppSession', () => {
    it('accepts seq=0, rejects replay seq=0, accepts seq=1', async () => {
      const ctx = setupDAppWithManualWallet();
      const { transport, session, walletKp } = ctx;
      const { sessionKey } = await connectDAppManually(ctx);

      // Send request so we have a pending request for seq=0 response
      const p0 = session.request('wallet_getAccounts');
      await wait(20);
      const req0 = transport.sent.find(m => m.t === 'req') as any;

      // Wallet responds with seq=0 -> should be accepted
      transport.receive({
        v: 1, t: 'res', ch: session.channelId,
        id: req0.id, from: walletKp.publicKeyB64,
        ok: true,
        sealed: sealPayload(sessionKey, session.channelId, 0, ['0xabc'], { type: 'res', from: walletKp.publicKeyB64, id: req0.id, ok: true }),
      } as ProtocolMessage);

      const result0 = await p0;
      expect(result0).toEqual(['0xabc']);

      // Send another request for seq=0 replay test
      const p1 = session.request('wallet_getAccounts');
      await wait(20);
      const req1 = transport.sent.filter(m => m.t === 'req')[1] as any;

      // Wallet responds with seq=0 again (replay) -> should be rejected
      transport.receive({
        v: 1, t: 'res', ch: session.channelId,
        id: req1.id, from: walletKp.publicKeyB64,
        ok: true,
        sealed: sealPayload(sessionKey, session.channelId, 0, ['0xreplay'], { type: 'res', from: walletKp.publicKeyB64, id: req1.id, ok: true }),
      } as ProtocolMessage);

      await expect(p1).rejects.toThrow('Replay detected');

      // Send another request for seq=1 test
      const p2 = session.request('wallet_getAccounts');
      await wait(20);
      const req2 = transport.sent.filter(m => m.t === 'req')[2] as any;

      // Wallet responds with seq=1 -> should be accepted
      transport.receive({
        v: 1, t: 'res', ch: session.channelId,
        id: req2.id, from: walletKp.publicKeyB64,
        ok: true,
        sealed: sealPayload(sessionKey, session.channelId, 1, ['0xdef'], { type: 'res', from: walletKp.publicKeyB64, id: req2.id, ok: true }),
      } as ProtocolMessage);

      const result2 = await p2;
      expect(result2).toEqual(['0xdef']);
    });

    it('silently drops replayed events', async () => {
      const ctx = setupDAppWithManualWallet();
      const { transport, session, walletKp } = ctx;
      const { sessionKey } = await connectDAppManually(ctx);

      const eventHandler = vi.fn();
      session.on('event', eventHandler);

      // First event with seq=0 -> accepted
      transport.receive({
        v: 1, t: 'evt', ch: session.channelId,
        from: walletKp.publicKeyB64, event: 'accountsChanged',
        sealed: sealPayload(sessionKey, session.channelId, 0, { accounts: ['0xa'] }, { type: 'evt', from: walletKp.publicKeyB64, event: 'accountsChanged' }),
      } as ProtocolMessage);

      expect(eventHandler).toHaveBeenCalledTimes(1);

      // Replay same event with seq=0 -> silently dropped
      transport.receive({
        v: 1, t: 'evt', ch: session.channelId,
        from: walletKp.publicKeyB64, event: 'accountsChanged',
        sealed: sealPayload(sessionKey, session.channelId, 0, { accounts: ['0xa'] }, { type: 'evt', from: walletKp.publicKeyB64, event: 'accountsChanged' }),
      } as ProtocolMessage);

      expect(eventHandler).toHaveBeenCalledTimes(1); // still 1

      // New event with seq=1 -> accepted
      transport.receive({
        v: 1, t: 'evt', ch: session.channelId,
        from: walletKp.publicKeyB64, event: 'accountsChanged',
        sealed: sealPayload(sessionKey, session.channelId, 1, { accounts: ['0xb'] }, { type: 'evt', from: walletKp.publicKeyB64, event: 'accountsChanged' }),
      } as ProtocolMessage);

      expect(eventHandler).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // 2. Replay rejection on WalletSession
  // -----------------------------------------------------------------------
  describe('replay rejection on WalletSession', () => {
    it('accepts seq=0, drops replay seq=0, accepts seq=1', async () => {
      const ctx = setupWalletWithManualDApp();
      const { transport, session, dappKp, channelId } = ctx;
      const { sessionKey } = await connectWalletManually(ctx);

      const requestHandler = vi.fn();
      session.on('request', requestHandler);

      // Request with seq=0 -> accepted
      transport.receive({
        v: 1, t: 'req', ch: channelId,
        id: 'req-1', from: dappKp.publicKeyB64,
        method: 'wallet_getAccounts',
        sealed: sealPayload(sessionKey, channelId, 0, { foo: 'bar' }, { type: 'req', from: dappKp.publicKeyB64, id: 'req-1', method: 'wallet_getAccounts' }),
      } as ProtocolMessage);

      expect(requestHandler).toHaveBeenCalledTimes(1);
      expect(requestHandler).toHaveBeenCalledWith({
        id: 'req-1',
        method: 'wallet_getAccounts',
        params: { foo: 'bar' },
      });

      // Replay same request with seq=0 -> silently dropped
      transport.receive({
        v: 1, t: 'req', ch: channelId,
        id: 'req-1-replay', from: dappKp.publicKeyB64,
        method: 'wallet_getAccounts',
        sealed: sealPayload(sessionKey, channelId, 0, { foo: 'bar' }, { type: 'req', from: dappKp.publicKeyB64, id: 'req-1-replay', method: 'wallet_getAccounts' }),
      } as ProtocolMessage);

      expect(requestHandler).toHaveBeenCalledTimes(1); // still 1

      // Request with seq=1 -> accepted
      transport.receive({
        v: 1, t: 'req', ch: channelId,
        id: 'req-2', from: dappKp.publicKeyB64,
        method: 'wallet_signMessage',
        sealed: sealPayload(sessionKey, channelId, 1, { message: 'hello' }, { type: 'req', from: dappKp.publicKeyB64, id: 'req-2', method: 'wallet_signMessage' }),
      } as ProtocolMessage);

      expect(requestHandler).toHaveBeenCalledTimes(2);
      expect(requestHandler).toHaveBeenLastCalledWith({
        id: 'req-2',
        method: 'wallet_signMessage',
        params: { message: 'hello' },
      });
    });
  });

  // -----------------------------------------------------------------------
  // 3. Sequence gaps accepted
  // -----------------------------------------------------------------------
  describe('sequence gaps accepted', () => {
    it('accepts seq=0 then seq=5 (gap), rejects seq=3 (below high watermark)', async () => {
      const ctx = setupDAppWithManualWallet();
      const { transport, session, walletKp } = ctx;
      const { sessionKey } = await connectDAppManually(ctx);

      // Request 1: seq=0
      const p0 = session.request('wallet_getAccounts');
      await wait(20);
      const req0 = transport.sent.find(m => m.t === 'req') as any;

      transport.receive({
        v: 1, t: 'res', ch: session.channelId,
        id: req0.id, from: walletKp.publicKeyB64,
        ok: true,
        sealed: sealPayload(sessionKey, session.channelId, 0, 'first', { type: 'res', from: walletKp.publicKeyB64, id: req0.id, ok: true }),
      } as ProtocolMessage);

      expect(await p0).toBe('first');

      // Request 2: seq=5 (gap of 4) -> should be accepted
      const p1 = session.request('wallet_getAccounts');
      await wait(20);
      const req1 = transport.sent.filter(m => m.t === 'req')[1] as any;

      transport.receive({
        v: 1, t: 'res', ch: session.channelId,
        id: req1.id, from: walletKp.publicKeyB64,
        ok: true,
        sealed: sealPayload(sessionKey, session.channelId, 5, 'second', { type: 'res', from: walletKp.publicKeyB64, id: req1.id, ok: true }),
      } as ProtocolMessage);

      expect(await p1).toBe('second');

      // Request 3: seq=3 (less than current high watermark of 5) -> rejected
      const p2 = session.request('wallet_getAccounts');
      await wait(20);
      const req2 = transport.sent.filter(m => m.t === 'req')[2] as any;

      transport.receive({
        v: 1, t: 'res', ch: session.channelId,
        id: req2.id, from: walletKp.publicKeyB64,
        ok: true,
        sealed: sealPayload(sessionKey, session.channelId, 3, 'replay-attempt', { type: 'res', from: walletKp.publicKeyB64, id: req2.id, ok: true }),
      } as ProtocolMessage);

      await expect(p2).rejects.toThrow('Replay detected');
    });

    it('wallet session also accepts gaps and rejects below watermark', async () => {
      const ctx = setupWalletWithManualDApp();
      const { transport, session, dappKp, channelId } = ctx;
      const { sessionKey } = await connectWalletManually(ctx);

      const requestHandler = vi.fn();
      session.on('request', requestHandler);

      // seq=0 -> accepted
      transport.receive({
        v: 1, t: 'req', ch: channelId,
        id: 'r1', from: dappKp.publicKeyB64,
        method: 'wallet_getAccounts',
        sealed: sealPayload(sessionKey, channelId, 0, {}, { type: 'req', from: dappKp.publicKeyB64, id: 'r1', method: 'wallet_getAccounts' }),
      } as ProtocolMessage);
      expect(requestHandler).toHaveBeenCalledTimes(1);

      // seq=5 (gap) -> accepted
      transport.receive({
        v: 1, t: 'req', ch: channelId,
        id: 'r2', from: dappKp.publicKeyB64,
        method: 'wallet_getAccounts',
        sealed: sealPayload(sessionKey, channelId, 5, {}, { type: 'req', from: dappKp.publicKeyB64, id: 'r2', method: 'wallet_getAccounts' }),
      } as ProtocolMessage);
      expect(requestHandler).toHaveBeenCalledTimes(2);

      // seq=3 (below 5) -> dropped
      transport.receive({
        v: 1, t: 'req', ch: channelId,
        id: 'r3', from: dappKp.publicKeyB64,
        method: 'wallet_getAccounts',
        sealed: sealPayload(sessionKey, channelId, 3, {}, { type: 'req', from: dappKp.publicKeyB64, id: 'r3', method: 'wallet_getAccounts' }),
      } as ProtocolMessage);
      expect(requestHandler).toHaveBeenCalledTimes(2); // still 2
    });
  });

  // -----------------------------------------------------------------------
  // 4. Sequence persistence through serialize/restore
  // -----------------------------------------------------------------------
  describe('sequence persistence', () => {
    it('DAppSession: restored session rejects replayed seq numbers', async () => {
      const ctx = setupDAppWithManualWallet();
      const { transport, session, walletKp } = ctx;
      const { sessionKey } = await connectDAppManually(ctx);

      // Exchange messages to advance recvSeq to 2
      for (let seq = 0; seq <= 2; seq++) {
        const p = session.request('wallet_getAccounts');
        await wait(20);
        const reqs = transport.sent.filter(m => m.t === 'req');
        const req = reqs[reqs.length - 1] as any;

        transport.receive({
          v: 1, t: 'res', ch: session.channelId,
          id: req.id, from: walletKp.publicKeyB64,
          ok: true,
          sealed: sealPayload(sessionKey, session.channelId, seq, `result-${seq}`, { type: 'res', from: walletKp.publicKeyB64, id: req.id, ok: true }),
        } as ProtocolMessage);

        await p;
      }

      // Serialize and restore
      const json = session.serialize();
      const newTransport = new MockTransport();
      const restored = new DAppSession({ transport: newTransport });
      expect(restored.restore(json)).toBe(true);

      // Manually set phase to connected so we can send requests
      (restored as any).phase = 'connected';

      // Try sending a request and responding with old seq=1 -> should be rejected
      const p = restored.request('wallet_getAccounts');
      await wait(20);
      const reqMsg = newTransport.sent.find(m => m.t === 'req') as any;

      newTransport.receive({
        v: 1, t: 'res', ch: restored.channelId,
        id: reqMsg.id, from: walletKp.publicKeyB64,
        ok: true,
        sealed: sealPayload(sessionKey, restored.channelId, 1, 'stale', { type: 'res', from: walletKp.publicKeyB64, id: reqMsg.id, ok: true }),
      } as ProtocolMessage);

      await expect(p).rejects.toThrow('Replay detected');

      // seq=3 should be accepted
      const p2 = restored.request('wallet_getAccounts');
      await wait(20);
      const reqMsg2 = newTransport.sent.filter(m => m.t === 'req')[1] as any;

      newTransport.receive({
        v: 1, t: 'res', ch: restored.channelId,
        id: reqMsg2.id, from: walletKp.publicKeyB64,
        ok: true,
        sealed: sealPayload(sessionKey, restored.channelId, 3, 'fresh', { type: 'res', from: walletKp.publicKeyB64, id: reqMsg2.id, ok: true }),
      } as ProtocolMessage);

      expect(await p2).toBe('fresh');
    });

    it('WalletSession: restored session rejects replayed seq numbers', async () => {
      const ctx = setupWalletWithManualDApp();
      const { transport, session, dappKp, channelId } = ctx;
      const { sessionKey } = await connectWalletManually(ctx);

      const handler = vi.fn();
      session.on('request', handler);

      // Advance recvSeq to 2
      for (let seq = 0; seq <= 2; seq++) {
        transport.receive({
          v: 1, t: 'req', ch: channelId,
          id: `req-${seq}`, from: dappKp.publicKeyB64,
          method: 'wallet_getAccounts',
          sealed: sealPayload(sessionKey, channelId, seq, {}, { type: 'req', from: dappKp.publicKeyB64, id: `req-${seq}`, method: 'wallet_getAccounts' }),
        } as ProtocolMessage);
      }
      expect(handler).toHaveBeenCalledTimes(3);

      // Serialize and restore
      const json = session.serialize();
      const newTransport = new MockTransport();
      const restored = new WalletSession({
        transport: newTransport,
        capabilities: { methods: ['wallet_getAccounts'], events: [], chains: ['eip155:1'] },
      });
      expect(restored.restore(json)).toBe(true);

      const handler2 = vi.fn();
      restored.on('request', handler2);

      // Old seq=1 -> dropped
      newTransport.receive({
        v: 1, t: 'req', ch: channelId,
        id: 'replay-1', from: dappKp.publicKeyB64,
        method: 'wallet_getAccounts',
        sealed: sealPayload(sessionKey, channelId, 1, {}, { type: 'req', from: dappKp.publicKeyB64, id: 'replay-1', method: 'wallet_getAccounts' }),
      } as ProtocolMessage);
      expect(handler2).toHaveBeenCalledTimes(0);

      // seq=3 -> accepted
      newTransport.receive({
        v: 1, t: 'req', ch: channelId,
        id: 'fresh-3', from: dappKp.publicKeyB64,
        method: 'wallet_getAccounts',
        sealed: sealPayload(sessionKey, channelId, 3, {}, { type: 'req', from: dappKp.publicKeyB64, id: 'fresh-3', method: 'wallet_getAccounts' }),
      } as ProtocolMessage);
      expect(handler2).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // 5. Send sequence overflow
  // -----------------------------------------------------------------------
  describe('send sequence overflow', () => {
    it('DAppSession closes on send sequence overflow', async () => {
      const ctx = setupDAppWithManualWallet();
      const { transport, session } = ctx;
      await connectDAppManually(ctx);

      // Set sendSeq close to overflow: (2^32 - 1) - 1
      (session as any).sendSeq = 0xFFFF_FFFE;

      const errorHandler = vi.fn();
      session.on('error', errorHandler);

      // First request with params (triggers sendSeq increment): sendSeq goes to 0xFFFF_FFFF
      // This will be left pending and rejected when session closes, so catch it.
      const p1 = session.request('wallet_getAccounts', { test: true }).catch(() => {});
      await wait(20);
      // p1 was sent successfully (sendSeq was 0xFFFF_FFFE, used that, incremented to 0xFFFF_FFFF)

      // Second request with params: sendSeq would go from 0xFFFF_FFFF to 0 (overflow)
      const p2 = session.request('wallet_getAccounts', { test: true });
      await expect(p2).rejects.toThrow('Send sequence overflow');
      expect(errorHandler).toHaveBeenCalled();
      expect(session.phase).toBe('closed');
      await p1; // ensure the suppressed rejection is settled
    });

    it('WalletSession closes on send sequence overflow via approve', async () => {
      const ctx = setupWalletWithManualDApp();
      const { transport, session, dappKp, channelId } = ctx;
      await connectWalletManually(ctx);

      // Set sendSeq close to overflow
      (session as any).sendSeq = 0xFFFF_FFFE;

      const errorHandler = vi.fn();
      session.on('error', errorHandler);

      // First approve: sendSeq 0xFFFF_FFFE -> 0xFFFF_FFFF (ok)
      transport.receive({
        v: 1, t: 'req', ch: channelId,
        id: 'r1', from: dappKp.publicKeyB64,
        method: 'wallet_getAccounts',
      } as ProtocolMessage);
      session.approve('r1', ['0x123']);

      // sendSeq is now 0xFFFF_FFFF
      // Second approve: sendSeq 0xFFFF_FFFF -> 0 (overflow, session closes)
      transport.receive({
        v: 1, t: 'req', ch: channelId,
        id: 'r2', from: dappKp.publicKeyB64,
        method: 'wallet_getAccounts',
      } as ProtocolMessage);
      session.approve('r2', ['0x456']);

      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('Send sequence overflow'),
      }));
      expect(session.phase).toBe('closed');
    });

    it('WalletSession closes on send sequence overflow via pushEvent', async () => {
      const ctx = setupWalletWithManualDApp();
      const { session } = ctx;
      await connectWalletManually(ctx);

      (session as any).sendSeq = 0xFFFF_FFFE;

      const errorHandler = vi.fn();
      session.on('error', errorHandler);

      // First push: ok
      session.pushEvent('accountsChanged', { accounts: ['0xa'] });
      expect(session.phase).toBe('connected');

      // Second push: overflow
      session.pushEvent('accountsChanged', { accounts: ['0xb'] });
      expect(errorHandler).toHaveBeenCalled();
      expect(session.phase).toBe('closed');
    });
  });

  // -----------------------------------------------------------------------
  // 6. Pending accept timeout
  // -----------------------------------------------------------------------
  describe('pending accept timeout', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('auto-rejects wallet after 60s without acceptWallet()', async () => {
      const transport = new MockTransport();
      const session = new DAppSession({ transport, name: 'Test dApp' });
      const walletKp = generateX25519KeyPair();

      await session.createPairing();

      const errorHandler = vi.fn();
      session.on('error', errorHandler);

      // Simulate wallet join
      transport.receive({
        v: 1, t: 'join', ch: session.channelId,
        from: walletKp.publicKeyB64, pubkey: walletKp.publicKeyB64,
        capabilities: { methods: ['wallet_getAccounts'], events: [], chains: ['eip155:1'] },
      } as ProtocolMessage);

      expect(session.phase).toBe('pending_accept');

      // Advance time past 60s timeout
      vi.advanceTimersByTime(61_000);

      // Should have emitted error and closed
      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('timed out'),
      }));
      expect(session.phase).toBe('closed');

      // Should have sent a close message with user_rejected
      const closeMsg = transport.sent.find(m => m.t === 'close');
      expect(closeMsg).toBeTruthy();
      expect((closeMsg as any).reason).toBe('user_rejected');
    });

    it('does not timeout if acceptWallet() is called in time', async () => {
      const transport = new MockTransport();
      const session = new DAppSession({ transport, name: 'Test dApp' });
      const walletKp = generateX25519KeyPair();

      await session.createPairing();

      transport.receive({
        v: 1, t: 'join', ch: session.channelId,
        from: walletKp.publicKeyB64, pubkey: walletKp.publicKeyB64,
        capabilities: { methods: ['wallet_getAccounts'], events: [], chains: ['eip155:1'] },
      } as ProtocolMessage);

      expect(session.phase).toBe('pending_accept');

      // Accept within timeout
      session.acceptWallet();

      // Advance past the timeout
      vi.advanceTimersByTime(61_000);

      // Should NOT be closed — should still be waiting for ready.connected
      expect(session.phase).not.toBe('closed');
    });
  });

  // -----------------------------------------------------------------------
  // 7. Capabilities validation
  // -----------------------------------------------------------------------
  describe('capabilities validation', () => {
    it('rejects join with capabilities.methods not an array', async () => {
      const transport = new MockTransport();
      const session = new DAppSession({ transport, name: 'Test dApp' });
      const walletKp = generateX25519KeyPair();

      await session.createPairing();

      const errorHandler = vi.fn();
      session.on('error', errorHandler);

      transport.receive({
        v: 1, t: 'join', ch: session.channelId,
        from: walletKp.publicKeyB64, pubkey: walletKp.publicKeyB64,
        capabilities: { methods: 'not-an-array', events: [], chains: [] },
      } as unknown as ProtocolMessage);

      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('Malformed wallet capabilities'),
      }));

      // Should have sent a close with protocol_error
      const closeMsg = transport.sent.find(m => m.t === 'close');
      expect(closeMsg).toBeTruthy();
      expect((closeMsg as any).reason).toBe('protocol_error');

      // Should NOT have transitioned to pending_accept
      expect(session.phase).not.toBe('pending_accept');
    });

    it('rejects join with capabilities as non-object', async () => {
      const transport = new MockTransport();
      const session = new DAppSession({ transport, name: 'Test dApp' });
      const walletKp = generateX25519KeyPair();

      await session.createPairing();

      const errorHandler = vi.fn();
      session.on('error', errorHandler);

      transport.receive({
        v: 1, t: 'join', ch: session.channelId,
        from: walletKp.publicKeyB64, pubkey: walletKp.publicKeyB64,
        capabilities: 'invalid',
      } as unknown as ProtocolMessage);

      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('Malformed wallet capabilities'),
      }));
    });

    it('accepts join with valid capabilities', async () => {
      const transport = new MockTransport();
      const session = new DAppSession({ transport, name: 'Test dApp' });
      const walletKp = generateX25519KeyPair();

      await session.createPairing();

      transport.receive({
        v: 1, t: 'join', ch: session.channelId,
        from: walletKp.publicKeyB64, pubkey: walletKp.publicKeyB64,
        capabilities: { methods: ['wallet_getAccounts'], events: ['accountsChanged'], chains: ['eip155:1'] },
      } as ProtocolMessage);

      expect(session.phase).toBe('pending_accept');
      expect(session.walletCapabilities).toEqual({
        methods: ['wallet_getAccounts'],
        events: ['accountsChanged'],
        chains: ['eip155:1'],
      });
    });

    it('accepts join with null/undefined capabilities (optional field)', async () => {
      const transport = new MockTransport();
      const session = new DAppSession({ transport, name: 'Test dApp' });
      const walletKp = generateX25519KeyPair();

      await session.createPairing();

      // capabilities omitted entirely — the validateCapabilities check only
      // runs when capabilities != null, so omitting it should be fine
      transport.receive({
        v: 1, t: 'join', ch: session.channelId,
        from: walletKp.publicKeyB64, pubkey: walletKp.publicKeyB64,
      } as ProtocolMessage);

      expect(session.phase).toBe('pending_accept');
    });

    it('rejects join with capabilities missing events array', async () => {
      const transport = new MockTransport();
      const session = new DAppSession({ transport, name: 'Test dApp' });
      const walletKp = generateX25519KeyPair();

      await session.createPairing();

      const errorHandler = vi.fn();
      session.on('error', errorHandler);

      transport.receive({
        v: 1, t: 'join', ch: session.channelId,
        from: walletKp.publicKeyB64, pubkey: walletKp.publicKeyB64,
        capabilities: { methods: ['wallet_getAccounts'], chains: ['eip155:1'] },
      } as ProtocolMessage);

      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('Malformed wallet capabilities'),
      }));
    });
  });
});
