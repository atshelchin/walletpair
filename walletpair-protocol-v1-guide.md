# WalletPair Protocol v1 — Implementation Guide

This document provides practical guidance for implementing the protocol.
For the normative specification, see `walletpair-protocol-v1.md`.

## 1. Sequence Counter Persistence

Sequence counters MUST survive app termination and device restarts. Use
write-ahead persistence: increment and persist **before** sending. A
crash between persist and send causes a harmless gap (the remote peer
accepts gaps), not dangerous counter reuse.

### Recommended Backends

| Platform | Backend |
|----------|---------|
| Browser | IndexedDB (not localStorage — may be cleared). Use dedicated object store with explicit `durableObjectStore` transactions where available. |
| iOS | Keychain or encrypted file storage. Must survive process kills. |
| Android | EncryptedSharedPreferences or Keystore-backed file. |
| Desktop/Server | SQLite (WAL mode) or file with `fsync`. |

### Ephemeral Contexts

If the platform cannot guarantee durable persistence (incognito mode,
ephemeral browser contexts), the implementation MUST NOT support
reconnect. Every transport disconnection becomes a terminal close
requiring fresh pairing.

## 2. Key Material Lifecycle

### Detailed Erasure Sequence

```text
1. Generate X25519 key pair
2. Compute shared_secret → erase shared_secret immediately
3. Derive root_key
4. Derive join_encryption_key → erase root_key
5. Encrypt/decrypt sealed_join → erase join_encryption_key
6. Compute transcript_hash
7. Derive dapp_to_wallet_key, wallet_to_dapp_key → erase transcript_hash
8. X25519 private key is no longer needed → erase it
9. Traffic keys persist until channel close → erase on close
10. Sequence counters → erase on close
11. Idempotency cache → erase (zero) on close
```

### Platform-Specific Memory Protection

| Platform | Approach |
|----------|----------|
| C/Rust | `sodium_mlock` / `mlock` to prevent swap. Zero on free. |
| Java/Kotlin | Use `byte[]` (not `String`), zero after use. Consider `DirectByteBuffer`. |
| Swift | Use `Data` with `resetBytes(in:)`. Consider `SecKey` for key operations. |
| JavaScript (browser) | Use `crypto.subtle` or WebAssembly. Minimize key lifetime in JS heap. `TypedArray.fill(0)` for erasure (not guaranteed by GC but best effort). |

## 3. Idempotency Cache Implementation

### Cache Structure

```text
Map<request_id, {
  params_hash: bytes[32],        // SHA-256 of raw plaintext bytes
  response_ok: boolean,
  response_json: string | null,  // null if > 16 KB (uncacheable)
  broadcast_tx_hash: bytes[32],  // only for wallet_sendTransaction
}>
```

- Maximum 1024 entries, LRU eviction.
- Broadcast tx hashes: separate persistent store, max 256 entries.
- Cache security: store in non-swappable memory or encrypt at rest
  using a key derived from the session's traffic key. Securely erase
  (zero) when the channel is closed. On platforms without memory
  locking (browser), minimize cache lifetime and clear entries as
  soon as the dApp acknowledges receipt.

### Retry Flow (DApp Side)

```text
1. DApp sends req with id="abc", caches the raw plaintext_json_utf8 bytes
2. No response within timeout (or transport drops)
3. DApp reconnects
4. DApp resends req with SAME id="abc" and SAME plaintext bytes
   → New sequence number (counters continued from persisted value)
   → Wallet sees cached id, params match → returns cached response
```

The dApp MUST cache and reuse the exact `plaintext_json_utf8` bytes. DO
NOT re-serialize from parsed objects — different key ordering or
whitespace will produce a different params hash.

## 4. Relay Implementation Notes

### Minimal Relay Architecture

```text
Relay state (in-memory):
  channels: Map<channel_id, {
    state: "waiting" | "paired" | "connected",
    dapp_conn: WebSocket | null,
    wallet_conn: WebSocket | null,
    dapp_pubkey: string,
    wallet_pubkey: string | null,
    created_at: timestamp,
    connected_at: timestamp | null,
  }>
```

A minimal relay is ~500-1000 lines of code. No database, no persistent
storage.

### Rate Limiting

The protocol requires relays to enforce rate limits (spec §17.3) but
leaves specific values to each deployment. Recommended defaults:

| Limit | Recommended |
|-------|-------------|
| Channel creation per IP | 10/min |
| Concurrent connections per IP | 50 |
| Messages per channel per peer | 60/min |
| Global concurrent channels | 10,000 |
| Global bandwidth | 100 MB/min |

When the global concurrent channels limit is exceeded, new `create`
messages receive `terminate` with `rate_limited`. When the global
bandwidth limit is exceeded, the relay SHOULD throttle new messages
with backpressure rather than dropping existing channels.

All limits should be configurable. Private relays serving a single dApp
may use much higher values; public relays may need stricter limits.

### Anti-Abuse Mechanisms

Beyond rate limits, relay operators may consider:

- **Proof-of-work challenge on `create`:** Relay responds with a
  hashcash challenge before accepting channel creation. Raises the cost
  of mass channel creation from botnets.
- **TLS fingerprinting:** Detect automated clients by analyzing the
  TLS ClientHello.
- **Pattern detection:** Flag IPs creating many channels that never
  pair.

These are relay-implementation details and do not affect protocol
interoperability.

### Self-Hosting

```bash
docker run -p 8080:8080 walletpair/relay
```

No environment variables, API keys, or external dependencies required.
Optional configuration: listen address, TLS certificate, channel TTL,
max concurrent channels.

## 5. Reconnect Implementation

Reconnect reuses the `create`/`join`/`accept` flow. The relay treats
it as a new channel — no relay-side state is needed.

### DApp Reconnect

1. Detect transport disconnect.
2. Apply backoff (1s -> 2s -> 5s -> 10s -> 30s).
3. Send `create` with the **same** `ch` and `from`.
4. Wait for wallet to rejoin.
5. When `join` arrives with `sealed_join: null`, match `from` against
   persisted wallet public key. If match, auto-send `accept`.
6. Resume encrypted communication with persisted traffic keys and
   sequence counters.

### Wallet Reconnect

1. Detect transport disconnect.
2. Apply backoff.
3. Send `join` with the **same** `ch` and `from`, set
   `sealed_join: null`.
4. Wait for `ready.connected`.
5. Resume encrypted communication.

### After Reconnect

- Retry pending requests with the same `req.id` (new sequence number).
- Wallet deduplicates via idempotency cache.
- DApp should call `wallet_getAccounts` to refresh state if missed
  events matter.

## 6. Complete Session Example

### Step 1: Pairing URI (QR Code)

```text
walletpair:?ch=aabb01...eeff&pubkey=dGhpcyBpcyBh...&relay=wss%3A%2F%2Frelay.example.com%2Fv1&name=MyDApp&url=https%3A%2F%2Fmydapp.com&icon=https%3A%2F%2Fmydapp.com%2Ficon.png&methods=wallet_signTransaction,wallet_signMessage&chains=eip155:1,eip155:137
```

### Step 2: DApp Creates Channel

```json
{
  "v": 1,
  "t": "create",
  "ch": "aabb01...eeff",
  "ts": 1779170000000,
  "from": "base64url-dapp-pubkey",
  "body": {
    "meta": {
      "name": "MyDApp",
      "description": "A decentralized exchange",
      "url": "https://mydapp.com",
      "icon": "https://mydapp.com/icon.png"
    }
  }
}
```

### Step 3: Relay Confirms

```json
{
  "v": 1,
  "t": "ready",
  "ch": "aabb01...eeff",
  "ts": 1779170000000,
  "from": "_adapter",
  "body": {
    "state": "waiting",
    "role": "dapp",
    "self": "base64url-dapp-pubkey",
    "remote": null,
    "reconnect": false
  }
}
```

### Step 4: Wallet Joins

```json
{
  "v": 1,
  "t": "join",
  "ch": "aabb01...eeff",
  "ts": 1779170000000,
  "from": "base64url-wallet-pubkey",
  "body": {
    "sealed_join": "base64url-encrypted-capabilities-and-meta"
  }
}
```

Decrypted `sealed_join`:

```json
{
  "capabilities": {
    "methods": ["wallet_signTransaction", "wallet_signMessage"],
    "events": ["accountsChanged", "chainChanged"],
    "chains": ["eip155:1", "eip155:137"]
  },
  "meta": {
    "name": "MyWallet",
    "description": "A multi-chain wallet",
    "url": "https://mywallet.app",
    "icon": "https://mywallet.app/icon.png"
  }
}
```

### Step 5: DApp Accepts

```json
{
  "v": 1,
  "t": "accept",
  "ch": "aabb01...eeff",
  "ts": 1779170000000,
  "from": "base64url-dapp-pubkey",
  "body": {
    "target": "base64url-wallet-pubkey"
  }
}
```

### Step 6: Both Receive ready.connected

```json
{
  "v": 1,
  "t": "ready",
  "ch": "aabb01...eeff",
  "ts": 1779170000000,
  "from": "_adapter",
  "body": {
    "state": "connected",
    "role": "dapp",
    "self": "base64url-dapp-pubkey",
    "remote": "base64url-wallet-pubkey",
    "reconnect": false
  }
}
```

### Step 7: Encrypted Request (seq=0)

Wire message:

```json
{
  "v": 1,
  "t": "req",
  "ch": "aabb01...eeff",
  "ts": 1779170000000,
  "from": "base64url-dapp-pubkey",
  "body": {
    "id": "req-001",
    "sealed": "base64url-encrypted-params"
  }
}
```

Decrypted `sealed`:

```json
{
  "_method": "wallet_signTransaction",
  "chain": "eip155:1",
  "address": "0xab16a96D359eC26a11e2C2b3d8f8B8942d5Bfcdb",
  "tx": {
    "to": "0x4976fb03C32e5B8cfe2b6cCB31c09Ba78EBaBa41",
    "value": "0xde0b6b3a7640000",
    "type": "0x2",
    "chainId": "0x1"
  }
}
```

### Step 8: Encrypted Response (seq=0)

Wire message:

```json
{
  "v": 1,
  "t": "res",
  "ch": "aabb01...eeff",
  "ts": 1779170000000,
  "from": "base64url-wallet-pubkey",
  "body": {
    "id": "req-001",
    "sealed": "base64url-encrypted-response"
  }
}
```

Decrypted `sealed`:

```json
{
  "_ok": true,
  "_result": {
    "signedTx": "0x..."
  }
}
```

### Step 9: Wallet Pushes Event (seq=1)

Decrypted `sealed`:

```json
{
  "_event": "accountsChanged",
  "accounts": [
    {
      "address": "0xNewAddress...",
      "chains": ["eip155:1", "eip155:137"]
    }
  ]
}
```

### Step 10: User Rejects a Request

Decrypted `sealed`:

```json
{
  "_ok": false,
  "code": "user_rejected",
  "message": "User rejected the request"
}
```

### Step 11: Close

```json
{
  "v": 1,
  "t": "close",
  "ch": "aabb01...eeff",
  "ts": 1779170000000,
  "from": "base64url-dapp-pubkey",
  "body": {
    "reason": "normal"
  }
}
```

## 7. Join Wire Format Example

```json
{
  "v": 1,
  "t": "join",
  "ch": "aabb01...eeff",
  "ts": 1779170000000,
  "from": "base64url-wallet-pubkey",
  "body": {
    "sealed_join": "base64url-encrypted-capabilities-and-meta"
  }
}
```

## 8. Deep Link Security Warning

When a wallet supports deep link pairing as a convenience mechanism
(e.g., same-device dApp-to-wallet), the wallet MUST display:

"This connection was not established via secure out-of-band channel. A
malicious app on this device could intercept the connection. For
high-value transactions, use QR code pairing from a separate device."

DApps that offer deep links alongside QR codes MUST label them as
"Less secure — same device only."

## 9. Sign-Only Wallet Flow

Sign-only wallets (hardware wallets, air-gapped wallets) grant
`wallet_signTransaction` but not `wallet_sendTransaction`.

```text
dApp URI:    methods=wallet_sendTransaction   (dApp's requirement)
Cold wallet: grants wallet_signTransaction     (what it can do)

→ dApp receives capabilities, adapts to sign-then-broadcast mode
```

1. DApp sends `req` with `_method: "wallet_signTransaction"`.
2. Wallet signs and returns signed transaction bytes in `_result`.
3. DApp broadcasts via its own RPC provider.

Sign-only wallet capability declaration:

```json
{
  "capabilities": {
    "methods": [
      "wallet_signTransaction",
      "wallet_signMessage",
      "wallet_getAccounts"
    ],
    "events": ["accountsChanged", "chainChanged"],
    "chains": ["eip155:1"]
  }
}
```

## 10. EIP-6963 Integration

SDK implementations that provide an EIP-1193 adapter for WalletPair
connections SHOULD register as an EIP-6963 provider in browser contexts.

Recommended provider info:

- `uuid`: Unique per WalletPair session (not the channel ID).
- `name`: Default "WalletPair Wallet". Update if the wallet provides
  a name via encrypted methods.
- `icon`: Wallet's `meta.icon` if available, or generic WalletPair icon.
  See spec Section 19.5 for icon URL privacy considerations.
- `rdns`: `io.walletpair.sdk`

## 11. Testing Checklist

### Cryptographic Correctness

- [ ] Canonical JSON output matches spec test vectors byte-for-byte
- [ ] Root key derivation matches spec A.2
- [ ] Join encryption key derivation matches spec A.2
- [ ] Sealed join encryption/decryption matches spec A.3
- [ ] Transcript hash matches spec A.4
- [ ] Traffic key derivation matches spec A.4
- [ ] Session fingerprint matches spec A.5
- [ ] AEAD encryption matches spec A.6
- [ ] Sequence number nonce derivation matches spec A.6

### Protocol Flow

- [ ] Full pairing: create -> join -> accept -> ready.connected
- [ ] Request/response round-trip with encryption
- [ ] Event delivery
- [ ] Heartbeat ping/pong
- [ ] Close from both sides
- [ ] Reconnect: dApp resends create (same ch/from), wallet resends
      join (same ch/from, sealed_join=null)
- [ ] Reconnect with sequence counter continuity
- [ ] Request retry (idempotency cache hit)
- [ ] Session expiry enforcement

### Error Handling

- [ ] Unsupported method -> unsupported_method
- [ ] Unsupported chain -> unsupported_chain
- [ ] Rate limiting -> rate_limited (32 pending requests)
- [ ] Invalid sequence number -> rejection
- [ ] Decryption failure -> close with decryption_failed
- [ ] Second wallet join -> already_connected

### Security

- [ ] Key material erased at correct lifecycle points
- [ ] Sequence counters never reset on reconnect
- [ ] Sequence counters persisted durably (write-ahead)
- [ ] Cache securely erased on channel close
- [ ] from field verified on all encrypted messages
- [ ] ready.connected remote matches handshake transcript peer
