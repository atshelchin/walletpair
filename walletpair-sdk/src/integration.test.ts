/**
 * Integration test: full dApp ↔ wallet flow through MockRelay.
 *
 * Verifies the complete lifecycle:
 *   1. DApp creates pairing
 *   2. Wallet joins via URI
 *   3. Pairing codes match
 *   4. DApp accepts → both connected
 *   5. DApp sends request → wallet receives → wallet approves → dApp gets response
 *   6. Wallet pushes event → dApp receives
 *   7. Close
 */

import { describe, it, expect, vi } from 'vitest';
import { DAppSession } from './dapp-session.js';
import { WalletSession } from './wallet-session.js';
import { MockTransport, MockRelay } from './test-helpers.js';
import { parsePairingUri } from './crypto.js';

function wait(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('Integration: DApp ↔ Wallet full flow', () => {
  it('completes full pairing and request/response cycle', async () => {
    // Setup transports + relay
    const dappTransport = new MockTransport();
    const walletTransport = new MockTransport();
    const _relay = new MockRelay(dappTransport, walletTransport);

    // Create sessions
    const dappSession = new DAppSession({
      transport: dappTransport,
      name: 'Test dApp',
    });

    const walletSession = new WalletSession({
      transport: walletTransport,
      capabilities: {
        methods: ['wallet_getAccounts', 'wallet_signMessage'],
        events: ['accountsChanged'],
        chains: ['eip155:1'],
      },
      meta: { name: 'Test Wallet', address: '0xWalletAddr' },
    });

    // Track events
    const dappPhases: string[] = [];
    const walletPhases: string[] = [];
    dappSession.on('phase', (p) => dappPhases.push(p));
    walletSession.on('phase', (p) => walletPhases.push(p));

    // Step 1: DApp creates pairing
    const pairingUri = await dappSession.createPairing();
    expect(pairingUri).toContain('walletpair:?ch=');
    await wait();
    expect(dappSession.phase).toBe('waiting');

    // Step 2: Wallet joins
    // Need to set the walletTransport URL from the pairing URI
    const parsed = parsePairingUri(pairingUri);
    if ('setUrl' in walletTransport) {
      (walletTransport as any).setUrl = () => {}; // mock
    }

    const pairingCode = await walletSession.joinFromUri(pairingUri);
    await wait();

    expect(walletSession.phase).toBe('waiting');
    expect(pairingCode).toMatch(/^\d{6}$/);

    // Step 3: Pairing codes match
    await wait();
    expect(dappSession.pairingCode).toBe(walletSession.pairingCode);
    expect(dappSession.phase).toBe('pending_accept');

    // Verify wallet capabilities were received
    expect(dappSession.walletCapabilities?.methods).toContain('wallet_getAccounts');
    expect(dappSession.walletMeta?.name).toBe('Test Wallet');

    // Step 4: DApp accepts
    dappSession.acceptWallet();
    await wait();

    expect(dappSession.phase).toBe('connected');
    expect(walletSession.phase).toBe('connected');

    // Step 5: DApp sends request → wallet responds
    walletSession.on('request', ({ id, method, params }) => {
      if (method === 'wallet_getAccounts') {
        walletSession.approve(id, ['0xWalletAddr']);
      }
    });

    const accounts = await dappSession.request('wallet_getAccounts');
    expect(accounts).toEqual(['0xWalletAddr']);

    // Step 6: Wallet pushes event → dApp receives
    const eventHandler = vi.fn();
    dappSession.on('event', eventHandler);

    walletSession.pushEvent('accountsChanged', { accounts: ['0xNewAddr'] });
    await wait();

    expect(eventHandler).toHaveBeenCalledWith({
      event: 'accountsChanged',
      data: { accounts: ['0xNewAddr'] },
    });

    // Step 7: Close
    dappSession.close();
    expect(dappSession.phase).toBe('closed');

    // Verify phase transitions
    expect(dappPhases).toContain('waiting');
    expect(dappPhases).toContain('pending_accept');
    expect(dappPhases).toContain('connected');
    expect(dappPhases).toContain('closed');

    expect(walletPhases).toContain('waiting');
    expect(walletPhases).toContain('connected');
  });

  it('wallet rejects request', async () => {
    const dappTransport = new MockTransport();
    const walletTransport = new MockTransport();
    const _relay = new MockRelay(dappTransport, walletTransport);

    const dappSession = new DAppSession({ transport: dappTransport });
    const walletSession = new WalletSession({
      transport: walletTransport,
      capabilities: { methods: ['wallet_signMessage'], events: [], chains: ['eip155:1'] },
    });

    // Connect
    const uri = await dappSession.createPairing();
    await walletSession.joinFromUri(uri);
    await wait();

    dappSession.acceptWallet();
    await wait();

    // Wallet rejects
    walletSession.on('request', ({ id }) => {
      walletSession.reject(id, 'user_rejected', 'No thanks');
    });

    await expect(dappSession.request('wallet_signMessage', { message: 'hi' }))
      .rejects.toThrow('No thanks');
  });

  it('multiple sequential requests', async () => {
    const dappTransport = new MockTransport();
    const walletTransport = new MockTransport();
    const _relay = new MockRelay(dappTransport, walletTransport);

    const dappSession = new DAppSession({ transport: dappTransport });
    const walletSession = new WalletSession({
      transport: walletTransport,
      capabilities: { methods: ['wallet_getAccounts'], events: [], chains: ['eip155:1'] },
    });

    const uri = await dappSession.createPairing();
    await walletSession.joinFromUri(uri);
    await wait();
    dappSession.acceptWallet();
    await wait();

    let callCount = 0;
    walletSession.on('request', ({ id, method }) => {
      callCount++;
      walletSession.approve(id, { call: callCount });
    });

    const r1 = await dappSession.request('wallet_getAccounts');
    const r2 = await dappSession.request('wallet_getAccounts');
    const r3 = await dappSession.request('wallet_getAccounts');

    expect(r1).toEqual({ call: 1 });
    expect(r2).toEqual({ call: 2 });
    expect(r3).toEqual({ call: 3 });
  });
});
