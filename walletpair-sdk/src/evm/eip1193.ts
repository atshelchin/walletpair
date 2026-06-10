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
import { evmNumericChainId } from '../types.js'

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

/** Validate that a transaction object contains all required fields. */
function validateTxFields(tx: Record<string, unknown> | undefined): void {
  const required = ['chainId']
  const missing = required.filter((f) => tx?.[f] === undefined || tx?.[f] === null)
  if (missing.length > 0) {
    throw Object.assign(new Error(`Missing required transaction fields: ${missing.join(', ')}`), {
      code: -32602,
    })
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
        validateTxFields(tx)
        return { method: 'wallet_sendTransaction', params: { address: tx?.from, tx } }
      }
      case 'eth_signTransaction': {
        // params: [txObject] — maps to wallet_signTransaction (sign only)
        const p = params as [Record<string, unknown>] | undefined
        const tx = p?.[0]
        validateTxFields(tx)
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
    if (method === 'personal_sign' || method === 'eth_signTypedData_v4') {
      const r = result as { signature?: string } | undefined
      if (r?.signature) return r.signature
    }
    // Unwrap wallet_sendCalls result → EIP-5792 expects { id: "0x..." }
    if (method === 'wallet_sendCalls') {
      const r = result as { id?: string } | undefined
      if (r?.id) return r.id
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
   * eth_blockNumber, etc.). If provided, any method not handled by WalletPair
   * is routed here instead of being sent to the wallet. If omitted, unknown
   * methods throw unsupported_method (4200).
   */
  rpcProvider?: RpcProvider | undefined
}

export class WalletPairProvider implements EIP1193Provider {
  private session: DAppSession
  private mapper: MethodMapper
  private rpcProvider: RpcProvider | undefined
  private emitter = new Emitter<EIP1193ProviderEvents>()
  private chainId: number
  private accounts: string[] = []
  private connected = false
  private disconnected = false

  constructor(options: WalletPairProviderOptions) {
    this.session = options.session
    this.mapper = options.mapper ?? defaultMapper
    this.rpcProvider = options.rpcProvider
    this.chainId = options.chainId ?? 1

    // Auto-construct RPC proxy from wallet-provided rpcUrls when no explicit rpcProvider
    if (!this.rpcProvider) {
      this.session.on('walletJoined', ({ capabilities }) => {
        if (capabilities?.rpcUrls && !this.rpcProvider) {
          this.rpcProvider = this.buildAutoRpcProvider(capabilities.rpcUrls)
        }
      })
    }

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

    if (method === 'eth_chainId') {
      return `0x${this.chainId.toString(16)}`
    }
    if (method === 'net_version') {
      return String(this.chainId)
    }
    if (method === 'wallet_getCapabilities') {
      return this.session.walletCapabilities?.walletCapabilities ?? {}
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
          real = this.rpcProvider
            ? await this.rpcProvider.request(args)
            : await this.session.request(method, params ?? [])
        } catch {
          real = '0x'
        }
        if (typeof real === 'string' && real !== '0x' && real.length > 2) return real
        return caps.contractBytecode
      }
    }

    // Route non-wallet methods: try local RPC, then relay to wallet
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
      if (!p.chain) {
        p.chain = `eip155:${this.chainId}`
      }
    }

    const result = await this.session.request(mapped.method, mapped.params)
    const mappedResult = this.mapper.mapResponse(method, result)

    if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
      if (Array.isArray(mappedResult)) this.accounts = mappedResult
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
   * Build an RPC provider from wallet-provided rpcUrls.
   * Resolves the RPC URL dynamically based on current chainId.
   */
  private buildAutoRpcProvider(rpcUrls: Record<string, string>): RpcProvider {
    return {
      request: async (requestArgs: EIP1193RequestArgs) => {
        const url = rpcUrls[String(this.chainId)] ?? rpcUrls[`eip155:${this.chainId}`]
        if (!url) {
          // No RPC for this chain — fall through to relay
          return this.session.request(requestArgs.method, requestArgs.params ?? [])
        }
        return jsonRpcFetch(url, requestArgs.method, requestArgs.params)
      },
    }
  }
}
