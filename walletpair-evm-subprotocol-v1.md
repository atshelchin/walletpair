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
| Goerli Testnet | `eip155:5` |
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
| `tx.type` | string | no | Transaction type: `"0x0"` (legacy), `"0x1"` (EIP-2930), `"0x2"` (EIP-1559). |
| `tx.chainId` | string | no | Chain ID, hex-encoded. MUST match `chain` if provided. |
| `tx.accessList` | array | no | EIP-2930 access list. |

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
5. If both `gasPrice` and `maxFeePerGas` are present, reject with
   `invalid_params` (conflicting transaction types).
6. The wallet MUST display to the user at minimum: chain name, recipient
   address (or "Contract Creation" if `to` is absent), and value.

**Result:**

```json
{
  "signedTx": "0x..."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `signedTx` | string | The full RLP-encoded signed transaction, hex-encoded. Ready to submit via `eth_sendRawTransaction`. |

The wallet MAY additionally include a `signature` field containing the
raw signature bytes (r + s + v, hex-encoded), but dApps MUST NOT depend
on its presence.

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
| `message` | string | yes | Message to sign. If prefixed with `0x` and contains only hex characters, treated as hex-encoded bytes. Otherwise treated as UTF-8 text. |

The wallet MUST apply the EIP-191 prefix `\x19Ethereum Signed Message:\n<length>`
where `<length>` is the byte length of the decoded message (hex-decoded bytes
for `0x`-prefixed, UTF-8 bytes otherwise).

The wallet SHOULD display the message as human-readable text when possible,
and as hex when it cannot be decoded as valid UTF-8.

**Validation rules:**

1. `address` MUST be an account authorized for this session.
2. `chain` MUST be in `capabilities.chains`.

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
3. If `typedData.domain.chainId` is present, the wallet MUST verify it
   equals the numeric chain ID from the `chain` parameter. On mismatch,
   reject with `invalid_params`.
4. The wallet MUST display `domain.name`, `domain.verifyingContract`,
   `primaryType`, and key message fields to the user before requesting
   confirmation.
5. The wallet MUST NOT perform blind signing of EIP-712 data.
6. The wallet SHOULD warn the user when signing known high-risk typed data
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

Chain switching affects only the current WalletPair session. The wallet
MUST NOT change the active chain for other sessions or its global state
unless the wallet explicitly chooses to do so.

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
| `nativeCurrency.decimals` | number | yes | Number of decimals (usually 18). |
| `rpcUrls` | string[] | yes | At least one RPC endpoint URL. |
| `blockExplorerUrls` | string[] | no | Block explorer URLs. |
| `iconUrls` | string[] | no | Chain icon URLs. Wallet MAY ignore. |

**Result:**

```json
{
  "added": true
}
```

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
| `unsupported_chain` | 4902 | Wallet does not support the requested chain. | Chain not in capabilities. |
| `unsupported_method` | 4200 | Wallet does not support the requested method. | Method not in capabilities. |
| `insufficient_funds` | -32000 | Account balance too low for the transaction. | Not enough ETH/token. |
| `nonce_too_low` | -32000 | Transaction nonce is already used. | Stale nonce. |
| `gas_estimation_failed` | -32000 | Wallet could not estimate gas for the transaction. | Reverted in estimation. |
| `tx_rejected` | -32000 | Network rejected the transaction. | RPC returned error. |
| `chain_not_added` | 4902 | Requested chain is not configured in wallet. | Unknown chain ID. |
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

| Standard | Relationship |
|----------|-------------|
| [EIP-155](https://eips.ethereum.org/EIPS/eip-155) | Chain ID format in transactions. |
| [EIP-191](https://eips.ethereum.org/EIPS/eip-191) | Personal message signing (`wallet_signMessage`). |
| [EIP-712](https://eips.ethereum.org/EIPS/eip-712) | Typed data signing (`wallet_signTypedData`). |
| [EIP-1193](https://eips.ethereum.org/EIPS/eip-1193) | Provider interface. SDK provides adapter. |
| [EIP-1559](https://eips.ethereum.org/EIPS/eip-1559) | Type 2 transaction format. |
| [EIP-2930](https://eips.ethereum.org/EIPS/eip-2930) | Access list transactions. |
| [EIP-3085](https://eips.ethereum.org/EIPS/eip-3085) | Add chain (`wallet_addChain`). |
| [EIP-3326](https://eips.ethereum.org/EIPS/eip-3326) | Switch chain (`wallet_switchChain`). |
| [EIP-747](https://eips.ethereum.org/EIPS/eip-747) | Watch asset (`wallet_watchAsset`). |
| [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md) | Chain identifier format. |

## 12. Session Isolation

Each WalletPair session is independent. The wallet MUST treat account
authorization, chain state, and event delivery on a per-session basis.
Accounts authorized in one session MUST NOT automatically become available
in another session.

If the wallet has a global "active chain" concept, `wallet_switchChain`
in one session SHOULD NOT affect other sessions unless the wallet
explicitly documents this behavior.
