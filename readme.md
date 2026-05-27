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
  |   [Both sides derive traffic keys and session fingerprint]   |
  |   [User can visually verify fingerprints match]             |
  |                              |                              |
  |-- accept (auto) -----------> |  (after sealed_join verify)  |
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
  formal-verification/         # ProVerif model - mathematically proven security properties
  walletpair-protocol-v1.md    # Protocol specification
  walletpair-evm-subprotocol-v1.md  # EVM sub-protocol specification
```

## Quick Start

### Install the SDK (not yet published)

```bash
# Clone the repo and link locally
git clone https://github.com/atshelchin/walletpair.git
cd walletpair/walletpair-sdk
npm install && npm link
```

### dApp Side

```typescript
import { DAppSession, WebSocketTransport } from 'walletpair-sdk';

const transport = new WebSocketTransport('wss://relay.walletpair.org/v1');
const session = new DAppSession({
  transport,
  meta: {
    name: 'My dApp',
    description: 'Example dApp',
    url: 'https://dapp.example',
    icon: 'https://dapp.example/icon.png',
  },
  methods: ['wallet_getAccounts', 'wallet_sendTransaction', 'wallet_signMessage'],
  chains: ['eip155:1', 'eip155:137'],
  persistence: {
    save: (snapshot) => localStorage.setItem('walletpair.session', snapshot),
    load: () => localStorage.getItem('walletpair.session'),
    clear: () => localStorage.removeItem('walletpair.session'),
  },
});

// Create pairing - display URI as QR code
const uri = await session.createPairing();

session.on('sessionFingerprint', (fingerprint) => {
  console.log('Session fingerprint (verify matches wallet):', fingerprint);
});

session.on('phase', async (phase) => {
  if (phase !== 'connected') return;
  const result = await session.request('wallet_getAccounts');
  console.log('Accounts:', result);
});
```

### Wallet Side

```typescript
import { WalletSession, WebSocketTransport } from 'walletpair-sdk';

const transport = new WebSocketTransport('wss://relay.walletpair.org/v1');
const session = new WalletSession({
  transport,
  capabilities: {
    methods: ['wallet_getAccounts', 'wallet_sendTransaction', 'wallet_signMessage'],
    events: ['accountsChanged', 'chainChanged'],
    chains: ['eip155:1', 'eip155:137'],
  },
  meta: {
    name: 'My Wallet',
    description: 'Example wallet',
    url: 'https://wallet.example',
    icon: 'https://wallet.example/icon.png',
  },
  persistence: {
    save: (snapshot) => secureStore.set('walletpair.session', snapshot),
    load: () => secureStore.get('walletpair.session'),
    clear: () => secureStore.delete('walletpair.session'),
  },
});

// Parse scanned QR code and join
await session.prepareJoin(pairingUri);
console.log('Session fingerprint:', session.sessionFingerprint);

// Send join (dApp auto-accepts after sealed_join verification)
await session.confirmJoin();

session.on('request', async (req) => {
  // Review and respond to requests
  await session.approve(req.id, { accounts: ['0x...'] });
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
      onSessionFingerprint: (fingerprint) => displayFingerprint(fingerprint),
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

### Build from Source

```bash
cd walletpair-websocket-relay
cargo build --release
./target/release/walletpair-relay --config config.toml
```

Docker support is planned but not yet available.

### Endpoints

| Path | Purpose |
|------|---------|
| `/v1` | WebSocket endpoint (requires `walletpair.v1` subprotocol) |
| `/healthz` | Liveness probe |
| `/readyz` | Readiness probe (503 if at capacity) |
| `/metrics` | Prometheus metrics |

## Protocol Highlights

### Cryptography

- **Key exchange**: X25519 ephemeral keypairs (with all-zero / low-order point rejection per RFC 7748 §6)
- **Key derivation**: HKDF-SHA256 with channel ID salt and domain-separated info strings
- **Encryption**: ChaCha20-Poly1305 AEAD with type-byte AAD (0x01/0x02/0x03 prevent cross-type confusion)
- **Canonical JSON**: RFC 8785 (JCS) — sole normative reference, with SHA-256 verified test vectors
- **Session fingerprint**: SHA256(prefix || channel_id || dapp_pubkey) mod 10000 for visual MITM prevention
- **Replay protection**: Per-peer monotonic sequence counters, HMAC-SHA256 snapshot integrity
- **Formal verification**: Protocol security properties proven with ProVerif (see below)

### Message Types

| Type | Direction | Description |
|------|-----------|-------------|
| `create` | dApp -> Relay | Create a new channel |
| `join` | Wallet -> Relay | Join an existing channel |
| `accept` | dApp -> Relay | Accept wallet (auto after sealed_join verification) |
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

Production reconnect requires durable `SessionPersistence` on both peers. The SDK persists full session snapshots write-ahead: after advancing `sendSeq`, it waits for `save()` to resolve before sending the encrypted `req`, `res`, or `evt`; after accepting an inbound sequence number, it persists `recvSeq` before resolving a response or emitting a request/event callback.

Sessions survive disconnects by re-running the create/join/accept flow on the same channel. The relay is stateless and needs no persistent storage. Sequence counters must survive process termination; if persistence is unavailable or corrupted, the peer must start a fresh pairing instead of reconnecting. Wallets deduplicate retried requests using an idempotency cache keyed on request ID and params hash.

The wagmi connector wires this automatically through `config.storage` and uses the stored snapshot when wagmi calls `connect({ isReconnecting: true })`.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| SDK | TypeScript, @noble/curves, @noble/hashes, @noble/ciphers |
| Extension | Svelte, Wxt, TypeScript |
| Relay | Rust, Axum, Tokio, Prometheus |
| Website | SvelteKit, Cloudflare Workers |
| Examples | HTML/JS, React Native (Expo), SvelteKit |

## Formal Verification

The protocol's security properties have been formally verified using [ProVerif](https://bblanche.gitlabpages.inria.fr/proverif/) under a Dolev-Yao attacker model (attacker controls the relay and the entire network):

| Property | Status |
|----------|--------|
| Request confidentiality | **Proved** |
| Response confidentiality | **Proved** |
| Event confidentiality | **Proved** |
| Request authentication (dApp → wallet) | **Proved** |
| Response authentication (wallet → dApp) | **Proved** |
| Event authentication (wallet → dApp) | **Proved** |
| `sealed_join` handshake authentication | **Proved** |

Run the verification yourself:

```bash
opam install proverif
proverif formal-verification/walletpair.pv
```

The model is in [formal-verification/walletpair.pv](formal-verification/walletpair.pv). See inline comments for threat model assumptions and modeling decisions.

## Testing

| Component | Tests | Framework |
|-----------|-------|-----------|
| SDK | 422 | Vitest |
| Extension | 236 | Vitest |
| Relay | 212+ | cargo test |

CI runs on every PR for all three components (lint, type check, test).

## Specifications

- [WalletPair Protocol v1](walletpair-protocol-v1.md) - Full protocol specification (RFC 8785 canonical JSON, X25519 + HKDF + ChaCha20-Poly1305)
- [WalletPair EVM Sub-Protocol v1](walletpair-evm-subprotocol-v1.md) - EVM-specific methods, events, and validation rules
- [Formal Verification Model](formal-verification/walletpair.pv) - ProVerif model with 7 proven security properties

## License

[MIT](LICENSE)
