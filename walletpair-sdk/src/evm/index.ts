/**
 * EVM-specific exports for WalletPair SDK.
 *
 * Provides EIP-1193 provider and wagmi connector for Ethereum/EVM networks.
 */

export {
  WalletPairProvider,
  type WalletPairProviderOptions,
  type EIP1193Provider,
  type EIP1193ProviderEvents,
  type EIP1193RequestArgs,
  type MethodMapper,
} from './eip1193.js';

export {
  walletPair,
  type WalletPairConnectorOptions,
} from './wagmi.js';
