# walletpair-sdk

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
