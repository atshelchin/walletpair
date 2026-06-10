/**
 * EIP-1193 Provider — wraps a DAppSession for Ethereum/EVM dApps.
 *
 * Maps standard Ethereum JSON-RPC methods to WalletPair protocol requests.
 * Emits standard EIP-1193 events: connect, disconnect, chainChanged, accountsChanged.
 *
 * Usage:
 *   import { WalletPairProvider } from 'walletpair-sdk/evm'
 *   const provider = new WalletPairProvider({ session })
 */

import type { DAppSession } from '../dapp-session.js'
import { Emitter } from '../emitter.js'
import { type Capabilities, evmNumericChainId } from '../types.js'

// ---------------------------------------------------------------------------
// EIP-1193 types
// ---------------------------------------------------------------------------

export interface EIP1193RequestArgs {
  method: string
  params?: unknown[] | Record<string, unknown>
}

export interface EIP1193ProviderEvents {
  [key: string]: unknown
  connect: { chainId: string }
  disconnect: { code: number; message: string }
  chainChanged: string
  accountsChanged: string[]
  message: { type: string; data?: unknown | undefined }
}

export interface EIP1193Provider {
  request(args: EIP1193RequestArgs): Promise<unknown>
  on(event: string, handler: (...args: unknown[]) => void): void
  removeListener(event: string, handler: (...args: unknown[]) => void): void
}

// ---------------------------------------------------------------------------
// Method mapping: EVM JSON-RPC → WalletPair protocol methods
// ---------------------------------------------------------------------------

export interface MethodMapper {
  mapRequest(
    method: string,
    params?: unknown,
  ): { method: string; params?: unknown | undefined } | null
  mapResponse(method: string, result: unknown): unknown
}

/** Convert hex chainId "0x89" to CAIP-2 "eip155:137". */
function hexChainToCaip2(hex: string): string {
  return `eip155:${Number.parseInt(hex, 16)}`
}

/**
 * Validate the request carried a transaction object.
 *
 * `chainId` is intentionally NOT required: many dApps (e.g. PancakeSwap) switch
 * networks first via `wallet_switchEthereumChain` and then send
 * `eth_sendTransaction` WITHOUT an embedded `tx.chainId`, relying on the
 * wallet's active chain — exactly like MetaMask. The provider fills the missing
 * chainId from the current session chain in `request()` before relaying, so the
 * wallet still receives a complete, chain-consistent transaction.
 */
function validateTxObject(tx: Record<string, unknown> | undefined): void {
  if (!tx || typeof tx !== 'object') {
    throw Object.assign(new Error('Missing required transaction object'), { code: -32602 })
  }
}

const defaultMapper: MethodMapper = {
  mapRequest(method, params) {
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return { method: 'wallet_getAccounts' }
      case 'personal_sign': {
        // personal_sign params: [message, address] where message is hex-encoded bytes
        const p = params as [string, string] | undefined
        const msg = p?.[0]
        // EIP-1193 personal_sign: message is always hex-encoded bytes.
        // Decode hex to UTF-8 text and route to wallet_signMessage.
        let text = msg ?? ''
        if (msg?.startsWith('0x')) {
          try {
            const hex = msg.slice(2)
            const bytes = new Uint8Array(hex.length / 2)
            for (let i = 0; i < bytes.length; i++) {
              bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
            }
            text = new TextDecoder().decode(bytes)
          } catch {
            text = msg
          }
        }
        return { method: 'wallet_signMessage', params: { message: text, address: p?.[1] } }
      }
      // v4 is a superset of v3; both map to wallet_signTypedData (params:
      // [address, typedDataJSON]). The wallet renders/validates per its own
      // rules. Mapping v3 here removes the inconsistency of declaring it in
      // WALLET_METHODS but returning null (which threw 4200 Unsupported).
      case 'eth_signTypedData_v3':
      case 'eth_signTypedData_v4': {
        // params: [address, typedDataJSON]
        const p = params as [string, string] | undefined
        let typedData: unknown
        try {
          typedData = typeof p?.[1] === 'string' ? JSON.parse(p[1]) : p?.[1]
        } catch {
          typedData = p?.[1]
        }
        return { method: 'wallet_signTypedData', params: { address: p?.[0], typedData } }
      }
      case 'eth_sendTransaction': {
        // params: [txObject] — maps to wallet_sendTransaction (sign + broadcast)
        const p = params as [Record<string, unknown>] | undefined
        const tx = p?.[0]
        validateTxObject(tx)
        return { method: 'wallet_sendTransaction', params: { address: tx?.from, tx } }
      }
      case 'eth_signTransaction': {
        // params: [txObject] — maps to wallet_signTransaction (sign only)
        const p = params as [Record<string, unknown>] | undefined
        const tx = p?.[0]
        validateTxObject(tx)
        return { method: 'wallet_signTransaction', params: { address: tx?.from, tx } }
      }
      case 'wallet_switchEthereumChain': {
        // params: [{ chainId: "0x89" }] — convert hex to CAIP-2
        const p = params as [{ chainId: string }] | undefined
        const hexId = p?.[0]?.chainId
        return {
          method: 'wallet_switchChain',
          params: { chain: hexId ? hexChainToCaip2(hexId) : undefined },
        }
      }
      case 'wallet_sendCalls': {
        // EIP-5792: params[0] = { calls: [...], chainId, from, ... }
        // Forward as wallet_sendCalls with the full payload
        const p = params as [Record<string, unknown>] | undefined
        return { method: 'wallet_sendCalls', params: p?.[0] ?? {} }
      }
      case 'wallet_getCallsStatus': {
        // EIP-5792: params[0] = batch id. Only the wallet that submitted the
        // batch can resolve its status, so forward over the channel as-is.
        const p = params as [string] | undefined
        return { method: 'wallet_getCallsStatus', params: p?.[0] }
      }
      case 'wallet_addEthereumChain':
        return null // unsupported — mapRequest returning null triggers unsupported_method error
      default:
        return null // unknown method — routed to rpcProvider or rejected before reaching here
    }
  },
  mapResponse(method, result) {
    // Unwrap wallet_getAccounts result to EIP-1193 format (string[])
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
      const r = result as { accounts?: { address: string }[] } | undefined
      if (r?.accounts) return r.accounts.map((a) => a.address)
    }
    // Unwrap wallet_sendTransaction result
    if (method === 'eth_sendTransaction') {
      const r = result as { txHash?: string } | undefined
      if (r?.txHash) return r.txHash
    }
    // Unwrap wallet_signTransaction result
    if (method === 'eth_signTransaction') {
      const r = result as { signedTx?: string } | undefined
      if (r?.signedTx) return r.signedTx
    }
    // Unwrap signature results
    if (
      method === 'personal_sign' ||
      method === 'eth_signTypedData_v4' ||
      method === 'eth_signTypedData_v3'
    ) {
      const r = result as { signature?: string } | undefined
      if (r?.signature) return r.signature
    }
    // EIP-5792 wallet_sendCalls returns an object `{ id, capabilities? }` — NOT a
    // bare string (that was the pre-2.0.0 draft). Return the wallet's object as-is.
    // For resilience against wallets that still answer with a bare id string,
    // normalize that to the spec object shape.
    if (method === 'wallet_sendCalls') {
      if (typeof result === 'string') return { id: result }
      return result
    }
    return result
  },
}

// ---------------------------------------------------------------------------
// RPC routing: wallet methods vs read-only RPC
// ---------------------------------------------------------------------------

/** Methods that MUST go through WalletPair (require wallet signing/authorization). */
const WALLET_METHODS = new Set([
  'eth_requestAccounts',
  'eth_accounts',
  'personal_sign',
  'eth_signTypedData_v4',
  'eth_signTypedData_v3',
  'eth_sendTransaction',
  'eth_signTransaction',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
  'wallet_sendCalls',
  'wallet_getCallsStatus',
])

/** Methods handled locally by the provider (no RPC or WalletPair needed). */
const LOCAL_METHODS = new Set(['eth_chainId', 'net_version', 'wallet_getCapabilities'])

/**
 * Pure read-only, chain-state methods that are identical from any RPC endpoint.
 * These are served on the dApp side (rpcProvider → wallet rpcUrls → ethereum-data
 * fallback) and NEVER relayed to the wallet, so a dApp polling reads in a tight
 * loop cannot occupy the wallet's 32-slot request channel and starve the user's
 * signing requests.
 *
 * Deliberately excluded:
 *  - eth_chainId / net_version / eth_accounts: WALLET state, not chain state.
 *  - eth_getCode for the wallet's OWN counterfactual address: needs the wallet's
 *    advertised Safe-proxy bytecode override (handled separately before this set).
 *  - filter methods (eth_newFilter / eth_getFilterChanges / eth_uninstallFilter)
 *    and eth_subscribe: stateful per-connection, cannot survive endpoint failover.
 */
const READ_ONLY_METHODS = new Set([
  'eth_call',
  'eth_getBalance',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getProof',
  'eth_getTransactionCount',
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getBlockTransactionCountByNumber',
  'eth_getBlockTransactionCountByHash',
  'eth_getBlockReceipts',
  'eth_getTransactionByHash',
  'eth_getTransactionByBlockHashAndIndex',
  'eth_getTransactionByBlockNumberAndIndex',
  'eth_getTransactionReceipt',
  'eth_getLogs',
  'eth_estimateGas',
  'eth_createAccessList',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
])

/** Default ethereum-data service for public RPC endpoint discovery by chain id. */
const DEFAULT_ETHEREUM_DATA_URL = 'https://ethereum-data.awesometools.dev'

/** Cap how many endpoints we try per read-only call to bound revert/failure latency. */
const MAX_RPC_FAILOVER_ENDPOINTS = 4

/**
 * JSON-RPC error codes that warrant trying another endpoint rather than treating
 * the error as definitive: rate limits (-32005) and transient server/internal
 * errors. Every other coded error (e.g. execution revert code 3, invalid params)
 * is a definitive node answer and must NOT be masked by failover.
 */
const TRANSIENT_RPC_CODES = new Set([-32005, -32603, -32097, -32098, 429])

/** Parse a chain-id key in numeric, 0x-hex, or CAIP-2 'eip155:N' form. */
function parseChainKey(key: string): number | null {
  let n: number
  if (key.startsWith('eip155:')) n = Number.parseInt(key.slice(7), 10)
  else if (key.startsWith('0x')) n = Number.parseInt(key, 16)
  else n = Number.parseInt(key, 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Normalize a constructor rpcUrls record into a chainId → url[] map. */
function normalizeRpcUrls(
  input: Record<string, string | string[]> | undefined,
): Map<number, string[]> {
  const map = new Map<number, string[]>()
  if (!input) return map
  for (const [key, value] of Object.entries(input)) {
    const chainId = parseChainKey(key)
    if (chainId == null) continue
    const urls = (Array.isArray(value) ? value : [value]).filter(
      (u): u is string => typeof u === 'string' && u.length > 0,
    )
    if (urls.length > 0) map.set(chainId, [...(map.get(chainId) ?? []), ...urls])
  }
  return map
}

/**
 * An RPC provider that handles read-only Ethereum JSON-RPC calls.
 * Pass any EIP-1193-compatible provider, or a simple fetch-based JSON-RPC client.
 */
export interface RpcProvider {
  request(args: EIP1193RequestArgs): Promise<unknown>
}

// ---------------------------------------------------------------------------
// Built-in JSON-RPC proxy (used when no external rpcProvider is supplied)
// ---------------------------------------------------------------------------

const RPC_TIMEOUT_MS = 30_000
const RPC_MAX_RESPONSE_BYTES = 2 * 1024 * 1024

async function jsonRpcFetch(
  url: string,
  method: string,
  params: unknown,
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? [] }),
      signal: controller.signal,
    })
    const contentLength = res.headers.get('content-length')
    if (contentLength && Number.parseInt(contentLength, 10) > RPC_MAX_RESPONSE_BYTES) {
      throw new Error('RPC response too large')
    }
    const json = (await res.json()) as { result?: unknown; error?: { code: number; message: string } }
    if (json.error) {
      throw Object.assign(new Error(json.error.message), { code: json.error.code })
    }
    return json.result
  } finally {
    clearTimeout(timer)
  }
}

/** Thrown when every candidate endpoint failed at the transport level (not a node-level JSON-RPC error). */
class RpcEndpointsUnavailable extends Error {}

/**
 * Try each endpoint in order until one answers. A node-level JSON-RPC error that
 * is a definitive answer (e.g. an eth_call revert) is rethrown immediately —
 * retrying other endpoints would only mask it. Transport/network failures advance
 * to the next endpoint; if all fail, throw RpcEndpointsUnavailable so the caller
 * can fall back (e.g. to the wallet relay).
 */
async function jsonRpcFetchFailover(
  endpoints: string[],
  method: string,
  params: unknown,
): Promise<unknown> {
  let lastErr: unknown
  for (const url of endpoints) {
    try {
      return await jsonRpcFetch(url, method, params)
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : undefined
      // A JSON-RPC error carrying a numeric code is a definitive node answer
      // (e.g. an execution revert) and must not be masked by trying another
      // endpoint — unless it is a known transient/rate-limit code. Errors with no
      // code are transport failures (timeout, bad gateway, DNS) → try the next.
      if (typeof code === 'number' && !TRANSIENT_RPC_CODES.has(code)) {
        throw err
      }
      lastErr = err
    }
  }
  throw new RpcEndpointsUnavailable(lastErr instanceof Error ? lastErr.message : 'All RPC endpoints failed')
}

// ---------------------------------------------------------------------------
// WalletPairProvider
// ---------------------------------------------------------------------------

export interface WalletPairProviderOptions {
  session: DAppSession
  /** Initial EVM chain ID (numeric). Default 1 (mainnet). */
  chainId?: number | undefined
  /** Custom method mapper. */
  mapper?: MethodMapper | undefined
  /**
   * Optional RPC provider for read-only methods (eth_call, eth_getBalance,
   * eth_blockNumber, etc.). If provided, it takes precedence over `rpcUrls`,
   * wallet-advertised rpcUrls, and the ethereum-data fallback for every
   * read-only call.
   */
  rpcProvider?: RpcProvider | undefined
  /**
   * Static RPC endpoints for read-only methods, keyed by chain id (numeric,
   * '0x..' hex, or CAIP-2 'eip155:..'); each value is a URL or list of URLs
   * tried in order. Takes precedence over wallet-advertised rpcUrls. Lets a dApp
   * fully own read-only RPC so polling reads never touch the wallet.
   */
  rpcUrls?: Record<string, string | string[]> | undefined
  /**
   * Base URL of the ethereum-data service used to discover public RPC endpoints
   * for chains not covered by `rpcUrls` or the wallet's advertised rpcUrls.
   * Defaults to https://ethereum-data.awesometools.dev. Pass null to disable the
   * fallback (read-only calls then relay to the wallet when no endpoint is known).
   */
  ethereumDataUrl?: string | null | undefined
}

export class WalletPairProvider implements EIP1193Provider {
  private session: DAppSession
  private mapper: MethodMapper
  private rpcProvider: RpcProvider | undefined
  private staticRpcUrls: Map<number, string[]>
  private ethereumDataBaseUrl: string
  private rpcUrlCache = new Map<number, string[]>()
  private rpcFetchInFlight = new Map<number, Promise<string[]>>()
  private emitter = new Emitter<EIP1193ProviderEvents>()
  private chainId: number
  private accounts: string[] = []
  private connected = false
  private disconnected = false

  constructor(options: WalletPairProviderOptions) {
    this.session = options.session
    this.mapper = options.mapper ?? defaultMapper
    this.rpcProvider = options.rpcProvider
    this.staticRpcUrls = normalizeRpcUrls(options.rpcUrls)
    // undefined → default service; null/'' → disabled (relay fallback only).
    this.ethereumDataBaseUrl = (
      options.ethereumDataUrl === undefined ? DEFAULT_ETHEREUM_DATA_URL : (options.ethereumDataUrl ?? '')
    ).replace(/\/+$/, '')
    this.chainId = options.chainId ?? 1

    // Read-only RPC endpoints are resolved lazily per request (constructor rpcUrls
    // → wallet-advertised capabilities.rpcUrls → ethereum-data fallback), so there
    // is no walletJoined race: a read that arrives before the wallet's capabilities
    // still resolves correctly once they land, and reads never block on the wallet.

    this.session.on('phase', (phase) => {
      if (phase === 'connected' && !this.connected) {
        this.connected = true
        this.emitter.emit('connect', { chainId: `0x${this.chainId.toString(16)}` })
      } else if ((phase === 'closed' || phase === 'disconnected') && this.connected) {
        this.connected = false
        this.emitter.emit('disconnect', { code: 4900, message: 'Disconnected' })
      }
    })

    this.session.on('event', ({ event, data }) => {
      if (event === 'disconnect') {
        this.connected = false
        this.disconnected = true
        const d = data as Record<string, unknown>
        const reason = String(d?.reason ?? 'unknown')
        const msg =
          typeof d?.message === 'string' ? d.message : `Disconnected by wallet (${reason})`
        this.emitter.emit('disconnect', { code: 4900, message: msg })
        this.session.close('normal')
        return
      }
      if (event === 'accountsChanged') {
        // Handle both formats:
        // - Simple: { accounts: ['0x...'] } or just ['0x...']
        // - Sub-protocol: { accounts: [{ address: '0x...', chains?: [...] }] }
        const payload = data as { accounts?: (string | { address: string })[] } | string[]
        const rawAccounts = Array.isArray(payload) ? payload : payload?.accounts
        if (Array.isArray(rawAccounts)) {
          this.accounts = rawAccounts.map((a: string | { address: string }) =>
            typeof a === 'string' ? a : a.address,
          )
          this.emitter.emit('accountsChanged', this.accounts)
        }
      } else if (event === 'chainChanged') {
        // Handle multiple formats:
        // - { chainId: 'eip155:137' } or { chainId: '0x89' } or { chainId: 137 }
        // - { chain: 'eip155:137' }
        // - raw string 'eip155:137' or '0x89'
        const raw =
          typeof data === 'object' && data !== null
            ? ((data as Record<string, unknown>).chainId ?? (data as Record<string, unknown>).chain)
            : data
        let newChainId: number | null = null
        if (typeof raw === 'string') {
          if (raw.startsWith('eip155:')) {
            newChainId = evmNumericChainId(raw)
          } else if (raw.startsWith('0x')) {
            newChainId = Number.parseInt(raw, 16)
          } else {
            newChainId = Number.parseInt(raw, 10) || null
          }
        } else if (typeof raw === 'number') {
          newChainId = raw
        }
        if (newChainId != null && newChainId !== this.chainId) {
          this.chainId = newChainId
          this.emitter.emit('chainChanged', `0x${newChainId.toString(16)}`)
        }
      }
    })
  }

  async request(args: EIP1193RequestArgs): Promise<unknown> {
    if (this.disconnected) {
      throw Object.assign(new Error('Provider is disconnected'), { code: 4900 })
    }

    const { method, params } = args

    // eth_sign is deprecated and dangerous (signs arbitrary 32-byte digests).
    // Reject it explicitly with 4200 instead of relaying it to the wallet, where
    // it has no mapping and would hang until the request timeout.
    if (method === 'eth_sign') {
      throw Object.assign(
        new Error('eth_sign is unsupported (deprecated/unsafe); use personal_sign or eth_signTypedData_v4'),
        { code: 4200 },
      )
    }

    if (method === 'eth_chainId') {
      return `0x${this.chainId.toString(16)}`
    }
    if (method === 'net_version') {
      return String(this.chainId)
    }
    if (method === 'wallet_getCapabilities') {
      // EIP-5792 params: [address, [chainIds]?]. When the dApp passes a chain
      // filter, return only those chains (matched by numeric value so hex casing
      // / leading zeros don't matter). No filter → return the full record.
      const all = this.session.walletCapabilities?.walletCapabilities ?? {}
      const filter = (params as [unknown, unknown] | undefined)?.[1]
      if (Array.isArray(filter) && filter.length > 0) {
        // Filter values may arrive as numbers, hex strings, or decimal strings;
        // normalize all of them (and the hex capability keys) to a numeric chainId.
        const wanted = new Set(
          filter.map((c) => parseChainKey(String(c))).filter((n): n is number => n != null),
        )
        const out: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(all)) {
          const cid = parseChainKey(key)
          if (cid != null && wanted.has(cid)) out[key] = value
        }
        return out
      }
      return all
    }

    // eth_accounts returns already-authorized accounts; serve from the local cache
    // (kept fresh by accountsChanged + eth_requestAccounts) so dApps that poll it
    // don't occupy the wallet's request channel. Falls through to the wallet on a
    // cold cache so the first read is always authoritative.
    if (method === 'eth_accounts' && this.accounts.length > 0) {
      return this.accounts
    }

    // Counterfactual smart-account override: if the wallet advertised
    // contractBytecode and the dApp queries eth_getCode for the connected
    // account, return that bytecode when the account isn't deployed yet, so
    // dApps detect a smart contract wallet (EIP-1271) instead of an EOA.
    if (method === 'eth_getCode') {
      const caps = this.session.walletCapabilities as unknown as { contractBytecode?: string } | undefined
      const target = (params as [string] | undefined)?.[0]?.toLowerCase()
      const self = this.accounts[0]?.toLowerCase()
      if (caps?.contractBytecode && target && self && target === self) {
        let real: unknown
        try {
          real = await this.serveReadOnly(args)
        } catch {
          real = '0x'
        }
        if (typeof real === 'string' && real !== '0x' && real.length > 2) return real
        return caps.contractBytecode
      }
    }

    // Pure read-only chain-state methods are served on the dApp side and never
    // relayed to the wallet (see READ_ONLY_METHODS), so a flood of polling reads
    // can't fill the wallet's 32-slot request channel and starve the user's
    // signing confirmation.
    if (READ_ONLY_METHODS.has(method)) {
      return this.serveReadOnly(args)
    }

    // Route remaining non-wallet methods: try explicit local RPC, then relay.
    if (!WALLET_METHODS.has(method) && !LOCAL_METHODS.has(method)) {
      if (this.rpcProvider) {
        return this.rpcProvider.request(args)
      }
      // No local RPC — forward through relay to wallet
      return this.session.request(method, params ?? [])
    }

    const mapped = this.mapper.mapRequest(method, params)
    if (!mapped) {
      throw Object.assign(new Error(`Unsupported method: ${method}`), { code: 4200 })
    }

    // Inject chain for methods that require it per EVM sub-protocol
    const chainRequiredMethods = [
      'wallet_signMessage',
      'wallet_signTypedData',
      'wallet_signTransaction',
      'wallet_sendTransaction',
      'wallet_getAccounts',
    ]
    if (
      mapped.params &&
      typeof mapped.params === 'object' &&
      chainRequiredMethods.includes(mapped.method)
    ) {
      const p = mapped.params as Record<string, unknown>
      // Reconcile a transaction's embedded chainId with the session chain.
      // dApps that switch networks first (wallet_switchEthereumChain) often omit
      // tx.chainId and rely on the wallet's active chain. Honor the embedded
      // chainId when present; otherwise fill it from the current session chain
      // so the wallet always receives a complete, chain-consistent tx. The
      // top-level `chain` param is then derived from the resolved chainId so the
      // two never disagree (EVM sub-protocol §6.2: tx.chainId MUST match chain).
      let chainNum = this.chainId
      if (
        (mapped.method === 'wallet_sendTransaction' ||
          mapped.method === 'wallet_signTransaction') &&
        p.tx &&
        typeof p.tx === 'object'
      ) {
        const tx = p.tx as Record<string, unknown>
        if (tx.chainId === undefined || tx.chainId === null || tx.chainId === '') {
          tx.chainId = `0x${this.chainId.toString(16)}`
        } else {
          const raw = tx.chainId
          const parsed =
            typeof raw === 'string'
              ? Number.parseInt(raw, raw.startsWith('0x') ? 16 : 10)
              : Number(raw)
          if (Number.isFinite(parsed) && parsed > 0) chainNum = parsed
        }
      }
      if (!p.chain) {
        p.chain = `eip155:${chainNum}`
      }
    }

    const result = await this.session.request(mapped.method, mapped.params)
    const mappedResult = this.mapper.mapResponse(method, result)

    if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
      if (Array.isArray(mappedResult)) this.accounts = mappedResult
    }

    // A resolved (non-throwing) wallet_switchEthereumChain means the wallet switched
    // (EIP-3326). Sync chainId optimistically so a follow-up eth_chainId reflects the
    // new chain immediately instead of racing the wallet's chainChanged event — viem/
    // wagmi read the chain right after switching and report "network mismatch" if the
    // event hasn't arrived yet. The wallet's later chainChanged is de-duped by the
    // `newChainId !== this.chainId` guard in the event handler.
    if (method === 'wallet_switchEthereumChain') {
      const p = params as [{ chainId?: string }] | undefined
      const target = p?.[0]?.chainId ? Number.parseInt(p[0].chainId, 16) : Number.NaN
      if (!Number.isNaN(target) && target !== this.chainId) {
        this.chainId = target
        this.emitter.emit('chainChanged', `0x${target.toString(16)}`)
      }
    }

    return mappedResult
  }

  // biome-ignore lint/suspicious/noExplicitAny: EIP-1193 interface requires generic handler signature
  on(event: string, handler: (...args: any[]) => void): void {
    this.emitter.on(event as keyof EIP1193ProviderEvents, handler as (data: unknown) => void)
  }

  // biome-ignore lint/suspicious/noExplicitAny: EIP-1193 interface requires generic handler signature
  removeListener(event: string, handler: (...args: any[]) => void): void {
    this.emitter.off(event as keyof EIP1193ProviderEvents, handler as (data: unknown) => void)
  }

  getChainId(): string {
    return `0x${this.chainId.toString(16)}`
  }

  getAccounts(): string[] {
    return this.accounts
  }

  isConnected(): boolean {
    return this.connected
  }

  getSession(): DAppSession {
    return this.session
  }

  /**
   * Serve a read-only method on the dApp side, never relaying it to the wallet
   * unless no endpoint is known at all. Order: explicit rpcProvider → resolved
   * endpoints (constructor rpcUrls → wallet rpcUrls → ethereum-data) → wallet relay.
   */
  private async serveReadOnly(args: EIP1193RequestArgs): Promise<unknown> {
    if (this.rpcProvider) return this.rpcProvider.request(args)
    const endpoints = await this.resolveEndpoints(this.chainId)
    if (endpoints.length > 0) {
      try {
        return await jsonRpcFetchFailover(endpoints, args.method, args.params)
      } catch (err) {
        // A definitive node answer (e.g. revert) propagates; only total transport
        // failure across every endpoint falls through to the wallet relay.
        if (!(err instanceof RpcEndpointsUnavailable)) throw err
      }
    }
    return this.session.request(args.method, args.params ?? [])
  }

  /**
   * Resolve read-only RPC endpoints for a chain, preferring dApp-configured URLs,
   * then the wallet's advertised rpcUrls, then the ethereum-data service. Results
   * from the network fallback are cached per chain and de-duplicated single-flight.
   */
  private async resolveEndpoints(chainId: number): Promise<string[]> {
    const out: string[] = []
    const seen = new Set<string>()
    const add = (u: string) => {
      if (u && !seen.has(u)) {
        seen.add(u)
        out.push(u)
      }
    }
    for (const u of this.staticRpcUrls.get(chainId) ?? []) add(u)
    for (const u of this.walletRpcUrlsForChain(chainId)) add(u)
    if (out.length > 0) return out.slice(0, MAX_RPC_FAILOVER_ENDPOINTS)

    const cached = this.rpcUrlCache.get(chainId)
    if (cached) return cached.slice(0, MAX_RPC_FAILOVER_ENDPOINTS)
    if (!this.ethereumDataBaseUrl) return []

    let inflight = this.rpcFetchInFlight.get(chainId)
    if (!inflight) {
      inflight = this.fetchEthereumDataRpc(chainId)
        .then((urls) => {
          // Only cache a non-empty result — caching [] from a transient outage
          // would permanently disable this chain's fallback.
          if (urls.length > 0) this.rpcUrlCache.set(chainId, urls)
          this.rpcFetchInFlight.delete(chainId)
          return urls
        })
        .catch(() => {
          this.rpcFetchInFlight.delete(chainId)
          return [] as string[]
        })
      this.rpcFetchInFlight.set(chainId, inflight)
    }
    const fetched = await inflight
    return fetched.slice(0, MAX_RPC_FAILOVER_ENDPOINTS)
  }

  /** Single HTTPS RPC URL the wallet advertised for a chain, if any. */
  private walletRpcUrlsForChain(chainId: number): string[] {
    const caps = this.session.walletCapabilities as Capabilities | undefined
    const urls = caps?.rpcUrls
    if (!urls) return []
    const u = urls[String(chainId)] ?? urls[`eip155:${chainId}`]
    return u ? [u] : []
  }

  /** Look up public HTTPS RPC endpoints for a chain from the ethereum-data service. */
  private async fetchEthereumDataRpc(chainId: number): Promise<string[]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS)
    try {
      const res = await fetch(`${this.ethereumDataBaseUrl}/chains/eip155-${chainId}.json`, {
        signal: controller.signal,
      })
      if (!res.ok) return []
      const data = (await res.json()) as { rpc?: unknown }
      if (!Array.isArray(data.rpc)) return []
      return data.rpc.filter(
        (u): u is string =>
          typeof u === 'string' &&
          u.startsWith('https://') &&
          !u.includes('${') &&
          !u.includes('API_KEY'),
      )
    } catch {
      return []
    } finally {
      clearTimeout(timer)
    }
  }
}
