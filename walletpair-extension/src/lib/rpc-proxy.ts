/**
 * RPC proxy logic — extracted for testability.
 *
 * Read-only Ethereum JSON-RPC methods are proxied to a public RPC node
 * instead of being forwarded to the connected wallet.
 */
import { getSettings } from './storage';

/** Default RPC endpoints per chain */
export const DEFAULT_RPC: Record<number, string> = {
  1: 'https://eth.llamarpc.com',
  10: 'https://mainnet.optimism.io',
  56: 'https://bsc-dataseed.binance.org',
  137: 'https://polygon-rpc.com',
  42161: 'https://arb1.arbitrum.io/rpc',
  8453: 'https://mainnet.base.org',
  43114: 'https://api.avax.network/ext/bc/C/rpc',
};

/** Read-only methods routed to a public RPC node, NOT the wallet */
export const READ_ONLY_METHODS = new Set([
  'eth_blockNumber', 'eth_call', 'eth_estimateGas', 'eth_feeHistory',
  'eth_gasPrice', 'eth_maxPriorityFeePerGas',
  'eth_getBalance', 'eth_getCode', 'eth_getStorageAt', 'eth_getTransactionCount',
  'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getLogs',
  'eth_getBlockByNumber', 'eth_getBlockByHash',
  'eth_newFilter', 'eth_newBlockFilter', 'eth_getFilterChanges', 'eth_uninstallFilter',
  'eth_sendRawTransaction', 'eth_syncing',
]);

/** RPC proxy timeout (30 seconds) */
const RPC_TIMEOUT_MS = 30_000;

/** Max RPC response size (2 MB) */
const RPC_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Proxy an RPC call to a public node for the given chain */
export async function proxyRpcCall(chainId: number, method: string, params: unknown): Promise<unknown> {
  const settings = await getSettings();
  const rpcUrl = settings.rpcUrls?.[chainId] ?? DEFAULT_RPC[chainId];
  if (!rpcUrl) {
    throw Object.assign(new Error(`No RPC URL configured for chain ${chainId}`), { code: -32601 });
  }

  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method,
    params: params ?? [],
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw Object.assign(new Error('RPC request timed out'), { code: -32603 });
    }
    throw Object.assign(new Error(err.message ?? 'RPC fetch failed'), { code: -32603 });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw Object.assign(new Error(`RPC HTTP ${res.status}: ${res.statusText}`), { code: -32603 });
  }

  // Check content-length if available
  const contentLength = res.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > RPC_MAX_RESPONSE_BYTES) {
    throw Object.assign(new Error('RPC response too large'), { code: -32603 });
  }

  const text = await res.text();
  if (text.length > RPC_MAX_RESPONSE_BYTES) {
    throw Object.assign(new Error('RPC response too large'), { code: -32603 });
  }

  const json = JSON.parse(text);
  if (json.error) {
    throw Object.assign(new Error(json.error.message ?? 'RPC error'), { code: json.error.code ?? -32603 });
  }
  return json.result;
}
