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

// ---------------------------------------------------------------------------
// Directional key integration tests
// ---------------------------------------------------------------------------

describe('Integration: Bidirectional flow with directional keys', () => {

  it('full bidirectional flow: dApp sends request, wallet receives, wallet responds, dApp receives', async () => {
    const dappTransport = new MockTransport();
    const walletTransport = new MockTransport();
    const _relay = new MockRelay(dappTransport, walletTransport);

    const dappSession = new DAppSession({ transport: dappTransport, name: 'BiDi dApp' });
    const walletSession = new WalletSession({
      transport: walletTransport,
      capabilities: { methods: ['wallet_getAccounts', 'wallet_signMessage'], events: ['accountsChanged'], chains: ['eip155:1'] },
      meta: { name: 'BiDi Wallet', address: '0xBiDi' },
    });

    const uri = await dappSession.createPairing();
    await walletSession.joinFromUri(uri);
    await wait();

    // Verify pairing codes match (both derived with directional transcript)
    expect(dappSession.pairingCode).toBe(walletSession.pairingCode);

    dappSession.acceptWallet();
    await wait();

    expect(dappSession.phase).toBe('connected');
    expect(walletSession.phase).toBe('connected');

    // Wallet handles requests
    walletSession.on('request', ({ id, method, params }) => {
      if (method === 'wallet_getAccounts') {
        walletSession.approve(id, ['0xBiDi']);
      } else if (method === 'wallet_signMessage') {
        walletSession.approve(id, { signature: '0xSIG' });
      }
    });

    // DApp sends request (uses dappToWalletKey), wallet decrypts (uses dappToWalletKey as recvKey)
    const accounts = await dappSession.request('wallet_getAccounts');
    expect(accounts).toEqual(['0xBiDi']);

    // Wallet responds (uses walletToDappKey), dApp decrypts (uses walletToDappKey as recvKey)
    const sig = await dappSession.request('wallet_signMessage', { message: 'test' });
    expect(sig).toEqual({ signature: '0xSIG' });
  });

  it('wallet pushes event, dApp receives with correct key', async () => {
    const dappTransport = new MockTransport();
    const walletTransport = new MockTransport();
    const _relay = new MockRelay(dappTransport, walletTransport);

    const dappSession = new DAppSession({ transport: dappTransport });
    const walletSession = new WalletSession({
      transport: walletTransport,
      capabilities: { methods: ['wallet_getAccounts'], events: ['accountsChanged', 'chainChanged'], chains: ['eip155:1'] },
    });

    const uri = await dappSession.createPairing();
    await walletSession.joinFromUri(uri);
    await wait();
    dappSession.acceptWallet();
    await wait();

    const events: Array<{ event: string; data: unknown }> = [];
    dappSession.on('event', (evt) => events.push(evt));

    // Push multiple events
    walletSession.pushEvent('accountsChanged', { accounts: ['0xNew'] });
    walletSession.pushEvent('chainChanged', { chainId: 'eip155:137' });
    await wait();

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ event: 'accountsChanged', data: { accounts: ['0xNew'] } });
    expect(events[1]).toEqual({ event: 'chainChanged', data: { chainId: 'eip155:137' } });
  });

  it('multiple concurrent requests do not interfere', async () => {
    const dappTransport = new MockTransport();
    const walletTransport = new MockTransport();
    const _relay = new MockRelay(dappTransport, walletTransport);

    const dappSession = new DAppSession({ transport: dappTransport });
    const walletSession = new WalletSession({
      transport: walletTransport,
      capabilities: { methods: ['wallet_getAccounts', 'wallet_signMessage'], events: [], chains: ['eip155:1'] },
    });

    const uri = await dappSession.createPairing();
    await walletSession.joinFromUri(uri);
    await wait();
    dappSession.acceptWallet();
    await wait();

    // Wallet responds to each request with method-specific data, but with a delay
    walletSession.on('request', ({ id, method }) => {
      if (method === 'wallet_getAccounts') {
        // Respond immediately
        walletSession.approve(id, ['0xABC']);
      } else if (method === 'wallet_signMessage') {
        // Respond slightly delayed
        setTimeout(() => walletSession.approve(id, '0xSIG123'), 10);
      }
    });

    // Fire both concurrently
    const [accounts, signature] = await Promise.all([
      dappSession.request('wallet_getAccounts'),
      dappSession.request('wallet_signMessage', { message: 'hello' }),
    ]);

    expect(accounts).toEqual(['0xABC']);
    expect(signature).toBe('0xSIG123');
  });

  it('session serialization preserves directional keys', async () => {
    const dappTransport = new MockTransport();
    const walletTransport = new MockTransport();
    const _relay = new MockRelay(dappTransport, walletTransport);

    const dappSession = new DAppSession({ transport: dappTransport, name: 'Persist dApp' });
    const walletSession = new WalletSession({
      transport: walletTransport,
      capabilities: { methods: ['wallet_getAccounts'], events: [], chains: ['eip155:1'] },
      meta: { name: 'Persist Wallet' },
    });

    const uri = await dappSession.createPairing();
    await walletSession.joinFromUri(uri);
    await wait();
    dappSession.acceptWallet();
    await wait();

    // Serialize both sessions
    const dappJson = dappSession.serialize();
    const walletJson = walletSession.serialize();

    // Parse and verify directional keys are stored
    const dappState = JSON.parse(dappJson);
    const walletState = JSON.parse(walletJson);

    expect(dappState.sendKey).toBeTruthy();
    expect(dappState.recvKey).toBeTruthy();
    expect(walletState.sendKey).toBeTruthy();
    expect(walletState.recvKey).toBeTruthy();

    // DApp sendKey (dappToWalletKey) == Wallet recvKey (dappToWalletKey)
    expect(dappState.sendKey).toBe(walletState.recvKey);
    // DApp recvKey (walletToDappKey) == Wallet sendKey (walletToDappKey)
    expect(dappState.recvKey).toBe(walletState.sendKey);

    // sendKey != recvKey (directional)
    expect(dappState.sendKey).not.toBe(dappState.recvKey);
  });

  it('restored session can still communicate', async () => {
    const dappTransport = new MockTransport();
    const walletTransport = new MockTransport();
    const _relay = new MockRelay(dappTransport, walletTransport);

    const dappSession = new DAppSession({ transport: dappTransport, name: 'Restore dApp' });
    const walletSession = new WalletSession({
      transport: walletTransport,
      capabilities: { methods: ['wallet_getAccounts'], events: [], chains: ['eip155:1'] },
    });

    const uri = await dappSession.createPairing();
    await walletSession.joinFromUri(uri);
    await wait();
    dappSession.acceptWallet();
    await wait();

    // Exchange one message to advance sequence counters
    walletSession.on('request', ({ id }) => walletSession.approve(id, 'first'));
    const r1 = await dappSession.request('wallet_getAccounts');
    expect(r1).toBe('first');

    // Serialize
    const dappJson = dappSession.serialize();
    const walletJson = walletSession.serialize();

    // Restore dApp session to a new transport that is linked to the wallet transport
    const newDappTransport = new MockTransport();
    const newWalletTransport = new MockTransport();
    newDappTransport.peer = newWalletTransport;
    newWalletTransport.peer = newDappTransport;

    const restoredDapp = new DAppSession({ transport: newDappTransport });
    expect(restoredDapp.restore(dappJson)).toBe(true);
    (restoredDapp as any).phase = 'connected';

    const restoredWallet = new WalletSession({
      transport: newWalletTransport,
      capabilities: { methods: ['wallet_getAccounts'], events: [], chains: ['eip155:1'] },
    });
    expect(restoredWallet.restore(walletJson)).toBe(true);
    (restoredWallet as any).phase = 'connected';

    // Set up request handler on restored wallet
    restoredWallet.on('request', ({ id }) => restoredWallet.approve(id, 'restored'));

    // Restored dApp sends request through linked transports
    const r2 = await restoredDapp.request('wallet_getAccounts');
    expect(r2).toBe('restored');
  });
});
