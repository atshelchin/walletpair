/**
 * WalletPair SDK — shared types and interfaces.
 *
 * Multi-chain ready: uses CAIP-2 chain IDs throughout (e.g. "eip155:1").
 */

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export type TransportState = 'disconnected' | 'connecting' | 'connected';

export interface Transport {
  readonly state: TransportState;
  send(msg: ProtocolMessage): void;
  connect(): Promise<void>;
  disconnect(): void;
  onMessage(handler: (msg: ProtocolMessage) => void): void;
  onClose(handler: () => void): void;
  onOpen(handler: () => void): void;
}

// ---------------------------------------------------------------------------
// Protocol messages (wire format)
// ---------------------------------------------------------------------------

export interface ProtocolMessageBase {
  v: 1;
  t: string;
  ch: string;
  from?: string;
}

export interface CreateMessage extends ProtocolMessageBase {
  t: 'create';
  pubkey: string;
  resume?: string | undefined;
}

export interface JoinMessage extends ProtocolMessageBase {
  t: 'join';
  pubkey: string;
  capabilities?: Capabilities | undefined;
  meta?: WalletMeta | undefined;
  resume?: string | undefined;
}

export interface AcceptMessage extends ProtocolMessageBase {
  t: 'accept';
  target: string;
}

export interface ReadyMessage extends ProtocolMessageBase {
  t: 'ready';
  state: 'waiting' | 'connected';
  resume?: string | undefined;
  remote?: string | undefined;
  role?: string | undefined;
  self?: string | undefined;
}

export interface RequestMessage extends ProtocolMessageBase {
  t: 'req';
  id: string;
  method: string;
  sealed?: string | undefined;
}

export interface ResponseMessage extends ProtocolMessageBase {
  t: 'res';
  id: string;
  ok: boolean;
  sealed?: string | undefined;
}

export interface EventMessage extends ProtocolMessageBase {
  t: 'evt';
  id?: string | undefined;
  event: string;
  sealed?: string | undefined;
}

export interface PingMessage extends ProtocolMessageBase {
  t: 'ping';
  ts: number;
}

export interface PongMessage extends ProtocolMessageBase {
  t: 'pong';
  ts: number;
}

export interface CloseMessage extends ProtocolMessageBase {
  t: 'close';
  reason: CloseReason;
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
  | CloseMessage;

export type CloseReason =
  | 'normal'
  | 'user_rejected'
  | 'unsupported_capability'
  | 'channel_not_found'
  | 'channel_exists'
  | 'already_connected'
  | 'invalid_state'
  | 'invalid_role'
  | 'invalid_resume'
  | 'timeout'
  | 'payload_too_large'
  | 'protocol_error'
  | 'unsupported_version'
  | 'decryption_failed';

// ---------------------------------------------------------------------------
// Capabilities & metadata (multi-chain via CAIP-2)
// ---------------------------------------------------------------------------

export interface Capabilities {
  /** Supported RPC methods (e.g. "wallet_getAccounts", "wallet_signMessage"). */
  methods: string[];
  /** Supported events (e.g. "accountsChanged", "chainChanged"). */
  events: string[];
  /** CAIP-2 chain IDs (e.g. "eip155:1", "solana:mainnet"). */
  chains: string[];
}

export interface WalletMeta {
  name?: string;
  address?: string;
  icon?: string;
  [key: string]: unknown;
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
  | 'closed';

export type WalletPhase =
  | 'idle'
  | 'waiting'
  | 'connected'
  | 'disconnected'
  | 'closed';

// ---------------------------------------------------------------------------
// Session events
// ---------------------------------------------------------------------------

export interface DAppSessionEvents {
  [key: string]: unknown;
  phase: DAppPhase;
  pairingUri: string;
  pairingCode: string;
  walletJoined: { pubkey: string; capabilities?: Capabilities | undefined; meta?: WalletMeta | undefined };
  response: { id: string; ok: boolean; data: unknown };
  event: { event: string; data: unknown };
  error: Error;
}

export interface WalletSessionEvents {
  [key: string]: unknown;
  phase: WalletPhase;
  pairingCode: string;
  request: { id: string; method: string; params: unknown };
  error: Error;
}

// ---------------------------------------------------------------------------
// Pairing URI
// ---------------------------------------------------------------------------

export interface PairingParams {
  ch: string;
  pubkey: string;
  /** Empty string = BLE mode (no relay). */
  relay: string;
  name?: string | undefined;
}

// ---------------------------------------------------------------------------
// Request/response helpers
// ---------------------------------------------------------------------------

export interface PendingRequest {
  id: string;
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Session options
// ---------------------------------------------------------------------------

export interface DAppSessionOptions {
  transport: Transport;
  /** DApp display name (included in pairing URI). */
  name?: string | undefined;
  /** Request timeout in ms (default 120_000). */
  requestTimeout?: number | undefined;
  /** Auto-accept known wallets on rejoin (default true). */
  autoAccept?: boolean | undefined;
}

export interface WalletSessionOptions {
  transport: Transport;
  /** Wallet capabilities to advertise. */
  capabilities: Capabilities;
  /** Wallet metadata. */
  meta?: WalletMeta | undefined;
}

// ---------------------------------------------------------------------------
// Chain namespace helpers (for future multi-chain)
// ---------------------------------------------------------------------------

/** Parse CAIP-2 chain ID into namespace and reference. */
export function parseChainId(caip2: string): { namespace: string; reference: string } {
  const [namespace, reference] = caip2.split(':');
  if (!namespace || !reference) throw new Error(`Invalid CAIP-2 chain ID: ${caip2}`);
  return { namespace, reference };
}

/** Build CAIP-2 chain ID from namespace and reference. */
export function formatChainId(namespace: string, reference: string): string {
  return `${namespace}:${reference}`;
}

/** Convert EVM numeric chain ID to CAIP-2. */
export function evmChainId(id: number): string {
  return `eip155:${id}`;
}

/** Extract EVM numeric chain ID from CAIP-2. Returns null if not eip155. */
export function evmNumericChainId(caip2: string): number | null {
  const { namespace, reference } = parseChainId(caip2);
  if (namespace !== 'eip155') return null;
  return Number.parseInt(reference, 10);
}
