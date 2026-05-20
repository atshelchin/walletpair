# WalletPair

A minimal, self-sovereign two-party channel protocol for connecting dApps with blockchain wallets over any transport.

WalletPair replaces centralized pairing services with a zero-registration, relay-blind protocol. The dApp creates a channel and generates a pairing URI (QR code), the wallet scans it, and after a cryptographic handshake with visual confirmation, they establish an end-to-end encrypted session.

## Why WalletPair?

- **No registration** - No API keys, project IDs, or signup. Deploy a relay and start pairing.
- **Self-sovereign** - Peers exchange keys directly. No central authority holds your session.
- **Relay-blind** - All payloads are end-to-end encrypted. The relay routes opaque bytes.
- **Transport agnostic** - WebSocket, Bluetooth, local TCP - same protocol.
- **EVM-first** - Full Ethereum support: transactions (legacy through EIP-7702), message signing (EIP-191, EIP-712), multi-chain (CAIP-2).

## How It Works

```
 dApp                          Relay                         Wallet
  |                              |                              |
  |-- create (pubkey) ---------> |                              |
  |<- ready.waiting ------------ |                              |
  |                              |                              |
  |   [dApp displays QR code with pairing URI]                  |
  |                              |                              |
  |                              | <------- join (pubkey) ------|
  |<- join (pubkey, caps) ------ |                              |
  |                              |                              |
  |   [Both sides derive session key and 6-digit pairing code]  |
  |   [User confirms codes match on both devices]               |
  |                              |                              |
  |-- accept ------------------> |                              |
  |                              | ---- ready.connected ------->|
  |<- ready.connected ---------- |                              |
  |                              |                              |
  |-- req (sealed) ------------> | ---- req (sealed) ---------> |
  |                              | <--- res (sealed) ---------- |
  |<- res (sealed) ------------- |                              |
```

## Repository Structure

```
walletpair/
  walletpair-sdk/              # TypeScript SDK - core protocol, crypto, sessions
  walletpair-extension/        # Browser extension - bridge dApps to wallets
  walletpair-websocket-relay/  # Rust relay server - production-grade message router
  walletpair-examples/         # Demo apps - standalone HTML, React Native, SvelteKit
  walletpair.org/              # Marketing site and interactive demo
  walletpair-protocol-v1.md    # Protocol specification
  walletpair-evm-subprotocol-v1.md  # EVM sub-protocol specification
```

## Quick Start

### Install the SDK

```bash
npm install walletpair-sdk
```

### dApp Side

```typescript
import { DAppSession, WebSocketTransport } from 'walletpair-sdk';

const transport = new WebSocketTransport({
  url: 'wss://relay.walletpair.org/v1',
  subprotocol: 'walletpair.v1',
});
const session = new DAppSession(transport);

// Create pairing - display URI as QR code
const uri = await session.createPairing({
  methods: ['wallet_sendTransaction', 'wallet_signMessage'],
  chains: ['eip155:1', 'eip155:137'],
});

session.on('pairingCode', (code) => {
  console.log('Confirm this code matches your wallet:', code);
});

session.on('ready', async () => {
  const result = await session.call('wallet_getAccounts');
  console.log('Accounts:', result);
});
```

### Wallet Side

```typescript
import { WalletSession, WebSocketTransport } from 'walletpair-sdk';

const transport = new WebSocketTransport({
  url: 'wss://relay.walletpair.org/v1',
  subprotocol: 'walletpair.v1',
});
const session = new WalletSession(transport);

// Parse scanned QR code
await session.prepareJoin(pairingUri);
console.log('Pairing code:', session.pairingCode);

// After user confirms code match
await session.confirmJoin();

session.on('request', async (req) => {
  // Review and respond to requests
  await session.sendResponse(req.id, true, { accounts: ['0x...'] });
});
```

### Wagmi Integration

```typescript
import { walletPair } from 'walletpair-sdk/evm/wagmi';
import { createConfig } from 'wagmi';

const config = createConfig({
  connectors: [
    walletPair({
      relayUrl: 'wss://relay.walletpair.org/v1',
      onPairingUri: (uri) => showQRCode(uri),
      onPairingCode: (code) => displayCode(code),
    }),
  ],
});
```

### EIP-1193 Provider

```typescript
import { WalletPairProvider } from 'walletpair-sdk/evm/eip1193';

const provider = new WalletPairProvider({ session: dAppSession });
const accounts = await provider.request({ method: 'eth_accounts' });
```

## Relay Server

The relay is a stateless Rust binary. It routes encrypted messages between peers without reading them.

### Run with Docker

```bash
docker run -p 8080:8080 walletpair-relay
```

### Build from Source

```bash
cd walletpair-websocket-relay
cargo build --release
./target/release/walletpair-relay --config config.toml
```

### Endpoints

| Path | Purpose |
|------|---------|
| `/v1` | WebSocket endpoint (requires `walletpair.v1` subprotocol) |
| `/healthz` | Liveness probe |
| `/readyz` | Readiness probe (503 if at capacity) |
| `/metrics` | Prometheus metrics |

## Protocol Highlights

### Cryptography

- **Key exchange**: X25519 ephemeral keypairs
- **Key derivation**: HKDF-SHA256 with channel ID as salt
- **Encryption**: ChaCha20-Poly1305 AEAD with length-prefixed AAD
- **Pairing code**: 6-digit code derived from session key for visual MITM prevention
- **Replay protection**: Per-peer sequence counters with monotonic enforcement

### Message Types

| Type | Direction | Description |
|------|-----------|-------------|
| `create` | dApp -> Relay | Create a new channel |
| `join` | Wallet -> Relay | Join an existing channel |
| `accept` | dApp -> Relay | Accept wallet after code confirmation |
| `req` | dApp -> Wallet | Encrypted request (e.g. sign transaction) |
| `res` | Wallet -> dApp | Encrypted response |
| `evt` | Wallet -> dApp | Encrypted event push (accountsChanged, etc.) |
| `ping`/`pong` | Either | Heartbeat (30s interval, 60s timeout) |
| `close` | Either | End session with reason |

### EVM Methods

| Method | Description |
|--------|-------------|
| `wallet_getAccounts` | Return authorized accounts |
| `wallet_signTransaction` | Sign a transaction (return RLP) |
| `wallet_sendTransaction` | Sign and broadcast a transaction |
| `wallet_signMessage` | EIP-191 personal sign |
| `wallet_signTypedData` | EIP-712 typed data signature |
| `wallet_switchChain` | Switch active EVM chain |
| `wallet_addChain` | Add a new chain to wallet |
| `wallet_watchAsset` | Track a token (ERC-20/721/1155) |

### Reconnection

Sessions survive disconnects via relay-issued resume tokens. Sequence counters persist across reconnects to prevent nonce reuse. Wallets deduplicate retried requests using an idempotency cache keyed on request ID and params hash.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| SDK | TypeScript, @noble/curves, @noble/hashes, @noble/ciphers |
| Extension | Svelte, Wxt, TypeScript |
| Relay | Rust, Axum, Tokio, Prometheus |
| Website | SvelteKit, Cloudflare Workers |
| Examples | HTML/JS, React Native (Expo), SvelteKit |

## Specifications

- [WalletPair Protocol v1](walletpair-protocol-v1.md) - Full protocol specification
- [WalletPair EVM Sub-Protocol v1](walletpair-evm-subprotocol-v1.md) - EVM-specific methods, events, and validation rules

## License

[MIT](LICENSE)
