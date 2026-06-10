# walletpair-sdk

## 1.0.9

### Patch Changes

- EVM sub-protocol improvements:

  - Add `wallet_getCallsStatus` (EIP-5792) relay mapping so dApps can poll batch status from the submitting wallet.
  - Handle `wallet_getCapabilities` locally, returning the wallet-advertised `walletCapabilities`.
  - Counterfactual smart-account support: `eth_getCode` for the connected account returns the wallet's `contractBytecode` when the account isn't deployed yet, so dApps detect an EIP-1271 smart contract wallet instead of an EOA.
  - Auto-build a read-only RPC proxy from wallet-provided `rpcUrls` when no explicit `rpcProvider` is supplied (with timeout and response-size limits); unsupported methods now fall through to the wallet over the relay instead of throwing.
  - Pass through `rpcUrls`, `walletCapabilities`, and `contractBytecode` in negotiated capabilities (previously dropped, breaking all three on the dApp side).
  - Fix array-typed JSON-RPC `params` being silently coerced to an object across the relay; arrays now round-trip correctly via `_params`.

## 1.0.8

### Patch Changes

- Add contractBytecode field to Capabilities for counterfactual smart wallet detection via eth_getCode

## 1.0.7

### Patch Changes

- Add EIP-5792 smart wallet support: walletCapabilities field in Capabilities type, wallet_sendCalls request/response mapping in EIP-1193 provider

## 1.0.6

### Patch Changes

- Add rpcUrls to Capabilities for local read-only RPC proxying, and relax tx validation to only require chainId (type/value/data are optional per EIP-1559 dApp conventions)

## 1.0.5

### Patch Changes

- Fix canonicalize CJS/ESM interop and linter cleanups

  - Fix `canonicalize is not a function` error caused by incorrect CJS/ESM default export unwrapping. Use runtime `typeof` check instead of static `.default` access.
  - Fix `secp256k1.Signature.fromBytes` crash in personalSign example — `secp256k1.sign()` already returns a Signature object, no need to call `fromBytes`.
  - Apply linter fixes: non-null assertions replaced with nullish coalescing, hex literal normalization.

## 1.0.3

### Patch Changes

- Make WebSocketTransport.url public for channel hint injection

## 1.0.2

### Patch Changes

- update readme.md

## 1.0.0

### Major Changes

- Initial release of the WalletPair SDK

### Features

- **Core protocol**: X25519 key exchange, HKDF session key derivation, ChaCha20-Poly1305 authenticated encryption
- **DAppSession / WalletSession**: Full session lifecycle — pairing, handshake, request/response, reconnection, and graceful close
- **WebSocket transport**: Auto-reconnect, ping/pong keepalive, configurable relay URL
- **EVM sub-protocol**: EIP-1193 provider (`walletpair-sdk/evm/eip1193`) and Wagmi connector (`walletpair-sdk/evm/wagmi`)
- **BLE transport**: BLE framing utilities and transport layer (`walletpair-sdk/ble`)
- **Security**: Directional session keys, handshake transcript hashing, session fingerprint verification, snapshot signing
- **Typed event emitter**: Type-safe event system for session state changes
- **CAIP-2 chain ID helpers**: `formatChainId`, `parseChainId`, `evmChainId`, `evmNumericChainId`
- **Pairing URI**: `buildPairingUri` / `parsePairingUri` for QR code and deep link flows
