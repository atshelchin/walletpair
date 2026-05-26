# WalletPair EVM Sub-Protocol v1

Status: Draft

This document defines the EVM (Ethereum Virtual Machine) sub-protocol for
WalletPair Protocol v1. It specifies the methods, parameters, results, error
codes, and events that a WalletPair-compatible EVM wallet must support.

This sub-protocol applies to all EIP-155 compatible chains including Ethereum,
Polygon, Arbitrum, Optimism, BSC, Avalanche, Base, and any other EVM chain.

## 1. Scope

This sub-protocol defines:

- chain and account identifier format
- wallet methods and their request/response schemas
- wallet events and their data schemas
- error codes
- capability declaration

This sub-protocol does not define:

- transport details (handled by WalletPair Protocol v1)
- key exchange or encryption (handled by WalletPair Protocol v1)
- specific smart contract ABIs
- token standards or metadata

### 1.1 Security Boundary

The following security properties are provided by WalletPair Protocol v1
and are assumed by this sub-protocol:

- **Confidentiality:** All `sealed` payloads are end-to-end encrypted
  (X25519 + ChaCha20-Poly1305). The relay cannot read params, results,
  or error details.
- **Integrity and replay protection:** Direction-specific traffic keys plus
  sequence-numbered AEAD prevent tampering, nonce reuse, and replay of
  encrypted payloads.
- **Peer authentication:** Peer identity is bound to X25519 public keys;
  pairing code verification prevents MITM.
- **Peer and role enforcement:** The transport may enforce roles, but wallets
  and dApps MUST still locally verify that messages come from the expected
  peer public key and are valid for that peer's role.

The following security properties are **not** provided by the transport
layer and MUST be enforced by the wallet implementation at this layer:

- **Account authorization:** The wallet decides which accounts to expose.
- **Chain ID validation:** The wallet must verify chain consistency across
  all identifier formats (CAIP-2, hex chainId, EIP-712 domain).
- **Transaction validation:** The wallet must validate and display
  transaction details before signing.
- **Signature scope:** The wallet must prevent cross-chain signature abuse.

## 2. Chain Identification

EVM chains use the `eip155` CAIP-2 namespace:

```text
eip155:<chain_id>
```

Where `<chain_id>` is the **decimal** integer from EIP-155. This is the
canonical chain identifier throughout this sub-protocol.

Examples:

| Chain | CAIP-2 |
|-------|--------|
| Ethereum Mainnet | `eip155:1` |
| Holesky Testnet | `eip155:17000` |
| Sepolia Testnet | `eip155:11155111` |
| Polygon | `eip155:137` |
| Arbitrum One | `eip155:42161` |
| Optimism | `eip155:10` |
| BSC | `eip155:56` |
| Avalanche C-Chain | `eip155:43114` |
| Base | `eip155:8453` |

### 2.1 Chain ID Format Conversion

Transaction objects use hex-encoded chain IDs (`"0x1"`), while this
sub-protocol uses CAIP-2 decimal (`"eip155:1"`). Implementations MUST
convert correctly between formats:

```text
CAIP-2 → hex:   "eip155:137"  → parse as uint256 decimal → "0x89"
hex → CAIP-2:   "0x89"        → parse as uint256 hex     → "eip155:137"
```

When both formats are present in a single request (e.g., `chain` and
`tx.chainId`), the wallet MUST verify they refer to the same chain.
See §5.2 for validation rules.

Numeric values in this sub-protocol use two representations:

- **Hex strings** (`tx.chainId`, `tx.nonce`, `tx.gas`, `tx.value`,
  etc.): MUST be parsed as arbitrary-precision integers. The wallet
  MUST NOT truncate or lose precision. Each field has its own valid
  range defined by the corresponding EIP (e.g., chainId ≤ 2^256-1,
  nonce < 2^64, gas < 2^64, value ≤ 2^256-1).
- **JSON numbers** (`typedData.domain.chainId`): MUST be safe
  integers (≤ 2^53 - 1). If a JSON number exceeds
  `Number.MAX_SAFE_INTEGER` (9007199254740991), the wallet MUST
  reject with `invalid_params`. DApps that need larger values MUST
  encode them as decimal strings.

Implementations MUST NOT use fixed-width integer types (e.g., JS
`Number`, 32-bit int) for transaction field parsing. Hex string
fields are the canonical representation and carry full EVM precision.

Hex quantity fields MUST follow Ethereum JSON-RPC quantity rules: `0x`
prefix, lowercase or uppercase hex digits accepted, no leading zeroes except
the value zero encoded as `0x0`, and no empty quantity (`0x`). Fixed-width byte
fields such as addresses, hashes, `r`, and `s` MUST use exact byte lengths.

## 3. Account Identification

Addresses are 20-byte EVM addresses, hex-encoded with the `0x` prefix.

Addresses in wallet responses MUST use EIP-55 mixed-case checksum encoding.
Addresses in dApp requests SHOULD use EIP-55 encoding. Wallets MUST perform
case-insensitive comparison when matching addresses.

The zero address (`0x0000000000000000000000000000000000000000`) MUST NOT be
used as a `from` or signing address.

### 3.1 Relationship to CAIP-10

A [CAIP-10](https://chainagnostic.org/CAIPs/caip-10) account identifier
combines a CAIP-2 chain ID and an address:

```text
eip155:1:0xab16a96D359eC26a11e2C2b3d8f8B8942d5Bfcdb
```

This sub-protocol does not use CAIP-10 strings on the wire. Instead,
`wallet_getAccounts` returns structured objects with separate `address`
and `chains` fields. Implementations that need to interoperate with
CAIP-10 systems can construct CAIP-10 identifiers by combining
`chain + ":" + address` for each chain in the account's `chains` array.

## 4. Capabilities

An EVM wallet declares the approved session scope in the WalletPair `join` message:

```json
{
  "capabilities": {
    "methods": [
      "wallet_getAccounts",
      "wallet_signTransaction",
      "wallet_sendTransaction",
      "wallet_signMessage",
      "wallet_signRawMessage",
      "wallet_signTypedData",
      "wallet_switchChain",
      "wallet_addChain",
      "wallet_watchAsset"
    ],
    "events": [
      "accountsChanged",
      "chainChanged",
      "connect",
      "disconnect"
    ],
    "chains": [
      "eip155:1",
      "eip155:137",
      "eip155:42161"
    ]
  }
}
```

A wallet MUST support at least `wallet_getAccounts`. All other methods are
optional. The dApp MUST check `capabilities.methods` before calling any
method and MUST check `capabilities.chains` before assuming chain support.
Calling an unsupported method results in error code `unsupported_method`.

### 4.1 Transaction Type Capabilities

Wallets MAY declare supported transaction types in a `txTypes` field
within `capabilities`:

```json
{
  "capabilities": {
    "methods": [...],
    "events": [...],
    "chains": [...],
    "txTypes": {
      "eip4844": "sign_only",
      "eip7702": "full"
    }
  }
}
```

The `txTypes` object maps transaction type identifiers to support levels:

| Key | Values | Description |
|-----|--------|-------------|
| `eip4844` | `"full"`, `"sign_only"`, `"none"` | Blob transaction (type 3) support. `"sign_only"` means the wallet can sign but cannot broadcast (no sidecar data). `"full"` means sign and broadcast. `"none"` means not supported. |
| `eip7702` | `"full"`, `"none"` | Set code transaction (type 4) support. |

If `txTypes` is absent, the dApp MUST assume `"full"` support for types
0, 1, and 2, `"sign_only"` for type 3 (EIP-4844), and `"none"` for
type 4 (EIP-7702). This default reflects the practical limitation that
most wallets cannot broadcast blob transactions without sidecar data
(see §5.3).

The dApp MUST check `txTypes` before sending transactions of type 3 or
4. For EIP-4844 with `"sign_only"`, the dApp MUST use
`wallet_signTransaction` (not `wallet_sendTransaction`) and handle
broadcast itself.

**Privacy note.** The `txTypes` field is part of `capabilities`, which
is encrypted inside `sealed_join` (WalletPair Protocol v1 §7.5). The
relay cannot observe transaction type capabilities.

## 5. Methods

All methods use the WalletPair `req` / `res` message flow. The method name is
never a plaintext `req` field. For requests, the decrypted content of
`body.sealed` MUST be `{ "_method": "<method_name>", ...params }`. For
responses, the decrypted content of `body.sealed` follows the format defined
in WalletPair Protocol v1 §5.3: `{ "_ok": true, "_result": <result> }` on
success, or `{ "_ok": false, "code": "<error_code>", "message": "..." }` on
failure. The **Result** sections below describe only the `_result` value.

### 5.1 wallet_getAccounts

Returns the list of accounts the wallet has authorized for this session.
This is typically called immediately after `ready.connected` to discover
available addresses.

This method MUST NOT prompt the user for new account authorization.
Account authorization is established during the pairing flow (join/accept).
The wallet MAY limit accounts on a per-session basis.

During pairing, the wallet MUST explicitly select or confirm the accounts that
will be exposed to this session. The selected account set is not sent in
`join`; it is disclosed only through encrypted `wallet_getAccounts`
and subsequent encrypted `accountsChanged` events. A wallet MUST NOT infer
account authorization from global wallet state.

**Method:** `wallet_getAccounts`

**Params:**

```json
{
  "chain": "eip155:1"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `chain` | string | no | CAIP-2 chain. If omitted, return accounts for all chains authorized in this session. |

**Result:**

```json
{
  "accounts": [
    {
      "address": "0xab16a96D359eC26a11e2C2b3d8f8B8942d5Bfcdb",
      "chains": ["eip155:1", "eip155:137", "eip155:42161"]
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `accounts` | Account[] | List of authorized accounts. |
| `accounts[].address` | string | EIP-55 checksummed hex address. |
| `accounts[].chains` | string[] | CAIP-2 chains this account is available on. |

**Errors:** `unauthorized`, `internal_error`

If `chain` is present and not in `capabilities.chains`, the wallet MUST reject
with `unsupported_chain`. A wallet MUST NOT return accounts for chains outside
the approved session scope.

### 5.2 wallet_signTransaction

Signs a transaction without broadcasting it. Returns the signed transaction
bytes. The dApp is responsible for submitting the signed transaction to the
network.

**Method:** `wallet_signTransaction`

**Params:**

```json
{
  "chain": "eip155:1",
  "address": "0xab16a96D359eC26a11e2C2b3d8f8B8942d5Bfcdb",
  "tx": {
    "to": "0x4976fb03C32e5B8cfe2b6cCB31c09Ba78EBaBa41",
    "value": "0xde0b6b3a7640000",
    "data": "0x",
    "gas": "0x5208",
    "maxFeePerGas": "0x2540be400",
    "maxPriorityFeePerGas": "0x3b9aca00",
    "nonce": "0x0",
    "type": "0x2",
    "chainId": "0x1"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `chain` | string | yes | CAIP-2 chain identifier. |
| `address` | string | yes | Sender address (EIP-55). |
| `tx` | object | yes | Transaction object. |
| `tx.to` | string | no | Recipient address. Omit for contract creation. |
| `tx.value` | string | no | Value in wei, hex-encoded. Default `"0x0"`. |
| `tx.data` | string | no | Call data, hex-encoded. Default `"0x"`. |
| `tx.gas` | string | no | Gas limit, hex-encoded. Wallet MAY estimate if omitted. |
| `tx.gasPrice` | string | no | Gas price for legacy (type 0) transactions. |
| `tx.maxFeePerGas` | string | no | Max fee for EIP-1559 (type 2) transactions. |
| `tx.maxPriorityFeePerGas` | string | no | Priority fee for EIP-1559 transactions. |
| `tx.nonce` | string | no | Nonce, hex-encoded. Wallet MAY determine if omitted. |
| `tx.type` | string | no | Transaction type: `"0x0"` (legacy), `"0x1"` (EIP-2930), `"0x2"` (EIP-1559), `"0x3"` (EIP-4844), `"0x4"` (EIP-7702). |
| `tx.chainId` | string | no | Chain ID, hex-encoded. MUST match `chain` if provided. |
| `tx.accessList` | array | no | EIP-2930 access list. Each entry: `{ address: string, storageKeys: string[] }`. |
| `tx.maxFeePerBlobGas` | string | no | Max fee per blob gas for EIP-4844 (type 3) transactions, hex-encoded. |
| `tx.blobVersionedHashes` | string[] | no | Versioned hashes for EIP-4844 (each 32-byte hex with `0x01` version prefix). The wallet cannot verify that actual blob data exists for these hashes — it trusts the dApp to provide correct hashes. See validation rule 5 for type 3 constraints. |
| `tx.authorizationList` | array | no | EIP-7702 authorization tuples. Each entry: `{ chainId: string, address: string, nonce: string, yParity: string, r: string, s: string, authority: string (optional) }`. All hex-encoded. Maximum 16 entries (see rationale below). These are pre-signed authorizations attached to the transaction; this method does not define a generic dApp-driven flow for creating new authorizations. The optional `authority` field is the expected recovered authority address (see validation rule 5b). |

**Validation rules:**

The wallet MUST enforce the following before signing:

1. `address` MUST be an account previously returned by `wallet_getAccounts`
   for this session and authorized for the requested `chain`. If not, reject
   with `unauthorized`.
2. `chain` MUST be in the wallet's declared `capabilities.chains`. If not,
   reject with `unsupported_chain`.
3. If `tx.chainId` is present, its uint256 value MUST equal the numeric chain
   ID from the `chain` field. On mismatch, reject with `invalid_params`.
4. If `tx.chainId` is absent, the wallet MUST set it to the chain ID
   derived from `chain` before signing.
5. Transaction type and fee field consistency:
   - If `tx.type` is `"0x0"` (legacy): `maxFeePerGas` and
     `maxPriorityFeePerGas` MUST NOT be present. `accessList` MUST NOT
     be present.
   - If `tx.type` is `"0x1"` (EIP-2930): `maxFeePerGas` and
     `maxPriorityFeePerGas` MUST NOT be present. `gasPrice` MUST be
     used. `accessList` MAY be present.
   - If `tx.type` is `"0x2"` (EIP-1559): `gasPrice` MUST NOT be
     present. `maxFeePerGas` MUST be used.
   - If `tx.type` is `"0x3"` (EIP-4844): `gasPrice` MUST NOT be
     present. `maxFeePerGas` and `maxFeePerBlobGas` MUST be used.
     `blobVersionedHashes` MUST be a non-empty array. `to` MUST be
     present (blob transactions cannot create contracts). Each entry
     in `blobVersionedHashes` MUST be a 32-byte hex value whose first
     byte is `0x01` (the version byte). The wallet MUST verify the
     version byte and reject entries with other versions via
     `invalid_params`. Note: the wallet cannot verify that actual blob
     sidecar data corresponds to these hashes; it signs the transaction
     trusting the dApp-provided hashes. The wallet SHOULD display the
     number of blob hashes and warn the user that blob transactions
     carry additional data costs.
   - If `tx.type` is `"0x4"` (EIP-7702): `gasPrice` MUST NOT be
     present. `maxFeePerGas` MUST be used. `to` MUST be present
     (EIP-7702 does not support contract creation). `authorizationList`
     MUST be a non-empty array with at most 16 entries. If more than
     16 entries are provided, reject with `invalid_params`.
     **Rationale for 16-entry limit:** Each authorization entry requires
     an `ecrecover` operation (~4,000 gas equivalent CPU cost on mobile
     devices, ~0.5 ms per recovery on modern ARM processors). 16 entries
     cap the worst-case wallet-side validation to ~8 ms, which is
     acceptable for interactive signing flows. Current EIP-7702 usage
     patterns (smart account setup, batch delegation) typically require
     1-3 entries. The limit of 16 provides ample headroom while
     preventing a malicious dApp from forcing expensive validation.
     Wallets that need to support specialized use cases requiring more
     entries MAY declare a higher limit via a custom capability field
     (e.g., `capabilities.txTypes.eip7702MaxAuth`). For each
     authorization entry, the wallet MUST:
     (a) Validate `yParity` is `"0x0"` or `"0x1"`. Validate `r` and
         `s` are 32-byte hex values within the secp256k1 curve order.
         `s` MUST be in the lower half of the curve order (low-s per
         EIP-2). Validate `nonce` is < 2^64.
     (b) Recover the authority address using the EIP-7702 signing
         hash: `keccak256(0x05 || rlp([chainId, address, nonce]))`,
         where `chainId`, `address`, and `nonce` are from the
         authorization tuple. Recovery uses `yParity`, `r`, `s`.
         If recovery fails, reject with `invalid_params`.
         If the optional `authority` field is present in the
         authorization entry, the wallet MUST verify that the
         recovered address matches `authority` (case-insensitive).
         On mismatch, reject with `invalid_params`. DApps SHOULD
         include the `authority` field to enable wallet-side
         verification without requiring the user to manually
         identify the recovered address.
     (c) Verify the entry's `chainId` is either `"0x0"`
         (chain-agnostic) or matches the transaction's chain.
     (d) If the recovered authority is an account managed by this
         wallet, the wallet MUST reject with `user_rejected` by
         default. A wallet MAY allow this only if ALL of the
         following conditions are met:
         (i)   The authorization was generated by the wallet's own
               internal flow — not by a dApp request. For example,
               a wallet-initiated smart account setup where the
               wallet itself constructs the authorization tuple.
         (ii)  The delegation target (`address` in the authorization)
               is on a wallet-maintained allowlist of audited
               contracts. The allowlist MUST be hardcoded or
               maintained by the wallet vendor, not configurable by
               dApps or users.
         (iii) The wallet displays an explicit warning to the user
               explaining that this authorization delegates code
               execution authority over their account to the target
               contract.
         If any of these conditions is not met, the wallet MUST
         reject with `user_rejected`.
     (e) Display to the user: the delegation target (`address`),
         the recovered authority address, and a warning that
         EIP-7702 grants the delegation target code execution
         authority over the authority's account — including full
         access to its balance and storage. The wallet MUST also
         warn that delegation persists even if the transaction
         reverts after the authorization is processed.
     (f) If `address` is the zero address, display this as clearing an
         existing delegation rather than granting a new one.
     (g) The wallet MUST NOT offer a generic UI that lets a dApp request a
         fresh EIP-7702 authorization signature for arbitrary code. Such
         authorization generation, if supported at all, MUST be wallet-owned,
         use audited delegation targets, and be outside this method's generic
         transaction-signing path.
   - If both `gasPrice` and `maxFeePerGas` are present regardless of
     `type`, reject with `invalid_params`.
   - If `tx.type` is absent, the wallet MAY infer it: presence of
     `maxFeePerGas` implies type 2; presence of `accessList` without
     `maxFeePerGas` implies type 1; otherwise type 0. Types 3 and 4
     MUST be explicitly specified (not inferred).
6. If `tx.type` is present and its value is not one of `"0x0"`, `"0x1"`,
   `"0x2"`, `"0x3"`, `"0x4"`, the wallet MUST reject with
   `invalid_params`.
7. `address` MUST be a 42-character hex string starting with `0x`. The
   wallet MUST reject requests with addresses of incorrect length or
   format with `invalid_params`.
8. If `tx.from` is present, the wallet MUST verify it matches `address`
   (case-insensitive comparison). On mismatch, reject with
   `invalid_params`. The wallet MUST use the `address` field as the
   authoritative sender, not `tx.from`.
9. `tx.to`, `tx.from`, all access-list addresses, and all authorization-list
   addresses MUST be exact 20-byte hex addresses. `accessList.storageKeys` and
   `blobVersionedHashes` MUST be exact 32-byte hex values, with blob hashes
   using version byte `0x01`.
10. `maxPriorityFeePerGas` MUST NOT exceed `maxFeePerGas` for transaction
   types that use EIP-1559-style fees. Fee fields, value, gas, nonce, and
   chainId MUST be non-negative integer quantities in their EIP-defined ranges.
11. The wallet MUST verify that the requested transaction type is supported on
   the requested chain. For example, an L2 or pre-fork chain that does not
   support EIP-4844 or EIP-7702 MUST reject type `0x3` or `0x4` with
   `invalid_params` or `unsupported_chain`.
12. The wallet MUST display to the user at minimum: chain name, recipient
   address (or "Contract Creation" if `to` is absent), and value. When
   `to` is absent (contract creation), the wallet SHOULD display a
   prominent warning.

**Result:**

```json
{
  "signedTx": "0x..."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `signedTx` | string | The full RLP-encoded signed transaction, hex-encoded. Ready to submit via `eth_sendRawTransaction`. |

**Errors:** `user_rejected`, `unauthorized`, `invalid_params`, `unsupported_chain`, `internal_error`

### 5.3 wallet_sendTransaction

Signs and broadcasts a transaction. Returns the transaction hash. This is the
most common method — dApps typically use this instead of `wallet_signTransaction`
unless they need custom submission logic.

**Method:** `wallet_sendTransaction`

**Params:** Same as `wallet_signTransaction` (§5.2). All validation rules
from §5.2 apply.

**Result:**

```json
{
  "txHash": "0xabc123..."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `txHash` | string | Transaction hash, hex-encoded (32 bytes). |

The wallet submits the signed transaction to its own RPC endpoint. A
successful response indicates the transaction was accepted by the wallet's
RPC endpoint, not that it was mined or confirmed. The dApp is responsible
for monitoring the transaction status on-chain.

**EIP-4844 blob transaction limitations.** Blob transactions (type 3)
require blob sidecar data for broadcasting, which typically exceeds the
64 KB WalletPair message limit. WalletPair v1 support for blob
transactions is therefore limited:

- **Default: sign-only.** Unless the wallet declares
  `capabilities.txTypes.eip4844 = "full"` (see §4.1), the dApp MUST
  use `wallet_signTransaction` for blob transactions and submit the
  signed transaction with sidecar data via its own RPC endpoint.
- For `wallet_sendTransaction` with type 3: the wallet signs and
  broadcasts. However, the wallet needs access to the blob sidecar data
  (not transmitted via WalletPair) to construct a valid broadcast. If
  the wallet does not have sidecar data available, it MUST reject with
  `invalid_params` and message "Blob sidecar data required for
  broadcast". A wallet that declares `txTypes.eip4844 = "full"` MUST
  have an independent mechanism for obtaining sidecar data (e.g., a
  local blob pool or direct RPC integration with the dApp's blob
  provider).
- The wallet signs the transaction based on `blobVersionedHashes`
  provided by the dApp. The wallet **cannot verify** that actual blob
  data exists for these hashes — it trusts the dApp to provide correct
  hashes. The wallet SHOULD display the number of blob hashes and a
  warning about additional data costs.
- A future WalletPair extension may define chunked transfer for large
  payloads to enable full blob transaction support.

**Errors:** `user_rejected`, `unauthorized`, `invalid_params`, `unsupported_chain`, `insufficient_funds`, `nonce_too_low`, `gas_estimation_failed`, `tx_rejected`, `internal_error`

### 5.4 wallet_signMessage

Signs an arbitrary message using [EIP-191](https://eips.ethereum.org/EIPS/eip-191)
personal sign (`\x19Ethereum Signed Message:\n` prefix).

**Method:** `wallet_signMessage`

**Params:**

```json
{
  "chain": "eip155:1",
  "address": "0xab16a96D359eC26a11e2C2b3d8f8B8942d5Bfcdb",
  "message": "Hello, WalletPair!"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `chain` | string | yes | CAIP-2 chain. |
| `address` | string | yes | Signing address. |
| `message` | string | yes | UTF-8 text to sign. The message is ALWAYS treated as UTF-8 text regardless of its content (including strings that start with `0x`). To sign raw bytes, use `wallet_signRawMessage` instead. |

The wallet MUST apply the EIP-191 prefix `\x19Ethereum Signed Message:\n<length>`
where `<length>` is the byte length of the message encoded as UTF-8.

The wallet MUST NOT infer encoding from message content. The `message`
field is always UTF-8 text.

The wallet MUST display the full message text to the user before signing.

**Validation rules:**

1. `address` MUST be an account authorized for this session.
2. `chain` MUST be in `capabilities.chains`.

Note: EIP-191 personal sign signatures are not chain-bound (the chain ID
is not part of the signed data). The `chain` parameter identifies the
session context but does not prevent cross-chain replay of the signature.
The wallet MUST display a prominent warning that the signature is not
chain-bound and may be replayed on any EVM chain. The wallet MUST
additionally warn when the message appears to be a login nonce or
authorization grant without domain/expiry/nonce fields (e.g., bare hex
hashes or short numeric strings).

**Structured message recommendation.** DApps that need domain-bound or
expiry-bound message signatures SHOULD use `wallet_signTypedData`
(EIP-712) instead, which supports `domain.chainId` for chain binding.
For login flows specifically, dApps SHOULD use
[EIP-4361](https://eips.ethereum.org/EIPS/eip-4361) (Sign-In with
Ethereum) formatted messages, which include domain, chain ID, nonce,
and expiration. The wallet SHOULD detect EIP-4361 formatted messages
and display the parsed fields (domain, chain, expiry) prominently.

**Risk-based confirmation.** The wallet MAY implement tiered confirmation
for `wallet_signMessage`:
- Messages matching EIP-4361 format: standard confirmation.
- Messages that are plain human-readable text: standard confirmation with
  cross-chain replay warning.
- Messages that appear to be bare hex hashes, short numeric strings, or
  unstructured authorization tokens: require elevated confirmation (e.g.,
  additional tap, delay, or explicit "I understand this may be replayed"
  acknowledgment).

**Result:**

```json
{
  "signature": "0x..."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `signature` | string | 65-byte signature (r + s + v), hex-encoded. |

**Errors:** `user_rejected`, `unauthorized`, `invalid_params`, `internal_error`

### 5.5 wallet_signTypedData

Signs typed structured data using [EIP-712](https://eips.ethereum.org/EIPS/eip-712).

**Method:** `wallet_signTypedData`

**Params:**

```json
{
  "chain": "eip155:1",
  "address": "0xab16a96D359eC26a11e2C2b3d8f8B8942d5Bfcdb",
  "typedData": {
    "types": {
      "EIP712Domain": [
        { "name": "name", "type": "string" },
        { "name": "version", "type": "string" },
        { "name": "chainId", "type": "uint256" },
        { "name": "verifyingContract", "type": "address" }
      ],
      "Mail": [
        { "name": "from", "type": "string" },
        { "name": "to", "type": "string" },
        { "name": "contents", "type": "string" }
      ]
    },
    "primaryType": "Mail",
    "domain": {
      "name": "Example DApp",
      "version": "1",
      "chainId": 1,
      "verifyingContract": "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"
    },
    "message": {
      "from": "Alice",
      "to": "Bob",
      "contents": "Hello!"
    }
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `chain` | string | yes | CAIP-2 chain. |
| `address` | string | yes | Signing address. |
| `typedData` | object | yes | EIP-712 typed data object (same schema as `eth_signTypedData_v4`). |

**Validation rules:**

1. `address` MUST be an account authorized for this session.
2. `chain` MUST be in `capabilities.chains`.
3. If `typedData.domain.chainId` is present, the wallet MUST parse it as a
   uint256 value: if it is a hex string (`0x`-prefixed), parse as hex; if a
   decimal string, parse as decimal; if a JSON number, accept it only when it
   is a safe integer. If parsing fails, reject with `invalid_params`. The
   resulting value MUST equal the numeric chain ID from the `chain` parameter.
   On mismatch, reject with `invalid_params`.
   If `typedData.domain.chainId` is absent AND the typed data matches a
   high-risk pattern (see below), the wallet MUST reject with
   `invalid_params`. For other typed data where `domain.chainId` is
   absent, the wallet MUST display a warning that the signature is not
   chain-bound and may be replayed on other chains.
   **High-risk pattern detection:** The wallet MUST treat typed data as
   high-risk if ANY of the following are true:
   - `primaryType` is `Permit` and `types` contains fields `owner`,
     `spender`, `value` (ERC-2612 / ERC-20 Permit).
   - `primaryType` is `Permit` and `types` contains fields `owner`,
     `spender`, `tokenId` (ERC-721 Permit).
   - `primaryType` is `PermitBatch` or `PermitSingle` (Permit2).
   - Any type in `types` contains a field named `allowance` or
     `permitted` with a struct type referencing `amount` or `token`.
   - `primaryType` contains the substring `Permit` (case-insensitive).
4. The wallet MUST verify that `typedData.primaryType` references a type
   defined in `typedData.types`. If not, reject with `invalid_params`.
5. The wallet MUST verify that `typedData.types` contains
   `EIP712Domain`. If not, reject with `invalid_params`.
6. If `typedData.domain.verifyingContract` is the zero address
   (`0x0000000000000000000000000000000000000000`), the wallet MUST
   display a prominent warning to the user before requesting
   confirmation. This is unusual and may indicate a malicious request.
7. The wallet MUST display `domain.name`, `domain.verifyingContract`,
   `primaryType`, and key message fields to the user before requesting
   confirmation.
8. The wallet MUST NOT perform blind signing of EIP-712 data.
9. The wallet SHOULD warn the user when signing known high-risk typed data
   patterns such as ERC-20 Permit (token approvals), ERC-2612, or any
   typed data that grants spending allowance.

**Result:**

```json
{
  "signature": "0x..."
}
```

**Errors:** `user_rejected`, `unauthorized`, `invalid_params`, `internal_error`

### 5.6 wallet_switchChain

Requests the wallet to switch its active chain for this session. If the
wallet supports the requested chain, it switches and emits a `chainChanged`
event.

Chain switching MUST affect only the current WalletPair session. The
wallet MUST NOT change the active chain for other sessions or its global
state as a result of this method.

If the wallet has pending confirmations or pending chain-specific RPC
requests for this session, it MUST cancel or reject them before completing
the switch. A dApp MUST treat a `chainChanged` event that arrives while a
request is pending as a possible invalidation of that request's assumptions.

**Method:** `wallet_switchChain`

**Params:**

```json
{
  "chain": "eip155:137"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `chain` | string | yes | CAIP-2 chain to switch to. |

**Result:**

```json
{
  "chain": "eip155:137"
}
```

Returns the chain that was switched to. The wallet MUST also emit a
`chainChanged` event after a successful switch.

**Errors:** `user_rejected`, `unsupported_chain`, `internal_error`

### 5.7 wallet_addChain

Requests the wallet to add a new EVM chain to its configuration.

`wallet_addChain` is a special case: it may target a chain that is not yet in
`capabilities.chains`, but only if `wallet_addChain` itself is in
`capabilities.methods`. A successful add does not automatically expand the
current session's chain scope.

**Session scope after adding a chain.** To use the newly added chain, the
dApp has two options:

1. **New session (recommended).** Close the current session and initiate a
   fresh pairing. The wallet will include the new chain in the next
   session's `capabilities.chains` if the user approves.
2. **In-session scope update (future extension).** WalletPair v1 does not
   define an in-session scope expansion mechanism. A future version may add
   a `wallet_updateScope` method that allows the wallet to expand
   `capabilities.chains` within an existing session, subject to user
   approval and a new `scopeChanged` event. Until such a method is
   standardized, dApps MUST NOT assume the added chain is usable in the
   current session.

The wallet MUST reject requests targeting the newly added chain in the
current session with `unsupported_chain` until a new session is established
that includes it in `capabilities.chains`.

**Design rationale for requiring re-pairing.** Allowing in-session scope
expansion introduces significant complexity:

- The transcript hash (WalletPair Protocol v1 §7.2) is computed at
  pairing time over the granted capabilities. Expanding scope
  post-pairing requires either re-deriving traffic keys (breaking
  in-flight messages) or accepting that the transcript no longer reflects
  the actual session scope (weakening the cryptographic binding).
- In-session scope changes create a TOCTOU (time-of-check-time-of-use)
  window where the dApp may send requests to a chain the wallet has not
  yet fully validated.
- Re-pairing is a one-time cost per scope change. In practice, most
  multi-chain dApps know their required chains at connection time and
  declare them in the pairing URI `chains` field. The re-pairing
  scenario is limited to cases where a user explicitly requests a chain
  not originally anticipated.
- DApps that frequently need dynamic chain switching SHOULD declare a
  broad `chains` set in the pairing URI to minimize re-pairing friction.

A future `wallet_updateScope` extension, if standardized, MUST define:
(1) how the transcript hash or traffic keys are updated to reflect the
new scope, (2) a user-confirmation requirement on the wallet side, and
(3) a `scopeChanged` event so the dApp can detect the expansion.

**Method:** `wallet_addChain`

**Params:**

```json
{
  "chain": "eip155:8453",
  "chainName": "Base",
  "nativeCurrency": {
    "name": "Ether",
    "symbol": "ETH",
    "decimals": 18
  },
  "rpcUrls": ["https://mainnet.base.org"],
  "blockExplorerUrls": ["https://basescan.org"],
  "iconUrls": ["https://example.com/base-icon.png"]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `chain` | string | yes | CAIP-2 chain to add. |
| `chainName` | string | yes | Human-readable chain name. |
| `nativeCurrency` | object | yes | Native currency info. |
| `nativeCurrency.name` | string | yes | Currency name. |
| `nativeCurrency.symbol` | string | yes | Currency symbol (2-6 characters). |
| `nativeCurrency.decimals` | number | yes | Number of decimals (usually 18). MUST be a non-negative integer not exceeding 36. |
| `rpcUrls` | string[] | yes | At least one RPC endpoint URL. |
| `blockExplorerUrls` | string[] | no | Block explorer URLs. |
| `iconUrls` | string[] | no | Chain icon URLs. Wallet MAY ignore. |

**Result:**

```json
{
  "added": true
}
```

**Global chain limits.** The wallet MUST enforce a maximum number of
dApp-added custom chains (recommended: 20). If the limit is reached,
the wallet MUST reject with `rate_limited`. Additionally, the wallet
MUST limit `wallet_addChain` calls to at most 3 per session to prevent
abuse. Subsequent calls in the same session MUST be rejected with
`rate_limited`.

**Input length limits.** The wallet MUST enforce the following limits and
reject with `invalid_params` if exceeded:

| Field | Maximum |
|-------|---------|
| `chainName` | 64 UTF-8 characters |
| `nativeCurrency.name` | 32 UTF-8 characters |
| `nativeCurrency.symbol` | 6 UTF-8 characters |
| `rpcUrls` | At most 5 entries |
| `blockExplorerUrls` | At most 5 entries |
| `iconUrls` | At most 3 entries |
| Each URL | 2048 UTF-8 characters |

**URL scheme validation.** The wallet MUST reject `rpcUrls` entries using
non-HTTPS schemes, except for `http://localhost` and `http://127.0.0.1`
(local development). The wallet MUST reject `rpcUrls` entries using
`javascript:`, `data:`, or other non-HTTP(S) schemes with `invalid_params`.

**RPC validation and TLS.** The wallet MUST query `eth_chainId` on each
accepted RPC URL before adding the chain and MUST reject the request if no
RPC URL returns the exact chain ID specified by `chain`. The wallet MUST
verify the TLS certificate chain for all HTTPS RPC URLs and MUST reject
URLs that fail TLS validation. The wallet MUST reject or quarantine RPC
URLs that return conflicting chain IDs, timeout repeatedly, or present
invalid certificates. After adding a chain, the wallet MUST periodically
re-validate that the RPC URL still returns the correct chain ID
(recommended: at least once every 24 hours, and before each transaction
signing operation on that chain). If re-validation fails, the wallet MUST
mark the RPC URL as untrusted and warn the user before any subsequent
transaction on that chain.

**Default RPC allowlist.** The wallet SHOULD maintain a built-in allowlist
of known-good default RPC URLs for well-known chains (e.g., Ethereum
Mainnet, Polygon, Arbitrum, Base). When a dApp calls `wallet_addChain`
for a chain already on the allowlist, the wallet MUST use its built-in
RPC URL and MUST NOT replace it with the dApp-provided URL unless the
user explicitly approves the override. RPC URLs provided by dApps MUST
be visually distinguished as "custom / unverified" in the wallet UI.

**Existing chain protection.** If the chain already exists in the wallet,
the wallet MUST prompt the user before updating RPC URLs. The prompt MUST
clearly display both the current (trusted) RPC URL and the proposed
(dApp-provided) URL. The wallet MUST NOT silently update RPC endpoints
for existing chains, as this could enable RPC hijacking (a malicious dApp
replacing a trusted RPC with one that returns false balances or transaction
results). For high-value chains (Ethereum Mainnet `eip155:1` and any chain
with user assets), the wallet SHOULD require elevated confirmation (e.g.,
additional tap with delay) before allowing RPC URL changes.

**Errors:** `user_rejected`, `invalid_params`, `internal_error`

### 5.8 wallet_watchAsset

Requests the wallet to track a token (ERC-20, ERC-721, or ERC-1155).

**Method:** `wallet_watchAsset`

**Params:**

```json
{
  "chain": "eip155:1",
  "type": "ERC20",
  "contract": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  "symbol": "USDC",
  "decimals": 6,
  "image": "https://example.com/usdc.png"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `chain` | string | yes | CAIP-2 chain. |
| `type` | string | yes | Token standard: `"ERC20"`, `"ERC721"`, or `"ERC1155"`. |
| `contract` | string | yes | Token contract address. |
| `symbol` | string | no | Token symbol. |
| `decimals` | number | conditional | Token decimals. MUST be provided for `"ERC20"`. |
| `image` | string | no | Token icon URL. Wallet MAY ignore. |
| `tokenId` | string | conditional | Token ID. MUST be provided for `"ERC721"` and `"ERC1155"`. |

**Result:**

```json
{
  "added": true
}
```

**Errors:** `user_rejected`, `invalid_params`, `internal_error`

The wallet MUST reject if `chain` is not in `capabilities.chains`, if
`contract` is not an exact 20-byte address, if `decimals` is outside the range
0-255 for ERC-20, or if `tokenId` is not a non-negative uint256 quantity for
ERC-721/ERC-1155. The wallet SHOULD verify token metadata from the chain rather
than trusting dApp-provided `symbol`, `decimals`, or `image`.

**Rate and quantity limits.** The wallet MUST enforce the following limits
to prevent abuse:

- At most **10 `wallet_watchAsset` calls per session**. Subsequent calls
  MUST be rejected with `rate_limited`.
- The wallet MUST enforce a **global maximum of 200 dApp-added watched
  assets** across all sessions. If the limit is reached, the wallet MUST
  reject with `rate_limited`.
- The wallet MUST NOT auto-display or auto-trust token metadata from
  dApp-provided fields without on-chain verification.

### 5.9 wallet_signRawMessage

Signs raw bytes using [EIP-191](https://eips.ethereum.org/EIPS/eip-191)
personal sign (`\x19Ethereum Signed Message:\n` prefix). Unlike
`wallet_signMessage` which accepts UTF-8 text, this method accepts
hex-encoded raw bytes.

**Method:** `wallet_signRawMessage`

**Params:**

```json
{
  "chain": "eip155:1",
  "address": "0xab16a96D359eC26a11e2C2b3d8f8B8942d5Bfcdb",
  "data": "0xdeadbeef"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `chain` | string | yes | CAIP-2 chain. |
| `address` | string | yes | Signing address. |
| `data` | string | yes | Hex-encoded bytes to sign, with `0x` prefix. MUST be even-length. |

The wallet MUST validate that `data` is a valid `0x`-prefixed hex string
with even length. If not, reject with `invalid_params`.

The wallet MUST apply the EIP-191 prefix `\x19Ethereum Signed Message:\n<length>`
where `<length>` is the byte length of the hex-decoded `data`.

The wallet SHOULD display the raw bytes as hex to the user. If the bytes
can be decoded as valid UTF-8, the wallet MAY additionally show the text
representation.

As with `wallet_signMessage`, EIP-191 signatures are not chain-bound. The
wallet MUST display a prominent warning that the signature may be replayed
on any EVM chain. The wallet SHOULD apply the same risk-based confirmation
tiers described in §5.4. Since raw byte signing is inherently opaque to the
user, the wallet SHOULD require elevated confirmation for all
`wallet_signRawMessage` requests.

**Validation rules:**

1. `address` MUST be an account authorized for this session.
2. `chain` MUST be in `capabilities.chains`.
3. `data` MUST be a `0x`-prefixed hex string with even length.

**Result:**

```json
{
  "signature": "0x..."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `signature` | string | 65-byte signature (r + s + v), hex-encoded. |

**Errors:** `user_rejected`, `unauthorized`, `invalid_params`, `internal_error`

## 6. Events

Events are sent from the wallet to the dApp using the WalletPair `evt`
message. The `event` field is the event name. The event data is encrypted
in the `sealed` field.

The dApp MUST NOT assume event ordering relative to pending request
responses. Events and responses may arrive in any order. The dApp MUST
handle `accountsChanged` or `chainChanged` arriving between sending a
request and receiving its response.

### 6.1 accountsChanged

Emitted when the wallet's exposed accounts change (user switches account,
adds or removes account access).

**Event:** `accountsChanged`

**Data:**

```json
{
  "accounts": [
    {
      "address": "0xNewAddress...",
      "chains": ["eip155:1", "eip155:137"]
    }
  ]
}
```

The dApp MUST update its local account state. It MAY call
`wallet_getAccounts` for a full refresh.

An empty `accounts` array indicates the wallet has revoked all account
access for this session. The dApp MUST treat this as equivalent to
session disconnection for authorization purposes.

### 6.2 chainChanged

Emitted when the wallet's active chain changes.

**Event:** `chainChanged`

**Data:**

```json
{
  "chain": "eip155:137"
}
```

### 6.3 connect

Emitted when the wallet establishes connectivity to a chain's RPC endpoint.
Note: This event refers to the wallet's connectivity to the chain's RPC
endpoint, not to the WalletPair session itself. WalletPair session lifecycle
is managed by the transport layer.

**Event:** `connect`

**Data:**

```json
{
  "chain": "eip155:1"
}
```

### 6.4 disconnect

Emitted when the wallet loses connectivity to a chain's RPC endpoint.

**Event:** `disconnect`

**Data:**

```json
{
  "chain": "eip155:1",
  "code": 4900,
  "message": "Disconnected from chain"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `chain` | string | CAIP-2 chain. |
| `code` | number | EIP-1193 error code (4900 = disconnected). Note: this is a numeric code for EIP-1193 compatibility, unlike the string-based error codes in §7. |
| `message` | string | Human-readable message. |

## 7. Error Codes

When a method fails, the decrypted `sealed` payload contains `_ok = false`
and an error object (per WalletPair Protocol v1 §5.3):

```json
{
  "code": "user_rejected",
  "message": "User rejected the transaction"
}
```

Standard error codes:

| Code | EIP-1193 Equivalent | Meaning | When to Use |
|------|---------------------|---------|-------------|
| `user_rejected` | 4001 | User declined the request in wallet UI. | User tapped reject/cancel. |
| `unauthorized` | 4100 | DApp is not authorized for this account or method. | Account not exposed to dApp. |
| `invalid_params` | -32602 | Request parameters are malformed or missing. | Bad address, missing field, chainId mismatch. |
| `unsupported_chain` | 4902 | Wallet does not support the requested chain and cannot add it. | Chain not in capabilities and not addable. |
| `unsupported_method` | 4200 | Wallet does not support the requested method. | Method not in capabilities. |
| `insufficient_funds` | -32000 | Account balance too low for the transaction. | Not enough ETH/token. |
| `nonce_too_low` | -32000 | Transaction nonce is already used. | Stale nonce. |
| `gas_estimation_failed` | -32000 | Wallet could not estimate gas for the transaction. | Reverted in estimation. |
| `tx_rejected` | -32000 | Network rejected the transaction. | RPC returned error. |
| `chain_not_added` | 4902 | Requested chain is not configured but could be added via `wallet_addChain`. | Chain unknown but addable. |
| `rate_limited` | -32005 | Too many pending requests or method call limit exceeded. | DApp exceeded 32 concurrent pending requests, or per-session/global limits for `wallet_addChain` or `wallet_watchAsset`. |
| `internal_error` | -32603 | Unexpected wallet error. | Catch-all. |

The `code` field is a string (not a number) to allow namespaced extensions.
Wallet implementations may define additional error codes prefixed with their
namespace (e.g., `metamask:snap_error`).

The EIP-1193 numeric codes are provided for reference. SDK implementations
that expose an EIP-1193 provider SHOULD map to these numeric codes on the
dApp side.

## 8. Wire Format Examples

All examples show the decrypted content of the `sealed` field. On the wire,
these JSON objects are encrypted and base64url-encoded in the `sealed` field
of the WalletPair message.

### DApp requests accounts

WalletPair message (wire):

```json
{
  "v": 1,
  "t": "req",
  "ch": "aabb...eeff",
  "ts": 1779170000000,
  "from": "base64url-dapp-pubkey",
  "body": {
    "id": "req-001",
    "sealed": "<encrypted params>"
  }
}
```

Decrypted `sealed` (params — includes `_method`):

```json
{
  "_method": "wallet_getAccounts",
  "chain": "eip155:1"
}
```

### Wallet responds with accounts

WalletPair message (wire):

```json
{
  "v": 1,
  "t": "res",
  "ch": "aabb...eeff",
  "ts": 1779170000000,
  "from": "base64url-wallet-pubkey",
  "body": {
    "id": "req-001",
    "sealed": "<encrypted result>"
  }
}
```

Decrypted `sealed` (result — `_ok` and `_result` per WalletPair Protocol v1 §5.3):

```json
{
  "_ok": true,
  "_result": {
    "accounts": [
      {
        "address": "0xab16a96D359eC26a11e2C2b3d8f8B8942d5Bfcdb",
        "chains": ["eip155:1", "eip155:137"]
      }
    ]
  }
}
```

### DApp sends transaction

WalletPair message (wire):

```json
{
  "v": 1,
  "t": "req",
  "ch": "aabb...eeff",
  "ts": 1779170000000,
  "from": "base64url-dapp-pubkey",
  "body": {
    "id": "req-002",
    "sealed": "<encrypted params>"
  }
}
```

Decrypted `sealed` (params):

```json
{
  "_method": "wallet_sendTransaction",
  "chain": "eip155:1",
  "address": "0xab16a96D359eC26a11e2C2b3d8f8B8942d5Bfcdb",
  "tx": {
    "to": "0x4976fb03C32e5B8cfe2b6cCB31c09Ba78EBaBa41",
    "value": "0xde0b6b3a7640000",
    "data": "0x",
    "type": "0x2",
    "chainId": "0x1"
  }
}
```

### Wallet responds with tx hash

Decrypted `sealed` (result — `_ok` and `_result` per WalletPair Protocol v1 §5.3):

```json
{
  "_ok": true,
  "_result": {
    "txHash": "0x6b17a7a5f05676c30edb0dbb66c1b3c86e2b0e6c20f39a53e021ec36bf3b9f7a"
  }
}
```

### User rejects a signing request

WalletPair message (wire):

```json
{
  "v": 1,
  "t": "res",
  "ch": "aabb...eeff",
  "ts": 1779170000000,
  "from": "base64url-wallet-pubkey",
  "body": {
    "id": "req-003",
    "sealed": "<encrypted error>"
  }
}
```

Decrypted `sealed` (error — `_ok` per WalletPair Protocol v1 §5.3):

```json
{
  "_ok": false,
  "code": "user_rejected",
  "message": "User rejected the request"
}
```

### Wallet pushes chainChanged event

WalletPair message (wire):

```json
{
  "v": 1,
  "t": "evt",
  "ch": "aabb...eeff",
  "ts": 1779170000000,
  "from": "base64url-wallet-pubkey",
  "body": {
    "id": "evt-001",
    "sealed": "<encrypted data>"
  }
}
```

Decrypted `sealed` (data):

```json
{
  "_event": "chainChanged",
  "chain": "eip155:137"
}
```

## 9. Typical Session Flow

```text
1. DApp creates channel, wallet scans QR
2. Pairing (create → join → accept → ready.connected)
3. DApp calls wallet_getAccounts
   → wallet returns previously authorized addresses
4. DApp displays UI, user initiates action
5. DApp calls wallet_sendTransaction
   → wallet validates chain ID consistency
   → wallet shows tx details (chain, to, value), user confirms
   → wallet signs, broadcasts, returns txHash
6. Wallet detects chain switch
   → wallet sends chainChanged event
7. DApp calls wallet_signTypedData (e.g., permit)
   → wallet validates domain.chainId matches chain param
   → wallet shows typed data details, warns if permit/approval
   → user confirms, wallet returns signature
8. User closes session
   → either side sends close
```

## 10. Versioning and Extension

This sub-protocol is versioned independently from WalletPair Protocol v1.
Wallets MUST declare the EVM sub-protocol version in the `capabilities.version`
object defined in WalletPair Protocol v1 §8:

```json
{
  "capabilities": {
    "methods": [...],
    "events": [...],
    "chains": ["eip155:1", "eip155:137"],
    "version": {
      "evm": 1
    }
  }
}
```

The `"evm"` key corresponds to the `eip155` CAIP-2 namespace. The integer
value is the sub-protocol version (currently `1`). If `version` is absent
or the `"evm"` key is missing, the dApp MUST assume EVM sub-protocol
version 1 for backward compatibility.

The version is not carried in each wire message, so incompatible schema
changes MUST use new method names or explicit capability flags. A major
version increment (e.g., `"evm": 2`) indicates breaking changes to
existing method schemas.

To add new methods:

1. Define the method name, params, result, and error codes.
2. Add it to the wallet's `capabilities.methods` list.
3. DApps check capabilities before calling.

Wallets MUST return error code `unsupported_method` for unknown methods.

Custom methods may use a namespace prefix:

```text
myapp_customMethod
uniswap_getQuote
```

This allows experimentation without conflicting with standard methods.

### 10.1 Design Note: Method Names

This sub-protocol uses `wallet_*` method names rather than standard
Ethereum JSON-RPC names (`personal_sign`, `eth_sendTransaction`, etc.).
This is intentional:

- WalletPair methods accept CAIP-2 chain identifiers and structured
  params, which differ from the positional-array format of JSON-RPC.
- SDK implementations provide an EIP-1193 adapter layer that maps
  standard JSON-RPC calls to WalletPair methods transparently.
- This separation keeps the WalletPair protocol clean and avoids
  ambiguity with existing JSON-RPC semantics.

## 11. Relationship to Existing Standards

### 11.1 EIPs

| Standard | Relationship |
|----------|-------------|
| [EIP-155](https://eips.ethereum.org/EIPS/eip-155) | Chain ID format in transactions. |
| [EIP-191](https://eips.ethereum.org/EIPS/eip-191) | Personal message signing (`wallet_signMessage`, `wallet_signRawMessage`). |
| [EIP-712](https://eips.ethereum.org/EIPS/eip-712) | Typed data signing (`wallet_signTypedData`). |
| [EIP-1193](https://eips.ethereum.org/EIPS/eip-1193) | Provider interface. SDK provides adapter. |
| [EIP-1559](https://eips.ethereum.org/EIPS/eip-1559) | Type 2 transaction format. |
| [EIP-2930](https://eips.ethereum.org/EIPS/eip-2930) | Access list transactions. |
| [EIP-4844](https://eips.ethereum.org/EIPS/eip-4844) | Blob transactions (type 3). |
| [EIP-7702](https://eips.ethereum.org/EIPS/eip-7702) | Set code transactions (type 4). |
| [EIP-3085](https://eips.ethereum.org/EIPS/eip-3085) | Add chain (`wallet_addChain`). |
| [EIP-3326](https://eips.ethereum.org/EIPS/eip-3326) | Switch chain (`wallet_switchChain`). |
| [EIP-747](https://eips.ethereum.org/EIPS/eip-747) | Watch asset (`wallet_watchAsset`). |
| [EIP-4361](https://eips.ethereum.org/EIPS/eip-4361) | Sign-In with Ethereum. Recommended for login flows (see §5.4). |
| [EIP-6963](https://eips.ethereum.org/EIPS/eip-6963) | Multi Injected Provider Discovery. See §11.1.1. |

#### 11.1.1 Relationship to EIP-6963

[EIP-6963](https://eips.ethereum.org/EIPS/eip-6963) defines a mechanism
for browser-injected wallet providers to announce themselves via DOM events,
allowing dApps to discover multiple wallets without `window.ethereum`
conflicts.

WalletPair operates as a **remote connection protocol** (cross-device,
cross-context) and is orthogonal to EIP-6963's browser injection model.
However, SDK implementations that provide an EIP-1193 adapter for
WalletPair connections SHOULD also register as an EIP-6963 provider when
running in a browser context. This allows dApps that use EIP-6963 wallet
discovery to find and use WalletPair connections alongside injected wallets.

The EIP-6963 provider info for a WalletPair connection SHOULD use:

- `uuid`: A unique identifier per WalletPair session (not the channel ID).
- `name`: The wallet's display name. Since `meta.name` in the `join`
  message is encrypted inside `sealed_join` and not visible to the relay,
  the SDK SHOULD use a default display name (e.g.,
  "WalletPair Wallet") for EIP-6963 registration. If the wallet provides
  a more specific name via an encrypted method after `ready.connected`
  (e.g., in the `wallet_getAccounts` response metadata or a future
  `wallet_getInfo` method), the SDK MAY update the EIP-6963 provider
  name accordingly.
- `icon`: The wallet's `meta.icon` if provided, or a generic WalletPair icon.
  Note: `meta.icon` URLs are subject to the privacy considerations in
  WalletPair Protocol v1 §20.6.
- `rdns`: A reverse-DNS identifier for the WalletPair SDK (e.g.,
  `io.walletpair.sdk`).

### 11.2 CAIPs

| Standard | Relationship |
|----------|-------------|
| [CAIP-2](https://chainagnostic.org/CAIPs/caip-2) | Chain identifier format. Used throughout as `eip155:<chain_id>`. |
| [CAIP-10](https://chainagnostic.org/CAIPs/caip-10) | Account identifier format. Not used on wire, but interoperable (see §3.1). |
| [CAIP-25](https://chainagnostic.org/CAIPs/caip-25) | Session authorization (`wallet_createSession`). Not adopted — see §11.3. |
| [CAIP-27](https://chainagnostic.org/CAIPs/caip-27) | Method invocation envelope (`wallet_invokeMethod`). Similar concept — see §11.3. |
| [CAIP-122](https://chainagnostic.org/CAIPs/caip-122) | Sign in With X (SIWx). Not in scope for v1, may be added as extension. |
| [CAIP-74](https://chainagnostic.org/CAIPs/caip-74) | CACAO capability object. Not in scope for v1, may be added as extension. |
| [CAIP-171](https://chainagnostic.org/CAIPs/caip-171) | Session identifier. WalletPair channel ID (256-bit) exceeds the 96-bit entropy requirement. |
| [CAIP-217](https://chainagnostic.org/CAIPs/caip-217) | Authorization scopes. WalletPair capabilities use a compatible flat structure. |

### 11.3 Design Comparison with CAIP-25 / CAIP-27

WalletPair does not adopt [CAIP-25](https://chainagnostic.org/CAIPs/caip-25)
(`wallet_createSession`) or [CAIP-27](https://chainagnostic.org/CAIPs/caip-27)
(`wallet_invokeMethod`). This is a deliberate design choice:

**CAIP-25** defines session authorization negotiation for in-browser
providers and extensions. It supports partial scope authorization,
namespace-wide scopes, capabilities merging, and multi-session
management via `sessionId`. WalletPair targets a different scenario:
cross-device communication over encrypted relay or Bluetooth, where:

- The pairing flow (QR scan → key exchange → pairing code) replaces
  scope negotiation. The wallet declares the approved session scope in
  the `join` message; the dApp either accepts or rejects.
- End-to-end encryption makes JSON-RPC 2.0 envelope nesting
  unnecessary — all payloads are encrypted in the `sealed` field.
- Each WalletPair channel is a 1:1 session by design. There is no
  need for `sessionId` management (the channel ID serves this role).
- Session lifecycle is handled by the transport layer (`create` /
  `join` / `accept` / `ready` / `close`), not by application-level
  methods like `wallet_getSession` or `wallet_revokeSession`.

**CAIP-27** wraps standard JSON-RPC methods in a routing envelope
(`{ chainId, request: { method, params } }`). WalletPair achieves the
same routing via the `chain` parameter in each method's params,
without an extra nesting layer. The SDK's EIP-1193 adapter transparently
maps standard JSON-RPC calls to WalletPair's flat method format.

**What is shared:**

- Chain identification uses [CAIP-2](https://chainagnostic.org/CAIPs/caip-2)
  throughout.
- The `capabilities` object in WalletPair's `join` message is structurally
  compatible with [CAIP-217](https://chainagnostic.org/CAIPs/caip-217)
  `scopeObject`s (`methods`, `events`/`notifications`, `chains`).
- Account data can be converted to/from
  [CAIP-10](https://chainagnostic.org/CAIPs/caip-10) format (see §3.1).

## 12. Session Isolation

Each WalletPair session is independent. The wallet MUST treat account
authorization, chain state, and event delivery on a per-session basis.
Accounts authorized in one session MUST NOT automatically become available
in another session.

If the wallet has a global "active chain" concept, `wallet_switchChain`
in one session MUST NOT affect other sessions.
