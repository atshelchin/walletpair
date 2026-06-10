/**
 * EVM method constants — extracted from background.ts, rpc-proxy.ts, and provider-factory.ts.
 *
 * Single source of truth for which methods belong to which category.
 *
 * Methods NOT listed in any set below are forwarded to the wallet over the
 * WalletPair channel by default. That includes the EIP-5792 extension methods
 * `wallet_sendCalls` and `wallet_getCallsStatus` (only the wallet can submit /
 * resolve a batch). EIP-2255 (`wallet_getPermissions` / `wallet_requestPermissions`)
 * is NOT a protocol method — it is kept only as a thin compatibility shim
 * (getPermissions answered locally; requestPermissions mapped to
 * eth_requestAccounts) and is never advertised in capabilities.
 */

/** Methods that require user confirmation popup before forwarding to wallet */
export const CONFIRMATION_METHODS: ReadonlySet<string> = new Set([
  'eth_sendTransaction',
  'eth_signTransaction',
  'personal_sign',
  'eth_signTypedData_v4',
  'eth_signTypedData_v3',
]);

/** Methods handled locally in the extension (no relay trip needed) */
export const LOCAL_METHODS: ReadonlySet<string> = new Set([
  'eth_chainId',
  'net_version',
  'eth_accounts',
  'wallet_getPermissions',
  'wallet_getCapabilities',
]);

/** Read-only methods routed to a public RPC node, NOT the wallet */
export const READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  'eth_blockNumber', 'eth_call', 'eth_estimateGas', 'eth_feeHistory',
  'eth_gasPrice', 'eth_maxPriorityFeePerGas',
  'eth_getBalance', 'eth_getCode', 'eth_getStorageAt', 'eth_getTransactionCount',
  'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getLogs',
  'eth_getBlockByNumber', 'eth_getBlockByHash',
  'eth_newFilter', 'eth_newBlockFilter', 'eth_getFilterChanges', 'eth_uninstallFilter',
  'eth_sendRawTransaction', 'eth_syncing',
]);

/** Methods that are explicitly unsupported */
export const UNSUPPORTED_METHODS: ReadonlySet<string> = new Set([
  'eth_getEncryptionPublicKey',
  'eth_decrypt',
  'eth_sign',
  'wallet_addEthereumChain',
]);
