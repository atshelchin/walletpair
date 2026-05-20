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
- **Integrity and replay protection:** Sequence-numbered AEAD prevents
  tampering and replay of encrypted payloads.
- **Peer authentication:** Peer identity is bound to X25519 public keys;
  pairing code verification prevents MITM.
- **Role enforcement:** The relay enforces that only the dApp sends `req`
  and only the wallet sends `res` / `evt`.

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
CAIP-2 → hex:   "eip155:137"  → parseInt("137", 10) → "0x89"
hex → CAIP-2:   "0x89"        → parseInt("0x89", 16) → "eip155:137"
```

When both formats are present in a single request (e.g., `chain` and
`tx.chainId`), the wallet MUST verify they refer to the same chain.
See §5.2 for validation rules.

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

An EVM wallet declares its capabilities in the WalletPair `join` message:

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

## 5. Methods

All methods use the WalletPair `req` / `res` message flow. The `method` field
in the `req` message is the method name. Parameters are encrypted in the
`sealed` field. The decrypted content of `sealed` is the `params` object (for
requests) or the `result` / `error` object (for responses).

### 5.1 wallet_getAccounts

Returns the list of accounts the wallet has authorized for this session.
This is typically called immediately after `ready.connected` to discover
available addresses.

This method MUST NOT prompt the user for new account authorization.
Account authorization is established during the pairing flow (join/accept).
The wallet MAY limit accounts on a per-session basis.

**Method:** `wallet_getAccounts`

**Params:**

```json
{
  "chain": "eip155:1"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `chain` | string | no | CAIP-2 chain. If omitted, return accounts for all supported chains. |

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
| `tx.blobVersionedHashes` | string[] | no | Versioned hashes for EIP-4844 (each 32-byte hex with `0x01` version prefix). |
| `tx.authorizationList` | array | no | EIP-7702 authorization tuples. Each entry: `{ chainId: string, address: string, nonce: string, yParity: string, r: string, s: string }`. All hex-encoded. The dApp provides pre-signed authorizations; the wallet MUST display each authorized address and warn the user. |

**Validation rules:**

The wallet MUST enforce the following before signing:

1. `address` MUST be an account previously returned by `wallet_getAccounts`
   for this session. If not, reject with `unauthorized`.
2. `chain` MUST be in the wallet's declared `capabilities.chains`. If not,
   reject with `unsupported_chain`.
3. If `tx.chainId` is present, `parseInt(tx.chainId, 16)` MUST equal the
   numeric chain ID from the `chain` field. On mismatch, reject with
   `invalid_params`.
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
     present (blob transactions cannot create contracts).
   - If `tx.type` is `"0x4"` (EIP-7702): `gasPrice` MUST NOT be
     present. `maxFeePerGas` MUST be used. `authorizationList` MUST
     be a non-empty array. For each authorization entry, the wallet
     MUST: (a) recover the authority address from the `yParity`, `r`,
     `s` fields; (b) verify the entry's `chainId` is either `"0x0"`
     (chain-agnostic) or matches the transaction's chain; (c) display
     to the user both the delegation target (`address`) and the
     recovered authority address; (d) warn that EIP-7702 grants the
     delegation target code execution authority over the authority's
     account, including access to its balance and storage.
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
9. The wallet MUST display to the user at minimum: chain name, recipient
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

Note: EIP-4844 blob transactions require blob sidecar data for
broadcasting, which may exceed the 64 KB WalletPair message limit.
For blob transactions, dApps SHOULD use `wallet_signTransaction`
(sign only) and submit the transaction with sidecar data themselves.

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
The wallet SHOULD display a warning when the message appears to be a
login nonce or authorization grant without domain/expiry/nonce fields
(e.g., bare hex hashes or short numeric strings).

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
3. If `typedData.domain.chainId` is present, the wallet MUST coerce it
   to a number: if it is a hex string (`0x`-prefixed), parse as hex; if
   a decimal string, parse as decimal; if a number, use directly. If
   coercion fails, reject with `invalid_params`. The resulting numeric
   value MUST equal the numeric chain ID from the `chain` parameter. On
   mismatch, reject with `invalid_params`.
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

The wallet MUST reject `rpcUrls` entries using non-HTTPS schemes, except
for `http://localhost` and `http://127.0.0.1` (local development). The
wallet MUST reject `rpcUrls` entries using `javascript:`, `data:`, or
other non-HTTP(S) schemes with `invalid_params`.

If the chain already exists in the wallet, the wallet MUST prompt the user
before updating RPC URLs. The wallet MUST NOT silently update RPC endpoints
for existing chains, as this could enable RPC hijacking (a malicious dApp
replacing a trusted RPC with one that returns false balances or transaction
results).

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

When a method fails, the wallet responds with `res.ok = false`. The
decrypted `sealed` contains an error object:

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
  "id": "req-001",
  "from": "base64url-dapp-pubkey",
  "method": "wallet_getAccounts",
  "sealed": "<encrypted params>"
}
```

Decrypted `sealed` (params):

```json
{
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
  "id": "req-001",
  "from": "base64url-wallet-pubkey",
  "ok": true,
  "sealed": "<encrypted result>"
}
```

Decrypted `sealed` (result):

```json
{
  "accounts": [
    {
      "address": "0xab16a96D359eC26a11e2C2b3d8f8B8942d5Bfcdb",
      "chains": ["eip155:1", "eip155:137"]
    }
  ]
}
```

### DApp sends transaction

WalletPair message (wire):

```json
{
  "v": 1,
  "t": "req",
  "ch": "aabb...eeff",
  "id": "req-002",
  "from": "base64url-dapp-pubkey",
  "method": "wallet_sendTransaction",
  "sealed": "<encrypted params>"
}
```

Decrypted `sealed` (params):

```json
{
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

```json
{
  "txHash": "0x6b17a7a5f05676c30edb0dbb66c1b3c86e2b0e6c20f39a53e021ec36bf3b9f7a"
}
```

### User rejects a signing request

WalletPair message (wire):

```json
{
  "v": 1,
  "t": "res",
  "ch": "aabb...eeff",
  "id": "req-003",
  "from": "base64url-wallet-pubkey",
  "ok": false,
  "sealed": "<encrypted error>"
}
```

Decrypted `sealed` (error):

```json
{
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
  "from": "base64url-wallet-pubkey",
  "event": "chainChanged",
  "sealed": "<encrypted data>"
}
```

Decrypted `sealed` (data):

```json
{
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
The sub-protocol version is not carried in wire messages — it is implied
by the method names and parameter schemas.

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
  scope negotiation. The wallet declares its full capabilities in the
  `join` message; the dApp either accepts or rejects.
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
