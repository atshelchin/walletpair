/**
 * E2E robustness / stress test: a real dApp (WalletPairProvider) talking to a
 * realistic simulated wallet (WalletSession) over a relay, exercised under load.
 *
 * Runs the SAME scenario suite over two transports:
 *   1. MockRelay      — in-memory, deterministic, always runs (the CI core).
 *   2. Live CF relay  — real WebSockets to wss://relay.walletpair.org/v1, run
 *                       when the relay's /healthz is reachable. Override the URL
 *                       with WALLETPAIR_RELAY_URL; force-skip with
 *                       WALLETPAIR_E2E_LIVE=0.
 *
 * The headline scenario models Uniswap-style behaviour: a dApp that continuously
 * polls read-only RPC (eth_call/eth_getBalance/eth_blockNumber/eth_getLogs) while
 * the user signs messages and sends transactions. The robustness property under
 * test: read-only polling is served on the dApp side and NEVER reaches the wallet
 * or occupies the relay channel, so signing requests are never starved or
 * rate-limited by read traffic.
 */
import { describe, expect, it } from 'vitest'
import { DAppSession } from '../dapp-session.js'
import { MockRelay, MockTransport } from '../test-helpers.js'
import { WalletSession } from '../wallet-session.js'
import { WebSocketTransport } from '../ws-transport.js'
import { WalletPairProvider } from './eip1193.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RELAY_URL = process.env.WALLETPAIR_RELAY_URL ?? 'wss://relay.walletpair.org/v1'
const WALLET_ADDR = '0x1111111111111111111111111111111111111111'

/** Derive the http(s) origin of a ws(s) relay URL for the /healthz probe. */
function healthzUrl(wsUrl: string): string {
  const u = new URL(wsUrl)
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'
  u.pathname = '/healthz'
  u.search = ''
  return u.toString()
}

// Probe the live relay once at module load so we can skip the live suite when
// offline (rather than hard-failing). Top-level await is fine under vitest ESM.
let LIVE_OK = false
if (process.env.WALLETPAIR_E2E_LIVE !== '0') {
  try {
    const res = await fetch(healthzUrl(RELAY_URL), { signal: AbortSignal.timeout(6000) })
    LIVE_OK = res.ok
  } catch {
    LIVE_OK = false
  }
}

// --- Real mainnet read targets (for the "real on-chain data" live scenarios) ---
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' // mainnet USDC, decimals() == 6
const USDC_DECIMALS_CALLDATA = '0x313ce567' // decimals()
const ETHEREUM_DATA_URL = 'https://ethereum-data.awesometools.dev'
const PUBLIC_RPCS = [
  'https://ethereum-rpc.publicnode.com',
  'https://eth.llamarpc.com',
  'https://cloudflare-eth.com',
  'https://eth.drpc.org',
]

async function probeBlockNumber(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      signal: AbortSignal.timeout(6000),
    })
    const json = (await res.json()) as { result?: unknown }
    return typeof json.result === 'string' && json.result.startsWith('0x')
  } catch {
    return false
  }
}

// Probe real RPC + ethereum-data reachability so the on-chain scenarios skip
// cleanly (rather than flaking) when public infra is briefly unavailable.
let REACHABLE_RPCS: string[] = []
let ETH_DATA_OK = false
if (LIVE_OK) {
  REACHABLE_RPCS = (await Promise.all(PUBLIC_RPCS.map(async (u) => ((await probeBlockNumber(u)) ? u : null)))).filter(
    (u): u is string => u != null,
  )
  try {
    const res = await fetch(`${ETHEREUM_DATA_URL}/chains/eip155-1.json`, { signal: AbortSignal.timeout(6000) })
    const json = (await res.json()) as { rpc?: unknown }
    ETH_DATA_OK = Array.isArray(json.rpc) && json.rpc.length > 0
  } catch {
    ETH_DATA_OK = false
  }
}
const REAL_RPC_OK = REACHABLE_RPCS.length > 0

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitUntil(fn: () => boolean, { timeout = 15000, interval = 20 } = {}): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('waitUntil: timeout')
    await delay(interval)
  }
}

const TYPED_DATA = {
  domain: { name: 'Stress', version: '1', chainId: 1, verifyingContract: WALLET_ADDR },
  types: { EIP712Domain: [{ name: 'name', type: 'string' }], Msg: [{ name: 'n', type: 'uint256' }] },
  primaryType: 'Msg',
  message: { n: 1 },
}

/** Canned dApp-side read results — stands in for the dApp's own RPC node. */
function readResultFor(method: string): unknown {
  switch (method) {
    case 'eth_blockNumber':
      return '0x112a880'
    case 'eth_gasPrice':
      return '0x3b9aca00'
    case 'eth_getBalance':
      return '0xde0b6b3a7640000'
    case 'eth_getLogs':
      return []
    case 'eth_call':
      return `0x${'00'.repeat(32)}`
    default:
      return '0x'
  }
}

function paramsFor(method: string): unknown[] {
  switch (method) {
    case 'eth_call':
      return [{ to: '0x2222222222222222222222222222222222222222', data: '0x70a08231' }, 'latest']
    case 'eth_getBalance':
      return [WALLET_ADDR, 'latest']
    case 'eth_getLogs':
      return [{ fromBlock: 'latest', toBlock: 'latest' }]
    default:
      return []
  }
}

interface WalletStats {
  reqByMethod: Record<string, number>
  signLatencyMs: number
}

/** Attach a realistic wallet-app request handler with configurable signing latency. */
function attachSimulatedWallet(walletSession: WalletSession, signLatencyMs = 25): WalletStats {
  const stats: WalletStats = { reqByMethod: {}, signLatencyMs }
  // biome-ignore lint/suspicious/noExplicitAny: test handler
  walletSession.on('request', async ({ id, method, params }: any) => {
    stats.reqByMethod[method] = (stats.reqByMethod[method] ?? 0) + 1
    try {
      switch (method) {
        case 'wallet_getAccounts':
          return walletSession.approve(id, [WALLET_ADDR])
        case 'wallet_signMessage':
          await delay(stats.signLatencyMs)
          return walletSession.approve(id, { signature: `0x${'ab'.repeat(65)}` })
        case 'wallet_signTypedData':
          await delay(stats.signLatencyMs)
          return walletSession.approve(id, { signature: `0x${'cd'.repeat(65)}` })
        case 'wallet_sendTransaction':
          await delay(stats.signLatencyMs * 2)
          return walletSession.approve(id, { txHash: `0x${'ef'.repeat(32)}` })
        case 'wallet_switchChain':
          walletSession.approve(id, { chain: (params as { chain: string }).chain })
          walletSession.pushEvent('chainChanged', { chain: (params as { chain: string }).chain })
          return
        case 'wallet_sendCalls':
          return walletSession.approve(id, { id: '0xbatch001' })
        case 'wallet_getCallsStatus':
          return walletSession.approve(id, { version: '2.0.0', id: '0xbatch001', chainId: '0x1', status: 200, atomic: true, receipts: [] })
        default:
          return walletSession.reject(id, 'unsupported_method', method)
      }
    } catch {
      return walletSession.reject(id, 'internal_error', 'handler failed')
    }
  })
  return stats
}

interface ReadProxy {
  request(args: { method: string; params?: unknown }): Promise<unknown>
}
interface ReadStats {
  calls: number
  byMethod: Record<string, number>
}

function makeReadProxy(): { proxy: ReadProxy; stats: ReadStats } {
  const stats: ReadStats = { calls: 0, byMethod: {} }
  const proxy: ReadProxy = {
    request: async ({ method }) => {
      stats.calls++
      stats.byMethod[method] = (stats.byMethod[method] ?? 0) + 1
      return readResultFor(method)
    },
  }
  return { proxy, stats }
}

interface Pair {
  provider: WalletPairProvider
  dapp: DAppSession
  walletSession: WalletSession
  walletStats: WalletStats
  readStats: ReadStats
  close: () => Promise<void>
}

type TransportPair = { dappTransport: MockTransport | WebSocketTransport; walletTransport: MockTransport | WebSocketTransport }

function mockTransports(): TransportPair {
  const dappTransport = new MockTransport()
  const walletTransport = new MockTransport()
  // MockRelay rewires send() on both to mimic the relay's create/join/accept/forward.
  new MockRelay(dappTransport, walletTransport)
  return { dappTransport, walletTransport }
}

function liveTransports(): TransportPair {
  return {
    dappTransport: new WebSocketTransport({ url: RELAY_URL }),
    walletTransport: new WebSocketTransport({ url: RELAY_URL }),
  }
}

/**
 * Read-serving configuration. Default (undefined) uses the canned dApp-side proxy
 * with NO network. Pass `rpcUrls` to serve reads from real public RPC endpoints,
 * or leave them unset with `ethereumDataUrl` to exercise the ethereum-data
 * endpoint-discovery fallback against real RPC.
 */
interface ReadConfig {
  chainId?: number
  rpcProvider?: ReadProxy
  rpcUrls?: Record<string, string | string[]>
  ethereumDataUrl?: string | null
}

/** Pair a real dApp provider with a simulated wallet over the given transport. */
async function connectPair(
  transports: TransportPair,
  opts: { connectTimeout: number; reads?: ReadConfig },
): Promise<Pair> {
  const { dappTransport, walletTransport } = transports
  const { proxy, stats: readStats } = makeReadProxy()
  const reads = opts.reads

  const dapp = new DAppSession({
    transport: dappTransport as never,
    meta: { name: 'Stress dApp', description: 'e2e', url: 'https://dapp.test', icon: 'https://dapp.test/i.png' },
  })
  const provider = new WalletPairProvider({
    session: dapp,
    chainId: reads?.chainId ?? 1,
    ...(reads
      ? // Real-read modes: serve from configured rpcUrls and/or the ethereum-data
        // fallback (ethereumDataUrl undefined → default service).
        { rpcProvider: reads.rpcProvider, rpcUrls: reads.rpcUrls, ethereumDataUrl: reads.ethereumDataUrl }
      : // Default: canned proxy, never touch the network for reads.
        { rpcProvider: proxy, ethereumDataUrl: null }),
  })

  const walletSession = new WalletSession({
    transport: walletTransport as never,
    capabilities: {
      methods: [
        'wallet_getAccounts',
        'wallet_signMessage',
        'wallet_signTypedData',
        'wallet_sendTransaction',
        'wallet_switchChain',
        'wallet_sendCalls',
        'wallet_getCallsStatus',
      ],
      events: ['accountsChanged', 'chainChanged'],
      chains: ['eip155:1', 'eip155:56', 'eip155:137'],
    },
    meta: { name: 'Stress Wallet', description: 'e2e', url: 'https://wallet.test', icon: 'https://wallet.test/i.png', address: WALLET_ADDR },
  })
  const walletStats = attachSimulatedWallet(walletSession)

  const uri = await dapp.createPairing()
  await walletSession.joinFromUri(uri)
  await waitUntil(() => dapp.phase === 'connected' && walletSession.phase === 'connected', { timeout: opts.connectTimeout })

  // Realistic first call — populates the account cache.
  const accounts = await provider.request({ method: 'eth_requestAccounts' })
  expect(accounts).toEqual([WALLET_ADDR])

  const close = async () => {
    try {
      dapp.close()
    } catch {
      /* ignore */
    }
    try {
      ;(walletSession as unknown as { close?: () => void }).close?.()
    } catch {
      /* ignore */
    }
    // Belt-and-suspenders: drop the underlying sockets so real WS handles don't
    // keep the test runner alive.
    try {
      ;(dappTransport as { disconnect?: () => void }).disconnect?.()
      ;(walletTransport as { disconnect?: () => void }).disconnect?.()
    } catch {
      /* ignore */
    }
    await delay(20)
  }

  return { provider, dapp, walletSession, walletStats, readStats, close }
}

// ---------------------------------------------------------------------------
// Scenario suite (transport-agnostic)
// ---------------------------------------------------------------------------

const READ_METHODS = ['eth_blockNumber', 'eth_call', 'eth_getBalance', 'eth_getLogs', 'eth_gasPrice', 'eth_call']

function defineSuite(
  label: string,
  makeTransports: () => TransportPair,
  scale: { floodMs: number; connectTimeout: number; retry: number },
) {
  describe(`E2E stress over ${label}`, () => {
    it(
      'Uniswap-style read flood is served dApp-side and never starves concurrent signing',
      { retry: scale.retry, timeout: scale.connectTimeout + 15000 },
      async () => {
        const pair = await connectPair(makeTransports(), { connectTimeout: scale.connectTimeout })
        try {
        const { provider, walletStats, readStats } = pair
        const readErrors: unknown[] = []

        // Background "Uniswap polling": fire batches of reads continuously.
        let flooding = true
        const floodLoop = (async () => {
          while (flooding) {
            await Promise.all(
              READ_METHODS.map((m) =>
                provider.request({ method: m, params: paramsFor(m) }).catch((e) => readErrors.push(e)),
              ),
            )
            await delay(3)
          }
        })()

        // Concurrently: the user signs messages / typed data / sends txs.
        const signs: Promise<unknown>[] = []
        const started = Date.now()
        for (let i = 0; i < 5; i++) {
          signs.push(provider.request({ method: 'personal_sign', params: [`0x${Buffer.from(`hi${i}`).toString('hex')}`, WALLET_ADDR] }))
          await delay(25)
        }
        for (let i = 0; i < 3; i++) {
          signs.push(provider.request({ method: 'eth_signTypedData_v4', params: [WALLET_ADDR, JSON.stringify(TYPED_DATA)] }))
          await delay(25)
        }
        for (let i = 0; i < 2; i++) {
          signs.push(provider.request({ method: 'eth_sendTransaction', params: [{ from: WALLET_ADDR, to: '0xdead', value: '0x0' }] }))
          await delay(25)
        }

        const results = await Promise.all(signs)
        const signWallClock = Date.now() - started
        flooding = false
        await floodLoop

        // (1) All 10 signing round-trips completed with the expected results.
        expect(results.slice(0, 5)).toEqual(Array(5).fill(`0x${'ab'.repeat(65)}`))
        expect(results.slice(5, 8)).toEqual(Array(3).fill(`0x${'cd'.repeat(65)}`))
        expect(results.slice(8, 10)).toEqual(Array(2).fill(`0x${'ef'.repeat(32)}`))

        // (2) The wallet saw ONLY signing/account methods — zero read-only traffic.
        expect(walletStats.reqByMethod.wallet_signMessage).toBe(5)
        expect(walletStats.reqByMethod.wallet_signTypedData).toBe(3)
        expect(walletStats.reqByMethod.wallet_sendTransaction).toBe(2)
        for (const m of ['eth_call', 'eth_getBalance', 'eth_blockNumber', 'eth_getLogs', 'eth_gasPrice']) {
          expect(walletStats.reqByMethod[m]).toBeUndefined()
        }

        // (3) The reads really happened — and were served by the dApp-side proxy.
        expect(readStats.calls).toBeGreaterThan(50)
        expect(readErrors).toEqual([])

        // (4) Signing was not starved: 10 sequential signs (with the wallet's own
        //     small latency) complete well within a generous bound even under the
        //     read flood. This is a soft check — the hard guarantees are (1)-(3).
        expect(signWallClock).toBeLessThan(scale.connectTimeout)
        } finally {
          await pair.close()
        }
      },
    )

    it(
      'chain switches under read load update chainId immediately and route subsequent txs correctly',
      { retry: scale.retry, timeout: scale.connectTimeout + 15000 },
      async () => {
        const pair = await connectPair(makeTransports(), { connectTimeout: scale.connectTimeout })
        try {
        const { provider } = pair

        let flooding = true
        const floodLoop = (async () => {
          while (flooding) {
            await provider.request({ method: 'eth_blockNumber', params: [] }).catch(() => {})
            await delay(3)
          }
        })()

        // Switch to BSC (56) — eth_chainId must reflect it immediately (optimistic),
        // before the wallet's chainChanged event has necessarily propagated.
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x38' }] })
        expect(await provider.request({ method: 'eth_chainId' })).toBe('0x38')

        // Switch to Polygon (137).
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x89' }] })
        expect(await provider.request({ method: 'eth_chainId' })).toBe('0x89')

        flooding = false
        await floodLoop

        // A tx sent without an embedded chainId inherits the switched-to chain.
        const hash = await provider.request({
          method: 'eth_sendTransaction',
          params: [{ from: WALLET_ADDR, to: '0xdead', value: '0x0' }],
        })
        expect(hash).toBe(`0x${'ef'.repeat(32)}`)
        } finally {
          await pair.close()
        }
      },
    )
  })
}

// ---------------------------------------------------------------------------
// Mock-relay-only scenarios (deterministic protocol-level robustness)
// ---------------------------------------------------------------------------

describe('E2E stress — MockRelay only (deterministic)', () => {
  it('signing channel degrades gracefully at the 32-pending limit and recovers', async () => {
    const pair = await connectPair(mockTransports(), { connectTimeout: 5000 })
    // Make the wallet hold every signature so all in-flight requests pile up.
    pair.walletStats.signLatencyMs = 250

    // Fire 40 concurrent signs. The dApp session caps in-flight requests at 32.
    const settled = await Promise.allSettled(
      Array.from({ length: 40 }, (_, i) =>
        pair.provider.request({ method: 'personal_sign', params: [`0x${Buffer.from(`m${i}`).toString('hex')}`, WALLET_ADDR] }),
      ),
    )
    const fulfilled = settled.filter((s) => s.status === 'fulfilled')
    const rejected = settled.filter((s) => s.status === 'rejected') as PromiseRejectedResult[]

    // 32 go through; the overflow is rejected — gracefully, with a clear message.
    expect(fulfilled.length).toBe(32)
    expect(rejected.length).toBe(8)
    for (const r of rejected) {
      expect(String(r.reason?.message ?? r.reason)).toMatch(/too many pending/i)
    }

    // The session is still healthy: a fresh sign succeeds after the burst drains.
    pair.walletStats.signLatencyMs = 5
    const after = await pair.provider.request({ method: 'personal_sign', params: [`0x${Buffer.from('ok').toString('hex')}`, WALLET_ADDR] })
    expect(after).toBe(`0x${'ab'.repeat(65)}`)

    await pair.close()
  }, 20000)

  it('soak: interleaved reads + signs + switches stay correct over many iterations', async () => {
    const pair = await connectPair(mockTransports(), { connectTimeout: 5000 })
    const { provider } = pair

    for (let i = 0; i < 40; i++) {
      // A burst of reads (served dApp-side) ...
      await Promise.all(READ_METHODS.map((m) => provider.request({ method: m, params: paramsFor(m) })))
      // ... a sign ...
      const sig = await provider.request({ method: 'personal_sign', params: [`0x${Buffer.from(`s${i}`).toString('hex')}`, WALLET_ADDR] })
      expect(sig).toBe(`0x${'ab'.repeat(65)}`)
      // ... and an occasional chain switch.
      if (i % 7 === 3) {
        const target = i % 2 === 0 ? '0x38' : '0x89'
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: target }] })
        expect(await provider.request({ method: 'eth_chainId' })).toBe(target)
      }
    }

    // No read traffic ever reached the wallet across the whole soak.
    for (const m of READ_METHODS) {
      expect(pair.walletStats.reqByMethod[m]).toBeUndefined()
    }
    expect(pair.walletStats.reqByMethod.wallet_signMessage).toBe(40)
    expect(pair.dapp.phase).toBe('connected')

    await pair.close()
  }, 30000)
})

// ---------------------------------------------------------------------------
// Run the shared suite over both transports
// ---------------------------------------------------------------------------

defineSuite('MockRelay', mockTransports, { floodMs: 800, connectTimeout: 5000, retry: 0 })

const liveSuite = LIVE_OK ? defineSuite : (..._args: Parameters<typeof defineSuite>) => {
  describe.skip(`E2E stress over live relay (${RELAY_URL}) — unreachable, skipped`, () => {
    it('skipped', () => {})
  })
}
liveSuite('live CF relay', liveTransports, { floodMs: 1200, connectTimeout: 25000, retry: 2 })

// ---------------------------------------------------------------------------
// Real on-chain reads over the live relay: the dApp fetches REAL mainnet data
// through the SDK's read path while the user signs over the live CF relay.
// ---------------------------------------------------------------------------

const realReadsDescribe = LIVE_OK && REAL_RPC_OK ? describe : describe.skip

realReadsDescribe('E2E real on-chain reads (configured RPC) + live-relay signing', () => {
  it(
    'fetches real mainnet state on the dApp side while signing over the live relay',
    { retry: 2, timeout: 40000 },
    async () => {
      const pair = await connectPair(liveTransports(), {
        connectTimeout: 25000,
        reads: { chainId: 1, rpcUrls: { 1: REACHABLE_RPCS }, ethereumDataUrl: null },
      })
      try {
      // Real reads (dApp-side, real public RPC) concurrent with live-relay signing.
      const [decimals, blockNo, gasPrice, sig, txHash] = await Promise.all([
        pair.provider.request({ method: 'eth_call', params: [{ to: USDC, data: USDC_DECIMALS_CALLDATA }, 'latest'] }),
        pair.provider.request({ method: 'eth_blockNumber', params: [] }),
        pair.provider.request({ method: 'eth_gasPrice', params: [] }),
        pair.provider.request({ method: 'personal_sign', params: [`0x${Buffer.from('real-read').toString('hex')}`, WALLET_ADDR] }),
        pair.provider.request({ method: 'eth_sendTransaction', params: [{ from: WALLET_ADDR, to: '0xdead', value: '0x0' }] }),
      ])

      // Real chain data: USDC reports 6 decimals; the head block is well past 15M.
      expect(BigInt(decimals as string)).toBe(6n)
      expect(Number(BigInt(blockNo as string))).toBeGreaterThan(15_000_000)
      expect(BigInt(gasPrice as string)).toBeGreaterThan(0n)

      // Signing round-tripped through the live relay.
      expect(sig).toBe(`0x${'ab'.repeat(65)}`)
      expect(txHash).toBe(`0x${'ef'.repeat(32)}`)

      // The real reads never touched the wallet — served entirely on the dApp side.
      for (const m of ['eth_call', 'eth_blockNumber', 'eth_gasPrice', 'eth_getBalance']) {
        expect(pair.walletStats.reqByMethod[m]).toBeUndefined()
      }
      } finally {
        await pair.close()
      }
    },
  )
})

const ethDataDescribe = LIVE_OK && ETH_DATA_OK ? describe : describe.skip

ethDataDescribe('E2E reads via ethereum-data endpoint discovery (real RPC)', () => {
  it(
    'discovers real RPC endpoints from ethereum-data and returns real chain data',
    { retry: 2, timeout: 40000 },
    async () => {
      // No rpcUrls / rpcProvider → the SDK resolves endpoints from the ethereum-data
      // service, then serves reads from the real RPCs it returns.
      const pair = await connectPair(liveTransports(), {
        connectTimeout: 25000,
        reads: { chainId: 1 },
      })
      try {
        const [decimals, blockNo] = await Promise.all([
          pair.provider.request({ method: 'eth_call', params: [{ to: USDC, data: USDC_DECIMALS_CALLDATA }, 'latest'] }),
          pair.provider.request({ method: 'eth_blockNumber', params: [] }),
        ])

        expect(BigInt(decimals as string)).toBe(6n)
        expect(Number(BigInt(blockNo as string))).toBeGreaterThan(15_000_000)
      } finally {
        await pair.close()
      }
    },
  )
})
