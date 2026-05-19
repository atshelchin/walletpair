# walletpair-sdk

TypeScript SDK for the [WalletPair Protocol](../walletpair-protocol-v1.md) -- connect dApps and wallets with end-to-end encrypted, relay-based or BLE communication.

## Features

- **Chain-agnostic core** -- uses [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md) chain IDs (`eip155:1`, `solana:mainnet`), ready for multi-chain
- **EVM support** -- EIP-1193 provider + wagmi connector (under `walletpair-sdk/evm`)
- **Transport-agnostic** -- WebSocket relay and Web Bluetooth (BLE) transports included, pluggable `Transport` interface for custom transports
- **End-to-end encrypted** -- X25519 key exchange + ChaCha20-Poly1305 AEAD, relay never sees payload content
- **Session persistence** -- `serialize()` / `restore()` for page reload survival
- **Zero native dependencies** -- pure JS crypto via [noble](https://github.com/paulmillr/noble-curves) libraries

## Architecture

```
walletpair-sdk
├── Core (chain-agnostic)
│   ├── crypto.ts          X25519, HKDF, ChaCha20-Poly1305, seal/unseal
│   ├── types.ts           Transport interface, CAIP-2 helpers, protocol messages
│   ├── emitter.ts         Typed event emitter
│   ├── ws-transport.ts    WebSocket transport (browser/Node/Deno/Bun)
│   ├── dapp-session.ts    DApp-side session state machine
│   └── wallet-session.ts  Wallet-side session state machine
├── BLE (walletpair-sdk/ble)
│   ├── framing.ts         BLE message fragmentation/reassembly (Section 19.5)
│   └── web-ble-transport.ts  Web Bluetooth Central transport (runtime detection)
└── EVM (walletpair-sdk/evm)
    ├── eip1193.ts         EIP-1193 provider (maps eth_ methods to WalletPair)
    └── wagmi.ts           wagmi connector factory
```

### Data Flow

```
┌──────────┐                              ┌──────────┐
│   dApp   │                              │  Wallet  │
│          │                              │          │
│ DAppSession                        WalletSession  │
│     │    │                              │    │     │
│     ▼    │     ┌──────────────┐         │    ▼     │
│ Transport├────►│ Relay / BLE  │◄────────┤Transport │
│          │     └──────────────┘         │          │
└──────────┘     (sees only routing       └──────────┘
                  metadata -- payloads
                  are E2E encrypted)
```

## Install

```bash
npm install walletpair-sdk
```

## Quick Start

### DApp Side (Vanilla JS/TS)

```ts
import { DAppSession, WebSocketTransport } from 'walletpair-sdk'

const transport = new WebSocketTransport('wss://relay.walletpair.org/v1')
const session = new DAppSession({ transport, name: 'My dApp' })

// 1. Create pairing -- display the URI as a QR code
const uri = await session.createPairing()
console.log('Scan this:', uri)

// 2. When wallet joins, verify the pairing code with user
session.on('pairingCode', (code) => {
  console.log('Pairing code:', code) // e.g. "482901"
  // Show code to user, user confirms it matches wallet display
  session.acceptWallet()
})

// 3. Once connected, send requests
session.on('phase', async (phase) => {
  if (phase === 'connected') {
    const accounts = await session.request('wallet_getAccounts')
    console.log('Accounts:', accounts)
  }
})

// 4. Listen for wallet events
session.on('event', ({ event, data }) => {
  console.log(`Event: ${event}`, data)
})
```

### Wallet Side (JS/TS / React Native)

```ts
import { WalletSession, WebSocketTransport } from 'walletpair-sdk'

const transport = new WebSocketTransport('wss://relay.walletpair.org/v1')
const session = new WalletSession({
  transport,
  capabilities: {
    methods: ['wallet_getAccounts', 'wallet_signMessage'],
    events: ['accountsChanged', 'chainChanged'],
    chains: ['eip155:1', 'eip155:137'],
  },
  meta: { name: 'My Wallet' },
})

// 1. Join from pairing URI (scanned from QR code)
const pairingCode = await session.joinFromUri(uri)
console.log('Pairing code:', pairingCode) // show to user for verification

// 2. Handle incoming requests
session.on('request', ({ id, method, params }) => {
  switch (method) {
    case 'wallet_getAccounts':
      session.approve(id, ['0xYourAddress'])
      break
    case 'wallet_signMessage':
      // Sign and return, or reject
      session.approve(id, { signature: '0x...' })
      // session.reject(id, 'user_rejected', 'User declined')
      break
  }
})

// 3. Push events to dApp
session.pushEvent('accountsChanged', { accounts: ['0xNewAddress'] })
```

### EVM dApp with EIP-1193 Provider

```ts
import { DAppSession, WebSocketTransport } from 'walletpair-sdk'
import { WalletPairProvider } from 'walletpair-sdk/evm'

const transport = new WebSocketTransport('wss://relay.walletpair.org/v1')
const session = new DAppSession({ transport })
const provider = new WalletPairProvider({ session, chainId: 1 })

// Use like any EIP-1193 provider
const accounts = await provider.request({ method: 'eth_requestAccounts' })
const chainId = await provider.request({ method: 'eth_chainId' })

// Standard EIP-1193 events
provider.on('accountsChanged', (accounts) => { /* ... */ })
provider.on('chainChanged', (chainId) => { /* ... */ })
provider.on('disconnect', (error) => { /* ... */ })
```

### EVM dApp with wagmi

```ts
import { walletPair } from 'walletpair-sdk/evm/wagmi'
import { createConfig, http } from 'wagmi'
import { mainnet, polygon } from 'wagmi/chains'

const config = createConfig({
  chains: [mainnet, polygon],
  connectors: [
    walletPair({
      relayUrl: 'wss://relay.walletpair.org/v1',
      name: 'My dApp',
      onPairingUri: (uri) => {
        // Display QR code with this URI
        showQrCode(uri)
      },
      onPairingCode: (code) => {
        // Display pairing code for user verification
        showPairingCode(code)
      },
      onPairingConfirm: async (code) => {
        // Ask user to confirm the code matches. Return true to accept.
        return await askUserToConfirm(code)
      },
    }),
  ],
  transports: {
    [mainnet.id]: http(),
    [polygon.id]: http(),
  },
})
```

### BLE Transport (Web Bluetooth)

```ts
import { DAppSession } from 'walletpair-sdk'
import { WebBleCentralTransport, isWebBleSupported } from 'walletpair-sdk/ble'

if (isWebBleSupported()) {
  const transport = new WebBleCentralTransport()
  const session = new DAppSession({ transport })

  // BLE pairing URI has no relay parameter
  const uri = await session.createPairing()
  // uri = "walletpair:?ch=...&pubkey=..."
}
```

## Session Persistence

Sessions can survive page reloads:

```ts
// Save before unload
window.addEventListener('beforeunload', () => {
  sessionStorage.setItem('wp', session.serialize())
})

// Restore on load
const saved = sessionStorage.getItem('wp')
if (saved && session.restore(saved)) {
  await session.reconnect()
}
```

## API Reference

### Core

#### `DAppSession`

```ts
new DAppSession({ transport, name?, requestTimeout?, autoAccept? })
```

| Method | Description |
|--------|-------------|
| `createPairing(): Promise<string>` | Create channel, returns pairing URI for QR display |
| `acceptWallet()` | Accept wallet after pairing code verification |
| `rejectWallet()` | Reject wallet pairing |
| `request<T>(method, params?): Promise<T>` | Send encrypted request, returns decrypted response |
| `ping()` | Send heartbeat ping |
| `close()` | Gracefully close session |
| `destroy()` | Close + remove all event listeners |
| `serialize(): string` | Serialize session state for persistence |
| `restore(json): boolean` | Restore session from serialized state |
| `reconnect(): Promise<void>` | Reconnect after restore |

**Events:**

| Event | Payload | Description |
|-------|---------|-------------|
| `phase` | `DAppPhase` | State machine transition |
| `pairingUri` | `string` | Pairing URI generated |
| `pairingCode` | `string` | 6-digit code for verification |
| `walletJoined` | `{ pubkey, capabilities?, meta? }` | Wallet joined the channel |
| `response` | `{ id, ok, data }` | Response received |
| `event` | `{ event, data }` | Wallet pushed an event |
| `error` | `Error` | Error occurred |

**Phases:** `idle` -> `waiting` -> `pending_accept` -> `connected` -> `closed`

#### `WalletSession`

```ts
new WalletSession({ transport, capabilities, meta? })
```

| Method | Description |
|--------|-------------|
| `joinFromUri(uri): Promise<string>` | Join channel, returns pairing code |
| `approve(requestId, result)` | Approve request with encrypted result |
| `reject(requestId, code?, message?)` | Reject request with error |
| `pushEvent(event, data)` | Push event to dApp |
| `ping()` | Send heartbeat ping |
| `close()` | Gracefully close session |
| `destroy()` | Close + remove all event listeners |
| `serialize()` / `restore(json)` | Session persistence |

**Events:**

| Event | Payload | Description |
|-------|---------|-------------|
| `phase` | `WalletPhase` | State machine transition |
| `pairingCode` | `string` | 6-digit code for verification |
| `request` | `{ id, method, params }` | Incoming request from dApp |
| `error` | `Error` | Error occurred |

**Phases:** `idle` -> `waiting` -> `connected` -> `closed`

#### `WebSocketTransport`

```ts
new WebSocketTransport(url: string)
new WebSocketTransport({ url: string, protocols?: string[] })
```

#### Transport Interface

Implement this to create custom transports (e.g., for React Native BLE peripheral):

```ts
interface Transport {
  readonly state: 'disconnected' | 'connecting' | 'connected'
  send(msg: ProtocolMessage): void
  connect(): Promise<void>
  disconnect(): void
  onMessage(handler: (msg: ProtocolMessage) => void): void
  onClose(handler: () => void): void
  onOpen(handler: () => void): void
}
```

### CAIP-2 Chain ID Helpers

```ts
import { parseChainId, formatChainId, evmChainId, evmNumericChainId } from 'walletpair-sdk'

parseChainId('eip155:1')           // { namespace: 'eip155', reference: '1' }
formatChainId('eip155', '137')     // 'eip155:137'
evmChainId(1)                      // 'eip155:1'
evmNumericChainId('eip155:1')      // 1
evmNumericChainId('solana:mainnet') // null
```

### EVM

#### `WalletPairProvider` (EIP-1193)

```ts
import { WalletPairProvider } from 'walletpair-sdk/evm'

new WalletPairProvider({ session, chainId?, mapper? })
```

**Default method mapping:**

| EIP-1193 Method | WalletPair Method |
|----------------|-------------------|
| `eth_requestAccounts` | `wallet_getAccounts` |
| `eth_accounts` | `wallet_getAccounts` |
| `personal_sign` | `wallet_signMessage` |
| `eth_signTypedData_v4` | `wallet_signTypedData` |
| `eth_sendTransaction` | `wallet_signTransaction` |
| `wallet_switchEthereumChain` | `wallet_switchChain` |
| `wallet_addEthereumChain` | `wallet_addChain` |
| `eth_chainId` | Handled locally (returns cached chain ID) |
| `net_version` | Handled locally (returns cached chain ID) |
| Others | Passed through as-is |

Override with a custom `MethodMapper` for specialized behavior.

#### `walletPair()` (wagmi connector)

```ts
import { walletPair } from 'walletpair-sdk/evm/wagmi'

walletPair({
  relayUrl: string,          // WebSocket relay URL
  name?: string,             // DApp display name
  requestTimeout?: number,   // Request timeout in ms
  onPairingUri?: (uri) => void,            // QR code display callback
  onPairingCode?: (code) => void,          // Pairing code display callback
  onPairingConfirm?: (code) => Promise<boolean>, // User confirmation callback
})
```

### BLE

```ts
import {
  WebBleCentralTransport,  // Web Bluetooth Central (dApp side)
  isWebBleSupported,        // Runtime availability check
  frameMessage,             // Low-level: split JSON into BLE frames
  Defragmenter,             // Low-level: reassemble BLE frames
  BLE_SERVICE_UUID,         // WalletPair BLE service UUID
  BLE_WRITE_CHAR_UUID,      // DApp -> Wallet characteristic
  BLE_NOTIFY_CHAR_UUID,     // Wallet -> DApp characteristic
} from 'walletpair-sdk/ble'
```

## Extending for New Chains

To add support for a new chain (e.g., Solana):

1. Create `src/solana/` directory
2. Implement a provider that maps Solana RPC methods to WalletPair requests
3. Add subpath export in `package.json`:
   ```json
   { "./solana": "./src/solana/index.ts" }
   ```
4. Wallet side: declare Solana chains in capabilities:
   ```ts
   capabilities: {
     methods: ['wallet_signTransaction', 'wallet_signMessage'],
     chains: ['solana:mainnet', 'solana:devnet'],
   }
   ```

The core protocol is chain-agnostic -- `DAppSession.request()` and `WalletSession.approve()` work with any method/params structure.

## Security

- **E2E Encryption**: X25519 ECDH -> HKDF-SHA256 -> ChaCha20-Poly1305 AEAD
- **MITM Protection**: 6-digit pairing code verified by user on both devices
- **Replay Protection**: Sequence-number-based nonces, monotonically increasing
- **Channel Isolation**: 256-bit random channel IDs
- **Zero Trust Relay**: Relay sees routing metadata only, never plaintext payloads

## License

MIT
