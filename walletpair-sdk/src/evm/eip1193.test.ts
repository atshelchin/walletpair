import { describe, expect, it, vi } from 'vitest'
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
    provider = new WalletPairProvider({ session, chainId })

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
