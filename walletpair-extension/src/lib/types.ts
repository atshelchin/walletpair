/** EIP-1193 request arguments */
export interface EIP1193Request {
  method: string;
  params?: unknown[] | Record<string, unknown>;
}

/** Wallet connection info stored in extension */
export interface ConnectedWallet {
  address: string;
  chainId: number;
  name?: string;
  icon?: string;
  /** Protocol name: 'ethereum', 'solana', etc. Defaults to 'ethereum'. */
  protocolName?: string;
  /** Chain reference string for the protocol. E.g., '1' for Ethereum mainnet. */
  chainRef?: string;
}

/** Per-origin permission record */
export interface OriginPermission {
  origin: string;
  granted: boolean;
  grantedAt: number; // timestamp
}

/** Extension settings */
export interface ExtensionSettings {
  relayUrl: string;
  autoConnect: boolean;
  /** @deprecated No longer used — the bridge is chain-agnostic. Kept for backward compat. */
  enabledChains?: string[];
  /** Custom RPC URLs per chain (for read-only method proxying) */
  rpcUrls: Record<number, string>;
}

/** Message types between injected script <-> content script */
export type InjectMessage =
  | { type: 'wp-request'; id: string; payload: EIP1193Request }
  | { type: 'wp-response'; id: string; result?: unknown; error?: { code: number; message: string } }
  | { type: 'wp-event'; event: string; data: unknown }
  | { type: 'wp-provider-ready' };

/** Pending tx/sign confirmation details sent to the confirm popup */
export interface PendingConfirmationInfo {
  id: string;
  method: string;
  params: unknown;
  origin: string;
}

/** Message types between content script <-> background */
export type BackgroundMessage =
  | { action: 'rpc-request'; id: string; payload: EIP1193Request; origin: string }
  | { action: 'rpc-response'; id: string; result?: unknown; error?: { code: number; message: string } }
  | { action: 'get-state' }
  | { action: 'start-pairing' }
  | { action: 'reject-wallet' }
  | { action: 'accept-wallet' }
  | { action: 'disconnect' }
  | { action: 'get-pairing-uri' }
  | { action: 'get-permissions' }
  | { action: 'revoke-permission'; origin: string }
  | { action: 'get-confirmation'; id: string }
  | { action: 'approve-confirmation'; id: string }
  | { action: 'reject-confirmation'; id: string };

/** State shared from background to popup/content */
export interface ExtensionState {
  phase: 'idle' | 'pairing' | 'pending_accept' | 'connected' | 'disconnected' | 'error';
  pairingUri?: string;
  sessionFingerprint?: string;
  wallet?: ConnectedWallet;
  walletMeta?: { name?: string; icon?: string };
  error?: string;
  signingInProgress?: { method: string; origin: string };
}

/** Activity log entry for request tracking */
export interface ActivityEntry {
  id: string;
  timestamp: number;
  origin: string;
  method: string;
  category: 'read' | 'sign' | 'tx' | 'auth' | 'local';
  status: 'pending' | 'success' | 'rejected' | 'error';
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}
