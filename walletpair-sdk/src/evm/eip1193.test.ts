import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AadHeader } from '../crypto.js'
import {
  b64urlDecode,
  computeSharedSecret,
  deriveSessionKey,
  generateX25519KeyPair,
  sealPayload,
} from '../crypto.js'
import { DAppSession } from '../dapp-session.js'
import { MockTransport, makeJoinBody } from '../test-helpers.js'
import type { ProtocolMessage } from '../types.js'
import { WalletPairProvider } from './eip1193.js'

function flushMicrotasks(): Promise<void> {
  return new Promise((r) => setTimeout(r, 10))
}

describe('WalletPairProvider', () => {
  let transport: MockTransport
  let session: DAppSession
  let provider: WalletPairProvider
  let walletKp: ReturnType<typeof generateX25519KeyPair>
  let sessionKey: Uint8Array

  async function setupConnectedSession(chainId = 1) {
    walletSendSeq = 0
    transport = new MockTransport()
    session = new DAppSession({
      transport,
      meta: {
        name: 'Test',
        description: 'Test dApp',
        url: 'https://test.com',
        icon: 'https://test.com/icon.png',
      },
    })
    // ethereumDataUrl: null keeps unit tests offline/deterministic — the network
    // RPC fallback is exercised separately with a mocked fetch.
    provider = new WalletPairProvider({ session, chainId, ethereumDataUrl: null })

    await session.createPairing()
    walletKp = generateX25519KeyPair()

    // Join
    transport.receive({
      v: 1,
      t: 'join',
      ch: session.channelId,
      ts: Date.now(),
      from: walletKp.publicKeyB64,
      body: makeJoinBody(session.channelId, transport.sent[0]?.from!, walletKp),
    } as ProtocolMessage)

    // Responses/events from the manual wallet use the wallet->dApp key.
    const dappPub = b64urlDecode(transport.sent[0]?.from!)
    const shared = computeSharedSecret(walletKp.privateKey, dappPub)
    deriveSessionKey(shared, session.channelId)
    sessionKey = (session as any).recvKey

    // Connect
    transport.receive({
      v: 1,
      t: 'ready',
      ch: session.channelId,
      ts: Date.now(),
      from: '_adapter',
      body: { state: 'connected', reconnect: false, remote: walletKp.publicKeyB64 },
    } as ProtocolMessage)
  }

  let walletSendSeq = 0

  function respondToLatestReq(result: unknown, ok = true) {
    const reqMsg = [...transport.sent].reverse().find((m) => m.t === 'req') as any
    if (!reqMsg) throw new Error('No req found')
    const reqId = reqMsg.body.id
    const hdr: AadHeader = { type: 'res', from: walletKp.publicKeyB64, id: reqId }
    const sealedData = ok ? { _ok: true, _result: result } : { _ok: false, ...(result as object) }
    transport.receive({
      v: 1,
      t: 'res',
      ch: session.channelId,
      ts: Date.now(),
      from: walletKp.publicKeyB64,
      body: {
        id: reqId,
        sealed: sealPayload(sessionKey, session.channelId, walletSendSeq++, sealedData, hdr),
      },
    } as ProtocolMessage)
  }

  // -----------------------------------------------------------------------
  // eth_chainId
  // -----------------------------------------------------------------------

  describe('eth_chainId', () => {
    it('returns chain ID as hex (default mainnet)', async () => {
      await setupConnectedSession()
      const result = await provider.request({ method: 'eth_chainId' })
      expect(result).toBe('0x1')
    })

    it('returns custom chain ID', async () => {
      await setupConnectedSession(137)
      const result = await provider.request({ method: 'eth_chainId' })
      expect(result).toBe('0x89')
    })
  })

  describe('net_version', () => {
    it('returns chain ID as decimal string', async () => {
      await setupConnectedSession()
      const result = await provider.request({ method: 'net_version' })
      expect(result).toBe('1')
    })
  })

  // -----------------------------------------------------------------------
  // eth_requestAccounts / eth_accounts
  // -----------------------------------------------------------------------

  describe('eth_requestAccounts', () => {
    it('maps to wallet_getAccounts and returns result', async () => {
      await setupConnectedSession()

      const promise = provider.request({ method: 'eth_requestAccounts' })
      await flushMicrotasks()

      // Verify it sent wallet_getAccounts
      const reqMsg = transport.sent.find((m) => m.t === 'req') as any
      expect(reqMsg.body.sealed).toBeTruthy() // method inside sealed

      respondToLatestReq(['0xabc123'])
      const result = await promise
      expect(result).toEqual(['0xabc123'])
    })

    it('caches accounts after request', async () => {
      await setupConnectedSession()

      const promise = provider.request({ method: 'eth_requestAccounts' })
      await flushMicrotasks()
      respondToLatestReq(['0xabc123'])
      await promise

      expect(provider.getAccounts()).toEqual(['0xabc123'])
    })
  })

  describe('eth_accounts', () => {
    it('maps to wallet_getAccounts', async () => {
      await setupConnectedSession()

      const promise = provider.request({ method: 'eth_accounts' })
      await flushMicrotasks()

      const reqMsg = transport.sent.find((m) => m.t === 'req') as any
      expect(reqMsg.body.sealed).toBeTruthy() // method inside sealed

      respondToLatestReq(['0x456'])
      const result = await promise
      expect(result).toEqual(['0x456'])
    })
  })

  // -----------------------------------------------------------------------
  // personal_sign
  // -----------------------------------------------------------------------

  describe('personal_sign', () => {
    it('maps hex data to wallet_signMessage with decoded text', async () => {
      await setupConnectedSession()

      // 0x48656c6c6f is "Hello" in hex
      const promise = provider.request({
        method: 'personal_sign',
        params: ['0x48656c6c6f', '0xabc'],
      })
      await flushMicrotasks()

      const reqMsg = transport.sent.find((m) => m.t === 'req') as any
      expect(reqMsg.body.sealed).toBeTruthy() // method inside sealed

      // Wallet responds with { signature }, mapResponse unwraps to just the string
      respondToLatestReq({ signature: '0xsig...' })
      const result = await promise
      expect(result).toBe('0xsig...')
    })

    it('maps plain text to wallet_signMessage', async () => {
      await setupConnectedSession()

      const promise = provider.request({
        method: 'personal_sign',
        params: ['Hello, WalletPair!', '0xabc'],
      })
      await flushMicrotasks()

      const reqMsg = transport.sent.find((m) => m.t === 'req') as any
      expect(reqMsg.body.sealed).toBeTruthy() // method inside sealed

      respondToLatestReq({ signature: '0xsig...' })
      const result = await promise
      expect(result).toBe('0xsig...')
    })
  })

  // -----------------------------------------------------------------------
  // eth_sendTransaction
  // -----------------------------------------------------------------------

  describe('eth_sendTransaction', () => {
    it('maps to wallet_sendTransaction', async () => {
      await setupConnectedSession()

      const tx = { to: '0x123', value: '0x0', data: '0x', type: '0x2', chainId: '0x1' }
      const promise = provider.request({
        method: 'eth_sendTransaction',
        params: [tx],
      })
      await flushMicrotasks()

      const reqMsg = transport.sent.find((m) => m.t === 'req') as any
      expect(reqMsg.body.sealed).toBeTruthy() // method inside sealed

      // mapResponse unwraps { txHash } to just the hash string
      respondToLatestReq({ txHash: '0xtx...' })
      const result = await promise
      expect(result).toBe('0xtx...')
    })
  })

  // -----------------------------------------------------------------------
  // wallet_switchEthereumChain
  // -----------------------------------------------------------------------

  describe('wallet_switchEthereumChain', () => {
    it('maps to wallet_switchChain', async () => {
      await setupConnectedSession()

      const promise = provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0x89' }],
      })
      await flushMicrotasks()

      const reqMsg = transport.sent.find((m) => m.t === 'req') as any
      expect(reqMsg.body.sealed).toBeTruthy() // method inside sealed

      respondToLatestReq({ success: true })
      await promise
    })

    it('syncs chainId and emits chainChanged on success without waiting for the wallet event', async () => {
      await setupConnectedSession(1)
      const handler = vi.fn()
      provider.on('chainChanged', handler)

      const promise = provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0x89' }],
      })
      await flushMicrotasks()
      respondToLatestReq({ success: true })
      await promise

      // eth_chainId must reflect the new chain immediately — before the wallet's
      // chainChanged event arrives — so viem/wagmi don't see a network mismatch.
      expect(await provider.request({ method: 'eth_chainId' })).toBe('0x89')
      expect(handler).toHaveBeenCalledWith('0x89')

      // A redundant chainChanged event from the wallet for the same chain is de-duped.
      handler.mockClear()
      transport.receive({
        v: 1,
        t: 'evt',
        ch: session.channelId,
        ts: Date.now(),
        from: walletKp.publicKeyB64,
        body: {
          id: 'evt-dup',
          sealed: sealPayload(
            sessionKey,
            session.channelId,
            walletSendSeq++,
            { _event: 'chainChanged', chain: 'eip155:137' },
            { type: 'evt', from: walletKp.publicKeyB64, id: 'evt-dup' },
          ),
        },
      } as ProtocolMessage)
      expect(handler).not.toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // Events
  // -----------------------------------------------------------------------

  describe('EIP-1193 events', () => {
    it('emits connect when session connects', async () => {
      await setupConnectedSession()
      // Provider constructor registered the listener, and session is already connected
      expect(provider.isConnected()).toBe(true)
    })

    it('emits disconnect when session closes', async () => {
      await setupConnectedSession()
      const handler = vi.fn()
      provider.on('disconnect', handler)

      session.close()
      expect(handler).toHaveBeenCalledWith({ code: 4900, message: 'Disconnected' })
      expect(provider.isConnected()).toBe(false)
    })

    it('emits accountsChanged from wallet event', async () => {
      await setupConnectedSession()
      const handler = vi.fn()
      provider.on('accountsChanged', handler)

      transport.receive({
        v: 1,
        t: 'evt',
        ch: session.channelId,
        ts: Date.now(),
        from: walletKp.publicKeyB64,
        body: {
          id: 'evt-1',
          sealed: sealPayload(
            sessionKey,
            session.channelId,
            0,
            { _event: 'accountsChanged', accounts: ['0xnew'] },
            { type: 'evt', from: walletKp.publicKeyB64, id: 'evt-1' },
          ),
        },
      } as ProtocolMessage)

      expect(handler).toHaveBeenCalledWith(['0xnew'])
      expect(provider.getAccounts()).toEqual(['0xnew'])
    })

    it('emits chainChanged from wallet event (CAIP-2 format)', async () => {
      await setupConnectedSession()
      const handler = vi.fn()
      provider.on('chainChanged', handler)

      transport.receive({
        v: 1,
        t: 'evt',
        ch: session.channelId,
        ts: Date.now(),
        from: walletKp.publicKeyB64,
        body: {
          id: 'evt-2',
          sealed: sealPayload(
            sessionKey,
            session.channelId,
            0,
            { _event: 'chainChanged', chainId: 'eip155:137' },
            { type: 'evt', from: walletKp.publicKeyB64, id: 'evt-2' },
          ),
        },
      } as ProtocolMessage)

      expect(handler).toHaveBeenCalledWith('0x89')
    })

    it('emits chainChanged from wallet event (hex format)', async () => {
      await setupConnectedSession()
      const handler = vi.fn()
      provider.on('chainChanged', handler)

      transport.receive({
        v: 1,
        t: 'evt',
        ch: session.channelId,
        ts: Date.now(),
        from: walletKp.publicKeyB64,
        body: {
          id: 'evt-3',
          sealed: sealPayload(
            sessionKey,
            session.channelId,
            0,
            { _event: 'chainChanged', chainId: '0x89' },
            { type: 'evt', from: walletKp.publicKeyB64, id: 'evt-3' },
          ),
        },
      } as ProtocolMessage)

      expect(handler).toHaveBeenCalledWith('0x89')
    })

    it('removeListener stops event delivery', async () => {
      await setupConnectedSession()
      const handler = vi.fn()
      provider.on('accountsChanged', handler)
      provider.removeListener('accountsChanged', handler)

      transport.receive({
        v: 1,
        t: 'evt',
        ch: session.channelId,
        ts: Date.now(),
        from: walletKp.publicKeyB64,
        body: {
          id: 'evt-4',
          sealed: sealPayload(
            sessionKey,
            session.channelId,
            0,
            { _event: 'accountsChanged', accounts: ['0x1'] },
            { type: 'evt', from: walletKp.publicKeyB64, id: 'evt-4' },
          ),
        },
      } as ProtocolMessage)

      expect(handler).not.toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // Helper methods
  // -----------------------------------------------------------------------

  describe('helper methods', () => {
    it('getChainId returns hex string', async () => {
      await setupConnectedSession(42161)
      expect(provider.getChainId()).toBe('0xa4b1')
    })

    it('getSession returns the underlying session', async () => {
      await setupConnectedSession()
      expect(provider.getSession()).toBe(session)
    })
  })

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  describe('error handling', () => {
    it('rejects on wallet error response', async () => {
      await setupConnectedSession()

      const promise = provider.request({ method: 'eth_requestAccounts' })
      await flushMicrotasks()

      respondToLatestReq({ code: 'user_rejected', message: 'Denied' }, false)
      await expect(promise).rejects.toThrow('Denied')
    })
  })

  // -----------------------------------------------------------------------
  // Passthrough methods
  // -----------------------------------------------------------------------

  describe('unknown methods', () => {
    it('routes read-only methods to rpcProvider when available', async () => {
      await setupConnectedSession()
      const rpcProvider = { request: vi.fn().mockResolvedValue('0x1234') }
      ;(provider as any).rpcProvider = rpcProvider

      const result = await provider.request({
        method: 'eth_getBalance',
        params: ['0x123', 'latest'],
      })
      expect(rpcProvider.request).toHaveBeenCalledWith({
        method: 'eth_getBalance',
        params: ['0x123', 'latest'],
      })
      expect(result).toBe('0x1234')
    })

    it('forwards read-only methods through relay when no rpcProvider', async () => {
      await setupConnectedSession()

      const promise = provider.request({ method: 'eth_getBalance', params: ['0x123', 'latest'] })
      await flushMicrotasks()

      // Wallet responds through the relay
      respondToLatestReq('0xde0b6b3a7640000')
      const result = await promise
      expect(result).toBe('0xde0b6b3a7640000')
    })
  })

  // -----------------------------------------------------------------------
  // Read-only RPC interception (served dApp-side, never relayed to wallet)
  // -----------------------------------------------------------------------

  describe('read-only RPC interception', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    // A fetch mock that returns a JSON-RPC result for any RPC POST.
    function rpcResult(result: unknown) {
      return { ok: true, headers: { get: () => null }, json: async () => ({ result }) }
    }

    function countRelayReqs(): number {
      return transport.sent.filter((m) => m.t === 'req').length
    }

    it('serves a read-only call from wallet-advertised rpcUrls instead of relaying', async () => {
      await setupConnectedSession(1)
      ;(session as any).walletCapabilities = {
        ...(session as any).walletCapabilities,
        rpcUrls: { 'eip155:1': 'https://wallet.rpc.test' },
      }
      const fetchMock = vi.fn().mockResolvedValue(rpcResult('0xbalance'))
      vi.stubGlobal('fetch', fetchMock)

      const result = await provider.request({ method: 'eth_getBalance', params: ['0x1', 'latest'] })

      expect(result).toBe('0xbalance')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://wallet.rpc.test')
      expect(countRelayReqs()).toBe(0) // never touched the wallet channel
    })

    it('prefers constructor rpcUrls over wallet rpcUrls', async () => {
      await setupConnectedSession(1)
      ;(session as any).walletCapabilities = {
        ...(session as any).walletCapabilities,
        rpcUrls: { 'eip155:1': 'https://wallet.rpc.test' },
      }
      const ctorProvider = new WalletPairProvider({
        session,
        chainId: 1,
        ethereumDataUrl: null,
        rpcUrls: { 1: 'https://ctor.rpc.test' },
      })
      const fetchMock = vi.fn().mockResolvedValue(rpcResult('0x5'))
      vi.stubGlobal('fetch', fetchMock)

      const result = await ctorProvider.request({ method: 'eth_blockNumber', params: [] })

      expect(result).toBe('0x5')
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://ctor.rpc.test')
    })

    it('falls back to the ethereum-data service when no rpcUrls are known', async () => {
      await setupConnectedSession(1)
      const edProvider = new WalletPairProvider({ session, chainId: 137 }) // ethereum-data enabled
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => null },
          // insecure + placeholder URLs must be filtered out
          json: async () => ({ rpc: ['http://insecure', 'https://${KEY}', 'https://poly.public.test'] }),
        })
        .mockResolvedValueOnce(rpcResult('0xblock'))
      vi.stubGlobal('fetch', fetchMock)

      const result = await edProvider.request({ method: 'eth_blockNumber', params: [] })

      expect(result).toBe('0xblock')
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        'https://ethereum-data.awesometools.dev/chains/eip155-137.json',
      )
      expect(fetchMock.mock.calls[1]?.[0]).toBe('https://poly.public.test')
      expect(countRelayReqs()).toBe(0)
    })

    it('de-duplicates the ethereum-data lookup across concurrent reads (single-flight)', async () => {
      await setupConnectedSession(1)
      const edProvider = new WalletPairProvider({ session, chainId: 137 })
      const fetchMock = vi.fn().mockImplementation((url: string) =>
        String(url).includes('/chains/')
          ? Promise.resolve({
              ok: true,
              headers: { get: () => null },
              json: async () => ({ rpc: ['https://poly.public.test'] }),
            })
          : Promise.resolve(rpcResult('0xok')),
      )
      vi.stubGlobal('fetch', fetchMock)

      await Promise.all([
        edProvider.request({ method: 'eth_blockNumber', params: [] }),
        edProvider.request({ method: 'eth_gasPrice', params: [] }),
        edProvider.request({ method: 'eth_blockNumber', params: [] }),
      ])

      const chainLookups = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/chains/'))
      expect(chainLookups.length).toBe(1)
    })

    it('propagates an execution revert without masking it or relaying', async () => {
      await setupConnectedSession(1)
      ;(session as any).walletCapabilities = {
        ...(session as any).walletCapabilities,
        rpcUrls: { 'eip155:1': 'https://wallet.rpc.test' },
      }
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => null },
        json: async () => ({ error: { code: 3, message: 'execution reverted' } }),
      })
      vi.stubGlobal('fetch', fetchMock)

      await expect(
        provider.request({ method: 'eth_call', params: [{ to: '0x1' }, 'latest'] }),
      ).rejects.toThrow('execution reverted')
      expect(countRelayReqs()).toBe(0)
    })

    it('falls back to the wallet relay when every endpoint fails at the transport level', async () => {
      await setupConnectedSession(1)
      ;(session as any).walletCapabilities = {
        ...(session as any).walletCapabilities,
        rpcUrls: { 'eip155:1': 'https://down.rpc.test' },
      }
      const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
      vi.stubGlobal('fetch', fetchMock)

      const promise = provider.request({ method: 'eth_getBalance', params: ['0x1', 'latest'] })
      await flushMicrotasks()
      respondToLatestReq('0xrelayed')

      expect(await promise).toBe('0xrelayed')
      expect(countRelayReqs()).toBe(1)
    })

    it('serves eth_accounts from the local cache after authorization (no extra relay)', async () => {
      await setupConnectedSession(1)
      const p = provider.request({ method: 'eth_requestAccounts' })
      await flushMicrotasks()
      respondToLatestReq(['0xcached'])
      await p

      const before = countRelayReqs();
      const accounts = await provider.request({ method: 'eth_accounts' })

      expect(accounts).toEqual(['0xcached'])
      expect(countRelayReqs()).toBe(before) // answered from cache, no new channel req
    })

    it('matches a decimal chain filter in wallet_getCapabilities', async () => {
      await setupConnectedSession(1)
      ;(session as any).walletCapabilities = {
        ...(session as any).walletCapabilities,
        walletCapabilities: { '0x1': { foo: true }, '0x89': { bar: true } },
      }
      const out = await provider.request({ method: 'wallet_getCapabilities', params: ['0xaddr', [137]] })
      expect(out).toEqual({ '0x89': { bar: true } })
    })

    it('retries the ethereum-data lookup after a transient empty result (no cache poisoning)', async () => {
      await setupConnectedSession(1)
      const edProvider = new WalletPairProvider({ session, chainId: 137 })
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, headers: { get: () => null }, json: async () => ({}) })
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => null },
          json: async () => ({ rpc: ['https://poly.ok.test'] }),
        })
        .mockResolvedValueOnce(rpcResult('0xblock'))
      vi.stubGlobal('fetch', fetchMock)

      // 1st read: ethereum-data fails → no endpoints → relay
      const p1 = edProvider.request({ method: 'eth_blockNumber', params: [] })
      await flushMicrotasks()
      respondToLatestReq('0xrelayed')
      expect(await p1).toBe('0xrelayed')

      // 2nd read: lookup is retried (empty result was NOT cached) → served via RPC
      expect(await edProvider.request({ method: 'eth_blockNumber', params: [] })).toBe('0xblock')
      const chainLookups = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/chains/'))
      expect(chainLookups.length).toBe(2)
    })

    it('fails over past a rate-limit (-32005) to the next endpoint', async () => {
      await setupConnectedSession(1)
      const edProvider = new WalletPairProvider({
        session,
        chainId: 1,
        ethereumDataUrl: null,
        rpcUrls: { 1: ['https://a.test', 'https://b.test'] },
      })
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => null },
          json: async () => ({ error: { code: -32005, message: 'rate limited' } }),
        })
        .mockResolvedValueOnce(rpcResult('0xok'))
      vi.stubGlobal('fetch', fetchMock)

      expect(await edProvider.request({ method: 'eth_call', params: [{}, 'latest'] })).toBe('0xok')
      expect(fetchMock).toHaveBeenCalledTimes(2) // failed over to the second endpoint
    })

    it('rethrows a definitive coded error (-32602) without failover or relay', async () => {
      await setupConnectedSession(1)
      const edProvider = new WalletPairProvider({
        session,
        chainId: 1,
        ethereumDataUrl: null,
        rpcUrls: { 1: ['https://a.test', 'https://b.test'] },
      })
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => null },
        json: async () => ({ error: { code: -32602, message: 'invalid params' } }),
      })
      vi.stubGlobal('fetch', fetchMock)

      await expect(
        edProvider.request({ method: 'eth_call', params: [{}, 'latest'] }),
      ).rejects.toThrow('invalid params')
      expect(fetchMock).toHaveBeenCalledTimes(1) // definitive → no failover, no relay
      expect(countRelayReqs()).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // eth_getCode — counterfactual smart-account override
  // -----------------------------------------------------------------------

  describe('eth_getCode (counterfactual smart account)', () => {
    const RUNTIME = '0x363d3d373d3d3d363d73deadbeefcafebabe000000000000000000005af43d82803e903d91602b57fd5bf3'

    async function connectWithAccount(addr = '0xAbC123', contractBytecode?: string) {
      await setupConnectedSession()
      if (contractBytecode !== undefined) {
        ;(session as any).walletCapabilities = {
          ...(session as any).walletCapabilities,
          contractBytecode,
        }
      }
      const p = provider.request({ method: 'eth_requestAccounts' })
      await flushMicrotasks()
      respondToLatestReq([addr])
      await p
    }

    it('returns wallet contractBytecode for an undeployed own account (relay path)', async () => {
      await connectWithAccount('0xAbC123', RUNTIME)

      const promise = provider.request({ method: 'eth_getCode', params: ['0xabc123', 'latest'] })
      await flushMicrotasks()
      // Real on-chain code is empty (counterfactual)
      respondToLatestReq('0x')
      const result = await promise
      expect(result).toBe(RUNTIME)
    })

    it('returns the real code once the account is deployed (relay path)', async () => {
      await connectWithAccount('0xAbC123', RUNTIME)

      const promise = provider.request({ method: 'eth_getCode', params: ['0xabc123', 'latest'] })
      await flushMicrotasks()
      respondToLatestReq('0x6080604052deployed')
      const result = await promise
      expect(result).toBe('0x6080604052deployed')
    })

    it('does NOT override eth_getCode for a different address', async () => {
      await connectWithAccount('0xAbC123', RUNTIME)

      const promise = provider.request({ method: 'eth_getCode', params: ['0xsomeOtherContract', 'latest'] })
      await flushMicrotasks()
      respondToLatestReq('0x')
      const result = await promise
      // Passes through untouched — NOT replaced with the wallet bytecode
      expect(result).toBe('0x')
    })

    it('does not override when the wallet advertised no contractBytecode', async () => {
      await connectWithAccount('0xAbC123') // no bytecode

      const promise = provider.request({ method: 'eth_getCode', params: ['0xabc123', 'latest'] })
      await flushMicrotasks()
      respondToLatestReq('0x')
      const result = await promise
      expect(result).toBe('0x')
    })

    it('falls back to bytecode when a local rpcProvider returns 0x', async () => {
      await connectWithAccount('0xAbC123', RUNTIME)
      const rpcProvider = { request: vi.fn().mockResolvedValue('0x') }
      ;(provider as any).rpcProvider = rpcProvider

      const result = await provider.request({ method: 'eth_getCode', params: ['0xabc123', 'latest'] })
      expect(rpcProvider.request).toHaveBeenCalled()
      expect(result).toBe(RUNTIME)
    })

    it('returns real code from a local rpcProvider when deployed', async () => {
      await connectWithAccount('0xAbC123', RUNTIME)
      const rpcProvider = { request: vi.fn().mockResolvedValue('0x6080604052deployed') }
      ;(provider as any).rpcProvider = rpcProvider

      const result = await provider.request({ method: 'eth_getCode', params: ['0xabc123', 'latest'] })
      expect(result).toBe('0x6080604052deployed')
    })
  })

  // -----------------------------------------------------------------------
  // wallet_sendCalls (EIP-5792)
  // -----------------------------------------------------------------------

  describe('wallet_sendCalls (EIP-5792)', () => {
    it('returns the spec object { id } when the wallet responds with { id }', async () => {
      await setupConnectedSession()

      const promise = provider.request({
        method: 'wallet_sendCalls',
        params: [
          {
            version: '2.0.0',
            chainId: '0x1',
            from: '0xabc',
            atomicRequired: false,
            calls: [{ to: '0xdead', value: '0x0' }],
          },
        ],
      })
      await flushMicrotasks()
      respondToLatestReq({ id: '0xbatch001' })
      const result = await promise
      // EIP-5792 v2.0.0: wallet_sendCalls returns an object, NOT a bare string.
      expect(result).toEqual({ id: '0xbatch001' })
    })

    it('preserves the capabilities field on the result object', async () => {
      await setupConnectedSession()

      const promise = provider.request({
        method: 'wallet_sendCalls',
        params: [{ version: '2.0.0', chainId: '0x1', atomicRequired: false, calls: [] }],
      })
      await flushMicrotasks()
      respondToLatestReq({ id: '0xbatch002', capabilities: { atomic: { status: 'supported' } } })
      const result = await promise
      expect(result).toEqual({
        id: '0xbatch002',
        capabilities: { atomic: { status: 'supported' } },
      })
    })

    it('normalizes a legacy bare-string wallet response to { id }', async () => {
      await setupConnectedSession()

      const promise = provider.request({
        method: 'wallet_sendCalls',
        params: [{ version: '2.0.0', chainId: '0x1', atomicRequired: false, calls: [] }],
      })
      await flushMicrotasks()
      // Pre-2.0.0 wallets answered with a bare id string — normalize it.
      respondToLatestReq('0xlegacybatch')
      const result = await promise
      expect(result).toEqual({ id: '0xlegacybatch' })
    })
  })

  // -----------------------------------------------------------------------
  // wallet_getCapabilities (EIP-5792)
  // -----------------------------------------------------------------------

  describe('wallet_getCapabilities (EIP-5792)', () => {
    const CAPS = {
      '0x1': { atomic: { status: 'supported' } },
      '0x89': { atomic: { status: 'supported' } },
    }

    async function connectWithCaps() {
      await setupConnectedSession()
      ;(session as any).walletCapabilities = {
        ...(session as any).walletCapabilities,
        walletCapabilities: CAPS,
      }
    }

    it('is answered locally (no relay round-trip)', async () => {
      await connectWithCaps()
      const before = transport.sent.length
      await provider.request({ method: 'wallet_getCapabilities', params: ['0xabc'] })
      // No new `req` frame was emitted on the wire.
      expect(transport.sent.filter((m) => m.t === 'req').length).toBe(0)
      expect(transport.sent.length).toBe(before)
    })

    it('returns the full capabilities record when no chain filter is given', async () => {
      await connectWithCaps()
      const result = await provider.request({
        method: 'wallet_getCapabilities',
        params: ['0xabc'],
      })
      expect(result).toEqual(CAPS)
    })

    it('filters to the requested chains (EIP-5792 [address, [chainIds]])', async () => {
      await connectWithCaps()
      const result = await provider.request({
        method: 'wallet_getCapabilities',
        params: ['0xabc', ['0x89']],
      })
      expect(result).toEqual({ '0x89': { atomic: { status: 'supported' } } })
    })

    it('matches chain ids by numeric value (ignores hex casing / leading zeros)', async () => {
      await connectWithCaps()
      const result = await provider.request({
        method: 'wallet_getCapabilities',
        params: ['0xabc', ['0x01']],
      })
      expect(result).toEqual({ '0x1': { atomic: { status: 'supported' } } })
    })

    it('returns an empty object when capabilities are not yet available', async () => {
      await setupConnectedSession()
      const result = await provider.request({
        method: 'wallet_getCapabilities',
        params: ['0xabc'],
      })
      expect(result).toEqual({})
    })
  })

  // -----------------------------------------------------------------------
  // wallet_getCallsStatus (EIP-5792)
  // -----------------------------------------------------------------------

  describe('wallet_getCallsStatus (EIP-5792)', () => {
    it('forwards to the wallet over the channel and returns the status object', async () => {
      await setupConnectedSession()
      const status = {
        version: '2.0.0',
        id: '0xbatch',
        chainId: '0x1',
        status: 200,
        atomic: true,
        receipts: [],
      }

      const promise = provider.request({ method: 'wallet_getCallsStatus', params: ['0xbatch'] })
      await flushMicrotasks()
      respondToLatestReq(status)
      const result = await promise
      expect(result).toEqual(status)
    })

    it('never routes to a local rpcProvider (only the wallet can resolve a batch)', async () => {
      await setupConnectedSession()
      const rpcProvider = { request: vi.fn() }
      ;(provider as any).rpcProvider = rpcProvider

      const promise = provider.request({ method: 'wallet_getCallsStatus', params: ['0xbatch'] })
      await flushMicrotasks()
      respondToLatestReq({ status: 100 })
      await promise
      expect(rpcProvider.request).not.toHaveBeenCalled()
    })
  })
})
