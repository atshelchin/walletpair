# WalletPair Protocol v1

Status: Draft

WalletPair Protocol is a minimal, self-sovereign two-party channel protocol for
connecting dApps and wallets. It replaces centralized pairing services with a
protocol that anyone can relay, no registration required.

The channel is created by the dApp. The wallet joins that channel. After a
cryptographic handshake and user confirmation, the dApp can send requests and
the wallet can send responses or events.

Intended flow:

1. DApp creates a channel and generates a pairing URI (QR code).
2. Wallet scans QR code or opens deep link.
3. Wallet derives the shared secret, displays pairing code, and asks user
   to confirm it matches the dApp's display.
4. User confirms on wallet. Wallet sends join with its public key and
   capabilities.
5. DApp verifies and accepts. Channel is now connected and encrypted.
6. DApp sends requests. Wallet sends responses and events.

WalletPair is transport independent. The same protocol messages can run over
WebSocket Relay, Bluetooth, local TCP, or another ordered bidirectional
transport.

`dapp` and `wallet` are application roles. They do not have to match lower
level transport roles such as Bluetooth central/peripheral or TCP client/server.

## 1. Scope

WalletPair defines:

- channel creation and pairing URI
- key exchange and end-to-end encryption
- capability negotiation
- user confirmation with pairing code
- request and response
- wallet events
- heartbeat
- close and reconnect semantics

WalletPair does not define:

- wallet logic or signing logic
- business payload schema
- specific service method registry
- relay cluster architecture or storage backend

Those belong to upper-layer protocols or deployment configurations.

## 2. Design Principles

1. **Zero registration.** A relay must not require API keys, project IDs, or
   account signup. Any developer can deploy a relay and use it immediately.
2. **Self-hostable.** The relay is a lightweight message router with only
   ephemeral in-memory state. No persistent storage is required. A single
   binary or container is all that is needed.
3. **Relay-blind.** All request parameters, response results, and event data
   are end-to-end encrypted. The relay sees only routing metadata.
4. **Transport independent.** The protocol works over any ordered bidirectional
   transport.
5. **Simple.** The full protocol fits in one document. Implementation should
   take days, not weeks.

## 3. Roles

Each channel has exactly two roles.

### DApp

The dApp creates the channel, accepts or rejects the wallet, and calls
wallet methods.

The dApp may send:

```text
create
accept
req
ping
pong
close
```

### Wallet

The wallet joins an existing channel, handles requests, and may push events.

The wallet may send:

```text
join
res
evt
ping
pong
close
```

### Transport Adapter

The transport adapter (relay, Bluetooth stack, etc.) is not a peer. It
generates `ready` messages on behalf of the channel and enforces protocol
state. Neither the dApp nor the wallet sends `ready`.

The wallet does not create channels. The dApp does not send events.

## 4. Identifiers

### Channel ID

Field: `ch`

The channel ID identifies one pending or connected channel. It must be a
random 32-byte value encoded as hex (64 characters).

### Peer ID

Field: `from`

The peer ID is the X25519 public key of the sender, encoded as base64url
(no padding). This binds identity to cryptographic material and prevents
impersonation.

Since `from` already carries the public key, the `pubkey` field in `create`
and `join` is an alias for clarity during the handshake. Implementations must
verify that `from` equals `pubkey` in those messages.

### Request ID

Field: `id`

The dApp generates a unique request ID for every `req`. The wallet must copy
the same `id` into the matching `res`. The request ID should be a UUID v4 or
another random string with sufficient entropy to avoid collisions.

## 5. Message Format

Every WalletPair message is one JSON object.

Common shape:

```json
{
  "v": 1,
  "t": "message_type",
  "ch": "channel-id"
}
```

Common fields:

| Field | Present in | Description |
|---|---|---|
| `v` | all | Protocol version. Must be `1`. |
| `t` | all | Message type. |
| `ch` | all | Channel ID (hex, 64 chars). |
| `from` | `create`, `join`, `accept`, `req`, `res`, `evt`, `ping`, `pong`, `close` | Sender peer ID (X25519 public key, base64url). |
| `pubkey` | `create`, `join` | Alias of `from`. Present for handshake clarity. |
| `id` | `req`, `res`, optional in `evt` | Request or event ID. |
| `method` | `req` | Wallet method name (plaintext, visible to relay). |
| `sealed` | `req`, `res`, `evt` (when encrypted payload exists) | Encrypted payload, base64url. See Section 7.4. |
| `ok` | `res` | Boolean. Whether the request succeeded. |
| `event` | `evt` | Event name (plaintext, visible to relay). |
| `capabilities` | `join` | Wallet capabilities object. See Section 8. |
| `meta` | optional in `create`, `join` | Display metadata such as app or device name. |
| `target` | `accept`, optional in `close` | Target peer ID. |
| `state` | `ready` | `waiting` or `connected`. |
| `role` | `ready` | Local role: `dapp` or `wallet`. |
| `self` | `ready` | Local peer ID. |
| `remote` | `ready` when `state=connected` | Remote peer ID. |
| `resume` | `ready`, or in `create`/`join` for reconnect | Reconnect token. See Section 14. |
| `reason` | `close` | Close or rejection reason. |
| `ts` | optional in `ping`, `pong` | Timestamp in milliseconds. |

Note: The plaintext fields `params`, `result`, `error`, and `data` never
appear on the wire. Their content is encrypted into the `sealed` field. The
receiver decrypts `sealed` to recover the original JSON value. See Section 7.4
for the mapping.

## 6. Message Types

WalletPair v1 has ten message types:

```text
create    (dApp -> adapter)
join      (wallet -> adapter)
accept    (dApp -> adapter)
ready     (adapter -> peer)
req       (dApp -> wallet, via adapter)
res       (wallet -> dApp, via adapter)
evt       (wallet -> dApp, via adapter)
ping      (either peer -> other peer)
pong      (either peer -> other peer)
close     (either peer or adapter -> peer)
```

There is no separate `error` message. Request errors use `res.ok = false`.
Channel errors, rejection, and shutdown use `close`.

## 7. Key Exchange and Encryption

### 7.1 Key Exchange

Both peers generate an ephemeral X25519 key pair per channel.

The dApp includes its public key in `create`. The wallet includes its public
key in `join`. After both keys are exchanged, each side computes the shared
secret using X25519 Diffie-Hellman.

Timeline:

1. The wallet obtains the dApp's public key from the pairing URI.
2. The wallet sends `join` with its own public key.
3. The dApp receives `join` and obtains the wallet's public key.
4. Both sides can now independently derive the session key.

### 7.2 Shared Secret Derivation

```text
shared_secret = X25519(local_private_key, remote_public_key)
session_key   = HKDF-SHA256(
                  ikm  = shared_secret,
                  salt = channel_id_bytes,   // 32 bytes, decoded from hex
                  info = "walletpair-v1"
                )[0:32]                      // 32 bytes output
```

The session key is 32 bytes and is used for all subsequent encryption.

### 7.3 Pairing Code

After key exchange, both sides independently derive a 6-digit pairing code:

```text
code_bytes   = HKDF-SHA256(
                 ikm  = session_key,
                 salt = channel_id_bytes,
                 info = "walletpair-pairing-code"
               )[0:4]                          // first 4 bytes (indices 0,1,2,3)
code_uint32  = big-endian uint32(code_bytes)
pairing_code = code_uint32 mod 1000000         // zero-pad to 6 digits
```

The wallet can compute its pairing code immediately after scanning the
pairing URI (it already has the dApp's public key and channel ID). The
wallet SHOULD display the pairing code and ask the user to confirm it
matches the dApp's display BEFORE sending `join`. This ensures the user
confirms on the device in their hand (the phone), providing better UX.

The dApp computes and displays its pairing code after creating the
channel (before receiving `join`). The dApp's code display serves as
the reference the wallet user visually checks.

After receiving `join`, the dApp MAY auto-accept if the implementation
trusts that the wallet user already confirmed the code. Alternatively,
the dApp MAY require explicit user confirmation on the dApp side.

This prevents man-in-the-middle attacks: if a relay substitutes public
keys, both sides will derive different session keys and different pairing
codes. The user will see mismatched codes and reject the connection.

### 7.4 Message Encryption

After `ready.connected`, payload fields must be encrypted into the `sealed`
field.

Mapping:

| Message type | Plaintext field | Encrypted into `sealed` |
|---|---|---|
| `req` | `params` | yes, if params exist |
| `res` with `ok=true` | `result` | yes, if result exists |
| `res` with `ok=false` | `error` | yes, always required |
| `evt` | `data` | yes, if data exists |

A `req` with no params, a `res` with `ok=true` and no return value, or an
`evt` with no data, may omit `sealed`. A `res` with `ok=false` must always
include `sealed` (the encrypted error object).

Encryption uses ChaCha20-Poly1305:

```text
nonce    = HMAC-SHA256(session_key, seq_bytes)[0:12]   // first 12 bytes
aad      = concat(channel_id_bytes, utf8(aad_suffix))
sealed   = AEAD_encrypt(session_key, nonce, plaintext_json_utf8, aad)
envelope = base64url_no_pad(seq_bytes || ciphertext || tag)
```

The `aad_suffix` authenticates the plaintext header fields to prevent a
compromised relay from tampering with routing metadata:

```text
req:  aad_suffix = from + ":" + id + ":" + method
res:  aad_suffix = from + ":" + id + ":" + (ok ? "ok" : "err")
evt:  aad_suffix = from + ":" + event
```

If a relay modifies `from`, `id`, `method`, `event`, or `ok`, the
receiver's AEAD decryption will fail, rejecting the tampered message.

Where `seq_bytes` is a 4-byte big-endian sequence number. Each peer maintains
its own send counter, starting at 0 and incrementing by 1 for each message
that carries a `sealed` field. Messages without `sealed` (e.g., a `req` with
no params) do not consume a sequence number.

The receiver tracks the highest accepted sequence number from the remote peer
(initially -1, meaning no message received yet). On receiving a message with
`sealed`, the receiver reads the 4-byte sequence prefix and must reject the
message if the sequence number is not strictly greater than the last accepted
value. After accepting, the receiver updates its tracking value.

During normal operation on an ordered transport, sequence numbers will arrive
consecutively (0, 1, 2, ...). After a reconnect, there may be gaps due to
in-flight messages lost during the transport drop; these gaps are expected and
valid (see Section 14).

Sequence counters are persisted across reconnects and never reset.

If a peer's send sequence counter reaches `2^31` (2,147,483,648), the
peer MUST close the channel with reason `normal` and require a fresh
pairing. This prevents nonce exhaustion. At typical usage rates (one
message per second), this limit allows ~68 years of continuous use per
session, so it should never be reached in practice. Implementations MUST
still handle this case to prevent nonce reuse if a counter is corrupted.

Example `req` with encrypted params:

```json
{
  "v": 1,
  "t": "req",
  "ch": "aabb...eeff",
  "id": "req-001",
  "from": "base64url-dapp-pubkey",
  "method": "wallet_signTransaction",
  "sealed": "base64url-of-seq-ciphertext-tag"
}
```

The `method` and `event` fields are plaintext so the relay can optionally log
them for debugging. If method-name privacy is needed, use a generic method
name like `encrypted` and put the real method inside the encrypted payload.

## 8. Capability Negotiation

The wallet declares its capabilities in the `join` message:

```json
{
  "v": 1,
  "t": "join",
  "ch": "aabb...eeff",
  "from": "base64url-wallet-pubkey",
  "pubkey": "base64url-wallet-pubkey",
  "capabilities": {
    "methods": [
      "wallet_signTransaction",
      "wallet_signMessage",
      "wallet_sendTransaction",
      "wallet_getAccounts"
    ],
    "events": [
      "accountsChanged",
      "chainChanged"
    ],
    "chains": [
      "eip155:1",
      "eip155:137",
      "solana:mainnet"
    ]
  },
  "meta": {
    "name": "MyWallet",
    "icon": "https://example.com/icon.png"
  }
}
```

The dApp inspects `capabilities` before calling `accept`. If the wallet does
not support a required chain or method, the dApp may `close` with
`unsupported_capability`.

Capability fields:

| Field | Type | Description |
|---|---|---|
| `methods` | string[] | Wallet methods the wallet supports. |
| `events` | string[] | Event types the wallet may push. |
| `chains` | string[] | CAIP-2 chain identifiers the wallet supports. |

All three fields are required in `capabilities`. An empty array means the
wallet explicitly supports none of that category.

## 9. Pairing Flow

### 9.1 Pairing URI

The dApp generates a pairing URI that encodes the channel ID, the dApp public
key, and the relay endpoint. The wallet scans this as a QR code or receives it
via deep link.

Format:

```text
walletpair:?ch=<channel-id>&pubkey=<dapp-pubkey-base64url>&relay=<relay-url-percent-encoded>&name=<dapp-name>&methods=<comma-list>&chains=<comma-list>
```

Example:

```text
walletpair:?ch=aabb01...eeff&pubkey=dGhpcyBpcyBh...&relay=wss%3A%2F%2Frelay.example.com%2Fv1&name=MyDApp&methods=wallet_sendTransaction,wallet_signTypedData&chains=eip155:1,eip155:137
```

Parameters:

| Param | Required | Description |
|---|---|---|
| `ch` | yes | Channel ID (hex, 64 chars). |
| `pubkey` | yes | DApp X25519 public key (base64url, no padding). |
| `relay` | yes for relay transport | WebSocket relay URL (percent-encoded). |
| `name` | optional | DApp display name. |
| `methods` | optional | Comma-separated list of methods the dApp intends to call. The wallet SHOULD display these to the user during the pairing confirmation prompt (e.g., "MyDApp wants to: send transactions, sign typed data"). |
| `chains` | optional | Comma-separated list of CAIP-2 chains the dApp intends to use. The wallet SHOULD display these during pairing confirmation. |

When `methods` or `chains` are present, the wallet SHOULD show the user
what the dApp is requesting before the user confirms the connection. This
enables informed consent. If `methods` or `chains` are absent, the wallet
SHOULD warn the user that the dApp did not declare its intent.

For Bluetooth pairing, the URI may omit `relay` and instead be transmitted
through BLE advertisement, NFC tap, or local QR code.

Multiple relay endpoints can be specified by repeating the `relay` parameter:

```text
walletpair:?ch=...&pubkey=...&relay=wss%3A%2F%2Fr1.example.com%2Fv1&relay=wss%3A%2F%2Fr2.example.com%2Fv1
```

The dApp must create the channel on all listed relays. The wallet tries relays
in order and uses the first one that connects. Since the session key is derived
from the key pair (not the relay), switching relays does not affect encryption.

### 9.2 DApp Creates Channel

The dApp connects to the relay and sends:

```json
{
  "v": 1,
  "t": "create",
  "ch": "aabb01...eeff",
  "from": "base64url-dapp-pubkey",
  "pubkey": "base64url-dapp-pubkey",
  "meta": {
    "name": "MyDApp"
  }
}
```

The relay replies:

```json
{
  "v": 1,
  "t": "ready",
  "ch": "aabb01...eeff",
  "state": "waiting",
  "role": "dapp",
  "self": "base64url-dapp-pubkey",
  "resume": "relay-generated-resume-token"
}
```

The `resume` token is generated by the relay and is opaque to the peer.

### 9.3 Wallet Confirms and Joins

The wallet scans the pairing URI, generates its keypair, and immediately
computes the session key and pairing code (it has the dApp's public key
from the URI). The wallet then displays the pairing code and prompts:

```text
Wallet: "Connect to MyDApp? Pairing code: 847293. [Connect] [Cancel]"
```

The user verifies the code matches the one displayed on the dApp, then
taps Connect. Only after user confirmation, the wallet connects to the
relay and sends:

```json
{
  "v": 1,
  "t": "join",
  "ch": "aabb01...eeff",
  "from": "base64url-wallet-pubkey",
  "pubkey": "base64url-wallet-pubkey",
  "capabilities": {
    "methods": ["wallet_signTransaction", "wallet_signMessage"],
    "events": ["accountsChanged", "chainChanged"],
    "chains": ["eip155:1", "eip155:137"]
  },
  "meta": {
    "name": "MyWallet"
  }
}
```

The relay does two things:

1. Forwards the `join` message to the dApp.
2. Sends `ready.waiting` back to the wallet:

```json
{
  "v": 1,
  "t": "ready",
  "ch": "aabb01...eeff",
  "state": "waiting",
  "role": "wallet",
  "self": "base64url-wallet-pubkey",
  "resume": "wallet-waiting-resume-token"
}
```

This gives the wallet a `resume` token so it can reconnect if the transport
drops during the waiting phase.

At this point:

- The wallet already confirmed the pairing code (before sending `join`).
- The dApp now has the wallet's public key (from `join`) and can compute
  the session key and verify the pairing code.

### 9.4 DApp Accepts Wallet

The dApp computes its pairing code and displays it. Since the wallet
user already confirmed the code matches before sending `join`, the dApp
MAY auto-accept:

```text
DApp:   "Pairing code: 847293. Wallet connected!"
```

The dApp sends:

```json
{
  "v": 1,
  "t": "accept",
  "ch": "aabb01...eeff",
  "from": "base64url-dapp-pubkey",
  "target": "base64url-wallet-pubkey"
}
```

The relay sends `ready.connected` to both peers:

DApp receives:

```json
{
  "v": 1,
  "t": "ready",
  "ch": "aabb01...eeff",
  "state": "connected",
  "role": "dapp",
  "self": "base64url-dapp-pubkey",
  "remote": "base64url-wallet-pubkey",
  "resume": "dapp-resume-token"
}
```

Wallet receives:

```json
{
  "v": 1,
  "t": "ready",
  "ch": "aabb01...eeff",
  "state": "connected",
  "role": "wallet",
  "self": "base64url-wallet-pubkey",
  "remote": "base64url-dapp-pubkey",
  "resume": "wallet-resume-token"
}
```

From this point on, both sides must encrypt payloads using the session key.
Both peers initialize their send and receive sequence counters to 0.

## 10. Request and Response

The dApp calls a wallet method with `req`. After `ready.connected`, all
payloads are encrypted.

```json
{
  "v": 1,
  "t": "req",
  "ch": "aabb01...eeff",
  "id": "req-001",
  "from": "base64url-dapp-pubkey",
  "method": "wallet_signTransaction",
  "sealed": "base64url-encrypted-params"
}
```

The wallet replies with exactly one `res`:

Successful response:

```json
{
  "v": 1,
  "t": "res",
  "ch": "aabb01...eeff",
  "id": "req-001",
  "from": "base64url-wallet-pubkey",
  "ok": true,
  "sealed": "base64url-encrypted-result"
}
```

Failed response:

```json
{
  "v": 1,
  "t": "res",
  "ch": "aabb01...eeff",
  "id": "req-001",
  "from": "base64url-wallet-pubkey",
  "ok": false,
  "sealed": "base64url-encrypted-error"
}
```

The decrypted `sealed` in a failed response is an error object with required
fields `code` (string) and `message` (string):

```json
{
  "code": "user_rejected",
  "message": "User rejected the request"
}
```

Rules:

1. Only the dApp sends `req`.
2. Only the wallet sends `res`.
3. `res.id` must equal the matching `req.id`.
4. A request receives exactly one response.
5. The decrypted content of `sealed` is the JSON value of `params`, `result`,
   or `error`, owned by the upper-layer service.
6. The wallet MUST track recently processed request IDs and their
   responses for at least 5 minutes. If the wallet receives a `req`
   with an `id` it has already processed:
   - If the params hash matches the original request, the wallet MUST
     return the cached response without re-executing the operation.
   - If the params hash differs, the wallet MUST reject with
     `invalid_params` ("Duplicate request ID with different params").
   This prevents duplicate signing or broadcast after reconnect retries.
   For `wallet_sendTransaction` specifically: if the wallet has already
   signed and broadcast a transaction for a given `req.id`, it MUST NOT
   sign or broadcast again — it MUST return the original `txHash`.

## 11. Wallet Events

The wallet can push an event to the dApp with `evt`.

```json
{
  "v": 1,
  "t": "evt",
  "ch": "aabb01...eeff",
  "id": "evt-001",
  "from": "base64url-wallet-pubkey",
  "event": "accountsChanged",
  "sealed": "base64url-encrypted-data"
}
```

Rules:

1. Only the wallet sends `evt`.
2. Events do not require a response.
3. Event ordering is transport-order while the connection is alive.
4. WalletPair v1 does not guarantee event replay after reconnect.
5. If events are critical, the dApp should call a snapshot method after
   reconnect, such as `wallet_getAccounts`.

## 12. Heartbeat

Either peer may send `ping`.

```json
{
  "v": 1,
  "t": "ping",
  "ch": "aabb01...eeff",
  "from": "base64url-dapp-pubkey",
  "ts": 1779170000000
}
```

The receiver replies with `pong`.

```json
{
  "v": 1,
  "t": "pong",
  "ch": "aabb01...eeff",
  "from": "base64url-wallet-pubkey",
  "ts": 1779170000100
}
```

Heartbeat messages are not encrypted (they carry no sensitive payload) and
do not consume sequence numbers.

Recommended timing:

```text
ping interval  : 30 seconds
timeout        : 60 seconds
```

If no `pong` is received within the timeout, the peer should treat the
connection as dead, close the transport, and begin reconnect (Section 14).

## 13. Close and Reject

`close` ends the channel or rejects an invalid operation.

Reject a wallet join request:

```json
{
  "v": 1,
  "t": "close",
  "ch": "aabb01...eeff",
  "from": "base64url-dapp-pubkey",
  "target": "base64url-wallet-pubkey",
  "reason": "user_rejected"
}
```

Normal close:

```json
{
  "v": 1,
  "t": "close",
  "ch": "aabb01...eeff",
  "from": "base64url-dapp-pubkey",
  "reason": "normal"
}
```

Close reasons:

| Reason | Meaning |
|---|---|
| `normal` | Normal close. |
| `user_rejected` | User rejected the wallet or closed the channel. |
| `unsupported_capability` | Wallet does not support a required chain or method. |
| `channel_not_found` | Wallet tried to join a missing channel. |
| `channel_exists` | Another dApp already owns the channel. |
| `already_connected` | Channel already has one dApp and one wallet. |
| `invalid_state` | Message is not allowed in current state. |
| `invalid_role` | Peer sent a message not allowed for its role. |
| `invalid_resume` | Resume token is missing or invalid. |
| `timeout` | Heartbeat or pairing confirmation timed out. |
| `payload_too_large` | Message exceeds 64 KB. |
| `protocol_error` | Malformed or unsupported message. |
| `unsupported_version` | Peer sent a `v` value the receiver does not support. |
| `decryption_failed` | Receiver could not decrypt `sealed` (bad seq, tampered data). |

A `close` may be sent by either peer or by the transport adapter. When the
adapter sends `close`, the `from` field is omitted.

## 14. Reconnect

When a peer receives `ready`, it should store the returned `resume` token.
The `resume` token is generated by the transport adapter (e.g., the relay)
and is opaque to the peer.

### 14.1 Resume Token Security

The relay MUST generate resume tokens with at least 128 bits of
cryptographic randomness. The relay MUST issue a new resume token on
every successful reconnect (token rotation). A used or expired resume
token MUST be invalidated immediately.

The relay MUST verify that the `from` field in the reconnect message
matches the original channel participant's public key. This prevents
an attacker who steals a resume token from impersonating the peer
(they would also need the corresponding private key for encryption).

If a peer loses its persisted sequence counter (e.g., due to app crash
or storage corruption), it MUST NOT attempt to reconnect. It MUST close
the channel and initiate a fresh pairing, because reusing sequence
numbers with the same session key would break AEAD security.

DApp reconnects by sending `create` with `resume`:

```json
{
  "v": 1,
  "t": "create",
  "ch": "aabb01...eeff",
  "from": "base64url-dapp-pubkey",
  "pubkey": "base64url-dapp-pubkey",
  "resume": "dapp-resume-token"
}
```

Wallet reconnects by sending `join` with `resume`:

```json
{
  "v": 1,
  "t": "join",
  "ch": "aabb01...eeff",
  "from": "base64url-wallet-pubkey",
  "pubkey": "base64url-wallet-pubkey",
  "resume": "wallet-resume-token"
}
```

Reconnect messages must include `from` and `pubkey` so the relay can verify
the peer identity matches the original channel participant.

If the token is valid, the relay restores the previous state without requiring
a new `accept`. If the other peer is still connected, the relay immediately
sends `ready.connected` to the reconnecting peer. If the other peer is also
disconnected, the relay sends `ready.waiting` and will send `ready.connected`
to both once the other peer also reconnects.

The previously negotiated session key remains valid. Peers must persist their
send and receive sequence counters across reconnects and continue from the
persisted values. **Sequence counters must never be reset**, because doing so
would cause nonce reuse and break AEAD security.

After reconnect, there may be gaps in the sequence numbers (in-flight messages
lost when the transport dropped). The sequence validation rule in Section 7.4
(must be strictly greater than last accepted) already handles this correctly
without special-case logic.

If the token is invalid, the relay rejects with:

```json
{
  "v": 1,
  "t": "close",
  "ch": "aabb01...eeff",
  "reason": "invalid_resume"
}
```

Recommended reconnect backoff:

```text
1s -> 2s -> 5s -> 10s -> 30s
```

After reconnect:

1. The dApp may retry pending requests with the same `req.id` (using new
   sequence numbers for encryption).
2. The wallet should deduplicate duplicate request IDs within a short window.
3. The dApp should refresh state by calling a method like `wallet_getAccounts`
   if missed events matter.

## 15. State Machine

### DApp State

```text
idle
  -> send create ---------------------------------> waiting
waiting
  -> receive join -------------------------------> pending_accept
  -> receive close ------------------------------> closed
  -> timeout ------------------------------------> closed
pending_accept
  -> user confirms pairing code -> send accept --> connected
  -> user rejects -> send close -----------------> closed
  -> timeout ------------------------------------> closed
connected
  -> send req
  -> receive res
  -> receive evt
  -> send/receive ping/pong
  -> send close ---------------------------------> closed
  -> receive close ------------------------------> closed
  -> transport disconnected ---------------------> disconnected
disconnected
  -> send create with resume --------------------> waiting
     (relay may respond with ready.waiting or
      ready.connected depending on other peer)
  -> give up ------------------------------------> closed
closed
  (terminal state)
```

### Wallet State

```text
idle
  -> send join ----------------------------------> waiting_accept
waiting_accept
  -> receive ready.connected --------------------> connected
  -> receive close ------------------------------> closed
  -> timeout ------------------------------------> closed
connected
  -> receive req
  -> send res
  -> send evt
  -> send/receive ping/pong
  -> send close ---------------------------------> closed
  -> receive close ------------------------------> closed
  -> transport disconnected ---------------------> disconnected
disconnected
  -> send join with resume ----------------------> waiting_accept
     (relay may respond with ready.waiting or
      ready.connected depending on other peer)
  -> give up ------------------------------------> closed
closed
  (terminal state)
```

## 16. Protocol Rules

1. A channel is created by the dApp.
2. A channel is joined by the wallet.
3. The dApp must accept the wallet before the channel is connected.
4. A channel can have at most one dApp and one wallet.
5. Only the dApp sends `req`.
6. Only the wallet sends `res` and `evt`.
7. `req`, `res`, and `evt` are valid only after `ready.connected`.
8. After `ready.connected`, payload content must be encrypted in the `sealed`
   field using the session key.
9. `resume` is secret and must not be shown to users.
10. A closed channel cannot carry more requests, responses, or events.
11. A single message must not exceed 64 KB on the wire.
12. A peer should have at most 32 pending (unanswered) requests per channel.
13. If a peer receives a message with an unsupported `v` value, it must reply
    with `close` reason `unsupported_version`.
14. Encryption sequence counters must never be reset. They persist across
    reconnects for the lifetime of the channel.

## 17. Transport Requirements

A transport adapter must provide:

1. Bidirectional delivery.
2. Ordered delivery while connected.
3. Channel creation by the dApp.
4. Wallet join delivery to the dApp.
5. Generation of `ready` messages to both peers (including `ready.waiting` to
   the wallet after a valid `join`).
6. State enforcement per Section 15.
7. Role enforcement per Section 3.
8. Heartbeat timeout handling.
9. Resume-token generation and validation for reconnect.

The adapter may be centralized or peer-to-peer.

## 18. WebSocket Relay Binding

### 18.1 Relay Philosophy

A WalletPair relay is a dumb pipe. It routes messages by channel ID and
enforces basic protocol state. It does not:

- require registration, API keys, or project IDs
- inspect or decrypt payload content
- store long-term user data
- need any configuration beyond a listen address

A minimal relay can be a single binary under 1000 lines of code.

### 18.2 Connection

Example endpoint:

```text
wss://relay.example.com/v1
```

WebSocket subprotocol:

```text
walletpair.v1
```

### 18.3 Relay Behavior

The relay must:

1. Accept WalletPair JSON messages over WebSocket text frames.
2. Track channel state in memory (no persistent storage required).
3. Create a channel when it receives `create` from a dApp. Reply with
   `ready.waiting` to the dApp.
4. When it receives `join` from a wallet: forward the `join` to the dApp and
   reply with `ready.waiting` to the wallet.
5. Upon receiving `accept` from the dApp, send `ready.connected` to both peers.
6. Forward `req` to the wallet only after `ready.connected`.
7. Forward `res` and `evt` to the dApp only after `ready.connected`.
8. Reject invalid role or state transitions with `close`.
9. Generate opaque `resume` tokens and include them in `ready` messages.
10. Validate `resume` tokens on reconnect and verify that `from` matches the
    original channel participant.
11. Expire channels after a configurable TTL (recommended: 5 minutes for
    unpaired channels, 24 hours for connected channels).

The relay SHOULD implement rate limiting to prevent abuse:

- Per-IP channel creation rate limit (recommended: 10 channels per
  minute per IP).
- Per-IP connection limit (recommended: 50 concurrent connections
  per IP).
- Message rate limit per channel (recommended: 60 messages per
  minute per peer).

These limits preserve the "zero registration" principle while preventing
resource exhaustion attacks. Relay operators MAY adjust limits based on
their deployment context.

The relay must not:

1. Require any form of authentication, registration, or API key.
2. Inspect, log, or store `sealed` content beyond immediate delivery.

### 18.4 Self-Hosting

A relay should be deployable with a single command:

```bash
docker run -p 8080:8080 walletpair/relay
```

No environment variables, API keys, or external dependencies are required for
basic operation. Operators may optionally configure:

- Listen address and port
- TLS certificate (or use a reverse proxy)
- Channel TTL values
- Maximum concurrent channels

### 18.5 Multiple Relays

When the pairing URI contains multiple `relay` parameters, the dApp must
create the channel on all listed relays and maintain connections to all of
them until one relay successfully delivers a `join`.

The wallet tries relays in order and uses the first one that connects and
has the channel. Since the session key is derived from the key pair (not the
relay), switching relays does not affect encryption.

## 19. Bluetooth Binding

### 19.1 Overview

In Bluetooth mode, the dApp still owns the WalletPair channel, regardless of
Bluetooth central/peripheral roles.

Bluetooth is ideal for local pairing when no internet is available. The
protocol messages are identical; only the transport layer changes.

In Bluetooth mode, there is no relay. The BLE stack itself acts as the
transport adapter and must enforce state transitions and generate `ready`
messages locally.

### 19.2 Discovery

The dApp creates a channel and advertises it through one of:

| Method | Use Case |
|---|---|
| QR code | DApp shows QR on screen, wallet scans. |
| NFC tap | Mobile-to-mobile or hardware wallet. |
| BLE advertisement | Wallet discovers nearby dApps. |

The QR code or NFC payload contains the pairing URI (Section 9.1) without the
`relay` parameter.

### 19.3 BLE Service

Recommended BLE GATT service:

```text
Service UUID: to be assigned
  Characteristic: Channel (read)     - returns pairing URI
  Characteristic: Message (write)    - wallet writes messages to dApp
  Characteristic: Message (notify)   - dApp sends messages to wallet
```

### 19.4 Flow

1. DApp creates `ch`. BLE adapter returns `ready.waiting` to the dApp.
2. DApp exposes pairing URI via QR, NFC, or BLE advertisement.
3. Wallet discovers the pairing URI and obtains the dApp's public key.
4. Wallet computes session key and pairing code. Wallet displays code
   and prompts user: "Connect to [DApp]? Code: XXXXXX".
5. User confirms code matches the dApp display and taps Connect.
6. Wallet connects via BLE and sends `join` with public key and capabilities.
7. BLE adapter forwards `join` to dApp and sends `ready.waiting` to wallet.
8. DApp computes session key and pairing code. DApp auto-accepts.
9. BLE adapter generates `ready.connected` for both sides.
10. DApp sends `req`. Wallet sends `res` and optional `evt`.
11. All payloads are encrypted with the session key.

### 19.5 Message Framing

Bluetooth MTU is typically small (23-517 bytes). Messages larger than MTU
must be fragmented. Recommended framing for each BLE write/notification:

```text
[1 byte flags] [2 bytes total length, big-endian unsigned] [payload fragment]

flags:
  bit 0: 1 = first fragment
  bit 1: 1 = last fragment
  bits 2-7: reserved
```

The `total length` field is only meaningful in the first fragment and
indicates the total payload size (max 65535 bytes, within the 64 KB protocol
limit). Subsequent fragments set total length to 0.

The receiver assembles fragments until the last-fragment flag is set, then
parses the complete JSON message.

## 20. Security

### 20.1 Threat Model

WalletPair assumes the transport (relay or Bluetooth) may be compromised.
The relay operator, network attacker, or eavesdropper should not be able to:

- read request parameters, response results, or event data
- impersonate a peer
- replay messages to cause duplicate signing

### 20.2 Protections

| Threat | Protection |
|---|---|
| Eavesdropping | E2E encryption with X25519 + ChaCha20-Poly1305. |
| Man-in-the-middle | Pairing code derived from shared secret; user visual verification. |
| Peer impersonation | Peer ID is the X25519 public key; relay verifies on reconnect. |
| Replay | Sequence-number-based nonce; receiver rejects out-of-order seq. |
| Channel hijack | Channel ID is 32 random bytes (256-bit entropy). |
| Relay compromise | Relay only sees encrypted `sealed` blobs and routing metadata. |

### 20.3 Rules

1. `ch` must be cryptographically random (256 bits).
2. `from` must match the sender's X25519 public key.
3. `resume` is secret and must be stored like a session token.
4. User confirmation of pairing code proves absence of MITM, not identity.
5. Ephemeral key pairs must be generated per channel.
6. Implementations must reject messages with sequence numbers that are not
   strictly greater than the last accepted value.
7. The relay must not log or store `sealed` content beyond delivery.
8. Sequence counters must never be reset for a given session key.

### 20.4 Privacy Considerations

The following fields are visible to the relay in plaintext:

- `ch` (channel ID)
- `from` (public key / peer ID)
- `method` (request method name)
- `event` (event name)
- `meta` (display metadata during handshake)
- `capabilities` (wallet capabilities during handshake)

This metadata leakage allows a malicious relay to build user behavior
profiles (when transactions are signed, which chains are used, wallet
type and capabilities). Privacy-sensitive implementations SHOULD mitigate
this:

- Use a generic `method` value (e.g., `encrypted`) and include the real
  method name inside the encrypted `sealed` payload. The wallet and dApp
  SHOULD agree on this via a `privacy_mode` capability.
- Omit `meta` from handshake messages.
- Use a minimal `capabilities` declaration during handshake.

Implementations that prioritize privacy SHOULD treat method/event name
encryption as the default behavior, not an optional optimization.

### 20.5 Close Message Trust

A `close` message may be sent by the transport adapter (relay) without a
`from` field. This means a malicious relay can terminate any session at
will. This is an inherent trust assumption of using a relay — the relay
can always sever the connection (e.g., by dropping WebSocket frames).

The relay cannot forge encrypted messages or impersonate a peer (it does
not have the session key), so the worst a malicious relay can do is deny
service. Peers SHOULD implement reconnect logic (Section 14) to recover
from relay-initiated disconnections. For critical operations, peers
SHOULD use multiple relays for redundancy.

### 20.6 Icon and Image URL Safety

URLs in `meta.icon`, `iconUrls`, and `image` fields may be used for
tracking (the wallet loading an icon reveals its IP address to the URL
host). Wallet implementations SHOULD either:

- Not load remote URLs automatically, or
- Load them through a privacy proxy, or
- Only load URLs with `https:` scheme and warn on other schemes.

## 21. Complete Example

### Pairing URI (shown as QR code)

```text
walletpair:?ch=aabb01...eeff&pubkey=dGhpcyBpcyBh...&relay=wss%3A%2F%2Frelay.example.com%2Fv1&name=MyDApp
```

### DApp creates channel

```json
{
  "v": 1,
  "t": "create",
  "ch": "aabb01...eeff",
  "from": "base64url-dapp-pubkey",
  "pubkey": "base64url-dapp-pubkey",
  "meta": { "name": "MyDApp" }
}
```

### Relay confirms channel created

```json
{
  "v": 1,
  "t": "ready",
  "ch": "aabb01...eeff",
  "state": "waiting",
  "role": "dapp",
  "self": "base64url-dapp-pubkey",
  "resume": "opaque-resume-token-1"
}
```

### Wallet joins with capabilities

```json
{
  "v": 1,
  "t": "join",
  "ch": "aabb01...eeff",
  "from": "base64url-wallet-pubkey",
  "pubkey": "base64url-wallet-pubkey",
  "capabilities": {
    "methods": ["wallet_signTransaction", "wallet_signMessage"],
    "events": ["accountsChanged", "chainChanged"],
    "chains": ["eip155:1", "eip155:137"]
  },
  "meta": { "name": "MyWallet" }
}
```

### Relay confirms wallet joined

```json
{
  "v": 1,
  "t": "ready",
  "ch": "aabb01...eeff",
  "state": "waiting",
  "role": "wallet",
  "self": "base64url-wallet-pubkey",
  "resume": "opaque-resume-token-2"
}
```

### Wallet confirms pairing code and DApp accepts

```text
DApp:   "Pairing code: 847293"  (displayed since channel creation)
Wallet: "Connect to MyDApp? Pairing code: 847293"  (user taps Connect)
DApp:   auto-accepts after receiving join
```

### DApp accepts

```json
{
  "v": 1,
  "t": "accept",
  "ch": "aabb01...eeff",
  "from": "base64url-dapp-pubkey",
  "target": "base64url-wallet-pubkey"
}
```

### Relay sends ready.connected to both peers

DApp receives:

```json
{
  "v": 1,
  "t": "ready",
  "ch": "aabb01...eeff",
  "state": "connected",
  "role": "dapp",
  "self": "base64url-dapp-pubkey",
  "remote": "base64url-wallet-pubkey",
  "resume": "opaque-resume-token-3"
}
```

Wallet receives:

```json
{
  "v": 1,
  "t": "ready",
  "ch": "aabb01...eeff",
  "state": "connected",
  "role": "wallet",
  "self": "base64url-wallet-pubkey",
  "remote": "base64url-dapp-pubkey",
  "resume": "opaque-resume-token-4"
}
```

### DApp sends encrypted request (seq=0)

```json
{
  "v": 1,
  "t": "req",
  "ch": "aabb01...eeff",
  "id": "req-001",
  "from": "base64url-dapp-pubkey",
  "method": "wallet_signTransaction",
  "sealed": "base64url-encrypted-params"
}
```

### Wallet sends encrypted response (seq=0)

```json
{
  "v": 1,
  "t": "res",
  "ch": "aabb01...eeff",
  "id": "req-001",
  "from": "base64url-wallet-pubkey",
  "ok": true,
  "sealed": "base64url-encrypted-result"
}
```

### Wallet pushes encrypted event (seq=1)

```json
{
  "v": 1,
  "t": "evt",
  "ch": "aabb01...eeff",
  "id": "evt-001",
  "from": "base64url-wallet-pubkey",
  "event": "accountsChanged",
  "sealed": "base64url-encrypted-data"
}
```
