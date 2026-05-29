/**
 * Adversarial tests: Malicious Relay
 *
 * Simulates a compromised relay attempting to break WalletPair protocol
 * security guarantees. The relay sees routing metadata (ch, from, t, ts)
 * but MUST NOT be able to read, forge, or replay application data.
 *
 * Threat model reference: Protocol spec Section 19.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  buildPairingUri,
  generateChannelId,
  generateX25519KeyPair,
  sealPayload,
} from '../../crypto.js'
import { DAppSession } from '../../dapp-session.js'
import { MockTransport, makeJoinBody, makeSealedJoin } from '../../test-helpers.js'
import type { CloseMessage, ProtocolMessage, RequestMessage } from '../../types.js'
import { WalletSession } from '../../wallet-session.js'

function wait(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ---------------------------------------------------------------------------
// Helpers for manual session setup (from security.test.ts patterns)
// ---------------------------------------------------------------------------

function setupDAppManual() {
  const transport = new MockTransport()
  const session = new DAppSession({
    transport,
    meta: {
      name: 'Test',
      description: 'Test dApp',
      url: 'https://test.com',
      icon: 'https://test.com/icon.png',
    },
  })
  const walletKp = generateX25519KeyPair()
  return { transport, session, walletKp }
}

async function connectDAppManual(ctx: ReturnType<typeof setupDAppManual>) {
  const { transport, session, walletKp } = ctx
  await session.createPairing()

  transport.receive({
    v: 1,
    t: 'join',
    ch: session.channelId,
    ts: Date.now(),
    from: walletKp.publicKeyB64,
    body: makeJoinBody(session.channelId, transport.sent[0]?.from ?? '', walletKp),
  } as ProtocolMessage)

  transport.receive({
    v: 1,
    t: 'ready',
    ch: session.channelId,
    ts: Date.now(),
    from: '_adapter',
    body: { state: 'connected', reconnect: false, remote: walletKp.publicKeyB64 },
  } as ProtocolMessage)

  const recvKey = (session as unknown as Record<string, unknown>).recvKey as Uint8Array
  const dappPubB64 = transport.sent[0]?.from ?? ''
  return { recvKey, dappPubB64 }
}

// ---------------------------------------------------------------------------
// Attack 1: Relay substitutes wallet public key in forwarded join
// ---------------------------------------------------------------------------

describe('Malicious Relay: Public key substitution in join', () => {
  it('sealed_join decryption fails when relay substitutes a different wallet key', async () => {
    // ATTACK: A compromised relay intercepts the wallet's join message and
    // replaces the "from" field with the relay's own key pair. The relay
    // hopes the dApp will derive keys with the relay's key instead of the
    // real wallet's key. However, the sealed_join was encrypted using the
    // wallet's private key + dApp's public key, so the dApp will fail to
    // decrypt it when using the relay's substituted key.
    //
    // PREVENTS: Man-in-the-middle — relay cannot impersonate the wallet
    // because sealed_join is bound to the wallet's key pair.

    const transport = new MockTransport()
    const session = new DAppSession({
      transport,
      meta: {
        name: 'Test',
        description: 'Test',
        url: 'https://test.com',
        icon: 'https://test.com/icon.png',
      },
      autoAccept: true,
    })

    const errorHandler = vi.fn()
    session.on('error', errorHandler)

    await session.createPairing()
    const dappPubB64 = transport.sent[0]?.from ?? ''

    // Real wallet generates sealed_join with its own key pair
    const realWalletKp = generateX25519KeyPair()
    const sealedJoin = makeSealedJoin(session.channelId, dappPubB64, realWalletKp)

    // Relay substitutes a DIFFERENT key in the "from" field
    const relayFakeKp = generateX25519KeyPair()

    transport.receive({
      v: 1,
      t: 'join',
      ch: session.channelId,
      ts: Date.now(),
      from: relayFakeKp.publicKeyB64, // substituted key!
      body: { sealed_join: sealedJoin }, // sealed with real wallet's key
    } as ProtocolMessage)

    await wait()

    // DApp should fail to decrypt sealed_join because it derives keys
    // using the fake relay key, which doesn't match the sealed_join
    expect(errorHandler).toHaveBeenCalled()
    const errorMsg = errorHandler.mock.calls[0]?.[0]?.message
    expect(errorMsg).toContain('decrypt')

    // DApp should have sent close with decryption_failed
    const closeMsg = transport.sent.find((m) => m.t === 'close') as CloseMessage | undefined
    expect(closeMsg).toBeTruthy()
    expect(closeMsg?.body.reason).toBe('decryption_failed')
  })
})

// ---------------------------------------------------------------------------
// Attack 2: Relay replays an old sealed message
// ---------------------------------------------------------------------------

describe('Malicious Relay: Message replay', () => {
  it('replayed sealed response with old seq is rejected', async () => {
    // ATTACK: Relay captures a valid encrypted response and replays it
    // later, hoping to cause duplicate action processing. The sequence
    // number in the sealed envelope prevents this — once a sequence
    // number is accepted, any message with equal or lower seq is rejected.
    //
    // PREVENTS: Replay attacks that could cause duplicate signing or
    // duplicate transaction submission.

    const ctx = setupDAppManual()
    const { transport, session, walletKp } = ctx
    const { recvKey } = await connectDAppManual(ctx)

    // First request succeeds with seq=0
    const p0 = session.request('wallet_getAccounts')
    await wait(20)
    const req0 = transport.sent.find((m) => m.t === 'req') as RequestMessage | undefined
    const req0Id = req0?.body.id ?? ''

    const validSealed = sealPayload(
      recvKey,
      session.channelId,
      0,
      { _ok: true, _result: ['0xAddr'] },
      { type: 'res', from: walletKp.publicKeyB64, id: req0Id },
    )

    transport.receive({
      v: 1,
      t: 'res',
      ch: session.channelId,
      ts: Date.now(),
      from: walletKp.publicKeyB64,
      body: { id: req0Id, sealed: validSealed },
    } as ProtocolMessage)
    expect(await p0).toEqual(['0xAddr'])

    // Second request: relay replays the SAME sealed payload (seq=0)
    const p1 = session.request('wallet_getAccounts')
    await wait(20)
    const req1 = transport.sent.filter((m) => m.t === 'req')[1] as RequestMessage | undefined
    const req1Id = req1?.body.id ?? ''

    // Relay creates a new envelope but copies the old sealed (seq=0)
    // Note: the AAD won't match because id differs, so it fails at AEAD level.
    // For a more precise replay, the relay would need the same req.id which
    // the idempotency cache would handle. Either way, the attack fails.
    transport.receive({
      v: 1,
      t: 'res',
      ch: session.channelId,
      ts: Date.now(),
      from: walletKp.publicKeyB64,
      body: {
        id: req1Id,
        sealed: sealPayload(
          recvKey,
          session.channelId,
          0, // replayed seq=0
          { _ok: true, _result: ['0xAddr'] },
          { type: 'res', from: walletKp.publicKeyB64, id: req1Id },
        ),
      },
    } as ProtocolMessage)
    await expect(p1).rejects.toThrow('Replay detected')
  })

  it('replayed event with old seq is silently dropped', async () => {
    // ATTACK: Relay replays a previously captured event to confuse the dApp.
    //
    // PREVENTS: Stale event injection.

    const ctx = setupDAppManual()
    const { transport, session, walletKp } = ctx
    const { recvKey } = await connectDAppManual(ctx)

    const eventHandler = vi.fn()
    session.on('event', eventHandler)

    // First event at seq=0 accepted
    transport.receive({
      v: 1,
      t: 'evt',
      ch: session.channelId,
      ts: Date.now(),
      from: walletKp.publicKeyB64,
      body: {
        id: 'evt-1',
        sealed: sealPayload(
          recvKey,
          session.channelId,
          0,
          { _event: 'accountsChanged', accounts: ['0xA'] },
          { type: 'evt', from: walletKp.publicKeyB64, id: 'evt-1' },
        ),
      },
    } as ProtocolMessage)
    await wait()
    expect(eventHandler).toHaveBeenCalledTimes(1)

    // Replay same seq=0 — should be silently dropped
    transport.receive({
      v: 1,
      t: 'evt',
      ch: session.channelId,
      ts: Date.now(),
      from: walletKp.publicKeyB64,
      body: {
        id: 'evt-replay',
        sealed: sealPayload(
          recvKey,
          session.channelId,
          0,
          { _event: 'accountsChanged', accounts: ['0xEvil'] },
          { type: 'evt', from: walletKp.publicKeyB64, id: 'evt-replay' },
        ),
      },
    } as ProtocolMessage)
    await wait()
    expect(eventHandler).toHaveBeenCalledTimes(1) // still 1, replay dropped
  })
})

// ---------------------------------------------------------------------------
// Attack 3: Relay reflects dApp's own message back as wallet message
// ---------------------------------------------------------------------------

describe('Malicious Relay: Reflection attack', () => {
  it('reflecting req back as res fails because directional keys differ', async () => {
    // ATTACK: Relay captures a dApp req (encrypted with dappToWalletKey)
    // and sends it back to the dApp as if it were a res from the wallet.
    // Because dApp decrypts responses with walletToDappKey (different from
    // dappToWalletKey), AEAD decryption will fail.
    //
    // PREVENTS: Reflection attacks where the relay bounces a peer's own
    // messages back — directional keys ensure each direction uses a
    // unique key (Section 6.2).

    const ctx = setupDAppManual()
    const { transport, session, walletKp } = ctx
    await connectDAppManual(ctx)

    const p = session.request('wallet_getAccounts')
    await wait(20)

    // Capture the outbound req
    const reqMsg = transport.sent.find((m) => m.t === 'req') as RequestMessage | undefined
    const reqId = reqMsg?.body.id ?? ''
    const reqSealed = reqMsg?.body.sealed ?? ''

    // Relay reflects the req's sealed payload back as a res
    transport.receive({
      v: 1,
      t: 'res',
      ch: session.channelId,
      ts: Date.now(),
      from: walletKp.publicKeyB64,
      body: { id: reqId, sealed: reqSealed }, // reflected sealed!
    } as ProtocolMessage)

    // Decryption must fail — dApp uses walletToDappKey to decrypt res,
    // but the sealed payload was encrypted with dappToWalletKey
    await expect(p).rejects.toThrow('Decryption failed')
  })
})

// ---------------------------------------------------------------------------
// Attack 4: Relay sends terminate with fake reasons (DoS)
// ---------------------------------------------------------------------------

describe('Malicious Relay: Fake terminate', () => {
  it('terminate from relay closes session but does not compromise data', async () => {
    // ATTACK: A malicious relay sends terminate messages to disrupt
    // the session. This is a DoS attack — the relay can always do this
    // since it controls transport. The protocol acknowledges this
    // (Section 19.5) and ensures no data compromise occurs.
    //
    // PREVENTS: Nothing — this is an inherent DoS vector. But we verify
    // the session transitions cleanly to closed state without leaking
    // any key material or corrupting state.

    const ctx = setupDAppManual()
    const { transport, session } = ctx
    await connectDAppManual(ctx)

    expect(session.phase).toBe('connected')

    // Relay sends a fake terminate
    transport.receive({
      v: 1,
      t: 'terminate',
      ch: session.channelId,
      ts: Date.now(),
      from: '_adapter',
      body: { reason: 'rate_limited' },
    } as ProtocolMessage)

    expect(session.phase).toBe('closed')
  })

  it('terminate does not prevent session from being properly destroyed', async () => {
    const ctx = setupDAppManual()
    const { transport, session } = ctx
    await connectDAppManual(ctx)

    transport.receive({
      v: 1,
      t: 'terminate',
      ch: session.channelId,
      ts: Date.now(),
      from: '_adapter',
      body: { reason: 'timeout' },
    } as ProtocolMessage)

    // Should not throw — session should be cleanly closeable
    expect(() => session.destroy()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Attack 5: Relay drops accept -> dApp times out
// ---------------------------------------------------------------------------

describe('Malicious Relay: Dropped accept', () => {
  it('dApp does not hang indefinitely when relay drops accept (relay never sends ready.connected)', async () => {
    // ATTACK: Relay receives accept from dApp but never forwards
    // ready.connected to either peer. The dApp must not hang forever.
    //
    // PREVENTS: Session hang from a relay that silently drops messages.
    // The dApp should time out from pending_accept phase.

    const transport = new MockTransport()
    const session = new DAppSession({
      transport,
      meta: {
        name: 'Test',
        description: 'Test',
        url: 'https://test.com',
        icon: 'https://test.com/icon.png',
      },
      autoAccept: true,
      requestTimeout: 200, // short timeout for test
    })

    await session.createPairing()
    const dappPubB64 = transport.sent[0]?.from ?? ''

    const walletKp = generateX25519KeyPair()

    // Wallet joins
    transport.receive({
      v: 1,
      t: 'join',
      ch: session.channelId,
      ts: Date.now(),
      from: walletKp.publicKeyB64,
      body: makeJoinBody(session.channelId, dappPubB64, walletKp),
    } as ProtocolMessage)

    await wait()
    // dApp auto-accepts and sends accept message
    const acceptMsg = transport.sent.find((m) => m.t === 'accept')
    expect(acceptMsg).toBeTruthy()

    // But relay NEVER sends ready.connected
    // Session should still be in pending_accept, not connected
    // Trying to send a request while not connected should fail immediately
    await expect(session.request('wallet_getAccounts')).rejects.toThrow('Not connected')
  })
})

// ---------------------------------------------------------------------------
// Attack 6: Relay sends ready.connected with wrong remote key
// ---------------------------------------------------------------------------

describe('Malicious Relay: Wrong remote key in ready.connected', () => {
  it('dApp rejects ready.connected when remote does not match paired wallet', async () => {
    // ATTACK: Relay sends ready.connected but with a different key in
    // the "remote" field, trying to trick the dApp into thinking a
    // different wallet connected. Section 15 rule 15 requires peers
    // to reject ready.connected if remote doesn't match the handshake.
    //
    // PREVENTS: Relay routing a different peer into an established
    // handshake after the key exchange has already occurred.

    const ctx = setupDAppManual()
    const { transport, session, walletKp } = ctx

    await session.createPairing()
    const dappPubB64 = transport.sent[0]?.from ?? ''

    // Wallet joins — dApp derives keys using walletKp
    transport.receive({
      v: 1,
      t: 'join',
      ch: session.channelId,
      ts: Date.now(),
      from: walletKp.publicKeyB64,
      body: makeJoinBody(session.channelId, dappPubB64, walletKp),
    } as ProtocolMessage)

    await wait()

    const errorHandler = vi.fn()
    session.on('error', errorHandler)

    // Relay sends ready.connected with a DIFFERENT remote key
    const fakeRemoteKp = generateX25519KeyPair()
    transport.receive({
      v: 1,
      t: 'ready',
      ch: session.channelId,
      ts: Date.now(),
      from: '_adapter',
      body: { state: 'connected', reconnect: false, remote: fakeRemoteKp.publicKeyB64 },
    } as ProtocolMessage)

    await wait()

    // DApp should reject and close
    expect(errorHandler).toHaveBeenCalled()
    expect(errorHandler.mock.calls[0]?.[0]?.message).toContain('remote does not match')
    expect(session.phase).toBe('closed')
  })

  it('wallet rejects ready.connected when remote does not match paired dApp', async () => {
    // Same attack from the wallet side: relay lies about who the remote is.

    const transport = new MockTransport()
    const dappKp = generateX25519KeyPair()
    const channelId = generateChannelId()

    const session = new WalletSession({
      transport,
      meta: { name: 'W', description: 'W', url: 'https://w.test', icon: 'https://w.test/i.png' },
      capabilities: { methods: ['wallet_getAccounts'], events: [], chains: ['eip155:1'] },
    })

    const uri = buildPairingUri({
      channelId,
      pubkeyB64: dappKp.publicKeyB64,
      relayUrl: 'ws://localhost/v1',
      name: 'D',
      url: 'https://d.test',
      icon: 'https://d.test/i.png',
    })
    await session.joinFromUri(uri)

    const errorHandler = vi.fn()
    session.on('error', errorHandler)

    // Relay sends ready.connected with wrong remote
    const fakeKp = generateX25519KeyPair()
    transport.receive({
      v: 1,
      t: 'ready',
      ch: channelId,
      ts: Date.now(),
      from: '_adapter',
      body: { state: 'connected', reconnect: false, remote: fakeKp.publicKeyB64 },
    } as ProtocolMessage)

    await wait()

    expect(errorHandler).toHaveBeenCalled()
    expect(errorHandler.mock.calls[0]?.[0]?.message).toContain('remote does not match')
    expect(session.phase).toBe('closed')
  })
})

// ---------------------------------------------------------------------------
// Attack 7: Relay forges ping/pong with fake from
// ---------------------------------------------------------------------------

describe('Malicious Relay: Forged ping/pong', () => {
  it('forged ping with _adapter from is rejected', async () => {
    // ATTACK: Relay sends a ping with from="_adapter". Section 2 states
    // peers MUST reject any peer-sent message where from equals "_adapter"
    // (except ready and terminate which are adapter messages).
    //
    // PREVENTS: Adapter impersonation in non-adapter message types.

    const ctx = setupDAppManual()
    const { transport, session } = ctx
    await connectDAppManual(ctx)

    const errorHandler = vi.fn()
    session.on('error', errorHandler)

    transport.receive({
      v: 1,
      t: 'ping',
      ch: session.channelId,
      ts: Date.now(),
      from: '_adapter', // spoofed!
      body: {},
    } as ProtocolMessage)

    await wait()

    expect(errorHandler).toHaveBeenCalled()
    expect(errorHandler.mock.calls[0]?.[0]?.message).toContain('spoofed _adapter')
  })

  it('ping/pong from unknown peer does not compromise encrypted state', async () => {
    // ATTACK: Relay injects a ping from a random key. Since ping/pong
    // are unencrypted and do not consume sequence numbers, the worst case
    // is a pong reply (no data compromise).
    //
    // PREVENTS: Verifies that heartbeat messages cannot leak secrets.

    const ctx = setupDAppManual()
    const { transport, session, walletKp } = ctx
    const { recvKey } = await connectDAppManual(ctx)

    const unknownKp = generateX25519KeyPair()

    transport.receive({
      v: 1,
      t: 'ping',
      ch: session.channelId,
      ts: Date.now(),
      from: unknownKp.publicKeyB64,
      body: {},
    } as ProtocolMessage)

    await wait()

    // DApp may reply with pong (no security issue) — verify session still works
    expect(session.phase).toBe('connected')

    // Verify encrypted communication still works after the forged ping
    const p = session.request('wallet_getAccounts')
    await wait(20)
    const req = transport.sent.filter((m) => m.t === 'req').pop() as RequestMessage | undefined
    const reqId = req?.body.id ?? ''

    transport.receive({
      v: 1,
      t: 'res',
      ch: session.channelId,
      ts: Date.now(),
      from: walletKp.publicKeyB64,
      body: {
        id: reqId,
        sealed: sealPayload(
          recvKey,
          session.channelId,
          0,
          { _ok: true, _result: 'still-works' },
          { type: 'res', from: walletKp.publicKeyB64, id: reqId },
        ),
      },
    } as ProtocolMessage)

    expect(await p).toBe('still-works')
  })
})
