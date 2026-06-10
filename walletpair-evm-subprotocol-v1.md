# WalletPair EVM Sub-Protocol v1

Status: Release Candidate

This document defines the EVM sub-protocol for WalletPair Protocol v1.
It applies to all EIP-155 compatible chains.

For transport, encryption, and pairing, see `walletpair-protocol-v1.md`.
For sub-protocol authoring guidance, see Appendix B of that document.

## 1. Namespace and Version

| Item | Value |
|------|-------|
| Namespace | `evm` |
| Version | `1` |
| CAIP-2 prefix | `eip155` |
| Method prefix | `wallet_` |

Declared in `capabilities.version`:

```json
{ "version": { "evm": 1 } }
```

## 2. Chain Identification

Format: `eip155:<chain_id>` where `<chain_id>` is the decimal integer
from EIP-155. Examples: `eip155:1` (Ethereum), `eip155:137` (Polygon),
`eip155:42161` (Arbitrum), `eip155:8453` (Base).

Transaction objects use hex chain IDs (`"0x1"`); this sub-protocol
uses CAIP-2 decimal (`"eip155:1"`). When both are present, the wallet
MUST verify they match. On mismatch, reject with `invalid_params`.

## 3. Account Identification

Addresses are 20-byte hex with `0x` prefix (42 characters). Wallet
responses MUST use EIP-55 checksum. Comparison MUST be
case-insensitive. The zero address MUST NOT be used as a signer.

## 4. Capabilities

```json
{
  "capabilities": {
    "version": { "evm": 1 },
    "methods": [
      "wallet_getAccounts",
      "wallet_signTransaction",
      "wallet_sendTransaction",
      "wallet_signMessage",
      "wallet_signTypedData",
      "wallet_switchChain"
    ],
    "events": [
      "accountsChanged",
      "chainChanged",
      "disconnect"
    ],
    "chains": ["eip155:1", "eip155:137"]
  }
}
```

A wallet MUST support `wallet_getAccounts`, `wallet_signTransaction`,
`wallet_signMessage`, `wallet_signTypedData`, and `wallet_switchChain`.
Only `wallet_sendTransaction` is optional (cold wallets and hardware
signers cannot broadcast). The dApp MUST check `capabilities.methods`
before calling `wallet_sendTransaction` and fall back to
`wallet_signTransaction` if it is not granted.

**Optional extension methods.** Beyond the six core methods, a wallet
MAY declare optional extension methods in `capabilities.methods` to
advertise EIP-5792 batched calls (see Section 6.7): `wallet_sendCalls`
and `wallet_getCallsStatus`. A dApp MUST check `capabilities.methods`
before calling either. These are distinct from EIP-1193 provider-local
methods (e.g. `eth_chainId`, `wallet_getCapabilities`), which are
answered by the provider and are NEVER declared here (see Section 9).

This sub-protocol does NOT define EIP-2255 permission methods
(`wallet_requestPermissions`, `wallet_getPermissions`,
`wallet_revokePermissions`). Session authorization is established at
pairing and is managed via the `accountsChanged` and `disconnect`
events. A provider MAY expose thin EIP-2255 compatibility shims for
dApps that still call them (Section 9.2), but they are not protocol
methods and MUST NOT appear in `capabilities.methods`.

## 5. Data Encoding

| Data type | Encoding |
|-----------|----------|
| Addresses | `0x` + 40 hex chars (20 bytes, EIP-55) |
| Values, nonce, gas, fees | `0x` hex string, no leading zeroes except `0x0` |
| Signed transactions | `0x` hex string (full RLP-encoded) |
| Signatures | `0x` hex string, 65 bytes (r: 32 + s: 32 + v: 1) |
| Call data, hashes | `0x` hex string |
| EIP-712 `domain.chainId` | JSON number (safe integer ≤ 2^53-1) |

## 6. Methods

Decrypted request: `{ "_method": "<name>", ...params }`. Decrypted
response: `{ "_ok": true, "_result": <value> }` or
`{ "_ok": false, "code": "<code>", "message": "..." }`.

### 6.1 wallet_getAccounts

Returns accounts authorized for this session. MUST NOT prompt.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `chain` | string | no | CAIP-2 chain filter. If omitted, return all. |

**Result:**

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

**Errors:** `unsupported_chain`, `internal_error`

### 6.2 wallet_signTransaction

Signs a transaction without broadcasting.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `chain` | string | yes | CAIP-2 chain. |
| `address` | string | yes | Sender address (EIP-55). |
| `tx` | object | yes | Transaction object (see below). |

**Transaction object:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `to` | string | no | Recipient. Omit for contract creation. |
| `value` | string | yes | Wei, hex. Use `"0x0"` for zero value. |
| `data` | string | yes | Call data, hex. Use `"0x"` for empty. |
| `gas` | string | † | Gas limit, hex. |
| `nonce` | string | † | Nonce, hex. |
| `type` | string | yes | `"0x0"`–`"0x4"` (legacy, EIP-2930, EIP-1559, EIP-4844, EIP-7702). |
| `chainId` | string | yes | Hex chain ID. MUST match `chain`. |
| `gasPrice` | string | † | For type 0/1. |
| `maxFeePerGas` | string | † | For type 2/3/4. |
| `maxPriorityFeePerGas` | string | † | For type 2/3/4. MUST NOT exceed `maxFeePerGas`. |
| `accessList` | array | no | EIP-2930. Each: `{ address, storageKeys[] }`. |
| `maxFeePerBlobGas` | string | † | For type 3. |
| `blobVersionedHashes` | string[] | no | For type 3. 32-byte hex, `0x01` version prefix. |
| `authorizationList` | array | no | For type 4. Max 16 entries. Each: `{ chainId, address, nonce, yParity, r, s }`. |

**† RPC-dependent fields.** `gas`, `nonce`, and fee fields (`gasPrice`,
`maxFeePerGas`, `maxPriorityFeePerGas`, `maxFeePerBlobGas`) require
chain RPC access to determine when absent. The rules differ by method:

- **`wallet_sendTransaction`:** The wallet broadcasts, so it has RPC.
  The dApp MAY omit these fields and the wallet MUST fill them.
- **`wallet_signTransaction`:** The wallet may be a cold wallet or
  hardware signer with no RPC access. The dApp SHOULD provide all
  RPC-dependent fields. If a field is missing and the wallet cannot
  determine it (no RPC), the wallet MUST reject with `invalid_params`
  and message indicating which field is missing.

DApps that use `wallet_signTransaction` MUST assume the wallet has no
RPC and provide complete transaction parameters.

**Validation:**

1. `address` MUST be authorized for this session and chain.
2. `chain` MUST be in `capabilities.chains`.
3. `tx.chainId` MUST match `chain`.
4. Fee fields MUST be consistent with `tx.type`.
5. Wallet MUST display: chain, recipient (or "Contract Creation"),
   value, gas estimate.

**Result:**

```json
{ "signedTx": "0x..." }
```

**Errors:** `user_rejected`, `unauthorized`, `invalid_params`,
`unsupported_chain`, `internal_error`

### 6.3 wallet_sendTransaction (optional)

The only optional method. Cold wallets and hardware signers that
cannot broadcast MUST omit this from `capabilities.methods`. The dApp
falls back to `wallet_signTransaction` + own RPC broadcast.

Same params and validation as Section 6.2.

**Result:**

```json
{ "txHash": "0x..." }
```

Response means accepted by RPC, not mined. Blob transactions (type 3)
require sidecar data for broadcast; unless the wallet supports it, the
dApp MUST use `wallet_signTransaction` and broadcast itself.

**Errors:** `user_rejected`, `unauthorized`, `invalid_params`,
`unsupported_chain`, `insufficient_funds`, `nonce_too_low`,
`gas_estimation_failed`, `tx_rejected`, `internal_error`

### 6.4 wallet_signMessage

Signs UTF-8 text with EIP-191 personal sign prefix
(`\x19Ethereum Signed Message:\n<byte_length>`).

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `chain` | string | yes | CAIP-2 chain. |
| `address` | string | yes | Signing address. |
| `message` | string | yes | UTF-8 text. Always text, never hex-decoded. |

Wallet MUST display the full message. EIP-191 signatures are NOT
chain-bound; the wallet MUST warn the user. DApps needing chain-bound
signatures SHOULD use `wallet_signTypedData`.

**Result:**

```json
{ "signature": "0x..." }
```

**Errors:** `user_rejected`, `unauthorized`, `invalid_params`,
`internal_error`

### 6.5 wallet_signTypedData

Signs EIP-712 structured data.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `chain` | string | yes | CAIP-2 chain. |
| `address` | string | yes | Signing address. |
| `typedData` | object | yes | EIP-712 typed data (same schema as `eth_signTypedData_v4`). |

**Validation:**

1. `address` MUST be authorized, `chain` MUST be in capabilities.
2. `typedData.types` MUST contain `EIP712Domain`;
   `typedData.primaryType` MUST reference a defined type.
3. If `domain.chainId` present, MUST match `chain`. If absent and
   data is high-risk (Permit, PermitBatch, PermitSingle), MUST reject.
4. Wallet MUST display `domain.name`, `domain.verifyingContract`,
   `primaryType`, and key fields. MUST NOT blind-sign.
5. Wallet SHOULD warn on Permit and spending-allowance patterns.

**Result:**

```json
{ "signature": "0x..." }
```

**Errors:** `user_rejected`, `unauthorized`, `invalid_params`,
`internal_error`

### 6.6 wallet_switchChain

Switches active chain for this session only.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `chain` | string | yes | CAIP-2 target chain. |

**Result:**

```json
{ "chain": "eip155:137" }
```

Wallet MUST also emit `chainChanged`.

**Errors:** `user_rejected`, `unsupported_chain`, `internal_error`

### 6.7 Optional Extension Methods (EIP-5792)

These methods are OPTIONAL. A wallet that supports one MUST declare it
in `capabilities.methods`; a dApp MUST NOT call one unless it is
declared. Both travel over the WalletPair channel — they broadcast or
poll batched calls, so they cannot be answered provider-locally.

| Method | Spec | User confirmation | Notes |
|--------|------|-------------------|-------|
| `wallet_sendCalls` | EIP-5792 | **Required** | Batched atomic calls. Equivalent to sending a transaction; MUST confirm. Params and result follow EIP-5792. |
| `wallet_getCallsStatus` | EIP-5792 | **None** | Polls the status of a prior `wallet_sendCalls` batch by its returned ID. Read-only over the channel; MUST NOT prompt. |

`wallet_sendCalls` MUST display a confirmation UI (Section 10.1).
`wallet_getCallsStatus` MUST NOT prompt, but still travels over the
channel because only the wallet (which submitted the batch) can resolve
the batch status.

`wallet_getCallsStatus` returns the EIP-5792 status object
(`{ version, id, chainId, status, atomic, receipts }`). For an unknown
batch ID the wallet MUST reject with `invalid_params`.

## 7. Events

Decrypted content: `{ "_event": "<name>", ...data }`.

### 7.1 accountsChanged

```json
{ "_event": "accountsChanged",
  "accounts": [{ "address": "0x...", "chains": ["eip155:1"] }] }
```

Empty `accounts` = all access revoked.

### 7.2 chainChanged

```json
{ "_event": "chainChanged", "chain": "eip155:137" }
```

### 7.3 disconnect

Wallet-initiated session end. Distinct from transport-layer `close`:
`disconnect` is encrypted and carries a reason visible only to the
dApp. The wallet SHOULD send `disconnect` before `close`.

```json
{ "_event": "disconnect",
  "reason": "user_closed",
  "message": "User closed the wallet" }
```

Reasons: `"user_closed"`, `"session_revoked"`, `"wallet_locked"`.
On receipt, the dApp MUST NOT send further requests.

## 8. Error Codes

| Code | Meaning |
|------|---------|
| `user_rejected` | User declined in wallet UI. |
| `unauthorized` | Account not authorized for this session. |
| `invalid_params` | Malformed or missing parameters. |
| `unsupported_chain` | Chain not in capabilities. |
| `unsupported_method` | Method not in capabilities. |
| `insufficient_funds` | Balance too low. |
| `nonce_too_low` | Nonce already used. |
| `gas_estimation_failed` | Gas estimation reverted. |
| `tx_rejected` | Network rejected the transaction. |
| `internal_error` | Unexpected wallet error. |

Wallets MAY define namespaced extensions (e.g., `metamask:snap_error`).

## 9. EIP-1193 Provider Method Coverage

Most EVM dApps interact with wallets exclusively through the EIP-1193
`window.ethereum` provider. They do **not** maintain their own RPC
connections — they rely on the provider for everything from signing to
`eth_call` and `eth_getBalance`. A WalletPair implementation that
exposes an EIP-1193 provider (browser extension, SDK adapter) MUST
therefore handle **all** standard methods, not just wallet operations.

### 9.1 Method Routing Architecture

The provider operates on two layers:

1. **WalletPair channel** (extension ↔ wallet, encrypted relay):
   Only methods that require private key access or user approval.
2. **Local / RPC proxy** (extension-side, no relay round-trip):
   Everything else — local state queries and read-only RPC calls.

```
  dApp (window.ethereum.request)
        │
        ▼
  ┌─────────────────────────────┐
  │  EIP-1193 Provider (ext.)   │
  │                             │
  │  ┌────────────┐  ┌────────┐ │
  │  │  Wallet    │  │ Local  │ │
  │  │  methods   │  │ state  │ │
  │  │  ──────►   │  │        │ │
  │  │  WalletPair│  └────────┘ │
  │  │  channel   │  ┌────────┐ │
  │  └────────────┘  │ RPC    │ │
  │                  │ proxy  │ │
  │                  └────────┘ │
  └─────────────────────────────┘
```

### 9.2 Full Method Table

| Category | Methods | Route | Notes |
|----------|---------|-------|-------|
| **Auth** | `eth_requestAccounts` | WalletPair channel | Opens pairing / approval UI |
| **Permissions (compat)** | `wallet_requestPermissions` | WalletPair channel | EIP-2255 compat shim — mapped to `eth_requestAccounts`. Not a protocol method |
| **Signing** | `personal_sign`, `eth_signTypedData_v4`, `eth_signTypedData_v3` | WalletPair channel | Requires user confirmation |
| **Transaction** | `eth_sendTransaction`, `eth_signTransaction`, `wallet_sendCalls` (EIP-5792) | WalletPair channel | Requires user confirmation |
| **Chain switch** | `wallet_switchEthereumChain` | Local + event | Updates local state, emits `chainChanged` |
| **Local state** | `eth_chainId`, `net_version`, `eth_accounts`, `web3_clientVersion` | Provider-local | Answered from cached session state |
| **Permissions (compat)** | `wallet_getPermissions` | Provider-local | EIP-2255 compat shim — derives from current accounts. Not a protocol method |
| **Capabilities** | `wallet_getCapabilities` (EIP-5792) | Provider-local | Returns wallet-declared smart account capabilities |
| **Batch status** | `wallet_getCallsStatus` (EIP-5792) | WalletPair channel | Polls `wallet_sendCalls` batch status. No prompt |
| **Read-only RPC** | `eth_call`, `eth_estimateGas`, `eth_getBalance`, `eth_getCode`, `eth_getStorageAt`, `eth_getTransactionCount`, `eth_getTransactionByHash`, `eth_getTransactionReceipt`, `eth_getLogs`, `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getBlockByHash`, `eth_feeHistory`, `eth_gasPrice`, `eth_maxPriorityFeePerGas`, `eth_newFilter`, `eth_newBlockFilter`, `eth_getFilterChanges`, `eth_uninstallFilter`, `eth_sendRawTransaction`, `eth_syncing` | RPC proxy | Forwarded to public RPC node |
| **Unsupported** | `eth_getEncryptionPublicKey`, `eth_decrypt`, `eth_sign`, `wallet_addEthereumChain` | Reject | Return code `4200` (`unsupported_method`) |
| **Unknown** | Any method not listed above | RPC proxy (best-effort) | Forward to RPC; reject with `-32601` on failure |

Implementations MUST support **every method in the Auth, Signing,
Transaction, Chain switch, Local state, and Read-only RPC categories**.
A provider that only handles wallet methods will break the majority of
production dApps (Uniswap, Aave, OpenSea, etc.) which depend on the
provider for `eth_call`, `eth_estimateGas`, and `eth_getBalance`.

**Active-chain synchronization.** `eth_chainId` and `net_version` are
answered from cached session state — but that cache is authoritative
ONLY while it is kept in sync. On session establishment and on resume,
the provider MUST synchronize the active chain from the wallet before
answering `eth_chainId` / `net_version` from cache. Thereafter it MUST
update the cache on every `chainChanged` event (Section 7.2). The
provider MUST NOT assume a default chain. The session chain remains the
wallet's to define; the cache merely mirrors it, and the wallet still
re-validates `chainId` at sign time (Sections 5, 6.2, 10).

### 9.3 Read-Only RPC Proxy

The provider MUST proxy read-only methods to a JSON-RPC endpoint
for the active chain. The RPC endpoint is resolved in priority order:

1. **Wallet-provided RPC**: The wallet MAY declare per-chain RPC URLs
   in its capabilities during session establishment (see Section 9.4).
2. **Built-in defaults**: The provider SHOULD ship a default RPC
   endpoint table for commonly used chains.
3. **Fallback discovery**: If both (1) and (2) are unavailable for a
   chain, the provider MAY attempt to discover an RPC endpoint from a
   public chain registry (e.g., `ethereum-lists/chains`).
4. **Rejection**: If no RPC can be found, reject with
   `{ code: -32603, message: "No RPC available for chain <id>" }`.

Requirements:

- The proxy MUST enforce a request timeout (RECOMMENDED: 30 seconds).
- The proxy MUST enforce a maximum response size (RECOMMENDED: 2 MB).
- The proxy MUST NOT cache responses unless the method is explicitly
  cacheable (e.g., `eth_chainId` for a known chain).
- The proxy SHOULD handle RPC failures gracefully — if the primary
  RPC returns an error, try a fallback before returning an error to
  the dApp.

### 9.4 Wallet-Provided RPC URLs

During session establishment (capabilities exchange), the wallet MAY
include an `rpcUrls` map in its capabilities:

```json
{
  "capabilities": {
    "version": { "evm": 1 },
    "methods": ["..."],
    "chains": ["eip155:1", "eip155:137"],
    "rpcUrls": {
      "1": "https://eth-mainnet.g.alchemy.com/v2/...",
      "137": "https://polygon-mainnet.g.alchemy.com/v2/..."
    }
  }
}
```

Keys are decimal chain ID strings. Values are JSON-RPC endpoint URLs.
The provider MUST prefer wallet-provided URLs over built-in defaults
because the wallet user may have a premium RPC subscription with
higher rate limits and lower latency.

### 9.5 Chain ID Inference from Requests

Many dApps embed a chain ID in the request payload (e.g.,
`typedData.domain.chainId` in `eth_signTypedData_v4`, `tx.chainId`
in `eth_sendTransaction`, `payload.chainId` in `wallet_sendCalls`).

When the provider or wallet receives a signing/transaction request
with an embedded chain ID that differs from the current session
chain, it SHOULD:

1. Check whether the wallet supports the embedded chain
   (`capabilities.chains`).
2. If supported, auto-switch the session chain and proceed.
3. If unsupported, reject with error code `4902`
   (EIP-3085: unrecognized chain ID).

This avoids the common failure where a dApp operates on chain X but
the wallet session is stuck on chain Y, producing invalid signatures
(wrong chain in EIP-712 domain hash, wrong Safe message hash, etc.).

### 9.6 Direct Connection (No Extension)

When a dApp connects directly to the wallet via the WalletPair SDK
— without a browser extension in between — the SDK uses a two-tier
fallback for read-only methods:

```
  dApp ─► SDK EIP-1193 Provider
              │
              ├─ Has local RPC? ──► proxy locally (fastest)
              │  (rpcProvider or wallet rpcUrls)
              │
              └─ No local RPC ──► forward through relay ──► Wallet
                                                              │
                                                              └─► Wallet's own RPC
```

**Tier 1 — Local RPC proxy (preferred):**
If the dApp supplies an `rpcProvider`, or the wallet declared
`rpcUrls` in capabilities (Section 9.4), the SDK intercepts
read-only methods locally — zero relay latency.

**Tier 2 — Relay forwarding to wallet:**
If no local RPC is available for the active chain, the SDK forwards
the method through the WalletPair encrypted channel. The wallet
receives it, forwards to its own RPC node, and returns the result.
This adds relay round-trip latency but guarantees the call succeeds.

**Requirements for wallet-side RPC handling (Tier 2):**

The session layer enforces a capability allowlist (protocol §7.1):
requests whose method is not in `capabilities.methods` are rejected
with `unsupported_method` before they reach the wallet application. A
wallet that accepts read-only methods over the channel therefore MUST
declare those methods in `capabilities.methods` during capability
negotiation. Explicit declaration is preferred over implicit
pass-through: the dApp can see exactly what the wallet will serve.

1. The wallet MUST maintain a working RPC endpoint for each chain in
   `capabilities.chains`.
2. On receiving a read-only method (`eth_call`, `eth_getBalance`,
   etc.), the wallet MUST forward it to the appropriate chain's RPC
   and return the result.
3. The wallet MUST enforce a timeout (RECOMMENDED: 30 seconds) and
   a response size limit (RECOMMENDED: 2 MB).
4. If the wallet cannot handle a method, it MUST reject with
   `{ code: -32601, message: "Method not supported" }` rather than
   silently dropping the request.

**Array params serialization:** Read-only methods use JSON-RPC array
params (e.g., `[{to, data}, "latest"]` for `eth_call`). When sending
through the WalletPair channel, array params MUST be wrapped as
`{ _params: [...] }` in the sealed payload (not spread as object
keys). The receiving side MUST unwrap `_params` if present.

**Method classification for wallet-side routing:**

| Category | Route | Methods |
|----------|-------|---------|
| **Requires key/auth** | User approval or batch op, over channel | `personal_sign`, `eth_signTypedData_v4`, `eth_signTypedData_v3`, `eth_sendTransaction`, `eth_signTransaction`, `eth_requestAccounts`, `wallet_requestPermissions` (compat), `wallet_sendCalls`, `wallet_getCallsStatus` |
| **Session mgmt** | Local state | `eth_accounts`, `eth_chainId`, `net_version`, `wallet_switchEthereumChain`, `wallet_getPermissions` (compat), `wallet_getCapabilities` |
| **Read-only RPC** | Forward to RPC | `eth_call`, `eth_estimateGas`, `eth_getBalance`, `eth_getCode`, `eth_getStorageAt`, `eth_getTransactionCount`, `eth_getTransactionByHash`, `eth_getTransactionReceipt`, `eth_getLogs`, `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getBlockByHash`, `eth_feeHistory`, `eth_gasPrice`, `eth_maxPriorityFeePerGas`, `eth_newFilter`, `eth_newBlockFilter`, `eth_getFilterChanges`, `eth_uninstallFilter`, `eth_sendRawTransaction`, `eth_syncing` |
| **Unknown** | Best-effort RPC forward | Any unlisted method |

### 9.7 Path Comparison

| | **Path 1: Extension** | **Path 2: SDK Direct** |
|---|---|---|
| **Signing methods** | Relay → Wallet | Relay → Wallet |
| **Local state** | Extension-local | SDK-local |
| **Read-only RPC (has RPC)** | Extension RPC proxy | SDK local proxy |
| **Read-only RPC (no RPC)** | Fallback discovery | Relay → Wallet RPC |
| **Latency (read-only)** | ~50-200ms | Tier 1: ~50-200ms, Tier 2: ~300-800ms |

Both paths provide full EIP-1193 coverage. Path 1 has no relay
overhead for read-only methods. Path 2 prefers local proxy when
possible, with relay fallback ensuring no method ever fails silently.

## 10. Security Requirements

1. All signing and transaction methods MUST display a confirmation UI.
2. Wallet MUST NOT blind-sign transactions or EIP-712 data.
3. EIP-191 signatures are not chain-bound; wallet MUST warn users.
4. Wallet MUST detect and warn on Permit and spending-allowance
   patterns in EIP-712 data.
5. Account authorization and chain state are per-session.
6. When `chain` param and `tx.chainId` are both present, wallet MUST
   verify they match.
