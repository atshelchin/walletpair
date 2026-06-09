/**
 * WalletPair SDK — shared types and interfaces.
 *
 * Multi-chain ready: uses CAIP-2 chain IDs throughout (e.g. "eip155:1").
 */

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export type TransportState = 'disconnected' | 'connecting' | 'connected'

export interface Transport {
  readonly state: TransportState
  send(msg: ProtocolMessage): void
  connect(): Promise<void>
  disconnect(): void
  onMessage(handler: (msg: ProtocolMessage) => void): void
  onClose(handler: () => void): void
  onOpen(handler: () => void): void
}

// ---------------------------------------------------------------------------
// Protocol messages (wire format)
// ---------------------------------------------------------------------------

export interface ProtocolMessageBase {
  v: 1
  t: string
  ch: string
  ts: number
  from: string
  body: Record<string, unknown>
}

export interface CreateMessage extends ProtocolMessageBase {
  t: 'create'
  body: { meta: DAppMeta }
}

export interface JoinMessage extends ProtocolMessageBase {
  t: 'join'
  body: { sealed_join: string | null }
}

export interface AcceptMessage extends ProtocolMessageBase {
  t: 'accept'
  body: { target: string }
}

export interface ReadyMessage extends ProtocolMessageBase {
  t: 'ready'
  body: {
    state: 'waiting' | 'connected'
    role: 'dapp' | 'wallet'
    self: string
    remote: string | null
    reconnect: boolean
  }
}

export interface RequestMessage extends ProtocolMessageBase {
  t: 'req'
  body: { id: string; sealed: string }
}

export interface ResponseMessage extends ProtocolMessageBase {
  t: 'res'
  body: { id: string; sealed: string }
}

export interface EventMessage extends ProtocolMessageBase {
  t: 'evt'
  body: { id: string; sealed: string }
}

export interface PingMessage extends ProtocolMessageBase {
  t: 'ping'
  body: Record<string, never>
}

export interface PongMessage extends ProtocolMessageBase {
  t: 'pong'
  body: Record<string, never>
}

export interface CloseMessage extends ProtocolMessageBase {
  t: 'close'
  body: { reason: CloseReason }
}

export interface TerminateMessage extends ProtocolMessageBase {
  t: 'terminate'
  from: '_adapter'
  body: { reason: CloseReason }
}

export type ProtocolMessage =
  | CreateMessage
  | JoinMessage
  | AcceptMessage
  | ReadyMessage
  | RequestMessage
  | ResponseMessage
  | EventMessage
  | PingMessage
  | PongMessage
  | CloseMessage
  | TerminateMessage

export type CloseReason =
  | 'normal'
  | 'user_rejected'
  | 'unsupported_capability'
  | 'channel_not_found'
  | 'channel_exists'
  | 'already_connected'
  | 'invalid_state'
  | 'invalid_role'
  | 'timeout'
  | 'rate_limited'
  | 'payload_too_large'
  | 'protocol_error'
  | 'unsupported_version'
  | 'decryption_failed'

// ---------------------------------------------------------------------------
// Capabilities & metadata (multi-chain via CAIP-2)
// ---------------------------------------------------------------------------

export interface Capabilities {
  /** Supported RPC methods (e.g. "wallet_getAccounts", "wallet_signMessage"). */
  methods: string[]
  /** Supported events (e.g. "accountsChanged", "chainChanged"). */
  events: string[]
  /** CAIP-2 chain IDs (e.g. "eip155:1", "solana:mainnet"). */
  chains: string[]
  /** Sub-protocol version map (e.g. { evm: 1 }). §8 */
  version?: Record<string, number> | undefined
  /**
   * RPC endpoint URLs keyed by CAIP-2 chain ID (e.g. { "eip155:1": "https://..." }).
   * Wallet shares its RPC URLs so the dApp-side can proxy read-only requests locally
   * without routing them through the relay.
   */
  rpcUrls?: Record<string, string> | undefined
  /**
   * EIP-5792 wallet capabilities keyed by hex chain ID.
   * Returned as-is by the dApp-side for wallet_getCapabilities.
   * Example: { "0x1": { "atomic": { "status": "supported" } } }
   */
  walletCapabilities?: Record<string, Record<string, unknown>> | undefined
  /**
   * Contract bytecode for counterfactual smart wallet detection.
   * When provided, the dApp-side returns this for eth_getCode queries
   * against the connected address if the contract is not yet deployed.
   * This lets dApps detect the address as a smart contract wallet.
   */
  contractBytecode?: string | undefined
}

export interface DAppMeta {
  name: string
  description: string
  url: string
  icon: string
}

export interface WalletMeta {
  name: string
  description: string
  url: string
  icon: string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Session phases
// ---------------------------------------------------------------------------

export type DAppPhase =
  | 'idle'
  | 'waiting'
  | 'pending_accept'
  | 'connected'
  | 'disconnected'
  | 'closed'

export type WalletPhase =
  | 'idle'
  | 'waiting'
  | 'waiting_accept'
  | 'connected'
  | 'disconnected'
  | 'closed'

// ---------------------------------------------------------------------------
// Session events
// ---------------------------------------------------------------------------

export interface DAppSessionEvents {
  [key: string]: unknown
  phase: DAppPhase
  pairingUri: string
  sessionFingerprint: string
  walletJoined: { capabilities?: Capabilities | undefined; meta?: WalletMeta | undefined }
  response: { id: string; ok: boolean; result: unknown }
  event: { event: string; data: unknown }
  error: Error
}

export interface WalletSessionEvents {
  [key: string]: unknown
  phase: WalletPhase
  sessionFingerprint: string
  request: { id: string; method: string; params: unknown }
  error: Error
}

// ---------------------------------------------------------------------------
// Pairing URI
// ---------------------------------------------------------------------------

export interface PairingParams {
  ch: string
  pubkey: string
  /** Relay URL. Undefined when using direct transport (BLE). */
  relay?: string | undefined
  name: string
  /** DApp website URL. */
  url: string
  /** DApp icon URL. */
  icon: string
  /** Methods the dApp intends to call (§9.1). */
  methods?: string[] | undefined
  /** CAIP-2 chains the dApp intends to use (§9.1). */
  chains?: string[] | undefined
}

// ---------------------------------------------------------------------------
// Request/response helpers
// ---------------------------------------------------------------------------

export interface PendingRequest {
  id: string
  method: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

export interface SessionPersistence {
  /**
   * Persist a complete serialized session snapshot. Implementations used for
   * reconnect MUST make this durable before resolving; the SDK calls this
   * before sending each encrypted message after advancing `sendSeq`.
   */
  save(snapshot: string): void | Promise<void>
  /** Load the most recent durable snapshot. */
  load?(): string | null | Promise<string | null>
  /** Remove the durable snapshot when the channel closes. */
  clear?(): void | Promise<void>
}

// ---------------------------------------------------------------------------
// Session options
// ---------------------------------------------------------------------------

export interface DAppSessionOptions {
  transport: Transport
  /** DApp metadata (name, description, url, icon). Included in pairing URI and create message. */
  meta: DAppMeta
  /** Methods the dApp intends to call (included in pairing URI §9.1). */
  methods?: string[] | undefined
  /** CAIP-2 chains the dApp intends to use (included in pairing URI §9.1). */
  chains?: string[] | undefined
  /** Request timeout in ms (default 120_000). */
  requestTimeout?: number | undefined
  /** Session lifetime in ms (default 86_400_000 = 24h). §16 rule 16. */
  sessionTtl?: number | undefined
  /** Auto-accept known wallets on rejoin (default true). */
  autoAccept?: boolean | undefined
  /** Durable snapshot persistence for reconnect and write-ahead counters. */
  persistence?: SessionPersistence | undefined
}

export interface WalletSessionOptions {
  transport: Transport
  /** Wallet capabilities to advertise. */
  capabilities: Capabilities
  /** Wallet metadata (name, description, url, icon). */
  meta: WalletMeta
  /** Session lifetime in ms (default 86_400_000 = 24h). §16 rule 16. */
  sessionTtl?: number | undefined
  /** Durable snapshot persistence for reconnect and write-ahead counters. */
  persistence?: SessionPersistence | undefined
}

// ---------------------------------------------------------------------------
// Chain namespace helpers (for future multi-chain)
// ---------------------------------------------------------------------------

/** Parse CAIP-2 chain ID into namespace and reference. */
export function parseChainId(caip2: string): { namespace: string; reference: string } {
  const [namespace, reference] = caip2.split(':')
  if (!namespace || !reference) throw new Error(`Invalid CAIP-2 chain ID: ${caip2}`)
  return { namespace, reference }
}

/** Build CAIP-2 chain ID from namespace and reference. */
export function formatChainId(namespace: string, reference: string): string {
  return `${namespace}:${reference}`
}

/** Convert EVM numeric chain ID to CAIP-2. */
export function evmChainId(id: number): string {
  return `eip155:${id}`
}

/** Extract EVM numeric chain ID from CAIP-2. Returns null if not eip155. */
export function evmNumericChainId(caip2: string): number | null {
  const { namespace, reference } = parseChainId(caip2)
  if (namespace !== 'eip155') return null
  return Number.parseInt(reference, 10)
}
