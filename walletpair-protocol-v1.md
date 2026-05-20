# WalletPair Protocol v1

Status: Draft

WalletPair Protocol is a minimal, permissionless two-party channel protocol for
connecting dApps and wallets.

In WebSocket mode, a relay server is still needed
to route messages between the two parties. However, unlike protocols that depend
on a single vendor's infrastructure, WalletPair allows anyone to deploy their
own relay — dApp developers can run a dedicated relay server, and the wallet can
switch between relays freely.In Bluetooth mode, no relay is needed at all. No
registration, API key, or vendor lock-in is required in either case.

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
wallet methods. To reject a wallet, the dApp sends `close` with an
appropriate reason (e.g., `user_rejected` or `unsupported_capability`).
There is no separate reject message.

The dApp may send:

```text
create
accept
req
ping
pong
close          (also used to reject a wallet join request)
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
acts as the channel state manager: when the dApp calls `create`, the
adapter replies with `ready.waiting`; when the wallet calls `join` and
the dApp sends `accept`, the adapter sends `ready.connected` to both
sides.

The adapter may send:

```text
ready          (channel state notification)
terminate      (adapter-initiated channel termination)
```

Neither the dApp nor the wallet sends `ready` or `terminate`. Adapter
messages use `from` = `"_adapter"` (a reserved identifier, not a
cryptographic key). Peers MUST reject any peer-sent message where
`from` equals `"_adapter"`.

The wallet does not create channels. The dApp does not send events.

## 4. Identifiers

### Channel ID

Field: `ch`

The channel ID identifies one pending or connected channel. It must be a
random 32-byte value encoded as hex (64 characters).

### Sender Identity

Field: `from`

The `from` field is present in **every** message and identifies the sender:

- **Peer-sent messages** (`create`, `join`, `accept`, `req`, `res`,
  `evt`, `ping`, `pong`, `close`): `from` is the sender's X25519 public
  key, encoded as base64url (no padding). This binds identity to
  cryptographic material and prevents impersonation.
- **Adapter-sent messages** (`ready`, `terminate`): `from` is the
  reserved string `"_adapter"`. This is not a cryptographic key. Peers
  MUST treat `"_adapter"` as a reserved value and MUST reject any
  peer-sent message where `from` equals `"_adapter"`.

### Request ID

Field: `id`

The dApp generates a unique request ID for every `req`. The wallet must copy
the same `id` into the matching `res`. The request ID should be a UUID v4 or
another random string with sufficient entropy to avoid collisions.

## 5. Message Format

Every WalletPair message is one JSON object with a fixed envelope and a
type-specific body.

### 5.1 Envelope

All messages share the same top-level envelope fields:

```json
{
  "v": 1,
  "t": "message_type",
  "ch": "channel-id",
  "ts": 1779170000000,
  "from": "base64url-pubkey-or-_adapter",
  "body": { }
}
```

| Field  | Required | Description |
|--------|----------|-------------|
| `v`    | yes | Protocol version. Must be `1`. |
| `t`    | yes | Message type. |
| `ch`   | yes | Channel ID (hex, 64 chars). |
| `ts`   | yes | Sender timestamp in milliseconds (Unix epoch). |
| `from` | yes | Sender identity. X25519 public key (base64url) for peer messages, `"_adapter"` for adapter messages. |
| `body` | yes | Type-specific payload. Schema determined by `t`. |

### 5.2 Body Schemas

Each message type defines its own `body` schema. **All fields listed are
required.** Use `null` when the value is not applicable (e.g., `resume`
is `null` on first connection, `remote` is `null` when state is
`waiting`).

| `t` | `body` fields |
|-----|---------------|
| `create` | `meta`, `resume` |
| `join` | `sealed_join`, `resume` |
| `accept` | `target` |
| `ready` | `state`, `role`, `self`, `remote`, `resume` |
| `req` | `id`, `sealed` |
| `res` | `id`, `ok`, `sealed` |
| `evt` | `id`, `sealed` |
| `ping` | (empty object) |
| `pong` | (empty object) |
| `close` | `reason` |
| `terminate` | `reason` |

Body field descriptions:

| Field | In `body` of | Description |
|-------|-------------|-------------|
| `meta` | `create` | Display metadata object (e.g., `{ "name": "MyDApp" }`). Use `{}` if no metadata. |
| `sealed_join` | `join` | Encrypted capabilities and metadata, base64url. See Section 7.5. |
| `resume` | `create`, `join`, `ready` | Reconnect token (Section 14). `null` on first connection. |
| `target` | `accept` | Target peer ID (wallet public key, base64url). |
| `state` | `ready` | `"waiting"` or `"connected"`. |
| `role` | `ready` | Local role: `"dapp"` or `"wallet"`. |
| `self` | `ready` | Local peer ID (base64url public key). |
| `remote` | `ready` | Remote peer ID (base64url public key). `null` when `state` is `"waiting"`. |
| `id` | `req`, `res`, `evt` | Request or event ID. |
| `sealed` | `req`, `res`, `evt` | Encrypted payload, base64url. See Section 7.4. |
| `ok` | `res` | Boolean. Whether the request succeeded. |
| `reason` | `close`, `terminate` | Close or termination reason. |

### 5.3 Sealed Payload Content

The `sealed` field contains encrypted JSON. The real method or event name
is carried **inside** the encrypted payload, never on the wire in
plaintext. The decrypted content depends on the message type:

| Message type | Decrypted `sealed` content |
|-------------|---------------------------|
| `req` | `{ "_method": "<method_name>", ...params }` |
| `res` with `ok=true` | result object (e.g., `{ "txHash": "0x..." }`) or `null` |
| `res` with `ok=false` | `{ "code": "<error_code>", "message": "<description>" }` |
| `evt` | `{ "_event": "<event_name>", ...data }` |

The `_method` and `_event` fields are required. If missing after
decryption, the receiver MUST reject with `invalid_params`.

When the payload is logically empty, encrypt `{ "_method": "<name>" }`
(for req), `null` (for result), or `{ "_event": "<name>" }` (for evt).
Every `req`, `res`, and `evt` MUST carry a `sealed` field — a message
without `sealed` after `ready.connected` MUST be rejected.

Note: The plaintext fields `params`, `result`, `error`, and `data` never
appear on the wire. Their content is encrypted into the `sealed` field.
The receiver decrypts `sealed` to recover the original JSON value. See
Section 7.4 for encryption details.

## 6. Message Types

WalletPair v1 has eleven message types:

Peer-sent messages:

```text
create    (dApp -> adapter)           channel creation
join      (wallet -> dApp)            wallet joins channel
accept    (dApp -> wallet)            dApp accepts wallet
req       (dApp -> wallet)            encrypted request
res       (wallet -> dApp)            encrypted response
evt       (wallet -> dApp)            encrypted event
ping      (either peer -> peer)       heartbeat
pong      (either peer -> peer)       heartbeat reply
close     (either peer -> peer)       peer-initiated close or reject
```

Adapter-sent messages:

```text
ready     (adapter -> peer)           channel state notification
terminate (adapter -> peer)           adapter-initiated termination
```

There is no separate `error` message. Request errors use `res.body.ok = false`.
Channel errors and rejection use `close`. Adapter-initiated shutdown uses
`terminate`.

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
4. Both sides can now independently derive the root key and, after `join`,
   the direction-specific traffic keys.

### 7.2 Shared Secret and Directional Key Derivation

```text
shared_secret = X25519(local_private_key, remote_public_key)
root_key      = HKDF-SHA256(
                  ikm  = shared_secret,
                  salt = channel_id_bytes,   // 32 bytes, decoded from hex
                  info = "walletpair-v1 root"
                )[0:32]                      // 32 bytes output
```

After the wallet sends `join`, both peers construct the same handshake
transcript:

```text
transcript_hash = SHA256(
  "walletpair-v1-transcript" ||
  channel_id_bytes ||
  lp(dapp_pubkey_base64url) ||
  lp(wallet_pubkey_base64url) ||
  lp(canonical_json(capabilities or null)) ||   // from decrypted sealed_join
  lp(canonical_json(meta or null)) ||            // from decrypted sealed_join
  lp(dapp_name_from_pairing_uri or "")
)
```

`canonical_json` is UTF-8 JSON with the following deterministic rules,
which are compatible with [RFC 8785 (JSON Canonicalization Scheme,
JCS)](https://www.rfc-editor.org/rfc/rfc8785). Implementations MAY use
a conforming RFC 8785 library directly. All object keys in this protocol
are ASCII; non-ASCII keys are reserved for future versions.

1. **Object keys** are sorted lexicographically by their UTF-8 byte
   representation (not by Unicode code point — in practice these are
   identical for ASCII keys used in this protocol).
2. **No insignificant whitespace** — no spaces after `:` or `,`, no
   newlines or indentation.
3. **`undefined`** is represented as `null`.
4. **Numbers** use the shortest decimal representation with no trailing
   zeroes (e.g., `1` not `1.0`, `0` not `0.0`). No leading zeroes. No
   `+` prefix. Negative zero is serialized as `0`.
5. **Strings** use `\uXXXX` escaping only for control characters
   (U+0000–U+001F). Printable characters including non-ASCII Unicode
   are serialized as literal UTF-8, not escaped. The mandatory JSON
   escapes (`\"`, `\\`, `\/`, `\b`, `\f`, `\n`, `\r`, `\t`) use the
   short form. Forward slash `/` MUST NOT be escaped.
6. **`null`**, **`true`**, **`false`** use their literal JSON forms.
7. Sorting is recursive: nested objects also have their keys sorted.

**Canonical JSON test vectors:**

```text
Input:  { "methods": ["wallet_signTransaction", "wallet_signMessage"],
          "events": ["accountsChanged", "chainChanged"],
          "chains": ["eip155:1", "eip155:137"] }

canonical_json output (UTF-8 bytes):
{"chains":["eip155:1","eip155:137"],"events":["accountsChanged","chainChanged"],"methods":["wallet_signTransaction","wallet_signMessage"]}

SHA-256 of above bytes:
4da366e2aae26b47b3d90fff52410752348733350ce2525dce7d64510f571333
```

```text
Input:  null
canonical_json output: null
```

```text
Input:  { "name": "MyWallet" }
canonical_json output: {"name":"MyWallet"}
```

Implementations MUST verify their canonical JSON output matches these test
vectors byte-for-byte before deployment. See also Appendix A for a complete
end-to-end test vector including canonical JSON in the transcript hash.

The traffic keys are direction-specific:

```text
dapp_to_wallet_key = HKDF-SHA256(
                       ikm  = root_key,
                       salt = transcript_hash,
                       info = "walletpair-v1 dapp-to-wallet"
                     )[0:32]

wallet_to_dapp_key = HKDF-SHA256(
                       ikm  = root_key,
                       salt = transcript_hash,
                       info = "walletpair-v1 wallet-to-dapp"
                     )[0:32]
```

The same key MUST NOT be used in both directions. `req` messages use
`dapp_to_wallet_key`; `res` and `evt` messages use `wallet_to_dapp_key`.
If a relay tampers with the wallet public key, capabilities, wallet
metadata, or dApp name visible to one peer, the peers derive different
pairing codes and traffic keys.

For private handshake (Section 7.5), the wallet encrypts capabilities
and metadata before sending `join`. This uses a separate key derived
from the root key:

```text
join_encryption_key = HKDF-SHA256(
                        ikm  = root_key,
                        salt = channel_id_bytes,
                        info = "walletpair-v1 join-encryption"
                      )[0:32]
```

This key is available to both peers at `join` time because the wallet
knows the dApp public key from the pairing URI and can compute the
shared secret and root key before sending `join`. The dApp computes the
same key after receiving the wallet's public key in `join`.

### 7.3 Pairing Code

After the wallet `join` message is delivered, both sides independently derive
a 4-digit pairing code:

```text
code_bytes   = HKDF-SHA256(
                 ikm  = root_key,
                 salt = transcript_hash,
                 info = "walletpair-pairing-code"
               )[0:4]                          // first 4 bytes (indices 0,1,2,3)
code_uint32  = big-endian uint32(code_bytes)
pairing_code = code_uint32 mod 10000           // zero-pad to 4 digits
```

The wallet can compute its local pairing code before sending `join`, because
it has generated its own public key and knows the dApp public key from the
pairing URI. However, the dApp cannot compute the same code until it receives
the wallet public key in `join`. Therefore, the wallet MUST NOT treat the code
as confirmed before `join` is sent.

The secure flow is:

1. The wallet scans the URI, computes its local code, and sends `join`.
2. The dApp receives `join`, computes the same code, and displays it.
3. The user compares the code displayed by the wallet and the dApp.
4. The dApp sends `accept` only after the user confirms the codes match.

A dApp MUST NOT auto-accept a first-time wallet connection. It MAY auto-accept
a previously paired wallet only if it verifies the same wallet public key and
the same approved session scope.

This prevents man-in-the-middle attacks: if a relay substitutes public
keys or tampers with the authenticated handshake context, both sides will
derive different root/traffic keys and different pairing codes. The user
will see mismatched codes and reject the connection.

### 7.4 Message Encryption

After `ready.connected`, payload fields must be encrypted into the
`body.sealed` field. See §5.3 for the mapping between message types and
their encrypted content.

Encryption uses ChaCha20-Poly1305 with the direction-specific traffic key:

```text
nonce    = HMAC-SHA256(traffic_key, seq_bytes)[0:12]   // first 12 bytes
aad      = concat(channel_id_bytes, aad_header)
sealed   = AEAD_encrypt(traffic_key, nonce, plaintext_json_utf8, aad)
envelope = base64url_no_pad(seq_bytes || ciphertext || tag)
```

The `aad_header` authenticates the plaintext envelope fields to prevent a
compromised relay from tampering with routing metadata. It uses
length-prefixed encoding to avoid delimiter ambiguity:

```text
lp(s) = uint16_be(byte_length(utf8(s))) || utf8(s)

req:  aad_header = 0x01 || lp(from) || lp(id)
res:  aad_header = 0x02 || lp(from) || lp(id) || (ok ? 0x01 : 0x00)
evt:  aad_header = 0x03 || lp(from) || lp(id)
```

The leading type byte doubles as a `t`+`v` binding (type bytes `0x01`-`0x03`
are defined for protocol version 1 only). The `ch` field is already bound
via `channel_id_bytes` in the AAD prefix.

The `lp()` function uses a 2-byte length prefix (uint16_be), supporting
field UTF-8 byte lengths up to 65535. If any field exceeds 65535 UTF-8
bytes, the sender MUST reject the message before encryption. In practice,
all AAD fields (`from`, `id`) are short strings well within this limit.

The leading type byte (`0x01`/`0x02`/`0x03`) and length-prefixed fields
ensure unambiguous parsing regardless of field content. If a relay
modifies any plaintext field (`from`, `id`, `ok`), AEAD decryption will
fail.

**AAD test vector** (for cross-implementation verification):

```text
Given:  ch = "aa" repeated 32 times (64 hex chars)
        type = req (0x01)
        from = "dGVzdA" (base64url of "test")
        id   = "req-1"

aad_header = 01                       (type byte)
           | 0006 6447567A6441       (lp("dGVzdA") = 6 bytes)
           | 0005 7265712D31         (lp("req-1") = 5 bytes)
aad = channel_id_bytes || aad_header
```

Where `seq_bytes` is a 4-byte big-endian sequence number. Each peer maintains
its own send counter, starting at 0 and incrementing by 1 for each message
that carries a `sealed` field.

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
  "ts": 1779170000000,
  "from": "base64url-dapp-pubkey",
  "body": {
    "id": "req-001",
    "sealed": "base64url-of-seq-ciphertext-tag"
  }
}
```

Method and event names are never on the wire. They exist only inside the
encrypted `sealed` payload (see §5.3). The relay cannot determine what
operations are being performed.

### 7.5 Encrypted Join (sealed_join)

The `join` message always encrypts capabilities and metadata in the
`body.sealed_join` field. The relay cannot read the wallet's
capabilities, supported chains, methods, or identity.

#### Encryption

The wallet encrypts its capabilities and metadata using the
`join_encryption_key` derived in Section 7.2:

```text
join_plaintext = canonical_json({
  "capabilities": { ... },
  "meta": { ... }
})

join_nonce     = HMAC-SHA256(join_encryption_key, "walletpair-v1-join-nonce")[0:12]
join_aad       = channel_id_bytes || 0x04   // type byte 0x04 = sealed_join
sealed_join    = AEAD_encrypt(join_encryption_key, join_nonce, join_plaintext, join_aad)
envelope       = base64url_no_pad(sealed_join_ciphertext || tag)
```

The nonce is deterministic because `sealed_join` is a one-shot
encryption per channel — the wallet sends exactly one `join` per
channel, so the (key, nonce) pair is never reused.

The type byte `0x04` is reserved for `sealed_join` in protocol
version 1.

#### Wire format

```json
{
  "v": 1,
  "t": "join",
  "ch": "aabb01...eeff",
  "ts": 1779170000000,
  "from": "base64url-wallet-pubkey",
  "body": {
    "sealed_join": "base64url-encrypted-capabilities-and-meta",
    "resume": null
  }
}
```

#### DApp processing

Upon receiving a `join`:

1. The dApp computes `shared_secret`, `root_key`, and
   `join_encryption_key` using the wallet's public key from `from`.
2. The dApp decrypts `body.sealed_join` to recover `capabilities` and
   `meta`.
3. If decryption fails, the dApp MUST close with `decryption_failed`.
4. The dApp uses the decrypted `capabilities` and `meta` for all
   subsequent operations (transcript hash, pairing code, accept/reject
   decision).

The transcript hash (Section 7.2) is computed over the **decrypted**
capabilities and meta values. Both peers produce identical transcript
hashes because they decrypt the same `sealed_join` content.

#### Relay transparency

The relay does not need to understand `sealed_join`. It forwards the
`join` message to the dApp as an opaque JSON object. The relay cannot
read capabilities, meta, supported chains, or wallet type.

## 8. Capability Negotiation

The wallet declares its capabilities inside the encrypted `sealed_join`
field of the `join` message (see §7.5). The decrypted content is:

```json
{
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
    "name": "Wallet"
  }
}
```

The dApp decrypts `sealed_join`, inspects `capabilities` before calling
`accept`. If the wallet does
not support a required chain or method, the dApp may `close` with
`unsupported_capability`.

Capability fields:

| Field       | Type     | Description                                      |
| ----------- | -------- | ------------------------------------------------ |
| `methods` | string[] | Methods authorized for this session.             |
| `events`  | string[] | Event types the wallet may push in this session. |
| `chains`  | string[] | CAIP-2 chains authorized for this session.       |

All three fields are required in `capabilities`. An empty array means the
wallet explicitly supports none of that category.

The wallet SHOULD include a `version` field in `capabilities` to declare
the sub-protocol versions it supports:

```json
{
  "capabilities": {
    "methods": [...],
    "events": [...],
    "chains": [...],
    "version": {
      "evm": 1
    }
  }
}
```

The `version` object maps sub-protocol namespace strings to integer version
numbers. This allows the dApp to verify sub-protocol compatibility before
`accept`. If the dApp requires a sub-protocol version the wallet does not
declare, the dApp SHOULD `close` with `unsupported_capability`. If
`version` is absent, the dApp MUST assume version 1 for all declared chain
namespaces (backward compatible with implementations that predate this
field).

The `capabilities` in the `join` message represents the **approved session
scope** — not the wallet's full capability set. When the pairing URI
includes `methods` and `chains`, the wallet MUST compute the intersection
(per §8.1) before populating `capabilities`. The dApp can inspect
`capabilities` to know exactly what was authorized without an extra round
trip.

After `ready.connected`, the dApp calls `wallet_getAccounts` to discover
the approved accounts. The combination of `capabilities` from the
decrypted `sealed_join` (methods, chains) and the `wallet_getAccounts`
response (accounts) constitutes the
complete approved session scope.

Account authorization is intentionally not placed in the plaintext `join`
message. Wallets that expose account-based methods MUST select or confirm the
session's account set during pairing, then reveal it only through encrypted
upper-layer methods such as `wallet_getAccounts`.

### 8.1 Session Scope Enforcement

The wallet's declared `capabilities` define the session scope. The wallet
MUST enforce these as a ceiling:

1. The wallet MUST reject any `req` whose `method` is not in
   `capabilities.methods` with error `unsupported_method`.
2. The wallet MUST reject any request targeting a chain not in
   `capabilities.chains` with error `unsupported_chain`.
3. The wallet MUST only expose accounts that were authorized for this
   session. Accounts authorized in one session MUST NOT leak into
   another.

When the pairing URI includes `methods` and/or `chains` (Section 9.1),
the wallet MUST restrict the session scope to the intersection of the
dApp's declared intent and the wallet's capabilities. For example, if
the dApp declares `methods=wallet_sendTransaction` but the wallet
supports `[wallet_sendTransaction, wallet_signTypedData]`, the wallet
MUST only authorize `wallet_sendTransaction` for this session and MUST
reject `wallet_signTypedData` with `unsupported_method`.

When the pairing URI omits `methods` and `chains`, the wallet MUST
treat this as a broad scope request and MUST display a prominent
warning to the user that the dApp did not declare its intent. The
wallet MAY require explicit per-method user confirmation in this case.

Session scope changes (account additions/removals, chain changes) are
communicated via `accountsChanged` and `chainChanged` events. The wallet
MUST NOT expand the session's method scope after pairing without the
dApp initiating a new session.

## 9. Pairing Flow

### 9.1 Pairing URI

The dApp generates a pairing URI that encodes the channel ID, the dApp public
key, and the relay endpoint. The wallet obtains this URI through an
**out-of-band channel** that is not controlled by the relay or any network
intermediary.

**Mandatory out-of-band delivery.** The pairing URI contains the dApp's
public key, which is the trust anchor for the entire session. The URI
MUST be delivered through a channel where a network attacker or
malicious relay cannot substitute the content:

| Delivery method         | Security                                                                                                                                                                                                                                        | Status                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| QR code (optical scan)  | Camera captures dApp screen directly. Relay not in path.                                                                                                                                                                                        | **REQUIRED** support.                               |
| NFC tap                 | Physical proximity required.                                                                                                                                                                                                                    | Permitted.                                                |
| BLE characteristic read | Physical proximity required.                                                                                                                                                                                                                    | Permitted.                                                |
| Deep link / URL scheme  | **INSECURE.** URI passes through OS URL handler, clipboard, browser extensions, or intent system. A malicious intermediary can replace the entire URI including the dApp public key, enabling a full MITM where pairing codes will match. | **MUST NOT** be used as the sole pairing mechanism. |
| Copy-paste              | URI may be intercepted by clipboard monitors.                                                                                                                                                                                                   | **MUST NOT** be used as the sole pairing mechanism. |

Wallets MUST support QR code scanning as the primary pairing method.
Wallets MUST NOT offer deep link or copy-paste as the only pairing
option. If a wallet supports deep link pairing as a convenience
mechanism (e.g., same-device dApp-to-wallet), it MUST display a
prominent security warning: "This connection was not established via
secure out-of-band channel. A malicious app on this device could
intercept the connection. For high-value transactions, use QR code
pairing from a separate device."

DApps MUST display a QR code as the primary pairing interface. DApps
MAY additionally offer deep links but MUST label them as "Less secure —
same device only."

Format:

```text
walletpair:?ch=<channel-id>&pubkey=<dapp-pubkey-base64url>&relay=<relay-url-percent-encoded>&name=<dapp-name>&methods=<comma-list>&chains=<comma-list>
```

Example:

```text
walletpair:?ch=aabb01...eeff&pubkey=dGhpcyBpcyBh...&relay=wss%3A%2F%2Frelay.example.com%2Fv1&name=MyDApp&methods=wallet_sendTransaction,wallet_signTypedData&chains=eip155:1,eip155:137
```

Parameters:

| Param            | Required                | Description                                                                                                                                                                                     |
| ---------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ch`           | yes                     | Channel ID (hex, 64 chars).                                                                                                                                                                     |
| `pubkey`       | yes                     | DApp X25519 public key (base64url, no padding).                                                                                                                                                 |
| `relay`        | yes for relay transport | WebSocket relay URL (percent-encoded).                                                                                                                                                          |
| `name`         | optional                | DApp display name.                                                                                                                                                                              |
| `methods`      | optional                | Comma-separated list of methods the dApp intends to call. When present, the wallet MUST restrict the session to these methods (see §8.1) and MUST display them to the user during pairing.     |
| `chains`       | optional                | Comma-separated list of CAIP-2 chains the dApp intends to use. When present, the wallet MUST restrict the session to these chains (see §8.1) and MUST display them to the user during pairing. |

When `methods` or `chains` are present, the wallet MUST show the user
what the dApp is requesting before the user confirms the connection, and
MUST enforce the declared scope per §8.1. If `methods` or `chains` are
absent, the wallet MUST warn the user that the dApp did not declare its
intent (see §8.1).

For Bluetooth pairing, the URI may omit `relay` and instead be transmitted
through BLE advertisement, NFC tap, or local QR code. All of these are
valid out-of-band channels.

Multiple relay endpoints can be specified by repeating the `relay` parameter:

```text
walletpair:?ch=...&pubkey=...&relay=wss%3A%2F%2Fr1.example.com%2Fv1&relay=wss%3A%2F%2Fr2.example.com%2Fv1
```

The dApp must create the channel on all listed relays. The wallet tries relays
in order and uses the first one that connects. Since the root and traffic keys
are derived from the peer keys and handshake transcript (not the relay),
switching relays does not affect encryption.

### 9.2 DApp Creates Channel

The dApp connects to the relay and sends:

```json
{
  "v": 1,
  "t": "create",
  "ch": "aabb01...eeff",
  "ts": 1779170000000,
  "from": "base64url-dapp-pubkey",
  "body": {
    "meta": {
      "name": "MyDApp"
    },
    "resume": null
  }
}
```

The relay replies:

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
    "resume": "relay-generated-resume-token"
  }
}
```

The `resume` token is generated by the relay and is opaque to the peer.

### 9.3 Wallet Joins

The wallet scans the pairing URI, generates its keypair, computes its local
root key and pairing code, displays the requested scope, and asks whether the
user wants to announce the wallet to the dApp:

```text
Wallet: "Connect to MyDApp? Requested: wallet_signTransaction on eip155:1.
Pairing code: 8472. Compare this with the dApp before it connects."
```

The dApp cannot display the matching code until it receives the wallet's
public key, so this is not yet a completed pairing confirmation. If the user
continues, the wallet connects to the relay and sends `join` with
capabilities and metadata encrypted in `sealed_join` (Section 7.5):

```json
{
  "v": 1,
  "t": "join",
  "ch": "aabb01...eeff",
  "ts": 1779170000000,
  "from": "base64url-wallet-pubkey",
  "body": {
    "sealed_join": "base64url-encrypted-capabilities-and-meta",
    "resume": null
  }
}
```

The relay cannot read the wallet's capabilities, supported chains, or
identity from this message.

The relay does two things:

1. Forwards the `join` message to the dApp.
2. Sends `ready.waiting` back to the wallet:

```json
{
  "v": 1,
  "t": "ready",
  "ch": "aabb01...eeff",
  "ts": 1779170000000,
  "from": "_adapter",
  "body": {
    "state": "waiting",
    "role": "wallet",
    "self": "base64url-wallet-pubkey",
    "remote": null,
    "resume": "wallet-waiting-resume-token"
  }
}
```

This gives the wallet a `resume` token so it can reconnect if the transport
drops during the waiting phase.

At this point:

- The wallet has displayed its local pairing code.
- The dApp now has the wallet's public key and can compute the same root key,
  transcript hash, traffic keys, and pairing code.
- The user must compare both displays before the dApp accepts.

### 9.4 DApp Accepts Wallet

The dApp computes its pairing code and displays it. For a first-time wallet,
the dApp MUST wait for explicit user confirmation that the wallet display
shows the same code and requested scope:

```text
DApp:   "Pairing code: 8472. Confirm this matches your wallet."
```

Only after confirmation does the dApp send:

The dApp sends:

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

The relay sends `ready.connected` to both peers:

DApp receives:

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
    "resume": "dapp-resume-token"
  }
}
```

Wallet receives:

```json
{
  "v": 1,
  "t": "ready",
  "ch": "aabb01...eeff",
  "ts": 1779170000000,
  "from": "_adapter",
  "body": {
    "state": "connected",
    "role": "wallet",
    "self": "base64url-wallet-pubkey",
    "remote": "base64url-dapp-pubkey",
    "resume": "wallet-resume-token"
  }
}
```

From this point on, both sides must encrypt payloads using the appropriate
direction-specific traffic key.
Both peers initialize their send and receive sequence counters to 0.

## 10. Request and Response

The dApp calls a wallet method with `req`. After `ready.connected`, all
payloads are encrypted.

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

The decrypted `sealed` contains `{ "_method": "wallet_signTransaction", ...params }`.

The wallet replies with exactly one `res`:

Successful response:

```json
{
  "v": 1,
  "t": "res",
  "ch": "aabb01...eeff",
  "ts": 1779170000000,
  "from": "base64url-wallet-pubkey",
  "body": {
    "id": "req-001",
    "ok": true,
    "sealed": "base64url-encrypted-result"
  }
}
```

Failed response:

```json
{
  "v": 1,
  "t": "res",
  "ch": "aabb01...eeff",
  "ts": 1779170000000,
  "from": "base64url-wallet-pubkey",
  "body": {
    "id": "req-001",
    "ok": false,
    "sealed": "base64url-encrypted-error"
  }
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
6. **Request idempotency.** The wallet MUST cache every processed
   request ID, its params hash, and its decrypted response (result or
   error object). The cache MUST hold at least the most recent 1024
   processed requests, evicted in LRU order. Wallets MAY use a larger
   cache. If a retried request's ID has been evicted, the wallet
   processes it as a new request (which is safe for read-only methods;
   for `wallet_sendTransaction`, see the broadcast-idempotency rule
   below).
   If the wallet receives a `req` with an `id` it has already processed
   and the entry is still in the cache:

   - If the params hash matches, the wallet MUST return the cached
     response by re-encrypting the cached result/error with a fresh
     sequence number. The wallet MUST NOT replay the old `sealed`
     bytes (they would be rejected by the sequence number rule).
   - If the params hash differs, the wallet MUST reject with
     `invalid_params` ("Duplicate request ID with different params").
     The **canonical params hash** is `SHA-256(plaintext_json_utf8)` —
     the raw UTF-8 bytes of the decrypted params JSON, before any
     parsing. The dApp MUST cache and reuse the exact
     `plaintext_json_utf8` bytes when retrying a request. The dApp
     MUST NOT re-serialize params from parsed objects, as this may
     produce different key ordering or whitespace.
     For `wallet_sendTransaction` specifically: if the wallet has already
     signed and broadcast a transaction for a given `req.id`, it MUST NOT
     sign or broadcast again — it MUST return the original `txHash`. To
     ensure this guarantee survives cache eviction, the wallet MUST
     persist broadcast tx hashes separately (keyed by `req.id`) until
     the channel is closed.

   **Cache entry size limit.** Each cached entry MUST store at most the
   params hash (32 bytes), the response status (ok/error), and the
   serialized response JSON. The wallet MUST cap individual cached
   response entries at 16 KB. If a response exceeds this limit, the
   wallet stores only the params hash and a flag indicating "response
   too large to cache"; on a cache hit with this flag, the wallet
   re-processes the request (safe for read-only methods). For
   `wallet_sendTransaction`, the broadcast tx hash (32 bytes) is
   always stored regardless of this limit.

   **Worst-case memory.** With 1024 cache entries at 16 KB each, the
   maximum idempotency cache size is 16 MB. Combined with the 32
   concurrent pending requests limit (§16 rule 12), a malicious dApp
   can generate at most 32 new cache entries per round-trip cycle.
   Wallets on memory-constrained devices MAY use a smaller cache
   (minimum 128 entries) and MUST document the reduced cache size in
   their capability declaration.

   **Cache security.** The idempotency cache contains decrypted
   response data, which may include signed transactions, signatures,
   or account information. Wallet implementations MUST store the cache
   in memory that is not swappable to disk, or encrypt the cache at
   rest using a key derived from the session's traffic key. The cache
   MUST be securely erased (zeroed) when the channel is closed. On
   platforms that do not support memory locking (e.g., browser
   environments), implementations SHOULD minimize cache lifetime and
   clear entries as soon as the dApp acknowledges receipt.

## 11. Wallet Events

The wallet can push an event to the dApp with `evt`.

```json
{
  "v": 1,
  "t": "evt",
  "ch": "aabb01...eeff",
  "ts": 1779170000000,
  "from": "base64url-wallet-pubkey",
  "body": {
    "id": "evt-001",
    "sealed": "base64url-encrypted-data"
  }
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
  "ts": 1779170000000,
  "from": "base64url-dapp-pubkey",
  "body": {}
}
```

The receiver replies with `pong`.

```json
{
  "v": 1,
  "t": "pong",
  "ch": "aabb01...eeff",
  "ts": 1779170000100,
  "from": "base64url-wallet-pubkey",
  "body": {}
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

### 12.1 Heartbeat Security

Heartbeat messages are **not encrypted** and do not consume sequence
numbers. This is intentional — heartbeats carry no sensitive payload and
must function even when encryption state is being established.

However, implementations MUST be aware of the following implications:

1. **Relay-forged heartbeats.** A malicious relay can forge `ping` or
   `pong` messages (including the `from` field) since they are not
   authenticated. This cannot cause data compromise but may confuse
   liveness detection.
2. **Heartbeat suppression.** A malicious relay can drop `pong` responses
   to make peers believe the connection is dead, triggering reconnection.
   This is a denial-of-service vector equivalent to the relay dropping
   any other message type — see §20.5.
3. **Timing metadata.** The `ts` field and heartbeat frequency are
   visible to the relay and can be used for timing analysis (e.g.,
   determining if a peer is active).

These risks are within the accepted threat model: a relay can always deny
service by dropping messages (§20.5). Peers SHOULD use reconnect logic
(§14) and multiple relays (§18.5) to mitigate relay-initiated disruption.

## 13. Close, Reject, and Terminate

### 13.1 Close (peer-initiated)

`close` is sent by a peer to end the channel or reject an operation.

Reject a wallet join request:

```json
{
  "v": 1,
  "t": "close",
  "ch": "aabb01...eeff",
  "ts": 1779170000000,
  "from": "base64url-dapp-pubkey",
  "body": {
    "reason": "user_rejected"
  }
}
```

Normal close:

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

### 13.2 Terminate (adapter-initiated)

`terminate` is sent by the transport adapter to forcibly end a channel.
Only the adapter may send `terminate`. Peers MUST NOT send it.

```json
{
  "v": 1,
  "t": "terminate",
  "ch": "aabb01...eeff",
  "ts": 1779170000000,
  "from": "_adapter",
  "body": {
    "reason": "timeout"
  }
}
```

### 13.3 Reasons

The following reasons apply to both `close` and `terminate`. Some
reasons are only used by peers (P), some only by the adapter (A),
and some by both:

| Reason                     | Used by | Meaning                                                         |
| -------------------------- | ------- | --------------------------------------------------------------- |
| `normal`                 | P       | Normal close.                                                   |
| `user_rejected`          | P       | User rejected the wallet or closed the channel.                 |
| `unsupported_capability` | P       | Wallet does not support a required chain or method.             |
| `unsupported_version`    | P       | Peer sent a `v` value the receiver does not support.          |
| `decryption_failed`      | P       | Receiver could not decrypt `sealed` (bad seq, tampered data). |
| `channel_not_found`      | A       | Wallet tried to join a missing channel.                         |
| `channel_exists`         | A       | Another dApp already owns the channel.                          |
| `already_connected`      | A       | Channel already has one dApp and one wallet.                    |
| `invalid_resume`         | A       | Resume token is missing or invalid.                             |
| `invalid_state`          | P, A    | Message is not allowed in current state.                        |
| `invalid_role`           | P, A    | Peer sent a message not allowed for its role.                   |
| `timeout`                | P, A    | Heartbeat, pairing confirmation, or session lifetime timed out. |
| `rate_limited`           | P, A    | Too many pending requests or messages.                          |
| `payload_too_large`      | P, A    | Message exceeds 64 KB.                                          |
| `protocol_error`         | P, A    | Malformed or unsupported message.                               |

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
numbers with the same traffic key would break AEAD security.

**Sequence counter persistence strategy.** Implementations MUST use
write-ahead persistence: increment and persist the counter value
**before** sending the message. This ensures that a crash between
persist and send results in a harmless gap (the remote peer accepts
gaps per §7.4), rather than a dangerous counter reuse. Recommended
storage backends by platform:

- **Browser:** IndexedDB (not localStorage, which may be cleared by
  user or browser). Implementations SHOULD use a dedicated object
  store with explicit `durableObjectStore` transactions where
  available.
- **Mobile (iOS/Android):** Platform keychain or encrypted file
  storage. The counter MUST survive app termination and OS-initiated
  process kills.
- **Desktop/Server:** File-backed storage with `fsync` after each
  write, or a lightweight embedded database (e.g., SQLite with WAL
  mode).

If the platform cannot guarantee durable persistence (e.g., ephemeral
browser contexts, incognito mode), the implementation MUST NOT support
reconnect and MUST treat every transport disconnection as a terminal
channel close requiring fresh pairing.

DApp reconnects by sending `create` with `resume`:

```json
{
  "v": 1,
  "t": "create",
  "ch": "aabb01...eeff",
  "ts": 1779170000000,
  "from": "base64url-dapp-pubkey",
  "body": {
    "meta": {
      "name": "MyDApp"
    },
    "resume": "dapp-resume-token"
  }
}
```

Wallet reconnects by sending `join` with `resume`:

```json
{
  "v": 1,
  "t": "join",
  "ch": "aabb01...eeff",
  "ts": 1779170000000,
  "from": "base64url-wallet-pubkey",
  "body": {
    "sealed_join": null,
    "resume": "wallet-resume-token"
  }
}
```

On reconnect, `sealed_join` is set to `null` because capabilities were
already negotiated during the initial pairing. The relay and dApp already
have the session scope from the original `join`. The `resume` token
proves the wallet's identity for this channel.

Reconnect messages must include `from` so the relay can verify the peer
identity matches the original channel participant.

If the token is valid, the relay restores the previous state without requiring
a new `accept`. If the other peer is still connected, the relay immediately
sends `ready.connected` to the reconnecting peer. If the other peer is also
disconnected, the relay sends `ready.waiting` and will send `ready.connected`
to both once the other peer also reconnects.

**Simultaneous reconnect.** When both peers reconnect at approximately the
same time (e.g., after a relay restart), the relay MUST handle resume token
validation atomically per channel. Specifically:

1. The relay MUST serialize resume token validation and state transitions
   for a given channel ID. Two concurrent reconnect messages for the same
   channel MUST NOT cause a race condition where both receive
   `ready.waiting` but neither triggers `ready.connected`.
2. If both resume tokens are validated successfully, the relay MUST send
   `ready.connected` to both peers regardless of arrival order. The relay
   MAY process them sequentially (first arrival gets `ready.waiting`, second
   arrival triggers `ready.connected` for both) or atomically (both get
   `ready.connected` immediately).
3. If one resume token is invalid, the relay MUST reject only that peer
   with `invalid_resume` and MUST NOT affect the other peer's reconnect.

The previously negotiated root key, transcript hash, and traffic keys remain
valid. Peers must persist their send and receive sequence counters across
reconnects and continue from the persisted values. **Sequence counters must
never be reset**, because doing so would cause nonce reuse and break AEAD
security.

After reconnect, there may be gaps in the sequence numbers (in-flight messages
lost when the transport dropped). The sequence validation rule in Section 7.4
(must be strictly greater than last accepted) already handles this correctly
without special-case logic.

If the token is invalid, the relay rejects with:

```json
{
  "v": 1,
  "t": "terminate",
  "ch": "aabb01...eeff",
  "ts": 1779170000000,
  "from": "_adapter",
  "body": {
    "reason": "invalid_resume"
  }
}
```

Recommended reconnect backoff:

```text
1s -> 2s -> 5s -> 10s -> 30s
```

After reconnect:

1. The dApp may retry pending requests with the same `req.id` (using new
   sequence numbers for encryption).
2. The wallet MUST deduplicate duplicate request IDs per Section 10 rule 6.
   The wallet's idempotency cache persists for the channel lifetime, so
   retried requests after reconnect are handled correctly.
3. The dApp should refresh state by calling a method like `wallet_getAccounts`
   if missed events matter.

## 15. State Machine

### DApp State

```text
idle
  -> send create ---------------------------------> waiting
waiting
  -> receive join -------------------------------> pending_accept
  -> receive close or terminate -----------------> closed
  -> timeout ------------------------------------> closed
pending_accept
  -> user confirms pairing code -> send accept --> connected
  -> user rejects -> send close -----------------> closed
  -> receive terminate --------------------------> closed
  -> timeout ------------------------------------> closed
connected
  -> send req
  -> receive res
  -> receive evt
  -> send/receive ping/pong
  -> send close ---------------------------------> closed
  -> receive close or terminate -----------------> closed
  -> transport disconnected ---------------------> disconnected
  -> session lifetime expired (§16 rule 17) -----> closed
disconnected
  -> send create with resume --------------------> waiting
     (relay may respond with ready.waiting or
      ready.connected depending on other peer)
  -> session lifetime expired (§16 rule 17) -----> closed
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
  -> receive close or terminate -----------------> closed
  -> timeout ------------------------------------> closed
connected
  -> receive req
  -> send res
  -> send evt
  -> send/receive ping/pong
  -> send close ---------------------------------> closed
  -> receive close or terminate -----------------> closed
  -> transport disconnected ---------------------> disconnected
  -> session lifetime expired (§16 rule 17) -----> closed
disconnected
  -> send join with resume ----------------------> waiting_accept
     (relay may respond with ready.waiting or
      ready.connected depending on other peer)
  -> session lifetime expired (§16 rule 17) -----> closed
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
   field using the direction-specific traffic key.
9. `resume` is secret and must not be shown to users.
10. A closed channel cannot carry more requests, responses, or events.
11. A single message must not exceed 64 KB on the wire.
12. A peer MUST NOT have more than 32 pending (unanswered) requests per
    channel. If a dApp sends a `req` that would exceed this limit, the
    wallet MUST reject it with error code `rate_limited` and message
    "Too many pending requests". The dApp MUST wait for at least one
    pending response before sending another request.
13. If a peer receives a message with an unsupported `v` value, it MUST reply
    with `close` reason `unsupported_version`. If the adapter detects an
    unsupported version, it sends `terminate` with the same reason.
14. Encryption sequence counters must never be reset. They persist across
    reconnects for the lifetime of the channel.
15. Each peer MUST locally verify that encrypted messages come from the expected
    remote peer public key. Relay role enforcement is an availability aid, not
    a cryptographic trust boundary.
16. A peer MUST reject `ready.connected` if `remote` does not match the peer
    public key used to derive the handshake transcript.
17. **Session expiry.** A channel MUST have a maximum session lifetime.
    The recommended default is 24 hours from `ready.connected`. Both
    peers MUST track the session start time and close the channel with
    reason `timeout` when the lifetime expires. After expiry, the peers
    MUST initiate a fresh pairing to re-establish a channel (reconnect
    with `resume` MUST NOT be used after session expiry). The wallet
    SHOULD display the remaining session lifetime to the user and warn
    before expiry. If a peer receives a message on an expired session,
    it MUST respond with `close` reason `timeout`. The relay SHOULD
    also enforce session expiry independently and terminate channels
    that exceed the configured TTL (using `terminate` with reason
    `timeout`). Implementations MAY allow users to
    configure a shorter session lifetime but MUST NOT allow unlimited
    sessions.

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
8. Reject invalid role or state transitions with `terminate`.
9. Generate opaque `resume` tokens and include them in `ready` messages.
10. Validate `resume` tokens on reconnect and verify that `from` matches the
    original channel participant.
11. Expire channels after a configurable TTL (recommended: 5 minutes for
    unpaired channels, 24 hours for connected channels).

The relay MUST implement rate limiting to prevent abuse:

- Per-IP channel creation rate limit (recommended: 10 channels per
  minute per IP).
- Per-IP connection limit (recommended: 50 concurrent connections
  per IP).
- Message rate limit per channel (recommended: 60 messages per
  minute per peer).

These limits preserve the "zero registration" principle while preventing
resource exhaustion attacks. The specific numeric thresholds above are
recommendations; relay operators MAY adjust them based on their
deployment context, but MUST enforce non-zero limits in all three
categories. A relay that does not rate-limit channel creation is
trivially vulnerable to resource exhaustion by a single attacker
rotating IP addresses.

The relay MUST also enforce global resource limits:

- Maximum concurrent channels (recommended: 10,000). When exceeded,
  new `create` messages receive `terminate` with `rate_limited`.
- Maximum total bandwidth (recommended: 100 MB/min aggregate). When
  exceeded, the relay SHOULD throttle new messages with backpressure
  rather than dropping existing channels.
- Maximum message size is 64 KB per the protocol limit (§16 rule 11).

To mitigate Sybil attacks from botnets or IPv6 rotation, relay
operators SHOULD consider additional anti-abuse mechanisms:

- Proof-of-work / hashcash challenge on `create` (the relay MAY
  respond with a challenge before accepting channel creation).
- Connection-level TLS fingerprinting to detect automated clients.
- Anomaly detection on channel creation patterns (e.g., many channels
  created but never paired).

These mechanisms are relay-implementation details and are not part of
the protocol wire format. They do not affect protocol interoperability.

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
has the channel. Since the root and traffic keys are derived from the peer
keys and handshake transcript (not the relay), switching relays does not
affect encryption.

**Relay affinity after pairing.** Once pairing completes on a specific
relay, both peers hold `resume` tokens valid only on that relay. If that
relay becomes unavailable, the `resume` tokens cannot be used on other
relays (each relay generates its own opaque tokens). In this case:

- The peer connecting to a different relay will receive
  `channel_not_found` or `invalid_resume`.
- Both peers MUST fall back to fresh pairing if the active relay is
  permanently unavailable. This is equivalent to creating a new channel.
- To mitigate this, the dApp SHOULD create the channel on all listed
  relays and maintain a heartbeat on the active relay. If the active
  relay fails, the dApp creates a new channel on the next relay and
  presents a new QR code or deep link to the user.
- Implementations that require seamless relay failover without
  re-pairing SHOULD persist the channel's cryptographic state (keys,
  sequence counters) and use a relay-independent reconnect mechanism
  (outside the scope of v1).

**Channel cleanup on unused relays.** Once pairing completes on one relay,
the dApp MUST close the channels it created on all other relays by sending
a `close` message with reason `normal` to each. This prevents orphaned
channels from consuming relay resources until TTL expiry. If the dApp
cannot reach an unused relay to send `close` (e.g., network error), it
SHOULD retry with backoff and eventually abandon — the relay's channel
TTL (§18.3 rule 11) will clean up the channel automatically. The wallet
does not need to perform cleanup because it only connects to one relay.

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

| Method            | Use Case                               |
| ----------------- | -------------------------------------- |
| QR code           | DApp shows QR on screen, wallet scans. |
| NFC tap           | Mobile-to-mobile or hardware wallet.   |
| BLE advertisement | Wallet discovers nearby dApps.         |

The QR code or NFC payload contains the pairing URI (Section 9.1) without the
`relay` parameter.

### 19.3 BLE Service

WalletPair BLE GATT service definition:

```text
Service UUID: 0000FE70-0000-1000-8000-00805F9B34FB
  Characteristic: Channel (read)     - returns pairing URI
    UUID: 0000FE71-0000-1000-8000-00805F9B34FB
  Characteristic: Message (write)    - wallet writes messages to dApp
    UUID: 0000FE72-0000-1000-8000-00805F9B34FB
  Characteristic: Message (notify)   - dApp sends messages to wallet
    UUID: 0000FE73-0000-1000-8000-00805F9B34FB
```

Note: The UUIDs above use the Bluetooth SIG 16-bit UUID base
(`0000xxxx-0000-1000-8000-00805F9B34FB`) with values in the `FE70-FE73`
range reserved for experimental/member use. Production deployments SHOULD
register a 16-bit UUID with the Bluetooth SIG or use a fully random
128-bit UUID to avoid collisions with other services.

### 19.4 Flow

1. DApp creates `ch`. BLE adapter returns `ready.waiting` to the dApp.
2. DApp exposes pairing URI via QR, NFC, or BLE advertisement.
3. Wallet discovers the pairing URI and obtains the dApp's public key.
4. Wallet computes its local root key and pairing code, then sends `join`
   with public key and capabilities.
5. BLE adapter forwards `join` to dApp and sends `ready.waiting` to wallet.
6. DApp computes the root key, transcript hash, traffic keys, and pairing code.
7. User confirms the wallet and dApp displays show the same code.
8. DApp sends `accept`.
9. BLE adapter generates `ready.connected` for both sides.
10. DApp sends `req`. Wallet sends `res` and optional `evt`.
11. All payloads are encrypted with direction-specific traffic keys.

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

### 19.6 Bluetooth Security Considerations

1. **BLE advertisement exposure.** When using BLE advertisement for
   discovery, any nearby device (typically within 10–30 meters) can
   discover the channel and read the pairing URI from the Channel
   characteristic. The same MITM protections apply as with relay
   transport: the attacker cannot complete a full MITM because the
   wallet obtains the dApp's public key directly from the BLE
   characteristic (out-of-band from any network attacker), and the
   pairing code provides human verification.
2. **Proximity assumption.** Unlike relay-based pairing, Bluetooth
   pairing implicitly assumes physical proximity. However, BLE range
   can extend beyond visual range (especially with directional
   antennas). Implementations MUST NOT rely on Bluetooth proximity as
   a security property — the pairing code verification is the trust
   anchor, not physical distance. The wallet SHOULD display the dApp
   name and pairing code prominently and require explicit user
   confirmation.
3. **BLE connection hijacking.** A nearby attacker could attempt to
   connect to the dApp's BLE service before the legitimate wallet.
   The dApp MUST enforce the one-wallet-per-channel rule (§16 rule 4).
   If a second device attempts to `join`, the BLE adapter MUST reject
   it with `already_connected`. The pairing code ensures the dApp
   connects to the intended wallet even if an attacker connects first
   (the codes will not match).
4. **Denial of service.** A nearby attacker can jam BLE frequencies or
   flood the GATT service with connections. This is inherent to any
   wireless protocol. For high-security scenarios, QR code scanning
   (which does not require BLE advertisement) is recommended over BLE
   discovery.

## 20. Security

### 20.1 Threat Model

WalletPair assumes the transport (relay or Bluetooth) may be compromised.
The relay operator, network attacker, or eavesdropper should not be able to:

- read request parameters, response results, or event data
- impersonate a peer
- replay messages to cause duplicate signing

### 20.2 Protections

| Threat             | Protection                                                         |
| ------------------ | ------------------------------------------------------------------ |
| Eavesdropping      | E2E encryption with X25519 + ChaCha20-Poly1305.                    |
| Man-in-the-middle  | Pairing code derived from shared secret; user visual verification. |
| Peer impersonation | Peer ID is the X25519 public key; relay verifies on reconnect.     |
| Replay             | Sequence-number-based nonce; receiver rejects out-of-order seq.    |
| Channel hijack     | Channel ID is 32 random bytes (256-bit entropy).                   |
| Relay compromise   | Relay only sees encrypted `sealed` blobs and routing metadata.   |

### 20.2.1 Pairing Code Security Analysis

The 4-digit pairing code is a **defense-in-depth** measure, not the primary
MITM protection. The primary defense is **out-of-band public key delivery**,
which is mandatory (Section 9.1).

**Primary defense: out-of-band public key delivery.** The dApp's public key
is embedded in the pairing URI. The wallet MUST obtain this URI through an
out-of-band channel where the relay and network attackers cannot substitute
content (see §9.1 for mandatory delivery methods). QR code optical scanning
is the required primary method: the wallet reads the dApp's screen directly,
and the relay is not in this path.

A relay-positioned attacker can only attempt a **half-MITM**: substituting
the wallet's public key in the forwarded `join` message. However, this
causes both sides to derive different `root_key`, `transcript_hash`, and
`traffic_key` values:

```text
dApp side:   shared_secret = X25519(dapp_priv, attacker_pub)
Wallet side: shared_secret = X25519(wallet_priv, dapp_pub)  ← real, from QR

→ Different root_key → different transcript_hash → different traffic_key
→ Channel is cryptographically non-functional (AEAD decryption fails)
→ Different pairing_code (user sees mismatch)
```

Even if the 4-digit codes coincidentally match (1 in 10,000), the channel
cannot carry any messages because the two sides have incompatible traffic
keys. The attacker cannot complete a full MITM because it cannot substitute
the dApp's public key (delivered via QR).

**What the pairing code guards against:** The pairing code provides
human-verifiable confirmation as a secondary safeguard. It does NOT protect
against phishing attacks where the attacker controls the QR code display
itself (e.g., a fake dApp website) — in that scenario the attacker controls
both ends and codes will match regardless of length.

**Collision probability:** The attacker gets exactly one attempt per pairing
session (one `join` per channel). The probability is 1/10,000 per attempt,
but a successful collision does not yield a functional MITM channel due to
the traffic key mismatch described above.

**Deep link and non-OOB delivery threat.** When the pairing URI is delivered
through a software-controlled channel (deep link, clipboard, URL scheme
handler, browser extension), a malicious intermediary can replace the entire
URI — including the dApp public key and channel ID. In this scenario:

1. The attacker creates its own channel and key pair.
2. The attacker forwards the wallet's `join` to the real dApp (or runs a
   full MITM proxy).
3. Both sides derive keys based on the attacker's public key.
4. The pairing codes **will match** because the attacker controls the key
   material on both sides.
5. The user cannot detect the MITM through pairing code comparison.

This is why §9.1 mandates out-of-band delivery and prohibits deep link as
the sole pairing mechanism. Wallets that offer deep link convenience pairing
MUST display a security downgrade warning and SHOULD restrict deep-link
sessions to read-only methods (e.g., `wallet_getAccounts`) by default.

### 20.3 Rules

1. `ch` must be cryptographically random (256 bits).
2. `from` must match the sender's X25519 public key.
3. `resume` is secret and must be stored like a session token.
4. User confirmation of pairing code proves absence of MITM, not identity.
5. Ephemeral key pairs must be generated per channel.
6. Implementations must reject messages with sequence numbers that are not
   strictly greater than the last accepted value.
7. The relay must not log or store `sealed` content beyond delivery.
8. Sequence counters must never be reset for a given traffic key.

### 20.4 Privacy Considerations

The following fields are visible to the relay in plaintext:

- `ch` (channel ID)
- `from` (public key / peer ID)
- `t` (message type)
- `ts` (timestamp)

The following are always encrypted and invisible to the relay:

- **Capabilities and metadata:** Always encrypted in `sealed_join`
  (Section 7.5). The relay cannot read the wallet's supported chains,
  methods, wallet brand, or identity.
- **Method and event names:** Never present on the wire. Real names
  are carried only inside the encrypted `sealed` payload (Section 5.3).
  The relay cannot determine what operations are being performed.

A malicious relay can still observe traffic patterns (message frequency,
timing, message sizes) and the `from` field (public key). However, the
relay cannot determine: what chains the user uses, what methods the
wallet supports, the wallet brand, what operations are being performed,
or whether requests succeed or fail (when response privacy mode is used).

Relay operators MUST NOT log, index, or retain `join` message content
beyond the immediate delivery.

**Response success/failure leakage.** The `ok` field in `res` messages is
plaintext on the wire. A malicious relay can observe whether requests
succeed or fail — for example, how many transaction signing requests the
user rejects. This is a known tradeoff: `ok` is plaintext so the relay can
deliver error responses without needing to decrypt them (relevant for relay
diagnostics and error routing). The `ok` field is bound into the AEAD's AAD
(§7.4), so the relay cannot flip it without causing decryption failure.

Implementations SHOULD support a **response privacy mode** where the
sender always sets `ok` to `true` on the wire and encodes the real
success/failure status inside the encrypted `sealed` payload. In this
mode, the decrypted payload MUST include a `"_ok"` boolean field
(`true` or `false`); the receiver MUST use `_ok` as the authoritative
status and ignore the wire `ok` value. This mode is negotiated via the
`"response_privacy": true` capability flag. When both peers declare
this capability, response privacy mode MUST be used. When not
negotiated, the wire `ok` field is authoritative (backward compatible).

A future protocol version SHOULD consider removing `ok` from the
plaintext wire format entirely.

### 20.5 Terminate Message Trust

A `terminate` message is sent by the transport adapter (relay) with
`from` = `"_adapter"`. This means a malicious relay can terminate any
session at will. This is an inherent trust assumption of using a relay —
the relay can always sever the connection (e.g., by dropping WebSocket
frames).

The relay cannot forge encrypted messages or impersonate a peer (it does
not have the traffic keys), so the worst a malicious relay can do is deny
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

### 20.7 Key Material Lifecycle and Secure Erasure

Implementations MUST manage the lifecycle of all cryptographic key
material and MUST securely erase (zero) sensitive values as soon as they
are no longer needed. The following rules apply:

1. **`shared_secret`** (X25519 output): MUST be securely erased
   immediately after `root_key` is derived. It is never needed again.
2. **X25519 private key**: MUST be securely erased after
   `join_encryption_key` and traffic keys (`dapp_to_wallet_key`,
   `wallet_to_dapp_key`) are derived. Reconnect (Section 14) does not
   require the private key — it uses `resume` tokens and persisted
   traffic keys.
3. **`root_key`**: MUST be securely erased after `join_encryption_key`,
   traffic keys, and pairing code are derived. It is never needed again.
4. **`join_encryption_key`**: MUST be securely erased after `sealed_join`
   is encrypted (wallet) or decrypted (dApp). It is a one-shot key.
5. **`dapp_to_wallet_key` and `wallet_to_dapp_key`** (traffic keys):
   MUST be persisted for the channel lifetime (including across
   reconnects). MUST be securely erased when the channel is closed or
   the session expires (§16 rule 17).
6. **`transcript_hash`**: MUST be securely erased after traffic keys and
   pairing code are derived. It is never needed again.
7. **`resume` token**: MUST be securely erased when the channel is
   closed, the session expires, or a new `resume` token replaces it
   after reconnect.
8. **Sequence counters**: MUST be persisted for the channel lifetime.
   MUST be securely erased when the channel is closed.
9. **Idempotency cache**: MUST be securely erased (zeroed) when the
   channel is closed. See §10 rule 6 for cache-specific security rules.

**Secure erasure** means overwriting the memory with zeroes (or random
bytes) before deallocation. On platforms that support it, implementations
SHOULD use memory-locking APIs (e.g., `mlock`, `VirtualLock`,
`sodium_mlock`) to prevent key material from being swapped to disk.

On platforms where memory locking is not available (e.g., browser
JavaScript environments), implementations MUST minimize the lifetime of
key material by erasing intermediate values (steps 1–4, 6) as soon as
derivation is complete, and SHOULD use `crypto.subtle` or WebAssembly
for key operations to reduce exposure in the JavaScript heap.

If a peer detects that persisted key material (traffic keys or sequence
counters) has been corrupted or lost (e.g., after an app crash),
it MUST NOT attempt to reconnect. It MUST close the channel and
initiate a fresh pairing, because reusing sequence numbers or operating
with incorrect keys would break AEAD security (see §14.1).

### 20.8 Idempotency Cache Side Channel

The idempotency cache (§10 rule 6) introduces a minor information
leakage vector: a malicious dApp can probe whether the wallet has
previously processed a specific request ID by observing the error
response type.

- If a `req.id` has been processed and the params hash differs, the
  wallet responds with `invalid_params` ("Duplicate request ID with
  different params").
- If the `req.id` is unknown, the wallet processes the request normally.

This allows a malicious dApp to enumerate which request IDs have been
cached. In practice, request IDs are dApp-generated and the dApp already
knows which requests it has sent, so this leakage is minimal.
Implementations SHOULD NOT add timing-based mitigations (e.g., constant-
time responses) as the complexity is not justified by the risk.

However, implementations MUST ensure that the cache lookup itself is not
vulnerable to timing attacks that reveal the cached response content
(e.g., through variable-time comparison of params hashes). The params
hash comparison MUST use constant-time comparison.

## 21. Complete Example

### Pairing URI (shown as QR code)

```text
walletpair:?ch=aabb01...eeff&pubkey=dGhpcyBpcyBh...&relay=wss%3A%2F%2Frelay.example.com%2Fv1&name=MyDApp&methods=wallet_signTransaction,wallet_signMessage&chains=eip155:1,eip155:137
```

### DApp creates channel

```json
{
  "v": 1,
  "t": "create",
  "ch": "aabb01...eeff",
  "ts": 1779170000000,
  "from": "base64url-dapp-pubkey",
  "body": {
    "meta": { "name": "MyDApp" },
    "resume": null
  }
}
```

### Relay confirms channel created

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
    "resume": "opaque-resume-token-1"
  }
}
```

### Wallet joins with encrypted capabilities

```json
{
  "v": 1,
  "t": "join",
  "ch": "aabb01...eeff",
  "ts": 1779170000000,
  "from": "base64url-wallet-pubkey",
  "body": {
    "sealed_join": "base64url-encrypted-capabilities-and-meta",
    "resume": null
  }
}
```

The dApp decrypts `sealed_join` to recover the capabilities and metadata
(see Section 7.5). The decrypted content is:

```json
{
  "capabilities": {
    "methods": ["wallet_signTransaction", "wallet_signMessage"],
    "events": ["accountsChanged", "chainChanged"],
    "chains": ["eip155:1", "eip155:137"]
  },
  "meta": { "name": "Wallet" }
}
```

### Relay confirms wallet joined

```json
{
  "v": 1,
  "t": "ready",
  "ch": "aabb01...eeff",
  "ts": 1779170000000,
  "from": "_adapter",
  "body": {
    "state": "waiting",
    "role": "wallet",
    "self": "base64url-wallet-pubkey",
    "remote": null,
    "resume": "opaque-resume-token-2"
  }
}
```

### User compares pairing code and DApp accepts

```text
Wallet: "Pairing code: 8472"  (displayed after scanning)
DApp:   "Pairing code: 8472"  (displayed after receiving join)
User:   confirms both displays match
```

### DApp accepts

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

### Relay sends ready.connected to both peers

DApp receives:

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
    "resume": "opaque-resume-token-3"
  }
}
```

Wallet receives:

```json
{
  "v": 1,
  "t": "ready",
  "ch": "aabb01...eeff",
  "ts": 1779170000000,
  "from": "_adapter",
  "body": {
    "state": "connected",
    "role": "wallet",
    "self": "base64url-wallet-pubkey",
    "remote": "base64url-dapp-pubkey",
    "resume": "opaque-resume-token-4"
  }
}
```

### DApp sends encrypted request (seq=0)

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

The decrypted `sealed` contains `{ "_method": "wallet_signTransaction", ...params }`.

### Wallet sends encrypted response (seq=0)

```json
{
  "v": 1,
  "t": "res",
  "ch": "aabb01...eeff",
  "ts": 1779170000000,
  "from": "base64url-wallet-pubkey",
  "body": {
    "id": "req-001",
    "ok": true,
    "sealed": "base64url-encrypted-result"
  }
}
```

### Wallet pushes encrypted event (seq=1)

```json
{
  "v": 1,
  "t": "evt",
  "ch": "aabb01...eeff",
  "ts": 1779170000000,
  "from": "base64url-wallet-pubkey",
  "body": {
    "id": "evt-001",
    "sealed": "base64url-encrypted-data"
  }
}
```

The decrypted `sealed` contains `{ "_event": "accountsChanged", ...data }`.

## Appendix A: Cryptographic Test Vectors

These test vectors allow independent implementations to verify their
cryptographic operations produce identical results. All hex values are
lowercase. Base64url values use no padding.

**WARNING:** The private keys below are for testing only. Never use them
in production.

### A.1 Key Material

```text
dapp_private_key     = a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4
dapp_public_key      = 1c9fd88f45606d932a80c71824ae151d15d73e77de38e8e000852e614fae7019
dapp_pub_base64url   = HJ_Yj0VgbZMqgMcYJK4VHRXXPnfeOOjgAIUuYU-ucBk

wallet_private_key   = 4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d
wallet_public_key    = ff63fe57bfbf43fa3f563628b149af704d3db625369c49983650347a6a71e00e
wallet_pub_base64url = _2P-V7-_Q_o_VjYosUmvcE09tiU2nEmYNlA0empx4A4

channel_id           = a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2
shared_secret        = 739311d35d8d3c41da4062c799a6c748808a31343facaaa7aa7e311908c1846e
```

#### Root key derivation

```text
HKDF-SHA256(
  ikm  = shared_secret,
  salt = channel_id_bytes,
  info = "walletpair-v1 root"
)[0:32]

root_key = c33b664ab3eea368d81109b432f04a1293a743212749e19bfe412a2996dcefee
```

#### Join encryption key derivation (for private handshake, Section 7.5)

```text
HKDF-SHA256(
  ikm  = root_key,
  salt = channel_id_bytes,
  info = "walletpair-v1 join-encryption"
)[0:32]

join_encryption_key = 981e75c4fad86e3db377517816a24b27564661ab89d327217684e0a56d68ec11
```

Note: The `join_encryption_key` is used to encrypt `sealed_join` before
the `join` message is sent. It is derived from `root_key` and
`channel_id_bytes` only — it does not depend on the transcript hash
(which is computed after `join` is received). Implementations MUST
securely erase this key after `sealed_join` is encrypted (wallet) or
decrypted (dApp).

#### Sealed join encryption (private handshake)

Using the test data from §A.2:

```text
join_plaintext = canonical_json({
  "capabilities": {"chains":["eip155:1","eip155:137"],"events":["accountsChanged","chainChanged"],"methods":["wallet_signTransaction","wallet_signMessage"]},
  "meta": {"name":"MyWallet"}
})

join_nonce     = HMAC-SHA256(join_encryption_key, "walletpair-v1-join-nonce")[0:12]
               = 09474eabe263432ebc7e4756

join_aad       = channel_id_bytes || 0x04
               = a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b204

sealed_join    = AEAD_encrypt(join_encryption_key, join_nonce, join_plaintext, join_aad)

ciphertext+tag = 1f21896b618b3413d711bfb4bcad479530a642b67011da91
                 45bd22c815fd6471a4bfbe0be89db82cc33601516cad757d
                 a637029ad2f1db57e48fabdeb3caddf91b63c96e964b8e3e
                 aa8f3bb27dfa2292e3848b6e523abf7a50d4affa823a9c21
                 a1522b142dbd6fb9fff6af1475b3007791f074a3622852eb
                 6fdd7fad68558f71ffcbbf1fc9fb7c2e21dbe76a74c85d91
                 581e66d3ebd987403d464f4704bf5a9ac10f9ce428ce4869
                 5abce7b95910d662d4e17004874fc8a457a3983a8a5e11f1
                 e6d028de7389

sealed_join (base64url) = HyGJa2GLNBPXEb-0vK1HlTCmQrZwEdqRRb0iyBX9ZHGkv74L6J24LMM2AVFsrXV9pjcCmtLx21fkj6ves8rd-RtjyW6WS44-qo87sn36IpLjhItuUjq_elDUr_qCOpwhoVIrFC29b7n_9q8UdbMAd5HwdKNiKFLrb91_rWhVj3H_y78fyft8LiHb52p0yF2RWB5m0-vZh0A9Rk9HBL9amsEPnOQozkhpWrznuVkQ1mLU4XAEh0_IpFejmDqKXhHx5tAo3nOJ
```

Implementations MUST verify that decrypting the above `sealed_join`
with the computed `join_encryption_key`, `join_nonce`, and `join_aad`
produces the expected plaintext.

### A.2 Transcript and Traffic Keys

Handshake context (test data only — production wallets SHOULD use generic
names per §20.4):

```text
capabilities (canonical JSON) = {"chains":["eip155:1","eip155:137"],"events":["accountsChanged","chainChanged"],"methods":["wallet_signTransaction","wallet_signMessage"]}
meta (canonical JSON)         = {"name":"MyWallet"}
dapp_name                     = MyDApp
```

```text
transcript_hash = SHA256(
  "walletpair-v1-transcript" ||
  channel_id_bytes ||
  lp("HJ_Yj0VgbZMqgMcYJK4VHRXXPnfeOOjgAIUuYU-ucBk") ||
  lp("_2P-V7-_Q_o_VjYosUmvcE09tiU2nEmYNlA0empx4A4") ||
  lp(capabilities_json) ||
  lp(meta_json) ||
  lp("MyDApp")
)

transcript_hash      = 51d1797d9ab563c1d26e033af2bf8fa17c741af5f6c0d4071e69dfd25ce8d39f
```

```text
dapp_to_wallet_key   = 782ccebad576c74dede0ba376a324d06b6aa7008b90116bc57c693171c41c074
wallet_to_dapp_key   = 26bb36c7e36a29df7b92cee30a6b16a09964b3b74833d0b742a2c01b4ab8c925
```

### A.3 Pairing Code

```text
HKDF-SHA256(
  ikm  = root_key,
  salt = transcript_hash,
  info = "walletpair-pairing-code"
)[0:4]

code_bytes  = 9b4c9732
code_uint32 = 2605487922   (big-endian)
pairing_code = 2605487922 mod 10000 = 7922
```

Display: `7922`

### A.4 AEAD Encryption (dapp→wallet, seq=0)

Message: `wallet_getAccounts` request.

```text
traffic_key     = dapp_to_wallet_key
                = 782ccebad576c74dede0ba376a324d06b6aa7008b90116bc57c693171c41c074

seq             = 0
seq_bytes       = 00000000

nonce           = HMAC-SHA256(traffic_key, seq_bytes)[0:12]
                = 8e8a6459ee942cc99709de1e
```

AAD construction (`req` type):

```text
from   = "HJ_Yj0VgbZMqgMcYJK4VHRXXPnfeOOjgAIUuYU-ucBk"
id     = "req-001"

aad_header = 01                                     (type byte: req)
           || 002b 484a5f596a3056...7563426b         (lp(from), 43 bytes)
           || 0007 7265712d303031                     (lp("req-001"), 7 bytes)

aad_header hex = 01002b484a5f596a305667625a4d71674d63594a4b345648525858506e66654f4f6a674149557559552d7563426b00077265712d303031

aad = channel_id_bytes || aad_header
```

Plaintext (`_method` inside sealed):

```text
{"_method":"wallet_getAccounts","chain":"eip155:1"}
```

Encryption result:

```text
ChaCha20-Poly1305(key=traffic_key, nonce=nonce, plaintext=above, aad=aad)

ciphertext+tag = ce3fe8bcf32e130e002ea8a9029d5457f4ee2978220af0b9
                 eff01361f788df6f50e8b281378ed1bc48b13516844b787b
                 784474b4bd8301b7ed97d52515d535ce223a79

sealed = base64url(seq_bytes || ciphertext || tag)
       = AAAAAM4_6LzzLhMOAC6oqQKdVFf07il4Igrwue_wE2H3iN9vUOiygTeO0bxIsTUWhEt4e3hEdLS9gwG37ZfVJRXVNc4iOnk
```

Wire message:

```json
{
  "v": 1,
  "t": "req",
  "ch": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
  "ts": 1779170000000,
  "from": "HJ_Yj0VgbZMqgMcYJK4VHRXXPnfeOOjgAIUuYU-ucBk",
  "body": {
    "id": "req-001",
    "sealed": "AAAAAM4_6LzzLhMOAC6oqQKdVFf07il4Igrwue_wE2H3iN9vUOiygTeO0bxIsTUWhEt4e3hEdLS9gwG37ZfVJRXVNc4iOnk"
  }
}
```

Implementations MUST verify that decrypting the above `sealed` value with
the computed `dapp_to_wallet_key`, `nonce`, and `aad` produces the expected
plaintext. Any deviation indicates an error in key derivation, canonical
JSON, transcript hashing, or AEAD implementation.
