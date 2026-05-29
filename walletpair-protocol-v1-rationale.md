# WalletPair Protocol v1 — Design Rationale and Security Analysis

This document explains **why** the protocol is designed the way it is.
For the normative specification, see `walletpair-protocol-v1.md`.

## 1. Design Principles

1. **Zero registration.** A relay must not require API keys, project IDs,
   or account signup. Any developer can deploy a relay and use it
   immediately.
2. **Self-hostable.** The relay is a lightweight message router with only
   ephemeral in-memory state. A single binary or container is sufficient.
3. **Relay-blind.** All request parameters, response results, and event
   data are end-to-end encrypted. The relay sees only routing metadata.
4. **Transport independent.** The protocol works over any ordered
   bidirectional transport.
5. **Simple.** The full protocol fits in one document. Implementation
   should take days, not weeks.

## 2. Key Exchange Rationale

### 2.1 Why Directional Traffic Keys

Using a single shared key for both directions would allow a reflection
attack: a relay could bounce a peer's own encrypted message back as if
it came from the other peer. Directional keys (`dapp_to_wallet_key`,
`wallet_to_dapp_key`) prevent this because a message encrypted with one
key cannot be decrypted with the other.

### 2.2 Why Transcript Hash Includes Capabilities and Meta

If a relay tampered with `sealed_join` content (e.g., removed
capabilities), each peer would compute a different transcript hash, which
would produce different traffic keys, and AEAD decryption would fail on
both sides. This makes the handshake tamper-evident without requiring an
explicit MAC exchange.

### 2.3 Why sealed_join Uses a Separate Key

The `join_encryption_key` is derived from `root_key` and
`channel_id_bytes` only — it does not depend on the transcript hash
(which requires the contents of `sealed_join` to compute). This avoids a
circular dependency: we need to encrypt capabilities before computing
the transcript, but the transcript includes those capabilities.

### 2.4 Why HMAC-Based Nonce Derivation

Using `HMAC-SHA256(traffic_key, seq_bytes)[0:12]` for the AEAD nonce
(instead of the raw sequence number zero-padded to 12 bytes) provides
defense-in-depth against nonce misuse. Even if a counter implementation
has bugs that produce unexpected values, the HMAC output remains
unpredictable and collision-resistant.

## 3. Pairing Security Analysis

### 3.1 Out-of-Band Key Delivery

The dApp's public key is the trust root. It is embedded in the pairing
URI and delivered via QR code — a physical optical channel that the relay
cannot intercept. This is why QR is the mandatory primary pairing method.

### 3.2 sealed_join as Cryptographic Proof

When the dApp receives `join` and successfully decrypts `sealed_join`,
this proves the sender controls the private key corresponding to the
`from` public key and used the dApp public key from the pairing URI. It
also detects relay tampering with the wallet public key in transit.

```text
Relay substitutes wallet key in forwarded join
→ dApp and real wallet compute different shared_secret
→ different join_encryption_key
→ sealed_join decryption fails
```

It does not prove that the sender is the intended user's wallet. A
malicious relay can see the dApp public key in `create`, generate its
own wallet key pair, and send a valid `join`. This cannot give the relay
the user's blockchain private keys or signatures, but it can squat the
channel or connect the dApp to an attacker-controlled wallet identity.
Applications that need user identity must verify accounts or signatures
after the encrypted session is established.

### 3.3 Half-MITM Attack (Relay Substitutes Wallet Key)

A relay could substitute the wallet's public key in the forwarded `join`:

```text
dApp:    shared_secret = X25519(dapp_priv, attacker_pub)
Wallet:  shared_secret = X25519(wallet_priv, dapp_pub)

→ Different shared_secret → different join_encryption_key
→ sealed_join decryption fails → dApp closes with decryption_failed
```

### 3.4 Fake Wallet Attack

A relay could generate its own key pair and send a valid `join` (the
relay knows `dapp_pub` from the `create` message). This achieves only
denial-of-service — the fake wallet cannot sign blockchain transactions
(lacks the user's private keys). The user retries or switches relays.

### 3.5 Deep Link Threat

When the pairing URI is delivered via deep link (software-controlled
channel), a malicious intermediary can replace the entire URI including
the dApp public key. The session fingerprint defends against this: the
legitimate dApp displays a fingerprint from the real key; the wallet
computes a fingerprint from the attacker's key. The user sees a mismatch.

This defense requires that the user is viewing the legitimate dApp. It
does not protect against phishing (fake dApp website). This is why the
spec mandates QR as the primary method and prohibits deep link as the
sole pairing mechanism.

Wallets that offer deep link convenience pairing SHOULD restrict
deep-link sessions to read-only methods by default.

## 4. Relay Trust Model

### 4.1 Relay Philosophy

A WalletPair relay is a dumb pipe. It routes messages by channel ID and
enforces basic protocol state. It does not:

- require registration, API keys, or project IDs
- inspect or decrypt payload content
- store long-term user data
- need any configuration beyond a listen address

A minimal relay can be a single binary under 1000 lines of code.

### 4.2 What the Relay Can Do

A relay can:

- Deny service (drop messages, terminate sessions)
- Observe traffic patterns (timing, message sizes, frequency)
- See `from` fields (public keys) and `t` fields (message types)
- See dApp `meta` in `create` (name, URL, icon — plaintext)

### 4.3 What the Relay Cannot Do

A relay cannot:

- Read encrypted payloads (method names, params, results, events)
- Read wallet capabilities or identity (encrypted in `sealed_join`)
- Determine if requests succeed or fail (`_ok` is encrypted)
- Forge encrypted messages (lacks traffic keys)
- Replay messages (sequence counter prevents it)

### 4.4 DApp Meta Asymmetry

DApp `meta` in `create` is plaintext (visible to relay), while wallet
`meta` is encrypted in `sealed_join`. This asymmetry exists because the
wallet needs the dApp's public key to encrypt, but the dApp sends
`create` before any wallet has joined. A future protocol version may
minimize plaintext `meta` or introduce relay-blind channel creation.

### 4.5 Relay Transparency

The relay does not need to understand `sealed_join`. It forwards the
`join` message to the dApp as an opaque JSON object. The relay cannot
read capabilities, meta, supported chains, or wallet type.

### 4.6 Terminate Message Trust

A `terminate` from the relay (`from` = `"_adapter"`) cannot be
cryptographically verified. A malicious relay can terminate any session.
This is inherent to using a relay — it can always sever the connection.
The worst case is denial of service, not data compromise. Peers should
use reconnect logic and consider multiple relays for critical operations.

### 4.7 Relay Restart Recovery

Because the relay is stateless (in-memory only), a relay restart clears
all channel state. Both peers detect the WebSocket disconnection and
automatically recover using the reconnect flow:

1. Both peers detect WebSocket close.
2. Both peers reconnect to the same relay URL (from the pairing URI)
   with backoff.
3. DApp sends `create` with the original `ch` and `from`.
4. Wallet sends `join` with the original `ch` and `from`,
   `sealed_join: null`.
5. DApp matches `from` against its persisted wallet public key and
   sends `accept`.
6. Relay sends `ready.connected` to both. Communication resumes with
   the persisted traffic keys and sequence counters.

From the relay's perspective, this is indistinguishable from a fresh
channel — no prior state is needed. From the peers' perspective, the
session continues seamlessly without re-pairing or re-scanning a QR code.

## 5. Heartbeat Security

Heartbeat messages are not encrypted and do not consume sequence numbers.
This is intentional — they carry no sensitive payload and must function
during encryption state setup.

Implications:

- **Relay-forged heartbeats:** A relay can forge `ping`/`pong`
  (including `from`). Cannot cause data compromise but may confuse
  liveness detection.
- **Heartbeat suppression:** A relay can drop `pong` to trigger
  reconnection (DoS equivalent to dropping any message).
- **Timing metadata:** `ts` and heartbeat frequency are visible to the
  relay (timing analysis).

These risks are within the accepted threat model (relay can always DoS).

## 6. Idempotency Cache Analysis

### 6.1 Cache Sizing

With 1024 entries at 16 KB max each, worst-case memory is 16 MB. Combined
with the 32 concurrent pending requests limit, a malicious dApp generates
at most 32 new cache entries per round-trip. Memory-constrained wallets
MAY use a smaller cache (minimum 128 entries).

### 6.2 Side Channel

A malicious dApp can probe whether a request ID has been cached by
observing error response types (cache hit with different params ->
`invalid_params` vs. new request -> normal processing). In practice, the
dApp already knows which requests it sent, so this leakage is minimal.

The params hash comparison MUST use constant-time comparison to prevent
timing attacks that could reveal cached response content.

## 7. Reconnect Design

### 7.1 Why Stateless Reconnect

Reconnect reuses the same `create`/`join`/`accept` flow as initial
pairing. The relay does not need to remember anything — it treats a
reconnect exactly like a new channel. Identity is verified end-to-end
via AEAD: each peer checks the remote `from` against its persisted
public key and verifies the other peer can encrypt/decrypt with the
existing traffic keys. This design avoids relay-managed session tokens
and keeps the relay truly stateless.

### 7.2 Why sealed_join Is Null on Reconnect

Capabilities were already negotiated during initial pairing. Repeating
`sealed_join` on reconnect would be redundant and waste bandwidth. The
dApp recognizes a reconnect by matching the wallet's `from` against its
persisted peer public key.

### 7.3 Why Sequence Counters Must Never Reset

Resetting counters with the same traffic key would cause nonce reuse,
breaking ChaCha20-Poly1305 security (allows plaintext recovery via
crib-dragging). This is why a peer that loses persisted counters MUST
NOT reconnect — it MUST close and re-pair.

### 7.4 Identity Verification on Reconnect

The relay does not verify peer identity — it is a stateless forwarder.
Identity is verified end-to-end:

1. **DApp verifies wallet:** On reconnect, the dApp checks that the
   wallet's `from` matches the persisted wallet public key. The wallet
   then proves possession of the corresponding private key by sending
   sealed messages that the dApp can decrypt with the existing traffic
   keys.
2. **Wallet verifies dApp:** The wallet checks that the dApp's `from`
   in `ready.connected` matches the persisted dApp public key. The dApp
   proves possession by sending sealed messages the wallet can decrypt.

An attacker who knows the public key and channel ID could attempt to
reconnect first ("channel squatting"). However, the attacker cannot
decrypt or forge sealed messages without the traffic keys derived from
the X25519 shared secret. The legitimate peer detects the impostor when
AEAD decryption fails and closes the channel.

### 7.5 Reconnect Race Conditions

Stateless reconnect introduces two race conditions because peers
reconnect independently and cannot coordinate timing.

**Race 1 — wallet arrives before dApp.** The dApp owns channel
creation, but the wallet may detect the transport disconnection first
and send `join` before the dApp sends `create`. The relay has no
channel state, so it replies `channel_not_found`. Treating this as a
permanent error would break reconnect whenever the wallet is faster.
The fix is simple: the wallet stays in `disconnected`, backs off, and
retries. No new mechanism is needed — the existing backoff schedule
handles it.

**Race 2 — stale connected state.** TCP disconnections are not always
detected instantly (lost FIN, mobile radio off). The relay may still
hold the old channel in `connected` state when the surviving peer tries
to `create`. Rejecting with `channel_exists` is correct (the relay
cannot know whether the old connection is truly dead), but the
reconnecting peer must not give up. It backs off and retries until the
relay's heartbeat timeout cleans up the stale connection. To reduce
this window, relays SHOULD proactively probe the liveness of attached
connections when receiving a `create` for an existing channel.

Both races resolve themselves through the existing backoff schedule
without requiring new message types or relay-side session memory.

## 8. Session Expiry Rationale

The 24-hour maximum session lifetime bounds the exposure window if
traffic keys are compromised. It also limits relay resource consumption.
Unlimited sessions would allow abandoned channels to persist
indefinitely.

## 9. Bluetooth Security Considerations

### 9.1 Proximity

BLE range can extend beyond visual range (especially with directional
antennas). Bluetooth proximity is NOT a security property — the QR code
is the trust anchor, not physical distance. Implementations MUST NOT
rely on Bluetooth proximity as a security property. The wallet SHOULD
display the dApp name prominently and require explicit user confirmation.

### 9.2 Connection Hijacking

A nearby attacker could connect to the BLE service before the legitimate
wallet. The one-wallet-per-channel rule prevents security compromise
(only DoS). The attacker cannot sign transactions without the user's
blockchain private keys.

### 9.3 Denial of Service

BLE frequency jamming and GATT connection flooding are inherent to
wireless protocols and outside the scope of this specification.

## 10. Capability Negotiation Design

### 10.1 Why the Wallet Declares Scope (Not the DApp)

The dApp declares its requirements in the pairing URI. The wallet
independently decides what to grant. This gives the user (via their
wallet) final authority over what is shared, consistent with the
principle that wallets are the user's security agent.

### 10.2 Sign-Only Wallets

Hardware wallets and air-gapped signers cannot broadcast transactions.
They grant `wallet_signTransaction` but not `wallet_sendTransaction`.
The dApp detects this from capabilities and falls back to
sign-then-broadcast mode (dApp broadcasts via its own RPC).

Example:

```text
dApp URI:      methods=wallet_sendTransaction
Cold wallet:   grants wallet_signTransaction only

→ dApp detects, switches to sign-then-broadcast
→ 1. DApp sends wallet_signTransaction
→ 2. Wallet signs, returns signed bytes
→ 3. DApp broadcasts via its own RPC
```

The dApp MUST check `capabilities.methods` to determine whether to use
`wallet_sendTransaction` or fall back to `wallet_signTransaction`. The
dApp MUST NOT send `wallet_sendTransaction` to a wallet that did not
grant it.

Broadcast idempotency: when the dApp broadcasts a signed transaction
from a sign-only wallet, the dApp handles its own broadcast idempotency
(e.g., deduplicating by tx hash). The wallet's idempotency cache ensures
retried `wallet_signTransaction` requests return the same signature.

### 10.3 Why Account Authorization Is Not in join

Accounts are revealed only through encrypted methods
(`wallet_getAccounts`), not in the plaintext-adjacent `join` message.
This prevents the relay from observing which blockchain addresses the
user has.

## 11. Multiple Relay Design

### 11.1 Channel Cleanup

Once pairing completes on one relay, the dApp must close channels on all
other relays to prevent orphaned channels consuming resources until TTL.
If the dApp cannot reach an unused relay, the relay's TTL will clean up
automatically.

### 11.2 Why Encryption Is Relay-Independent

Traffic keys derive from peer keys and the handshake transcript, not
from relay identity. This allows the wallet to connect to any relay
without affecting encryption — the same keys work regardless of which
relay routes the messages.

## 12. Comparison with Existing Protocols

### 12.1 vs. CAIP-25 / CAIP-27

WalletPair does not adopt CAIP-25 (`wallet_createSession`) or CAIP-27
(`wallet_invokeMethod`). CAIP-25 targets in-browser providers with scope
negotiation, partial authorization, and multi-session management.
WalletPair targets cross-device communication where:

- The pairing flow (QR -> key exchange -> fingerprint) replaces scope
  negotiation.
- E2E encryption makes JSON-RPC envelope nesting unnecessary.
- Each channel is a 1:1 session (channel ID = session ID).
- Session lifecycle is handled by the transport layer.

CAIP-27 wraps methods in a routing envelope. WalletPair achieves
routing via the `chain` parameter in each method's params, without
nesting.

### 12.2 Shared Standards

- Chain identification: CAIP-2 throughout.
- Capabilities structure: compatible with CAIP-217 `scopeObject`.
- Account data: convertible to/from CAIP-10.

### 12.3 vs. WalletConnect v2

Key differences:

- **No vendor lock-in:** No project ID, no registration, no single
  relay provider.
- **Better privacy:** Method names, capabilities, and wallet identity
  are encrypted. WalletConnect v2 exposes these to the relay.
- **Simpler:** One document vs. multiple interleaved specifications.
- **Self-hostable:** Single-binary relay with no dependencies.
