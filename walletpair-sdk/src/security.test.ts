/**
 * Security tests for WalletPair SDK.
 *
 * Covers: replay detection, AAD tampering, ciphertext tampering, wrong key,
 * sequence overflow, mandatory encryption enforcement, and key isolation
 * across sessions.
 */

import { describe, it, expect, vi } from 'vitest';
import { DAppSession } from './dapp-session.js';
import { WalletSession } from './wallet-session.js';
import { makeJoinBody, MockTransport, MockRelay } from './test-helpers.js';
import {
  generateX25519KeyPair,
  generateChannelId,
  computeSharedSecret,
  deriveSessionKey,
  sealPayload,
  unsealPayload,
  b64urlEncode,
  b64urlDecode,
  bytesToHex,
  buildPairingUri,
} from './crypto.js';
import { deriveDirectionalSessionKeys } from './crypto.js';
import type { SessionCryptoContext } from './crypto.js';
import type { ProtocolMessage } from './types.js';

function wait(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Helpers to set up sessions with manual control
// ---------------------------------------------------------------------------

function setupDAppManual() {
  const transport = new MockTransport();
  const session = new DAppSession({ transport, meta: { name: 'Test', description: 'Test dApp', url: 'https://test.com', icon: 'https://test.com/icon.png' } });
  const walletKp = generateX25519KeyPair();
  return { transport, session, walletKp };
}

async function connectDAppManual(ctx: ReturnType<typeof setupDAppManual>) {
  const { transport, session, walletKp } = ctx;
  await session.createPairing();

  transport.receive({
    v: 1, t: 'join', ch: session.channelId,
    ts: Date.now(), from: walletKp.publicKeyB64,
    body: makeJoinBody(session.channelId, transport.sent[0]!.from!, walletKp),
  } as ProtocolMessage);

  transport.receive({
    v: 1, t: 'ready', ch: session.channelId,
    ts: Date.now(), from: '_adapter',
    body: { state: 'connected', resume: 'tok', remote: walletKp.publicKeyB64 },
  } as ProtocolMessage);

  // Derive the wallet's send key (walletToDappKey) which is what
  // the DAppSession expects to receive (its recvKey).
  const recvKey = (session as any).recvKey as Uint8Array;
  const dappPubB64 = transport.sent[0]!.from!;
  return { recvKey, dappPubB64 };
}

function setupWalletManual() {
  const transport = new MockTransport();
  const dappKp = generateX25519KeyPair();
  const channelId = generateChannelId();
  const session = new WalletSession({
    transport,
    meta: { name: 'Test Wallet', description: 'Test wallet', url: 'https://wallet.test', icon: 'https://wallet.test/icon.png' },
    capabilities: { methods: ['wallet_getAccounts'], events: [], chains: ['eip155:1'] },
  });
  return { transport, session, dappKp, channelId };
}

async function connectWalletManual(ctx: ReturnType<typeof setupWalletManual>) {
  const { transport, session, dappKp, channelId } = ctx;
  const uri = buildPairingUri({ channelId, pubkeyB64: dappKp.publicKeyB64, relayUrl: 'ws://localhost/v1' });
  await session.joinFromUri(uri);

  transport.receive({
    v: 1, t: 'ready', ch: channelId,
    ts: Date.now(), from: '_adapter',
    body: { state: 'connected', resume: 'tok', remote: dappKp.publicKeyB64 },
  } as ProtocolMessage);

  // The wallet's recvKey is dappToWalletKey
  const recvKey = (session as any).recvKey as Uint8Array;
  const walletPubB64 = transport.sent.find(m => m.t === 'join')!.from!;
  return { recvKey, walletPubB64 };
}

// ---------------------------------------------------------------------------
// Tests: Replay detection
// ---------------------------------------------------------------------------

describe('Security: Replay detection', () => {

  it('same sequence number is rejected', async () => {
    const ctx = setupDAppManual();
    const { transport, session, walletKp } = ctx;
    const { recvKey } = await connectDAppManual(ctx);

    // First request -> seq=0 response accepted
    const p0 = session.request('wallet_getAccounts');
    await wait(20);
    const req0 = transport.sent.find(m => m.t === 'req') as any;
    const req0Id = req0.body.id;

    transport.receive({
      v: 1, t: 'res', ch: session.channelId,
      ts: Date.now(), from: walletKp.publicKeyB64,
      body: { id: req0Id, sealed: sealPayload(recvKey, session.channelId, 0, { _ok: true, _result: ['0xa'] },
        { type: 'res', from: walletKp.publicKeyB64, id: req0Id }) },
    } as ProtocolMessage);
    expect(await p0).toEqual(['0xa']);

    // Second request -> seq=0 again (replay) must be rejected
    const p1 = session.request('wallet_getAccounts');
    await wait(20);
    const req1 = transport.sent.filter(m => m.t === 'req')[1] as any;
    const req1Id = req1.body.id;

    transport.receive({
      v: 1, t: 'res', ch: session.channelId,
      ts: Date.now(), from: walletKp.publicKeyB64,
      body: { id: req1Id, sealed: sealPayload(recvKey, session.channelId, 0, { _ok: true, _result: ['replay'] },
        { type: 'res', from: walletKp.publicKeyB64, id: req1Id }) },
    } as ProtocolMessage);
    await expect(p1).rejects.toThrow('Replay detected');
  });

  it('lower sequence number is rejected', async () => {
    const ctx = setupDAppManual();
    const { transport, session, walletKp } = ctx;
    const { recvKey } = await connectDAppManual(ctx);

    // seq=5 accepted
    const p0 = session.request('wallet_getAccounts');
    await wait(20);
    const req0 = transport.sent.find(m => m.t === 'req') as any;
    const r0id = req0.body.id;
    transport.receive({
      v: 1, t: 'res', ch: session.channelId,
      ts: Date.now(), from: walletKp.publicKeyB64,
      body: { id: r0id, sealed: sealPayload(recvKey, session.channelId, 5, { _ok: true, _result: 'ok' },
        { type: 'res', from: walletKp.publicKeyB64, id: r0id }) },
    } as ProtocolMessage);
    expect(await p0).toBe('ok');

    // seq=3 (lower) must be rejected
    const p1 = session.request('wallet_getAccounts');
    await wait(20);
    const req1 = transport.sent.filter(m => m.t === 'req')[1] as any;
    const r1id = req1.body.id;
    transport.receive({
      v: 1, t: 'res', ch: session.channelId,
      ts: Date.now(), from: walletKp.publicKeyB64,
      body: { id: r1id, sealed: sealPayload(recvKey, session.channelId, 3, { _ok: true, _result: 'stale' },
        { type: 'res', from: walletKp.publicKeyB64, id: r1id }) },
    } as ProtocolMessage);
    await expect(p1).rejects.toThrow('Replay detected');
  });

  it('higher sequence number is accepted', async () => {
    const ctx = setupDAppManual();
    const { transport, session, walletKp } = ctx;
    const { recvKey } = await connectDAppManual(ctx);

    // seq=0 accepted
    const p0 = session.request('wallet_getAccounts');
    await wait(20);
    const req0 = transport.sent.find(m => m.t === 'req') as any;
    const r0id = req0.body.id;
    transport.receive({
      v: 1, t: 'res', ch: session.channelId,
      ts: Date.now(), from: walletKp.publicKeyB64,
      body: { id: r0id, sealed: sealPayload(recvKey, session.channelId, 0, { _ok: true, _result: 'first' },
        { type: 'res', from: walletKp.publicKeyB64, id: r0id }) },
    } as ProtocolMessage);
    expect(await p0).toBe('first');

    // seq=10 (higher) accepted
    const p1 = session.request('wallet_getAccounts');
    await wait(20);
    const req1 = transport.sent.filter(m => m.t === 'req')[1] as any;
    const r1id = req1.body.id;
    transport.receive({
      v: 1, t: 'res', ch: session.channelId,
      ts: Date.now(), from: walletKp.publicKeyB64,
      body: { id: r1id, sealed: sealPayload(recvKey, session.channelId, 10, { _ok: true, _result: 'second' },
        { type: 'res', from: walletKp.publicKeyB64, id: r1id }) },
    } as ProtocolMessage);
    expect(await p1).toBe('second');
  });
});

// ---------------------------------------------------------------------------
// Tests: AAD tampering
// ---------------------------------------------------------------------------

describe('Security: AAD tampering', () => {

  it('tampered AAD (wrong id) causes decryption failure', () => {
    const key = new Uint8Array(32);
    crypto.getRandomValues(key);
    const channelId = generateChannelId();

    const hdr = { type: 'req' as const, from: 'dapp', id: 'req-1' };
    const sealed = sealPayload(key, channelId, 0, { foo: 'bar' }, hdr);

    const tamperedHdr = { ...hdr, id: 'req-999' };
    expect(() => unsealPayload(key, channelId, sealed, tamperedHdr)).toThrow();
  });

  it('tampered AAD (wrong from) causes decryption failure', () => {
    const key = new Uint8Array(32);
    crypto.getRandomValues(key);
    const channelId = generateChannelId();

    const hdr = { type: 'req' as const, from: 'dapp', id: 'req-1' };
    const sealed = sealPayload(key, channelId, 0, {}, hdr);

    const tamperedHdr = { ...hdr, from: 'evil-relay' };
    expect(() => unsealPayload(key, channelId, sealed, tamperedHdr)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: Ciphertext and key tampering
// ---------------------------------------------------------------------------

describe('Security: Ciphertext and key tampering', () => {

  it('tampered ciphertext causes decryption failure', () => {
    const key = new Uint8Array(32);
    crypto.getRandomValues(key);
    const channelId = generateChannelId();

    const hdr = { type: 'req' as const, from: 'dapp', id: 'req-1' };
    const sealed = sealPayload(key, channelId, 0, { secret: true }, hdr);

    // Decode, flip a byte in the ciphertext, re-encode
    const bytes = b64urlDecode(sealed);
    bytes[10] = bytes[10]! ^ 0xff;
    const tampered = b64urlEncode(bytes);

    expect(() => unsealPayload(key, channelId, tampered, hdr)).toThrow();
  });

  it('wrong key causes decryption failure', () => {
    const key = new Uint8Array(32);
    crypto.getRandomValues(key);
    const wrongKey = new Uint8Array(32);
    crypto.getRandomValues(wrongKey);
    const channelId = generateChannelId();

    const sealed = sealPayload(key, channelId, 0, { data: 'test' });
    expect(() => unsealPayload(wrongKey, channelId, sealed)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: Sequence overflow closes session
// ---------------------------------------------------------------------------

describe('Security: Sequence overflow', () => {

  it('DAppSession: overflow at MAX_SEND_SEQ causes session close', async () => {
    const ctx = setupDAppManual();
    const { session } = ctx;
    await connectDAppManual(ctx);

    (session as any).sendSeq = 2 ** 31;

    const errorHandler = vi.fn();
    session.on('error', errorHandler);

    await expect(session.request('wallet_getAccounts')).rejects.toThrow('Send sequence overflow');
    expect(errorHandler).toHaveBeenCalled();
    expect(session.phase).toBe('closed');
  });

  it('WalletSession: overflow at MAX_SEND_SEQ causes session close via pushEvent', async () => {
    const ctx = setupWalletManual();
    const { session } = ctx;
    await connectWalletManual(ctx);

    (session as any).sendSeq = 2 ** 31 - 1;

    const errorHandler = vi.fn();
    session.on('error', errorHandler);

    // Last allowed
    session.pushEvent('accountsChanged', { accounts: ['0xa'] });
    expect(session.phase).toBe('connected');

    // Overflow
    session.pushEvent('accountsChanged', { accounts: ['0xb'] });
    expect(errorHandler).toHaveBeenCalled();
    expect(session.phase).toBe('closed');
  });
});

// ---------------------------------------------------------------------------
// Tests: Mandatory encryption enforcement
// ---------------------------------------------------------------------------

describe('Security: Mandatory encryption', () => {

  it('DAppSession rejects unsealed responses', async () => {
    const ctx = setupDAppManual();
    const { transport, session, walletKp } = ctx;
    await connectDAppManual(ctx);

    const p = session.request('wallet_getAccounts');
    await wait(20);
    const req = transport.sent.find(m => m.t === 'req') as any;
    const reqId = req.body.id;

    // Send a response without sealed field
    transport.receive({
      v: 1, t: 'res', ch: session.channelId,
      ts: Date.now(), from: walletKp.publicKeyB64,
      body: { id: reqId },
      // no sealed field in body
    } as ProtocolMessage);

    await expect(p).rejects.toThrow('Response must be encrypted');
  });

  it('WalletSession rejects unsealed requests', async () => {
    const ctx = setupWalletManual();
    const { transport, session, dappKp, channelId } = ctx;
    await connectWalletManual(ctx);

    const requestHandler = vi.fn();
    session.on('request', requestHandler);

    // Send a request without sealed field in body
    transport.receive({
      v: 1, t: 'req', ch: channelId,
      ts: Date.now(), from: dappKp.publicKeyB64,
      body: { id: 'req-unseal' },
      // no sealed field
    } as ProtocolMessage);

    // The request handler should NOT be called
    expect(requestHandler).not.toHaveBeenCalled();

    // Wallet should have sent a rejection response
    const rejectionMsg = transport.sent.find(m => m.t === 'res' && (m as any).body?.id === 'req-unseal') as any;
    expect(rejectionMsg).toBeTruthy();
    // ok no longer exists on wire body
  });

  it('DAppSession drops unsealed events', async () => {
    const ctx = setupDAppManual();
    const { transport, session, walletKp } = ctx;
    await connectDAppManual(ctx);

    const eventHandler = vi.fn();
    session.on('event', eventHandler);

    // Send an event without sealed field in body
    transport.receive({
      v: 1, t: 'evt', ch: session.channelId,
      ts: Date.now(), from: walletKp.publicKeyB64,
      body: { id: 'evt-1' },
      // no sealed field
    } as ProtocolMessage);

    await wait(20);
    expect(eventHandler).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: Key isolation across sessions
// ---------------------------------------------------------------------------

describe('Security: Key isolation across sessions', () => {

  it('session key changes if wallet pubkey changes (no key reuse)', async () => {
    const dappKp = generateX25519KeyPair();
    const channelId = generateChannelId();

    // First wallet
    const wallet1 = generateX25519KeyPair();
    const shared1 = computeSharedSecret(dappKp.privateKey, wallet1.publicKey);
    const root1 = deriveSessionKey(shared1, channelId);
    const ctx1: SessionCryptoContext = {
      dappPubKeyB64: dappKp.publicKeyB64,
      walletPubKeyB64: wallet1.publicKeyB64,
      capabilities: null,
      walletMeta: null,
      dappName: 'App',
    };
    const keys1 = deriveDirectionalSessionKeys(root1, channelId, ctx1);

    // Second wallet (different pubkey)
    const wallet2 = generateX25519KeyPair();
    const shared2 = computeSharedSecret(dappKp.privateKey, wallet2.publicKey);
    const root2 = deriveSessionKey(shared2, channelId);
    const ctx2: SessionCryptoContext = {
      dappPubKeyB64: dappKp.publicKeyB64,
      walletPubKeyB64: wallet2.publicKeyB64,
      capabilities: null,
      walletMeta: null,
      dappName: 'App',
    };
    const keys2 = deriveDirectionalSessionKeys(root2, channelId, ctx2);

    // All keys must differ
    expect(bytesToHex(keys1.dappToWalletKey)).not.toBe(bytesToHex(keys2.dappToWalletKey));
    expect(bytesToHex(keys1.walletToDappKey)).not.toBe(bytesToHex(keys2.walletToDappKey));
    expect(bytesToHex(keys1.rootKey)).not.toBe(bytesToHex(keys2.rootKey));
    expect(bytesToHex(keys1.transcriptHash)).not.toBe(bytesToHex(keys2.transcriptHash));
  });
});
