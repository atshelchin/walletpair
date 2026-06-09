/**
 * EVM RPC proxy — sends read-only JSON-RPC calls to public nodes.
 *
 * Moved from src/lib/rpc-proxy.ts into the protocol layer.
 */

/**
 * Default RPC endpoints per chain for read-only method proxying.
 * The bridge itself is chain-agnostic — it forwards any chain the wallet supports.
 * These RPCs are only used for `eth_call`, `eth_getBalance`, etc. so the dApp
 * doesn't need its own RPC provider.
 */
export const DEFAULT_RPC: Record<number, string> = {
  1: 'https://eth.llamarpc.com',
  10: 'https://mainnet.optimism.io',
  56: 'https://bsc-dataseed.binance.org',
  100: 'https://rpc.gnosis.gateway.fm',
  137: 'https://polygon-rpc.com',
  250: 'https://rpc.ftm.tools',
  324: 'https://mainnet.era.zksync.io',
  8453: 'https://mainnet.base.org',
  42161: 'https://arb1.arbitrum.io/rpc',
  42170: 'https://nova.arbitrum.io/rpc',
  43114: 'https://api.avax.network/ext/bc/C/rpc',
  59144: 'https://rpc.linea.build',
  534352: 'https://rpc.scroll.io',
  7777777: 'https://rpc.zora.energy',
};

/** RPC proxy timeout (30 seconds) */
const RPC_TIMEOUT_MS = 30_000;

/** Fallback discovery timeout (5 seconds per candidate) */
const FALLBACK_TIMEOUT_MS = 5_000;

/** Max RPC response size (2 MB) */
const RPC_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** In-memory cache: chainId → working fallback RPC URL */
const fallbackCache = new Map<number, { url: string; ts: number }>();

/** Cache TTL: 10 minutes */
const FALLBACK_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Proxy an RPC call to a public node for the given chain.
 *
 * @param chainRef - Numeric chain ID as a string (e.g., '1', '137')
 * @param method - JSON-RPC method name
 * @param params - JSON-RPC params
 * @param customRpcUrls - User-configured RPC URLs keyed by chain ID (string or number keys)
 */
export async function evmProxyRpcCall(
  chainRef: string,
  method: string,
  params: unknown,
  customRpcUrls: Record<string, string>,
): Promise<unknown> {
  const chainId = parseInt(chainRef, 10);
  const rpcUrl = customRpcUrls[chainId] ?? customRpcUrls[chainRef] ?? DEFAULT_RPC[chainId];

  // Try primary RPC first
  if (rpcUrl) {
    try {
      return await rpcFetch(rpcUrl, method, params);
    } catch (err) {
      // Primary failed — try fallback
      console.warn(`[RPC] Primary RPC failed for chain ${chainId}:`, (err as Error).message);
    }
  }

  // Try cached fallback
  const cached = fallbackCache.get(chainId);
  if (cached && Date.now() - cached.ts < FALLBACK_CACHE_TTL_MS) {
    try {
      return await rpcFetch(cached.url, method, params);
    } catch {
      // Cached fallback also failed — invalidate and discover new one
      fallbackCache.delete(chainId);
    }
  }

  // Discover a working RPC from ethereum-data API
  const fallbackUrl = await discoverFallbackRpc(chainId);
  if (fallbackUrl) {
    try {
      const result = await rpcFetch(fallbackUrl, method, params);
      // Cache the working URL
      fallbackCache.set(chainId, { url: fallbackUrl, ts: Date.now() });
      return result;
    } catch (err) {
      throw Object.assign(new Error((err as Error).message ?? 'All RPCs failed'), { code: -32603 });
    }
  }

  throw Object.assign(new Error(`No working RPC found for chain ${chainId}`), { code: -32601 });
}

// ── Internal helpers ─────────────────────────────────────────────────────

/** Execute a single JSON-RPC fetch against the given URL. */
async function rpcFetch(rpcUrl: string, method: string, params: unknown): Promise<unknown> {
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

/**
 * Fetch RPC list from ethereum-data API and find the first working one.
 * Returns the first URL that successfully responds to eth_chainId, or null.
 */
async function discoverFallbackRpc(chainId: number): Promise<string | null> {
  const apiUrl = `https://ethereum-data.awesometools.dev/chains/eip155-${chainId}.json`;

  let urls: string[];
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FALLBACK_TIMEOUT_MS);
    const res = await fetch(apiUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    urls = data.rpc;
    if (!Array.isArray(urls)) return null;
  } catch {
    return null;
  }

  // Filter: only HTTPS, no template variables, no WebSocket
  const candidates = urls.filter(
    (u: string) => u.startsWith('https://') && !u.includes('${'),
  );

  // Race: try candidates in parallel batches of 3, return first success
  for (let i = 0; i < candidates.length; i += 3) {
    const batch = candidates.slice(i, i + 3);
    const result = await Promise.any(
      batch.map(async (url) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FALLBACK_TIMEOUT_MS);
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
            signal: controller.signal,
          });
          clearTimeout(timer);
          if (!res.ok) throw new Error('bad status');
          const json = await res.json();
          if (json.error) throw new Error('rpc error');
          return url;
        } catch (err) {
          clearTimeout(timer);
          throw err;
        }
      }),
    ).catch(() => null);

    if (result) return result;
  }

  return null;
}
