/**
 * WalletPair SDK — connect dApps and wallets over the WalletPair protocol.
 *
 * Main entry point re-exports everything needed for both dApp and wallet sides.
 *
 * Subpath exports:
 *   - walletpair-sdk            Core (this file)
 *   - walletpair-sdk/evm        EVM: EIP-1193 provider + wagmi connector
 *   - walletpair-sdk/evm/eip1193  EIP-1193 provider only
 *   - walletpair-sdk/evm/wagmi    Wagmi connector only
 *   - walletpair-sdk/ble        BLE transport + framing utilities
 */

// Types
export type {
  Transport,
  TransportState,
  ProtocolMessage,
  ProtocolMessageBase,
  CreateMessage,
  JoinMessage,
  AcceptMessage,
  ReadyMessage,
  RequestMessage,
  ResponseMessage,
  EventMessage,
  PingMessage,
  PongMessage,
  CloseMessage,
  TerminateMessage,
  CloseReason,
  Capabilities,
  WalletMeta,
  DAppPhase,
  WalletPhase,
  DAppSessionEvents,
  WalletSessionEvents,
  PairingParams,
  PendingRequest,
  DAppSessionOptions,
  WalletSessionOptions,
} from './types.js';

// Chain ID helpers (CAIP-2)
export {
  parseChainId,
  formatChainId,
  evmChainId,
  evmNumericChainId,
} from './types.js';

// Crypto
export {
  generateX25519KeyPair,
  getPublicKey,
  computeSharedSecret,
  deriveSessionKey,
  deriveDirectionalSessionKeys,
  deriveJoinEncryptionKey,
  computeHandshakeTranscriptHash,
  computePairingCode,
  canonicalJson,
  sealPayload,
  unsealPayload,
  sealJoin,
  unsealJoin,
  generateChannelId,
  buildPairingUri,
  parsePairingUri,
  b64urlEncode,
  b64urlDecode,
  bytesToHex,
  hexToBytes,
  sha256Hex,
} from './crypto.js';
export type { X25519KeyPair, SessionCryptoContext, DirectionalSessionKeys } from './crypto.js';

// Emitter
export { Emitter } from './emitter.js';

// Transport
export { WebSocketTransport } from './ws-transport.js';
export type { WebSocketTransportOptions } from './ws-transport.js';

// Sessions
export { DAppSession } from './dapp-session.js';
export { WalletSession } from './wallet-session.js';
