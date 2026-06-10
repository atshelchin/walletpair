/**
 * E2E (protocol round-trip) test for the EVM EIP-1193 provider.
 *
 * Wires a real WalletPairProvider (dApp side) to a real WalletSession (wallet
 * side) through a MockRelay — the same path production uses, minus the network.
 * Exercises the smart-contract-wallet scenarios end to end:
 *   - capability relay (contractBytecode, EIP-5792 methods)
 *   - eth_getCode counterfactual override (undeployed → runtime bytecode)
 *   - eth_getCode passthrough once deployed
 *   - wallet_sendCalls + wallet_getCallsStatus (EIP-5792)
 */

import { describe, expect, it } from 'vitest'
import { DAppSession } from '../dapp-session.js'
import { MockRelay, MockTransport } from '../test-helpers.js'
import { WalletSession } from '../wallet-session.js'
import { WalletPairProvider } from './eip1193.js'

function wait(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// Arbitrary but realistic-looking smart-account runtime bytecode.
const RUNTIME =
  '0x608060405273ffffffffffffffffffffffffffffffffffffffff600054163d3d3d3d3d73deadbeef5af43d82803e903d91602b57fd5bf3'

const WALLET_ADDR = '0xWalletAddr0000000000000000000000000000aA'

describe('E2E: EVM provider ↔ wallet (smart contract wallet)', () => {
  it('relays capabilities and runs the counterfactual + EIP-5792 flows', async () => {
    // --- Wire dApp + wallet through a mock relay ---
    const dappTransport = new MockTransport()
    const walletTransport = new MockTransport()
    const _relay = new MockRelay(dappTransport, walletTransport)

    const dappSession = new DAppSession({
      transport: dappTransport,
      meta: { name: 'Test dApp', description: 'Test', url: 'https://test.com', icon: 'https://test.com/icon.png' },
    })
    const provider = new WalletPairProvider({ session: dappSession, chainId: 1 })

    const walletSession = new WalletSession({
      transport: walletTransport,
      capabilities: {
        methods: [
          'wallet_getAccounts',
          'wallet_signMessage',
          'wallet_sendCalls',
          'wallet_getCallsStatus',
        ],
        events: ['accountsChanged', 'chainChanged'],
        chains: ['eip155:1'],
        // Smart contract wallet: advertise the Safe proxy runtime so the dApp
        // can answer eth_getCode for a counterfactual account.
        contractBytecode: RUNTIME,
      },
      meta: {
        name: 'Test Wallet',
        description: 'Test',
        url: 'https://test.com',
        icon: 'https://test.com/icon.png',
        address: WALLET_ADDR,
      },
    })

    // --- Wallet-side request handler (signing + EIP-5792 only) ---
    // Read-only RPC (eth_getCode etc.) is NOT a wallet sub-protocol method; it
    // is served by the dApp-side local RPC proxy (Tier 1, §9.6), modelled by
    // `rpcProvider` below — exactly as production does when the wallet advertises
    // rpcUrls.
    walletSession.on('request', ({ id, method }) => {
      switch (method) {
        case 'wallet_getAccounts':
          return walletSession.approve(id, [WALLET_ADDR])
        case 'wallet_sendCalls':
          return walletSession.approve(id, { id: '0xbatch001' })
        case 'wallet_getCallsStatus':
          return walletSession.approve(id, {
            version: '2.0.0',
            id: '0xbatch001',
            chainId: '0x1',
            status: 200,
            atomic: true,
            receipts: [],
          })
        default:
          return walletSession.reject(id, 'unsupported_method', method)
      }
    })

    // dApp-side local read-only RPC proxy (Tier 1). `getCodeResult` is toggled
    // per scenario to simulate an undeployed vs deployed account.
    let getCodeResult = '0x'
    const readProxy = {
      request: async ({ method }: { method: string; params?: unknown }) => {
        if (method === 'eth_getCode') return getCodeResult
        return '0x'
      },
    }

    // --- Connect ---
    const pairingUri = await dappSession.createPairing()
    await wait()
    await walletSession.joinFromUri(pairingUri)
    await wait()
    expect(dappSession.phase).toBe('connected')
    expect(walletSession.phase).toBe('connected')

    // --- Capabilities relayed to the dApp ---
    expect((dappSession.walletCapabilities as any)?.contractBytecode).toBe(RUNTIME)
    expect(dappSession.walletCapabilities?.methods).toContain('wallet_sendCalls')
    expect(dappSession.walletCapabilities?.methods).toContain('wallet_getCallsStatus')

    // Attach the Tier-1 local read proxy (production wires this from the
    // wallet's advertised rpcUrls).
    ;(provider as any).rpcProvider = readProxy

    // --- Accounts ---
    const accounts = await provider.request({ method: 'eth_requestAccounts' })
    expect(accounts).toEqual([WALLET_ADDR])

    // --- eth_getCode: counterfactual (not deployed) → runtime bytecode ---
    getCodeResult = '0x'
    const codeUndeployed = await provider.request({
      method: 'eth_getCode',
      params: [WALLET_ADDR, 'latest'],
    })
    expect(codeUndeployed).toBe(RUNTIME)

    // --- eth_getCode: once deployed → real on-chain code passes through ---
    getCodeResult = '0x6080604052deadbeef'
    const codeDeployed = await provider.request({
      method: 'eth_getCode',
      params: [WALLET_ADDR, 'latest'],
    })
    expect(codeDeployed).toBe('0x6080604052deadbeef')

    // --- eth_getCode: a different contract is never overridden ---
    getCodeResult = '0x'
    const otherCode = await provider.request({
      method: 'eth_getCode',
      params: ['0xSomeOtherContract', 'latest'],
    })
    expect(otherCode).toBe('0x')

    // --- EIP-5792: wallet_sendCalls returns a batch id ---
    const batchId = await provider.request({
      method: 'wallet_sendCalls',
      params: [{ version: '2.0.0', chainId: '0x1', from: WALLET_ADDR, calls: [{ to: '0xdead', value: '0x0' }] }],
    })
    expect(batchId).toBe('0xbatch001')

    // --- EIP-5792: wallet_getCallsStatus resolves the batch ---
    const status = (await provider.request({
      method: 'wallet_getCallsStatus',
      params: ['0xbatch001'],
    })) as { status: number; id: string }
    expect(status.status).toBe(200)
    expect(status.id).toBe('0xbatch001')

    dappSession.close()
  })
})
