# walletpair-sdk

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
