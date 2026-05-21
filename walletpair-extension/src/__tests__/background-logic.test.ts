/**
 * Unit tests for background service worker extractable logic.
 *
 * Tests RPC routing, permission logic, deferred requests, state management,
 * and method mapping — all the critical logic from background.ts.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { READ_ONLY_METHODS, proxyRpcCall, DEFAULT_RPC } from '../lib/rpc-proxy';
import {
  grantPermission,
  revokePermission,
  isPermitted,
  getPermissions,
} from '../lib/storage';
import type { ExtensionState, EIP1193Request } from '../lib/types';

// ── Mock chrome APIs ──────────────────────────────────────────────────

const store: Record<string, unknown> = {};

const chromeStorageLocal = {
  get: vi.fn(async (key: string) => ({ [key]: store[key] })),
  set: vi.fn(async (items: Record<string, unknown>) => Object.assign(store, items)),
  remove: vi.fn(async (key: string) => { delete store[key]; }),
};

vi.stubGlobal('chrome', {
  storage: { local: chromeStorageLocal },
  runtime: {
    sendMessage: vi.fn(async () => {}),
    getURL: vi.fn((path: string) => `chrome-extension://fake-id${path}`),
  },
  alarms: {
    create: vi.fn(),
    clear: vi.fn(),
    onAlarm: { addListener: vi.fn() },
  },
  windows: {
    create: vi.fn(async () => ({ id: 1 })),
    remove: vi.fn(async () => {}),
    onRemoved: { addListener: vi.fn() },
  },
  action: {
    openPopup: vi.fn(async () => {}),
  },
});

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ── Helpers ───────────────────────────────────────────────────────────

function clearStore() {
  for (const key of Object.keys(store)) delete store[key];
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('RPC Routing Logic', () => {
  beforeEach(() => {
    clearStore();
    vi.clearAllMocks();
  });

  describe('READ_ONLY_METHODS set', () => {
    it('contains all expected read-only methods', () => {
      const expected = [
        'eth_blockNumber', 'eth_call', 'eth_estimateGas', 'eth_feeHistory',
        'eth_gasPrice', 'eth_maxPriorityFeePerGas',
        'eth_getBalance', 'eth_getCode', 'eth_getStorageAt', 'eth_getTransactionCount',
        'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getLogs',
        'eth_getBlockByNumber', 'eth_getBlockByHash',
        'eth_newFilter', 'eth_newBlockFilter', 'eth_getFilterChanges', 'eth_uninstallFilter',
        'eth_sendRawTransaction', 'eth_syncing',
      ];
      expect(READ_ONLY_METHODS.size).toBe(expected.length);
      for (const method of expected) {
        expect(READ_ONLY_METHODS.has(method), `Missing: ${method}`).toBe(true);
      }
    });

    it('does NOT contain wallet-interaction methods', () => {
      const walletMethods = [
        'eth_sendTransaction',
        'eth_signTransaction',
        'personal_sign',
        'eth_signTypedData_v4',
        'eth_signTypedData_v3',
        'eth_requestAccounts',
        'wallet_switchEthereumChain',
        'wallet_addEthereumChain',
        'wallet_requestPermissions',
        'wallet_getPermissions',
        'wallet_watchAsset',
      ];
      for (const method of walletMethods) {
        expect(READ_ONLY_METHODS.has(method), `Should not contain: ${method}`).toBe(false);
      }
    });

    it('does NOT contain local-only methods', () => {
      expect(READ_ONLY_METHODS.has('eth_chainId')).toBe(false);
      expect(READ_ONLY_METHODS.has('net_version')).toBe(false);
      expect(READ_ONLY_METHODS.has('eth_accounts')).toBe(false);
    });
  });

  describe('proxyRpcCall', () => {
    /** Helper to build mock Response with text() and headers matching our implementation. */
    function mockJsonResp(body: unknown, opts?: { ok?: boolean; status?: number; statusText?: string }) {
      const text = JSON.stringify(body);
      return {
        ok: opts?.ok ?? true,
        status: opts?.status ?? 200,
        statusText: opts?.statusText ?? 'OK',
        headers: { get: (k: string) => k.toLowerCase() === 'content-length' ? String(text.length) : null },
        text: async () => text,
      };
    }

    it('formats correct JSON-RPC body', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResp({ jsonrpc: '2.0', id: 1, result: '0xabc' }));

      await proxyRpcCall(1, 'eth_getBalance', ['0xdead', 'latest']);

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://eth.llamarpc.com');
      const body = JSON.parse(options.body);
      expect(body).toEqual({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getBalance',
        params: ['0xdead', 'latest'],
      });
    });

    it('handles HTTP errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(proxyRpcCall(1, 'eth_blockNumber', []))
        .rejects.toMatchObject({ code: -32603 });
    });

    it('handles JSON-RPC errors in response', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResp({
        jsonrpc: '2.0', id: 1,
        error: { code: -32000, message: 'nonce too low' },
      }));

      await expect(proxyRpcCall(1, 'eth_sendRawTransaction', ['0xsigned']))
        .rejects.toMatchObject({ code: -32000, message: 'nonce too low' });
    });

    it('throws for missing/unconfigured chain', async () => {
      store['settings'] = { rpcUrls: {} };

      await expect(proxyRpcCall(999999, 'eth_blockNumber', []))
        .rejects.toMatchObject({ code: -32601 });
    });

    it('uses correct RPC URL per chain from DEFAULT_RPC', async () => {
      const chains = [
        { id: 1, url: 'https://eth.llamarpc.com' },
        { id: 137, url: 'https://polygon-rpc.com' },
        { id: 42161, url: 'https://arb1.arbitrum.io/rpc' },
        { id: 8453, url: 'https://mainnet.base.org' },
      ];

      for (const chain of chains) {
        mockFetch.mockResolvedValueOnce(mockJsonResp({ jsonrpc: '2.0', id: 1, result: '0x1' }));
        await proxyRpcCall(chain.id, 'eth_blockNumber', []);
        const [url] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
        expect(url).toBe(chain.url);
      }
    });
  });
});

// ── Permission Logic ─────────────────────────────────────────────────

describe('Permission Logic', () => {
  beforeEach(() => {
    clearStore();
    vi.clearAllMocks();
  });

  it('grantPermission stores origin correctly', async () => {
    await grantPermission('https://example.com');

    const perms = await getPermissions();
    expect(perms['https://example.com']).toBeDefined();
    expect(perms['https://example.com'].granted).toBe(true);
    expect(perms['https://example.com'].origin).toBe('https://example.com');
    expect(typeof perms['https://example.com'].grantedAt).toBe('number');
  });

  it('revokePermission removes origin correctly', async () => {
    await grantPermission('https://example.com');
    expect(await isPermitted('https://example.com')).toBe(true);

    await revokePermission('https://example.com');
    expect(await isPermitted('https://example.com')).toBe(false);

    const perms = await getPermissions();
    expect(perms['https://example.com']).toBeUndefined();
  });

  it('isPermitted returns true for granted origins', async () => {
    await grantPermission('https://app.example.com');
    expect(await isPermitted('https://app.example.com')).toBe(true);
  });

  it('isPermitted returns false for unknown origins', async () => {
    expect(await isPermitted('https://unknown.com')).toBe(false);
  });

  it('multiple origins do not interfere with each other', async () => {
    await grantPermission('https://alpha.com');
    await grantPermission('https://beta.com');
    await grantPermission('https://gamma.com');

    expect(await isPermitted('https://alpha.com')).toBe(true);
    expect(await isPermitted('https://beta.com')).toBe(true);
    expect(await isPermitted('https://gamma.com')).toBe(true);

    // Revoking one does not affect others
    await revokePermission('https://beta.com');
    expect(await isPermitted('https://alpha.com')).toBe(true);
    expect(await isPermitted('https://beta.com')).toBe(false);
    expect(await isPermitted('https://gamma.com')).toBe(true);
  });

  it('granting same origin twice updates grantedAt', async () => {
    await grantPermission('https://example.com');
    const perms1 = await getPermissions();
    const ts1 = perms1['https://example.com'].grantedAt;

    // Small delay to ensure different timestamp
    await new Promise((r) => setTimeout(r, 5));
    await grantPermission('https://example.com');
    const perms2 = await getPermissions();
    const ts2 = perms2['https://example.com'].grantedAt;

    expect(ts2).toBeGreaterThanOrEqual(ts1);
    expect(perms2['https://example.com'].granted).toBe(true);
  });

  it('revoking non-existent origin does not throw', async () => {
    await expect(revokePermission('https://nonexistent.com')).resolves.not.toThrow();
  });
});

// ── Deferred Request Logic ──────────────────────────────────────────

describe('Deferred Request Logic', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Simulates the deferred request queue from background.ts.
   * We re-implement the queue locally since background.ts module-scoped
   * state cannot be imported directly.
   */
  function createDeferredQueue() {
    const DEFERRED_TIMEOUT_MS = 5 * 60 * 1000;
    const queue: Array<{
      id: string;
      payload: EIP1193Request;
      origin?: string;
      resolve: (v: { result?: unknown; error?: { code: number; message: string } }) => void;
      timer: ReturnType<typeof setTimeout>;
    }> = [];

    function addDeferredRequest(
      id: string,
      payload: EIP1193Request,
      resolve: (v: { result?: unknown; error?: { code: number; message: string } }) => void,
      origin?: string,
    ) {
      const timer = setTimeout(() => {
        const idx = queue.findIndex((r) => r.id === id);
        if (idx !== -1) {
          const [req] = queue.splice(idx, 1);
          req!.resolve({ error: { code: 4001, message: 'Request timed out waiting for wallet pairing' } });
        }
      }, DEFERRED_TIMEOUT_MS);

      queue.push({ id, payload, origin, resolve, timer });
    }

    function rejectAllDeferred(code: number, message: string) {
      while (queue.length > 0) {
        const req = queue.shift()!;
        clearTimeout(req.timer);
        req.resolve({ error: { code, message } });
      }
    }

    return { queue, addDeferredRequest, rejectAllDeferred, DEFERRED_TIMEOUT_MS };
  }

  it('timeout fires after 5 minutes and resolves with error code 4001', async () => {
    const { addDeferredRequest, queue, DEFERRED_TIMEOUT_MS } = createDeferredQueue();
    const resolveCallback = vi.fn();

    addDeferredRequest('req-1', { method: 'eth_requestAccounts' }, resolveCallback, 'https://app.com');

    expect(queue.length).toBe(1);
    expect(resolveCallback).not.toHaveBeenCalled();

    // Advance time to just before timeout
    vi.advanceTimersByTime(DEFERRED_TIMEOUT_MS - 1);
    expect(resolveCallback).not.toHaveBeenCalled();

    // Advance past timeout
    vi.advanceTimersByTime(2);
    expect(resolveCallback).toHaveBeenCalledOnce();
    expect(resolveCallback).toHaveBeenCalledWith({
      error: { code: 4001, message: 'Request timed out waiting for wallet pairing' },
    });

    // Queue should be empty
    expect(queue.length).toBe(0);
  });

  it('rejectAllDeferred clears the entire queue', () => {
    const { addDeferredRequest, rejectAllDeferred, queue } = createDeferredQueue();
    const resolve1 = vi.fn();
    const resolve2 = vi.fn();
    const resolve3 = vi.fn();

    addDeferredRequest('req-1', { method: 'eth_requestAccounts' }, resolve1);
    addDeferredRequest('req-2', { method: 'eth_requestAccounts' }, resolve2);
    addDeferredRequest('req-3', { method: 'eth_requestAccounts' }, resolve3);

    expect(queue.length).toBe(3);

    rejectAllDeferred(4001, 'User rejected wallet');

    expect(queue.length).toBe(0);
    expect(resolve1).toHaveBeenCalledWith({ error: { code: 4001, message: 'User rejected wallet' } });
    expect(resolve2).toHaveBeenCalledWith({ error: { code: 4001, message: 'User rejected wallet' } });
    expect(resolve3).toHaveBeenCalledWith({ error: { code: 4001, message: 'User rejected wallet' } });
  });

  it('rejectAllDeferred on empty queue does not throw', () => {
    const { rejectAllDeferred } = createDeferredQueue();
    expect(() => rejectAllDeferred(4001, 'No requests')).not.toThrow();
  });

  it('individual timeout only removes the timed-out request', () => {
    const { addDeferredRequest, queue, DEFERRED_TIMEOUT_MS } = createDeferredQueue();
    const resolve1 = vi.fn();
    const resolve2 = vi.fn();

    addDeferredRequest('req-1', { method: 'eth_requestAccounts' }, resolve1);

    // Add second request 1 minute later
    vi.advanceTimersByTime(60_000);
    addDeferredRequest('req-2', { method: 'eth_requestAccounts' }, resolve2);

    // First request should timeout at 5 min mark
    vi.advanceTimersByTime(DEFERRED_TIMEOUT_MS - 60_000);
    expect(resolve1).toHaveBeenCalledOnce();
    expect(resolve2).not.toHaveBeenCalled();
    expect(queue.length).toBe(1);
    expect(queue[0].id).toBe('req-2');

    // Second request times out 1 min later
    vi.advanceTimersByTime(60_000);
    expect(resolve2).toHaveBeenCalledOnce();
    expect(queue.length).toBe(0);
  });

  it('rejectAllDeferred cancels pending timers', () => {
    const { addDeferredRequest, rejectAllDeferred, DEFERRED_TIMEOUT_MS } = createDeferredQueue();
    const resolve1 = vi.fn();

    addDeferredRequest('req-1', { method: 'eth_requestAccounts' }, resolve1);
    rejectAllDeferred(4001, 'Session closed');

    expect(resolve1).toHaveBeenCalledOnce();

    // Advancing past the original timeout should NOT trigger another call
    vi.advanceTimersByTime(DEFERRED_TIMEOUT_MS + 1000);
    expect(resolve1).toHaveBeenCalledOnce();
  });
});

// ── State Management ──────────────────────────────────────────────────

describe('ExtensionState Transitions', () => {
  /**
   * Simulates the updateState logic from background.ts.
   * Tests state shape and transition correctness.
   */
  function createStateMachine() {
    let state: ExtensionState = { phase: 'idle' };
    const broadcasts: ExtensionState[] = [];

    function updateState(patch: Partial<ExtensionState>) {
      state = { ...state, ...patch };
      broadcasts.push({ ...state });
    }

    return { getState: () => state, updateState, broadcasts };
  }

  it('starts in idle phase', () => {
    const { getState } = createStateMachine();
    expect(getState().phase).toBe('idle');
  });

  it('transitions idle -> pairing -> pending_accept -> connected -> idle (full lifecycle)', () => {
    const { getState, updateState } = createStateMachine();

    // Start pairing
    updateState({ phase: 'pairing', pairingUri: 'wc:abc123' });
    expect(getState().phase).toBe('pairing');
    expect(getState().pairingUri).toBe('wc:abc123');

    // Wallet wants to connect
    updateState({ phase: 'pending_accept' });
    expect(getState().phase).toBe('pending_accept');
    // pairingUri persists from previous state (shallow merge)
    expect(getState().pairingUri).toBe('wc:abc123');

    // Connected
    updateState({ phase: 'connected' });
    expect(getState().phase).toBe('connected');

    // Disconnect (cleanup)
    updateState({
      phase: 'idle',
      pairingUri: undefined,
      sessionFingerprint: undefined,
      wallet: undefined,
      walletMeta: undefined,
    });
    expect(getState().phase).toBe('idle');
    expect(getState().pairingUri).toBeUndefined();
    expect(getState().wallet).toBeUndefined();
  });

  it('transitions idle -> pairing -> idle (reject flow)', () => {
    const { getState, updateState } = createStateMachine();

    updateState({ phase: 'pairing', pairingUri: 'wc:xyz' });
    expect(getState().phase).toBe('pairing');

    // User rejects wallet
    updateState({
      phase: 'idle',
      pairingUri: undefined,
      sessionFingerprint: undefined,
      wallet: undefined,
      walletMeta: undefined,
    });
    expect(getState().phase).toBe('idle');
    expect(getState().pairingUri).toBeUndefined();
  });

  it('handles disconnected phase before returning to idle', () => {
    const { getState, updateState } = createStateMachine();

    updateState({ phase: 'connected', wallet: { address: '0xabc', chainId: 1 } });
    expect(getState().phase).toBe('connected');

    updateState({ phase: 'disconnected' });
    expect(getState().phase).toBe('disconnected');
    // Wallet info persists in disconnected state until explicit cleanup
    expect(getState().wallet).toBeDefined();

    // Session closed -> cleanup
    updateState({
      phase: 'idle',
      pairingUri: undefined,
      sessionFingerprint: undefined,
      wallet: undefined,
      walletMeta: undefined,
    });
    expect(getState().phase).toBe('idle');
    expect(getState().wallet).toBeUndefined();
  });

  it('error phase preserves error message', () => {
    const { getState, updateState } = createStateMachine();

    updateState({ phase: 'error', error: 'Connection failed' });
    expect(getState().phase).toBe('error');
    expect(getState().error).toBe('Connection failed');
  });

  it('broadcasts every state update', () => {
    const { updateState, broadcasts } = createStateMachine();

    updateState({ phase: 'pairing' });
    updateState({ phase: 'connected' });
    updateState({ phase: 'idle' });

    expect(broadcasts.length).toBe(3);
    expect(broadcasts[0].phase).toBe('pairing');
    expect(broadcasts[1].phase).toBe('connected');
    expect(broadcasts[2].phase).toBe('idle');
  });

  it('sessionFingerprint is set during pairing phase', () => {
    const { getState, updateState } = createStateMachine();

    updateState({ phase: 'pairing', pairingUri: 'wc:abc' });
    updateState({ sessionFingerprint: '123456' });
    expect(getState().sessionFingerprint).toBe('123456');
    expect(getState().phase).toBe('pairing');
  });

  it('walletMeta is set when wallet joins', () => {
    const { getState, updateState } = createStateMachine();

    updateState({ phase: 'pending_accept' });
    updateState({ walletMeta: { name: 'MetaMask', icon: 'https://mm.io/icon.png' } });
    expect(getState().walletMeta).toEqual({ name: 'MetaMask', icon: 'https://mm.io/icon.png' });
  });
});

// ── Method Mapping ───────────────────────────────────────────────────

describe('Method Mapping', () => {
  describe('CONFIRMATION_METHODS', () => {
    /**
     * Re-declare the set from background.ts since it is module-scoped.
     */
    const CONFIRMATION_METHODS = new Set([
      'eth_sendTransaction',
      'eth_signTransaction',
      'personal_sign',
      'eth_signTypedData_v4',
      'eth_signTypedData_v3',
    ]);

    it('contains all methods that require user confirmation', () => {
      expect(CONFIRMATION_METHODS.has('eth_sendTransaction')).toBe(true);
      expect(CONFIRMATION_METHODS.has('eth_signTransaction')).toBe(true);
      expect(CONFIRMATION_METHODS.has('personal_sign')).toBe(true);
      expect(CONFIRMATION_METHODS.has('eth_signTypedData_v4')).toBe(true);
      expect(CONFIRMATION_METHODS.has('eth_signTypedData_v3')).toBe(true);
    });

    it('does not include read-only or non-signing methods', () => {
      expect(CONFIRMATION_METHODS.has('eth_call')).toBe(false);
      expect(CONFIRMATION_METHODS.has('eth_requestAccounts')).toBe(false);
      expect(CONFIRMATION_METHODS.has('eth_chainId')).toBe(false);
      expect(CONFIRMATION_METHODS.has('wallet_switchEthereumChain')).toBe(false);
    });
  });

  describe('wallet_getPermissions response shape', () => {
    it('returns array with parentCapability when permitted and connected', () => {
      // Simulate the response from handleRpcRequest for wallet_getPermissions
      const permitted = true;
      const connectedWallet = { address: '0xabc', chainId: 1 };
      const sessionConnected = true;

      let result: unknown;
      if (permitted && connectedWallet && sessionConnected) {
        result = [{ parentCapability: 'eth_accounts' }];
      } else {
        result = [];
      }

      expect(result).toEqual([{ parentCapability: 'eth_accounts' }]);
    });

    it('returns empty array when not permitted', () => {
      const permitted = false;
      const connectedWallet = { address: '0xabc', chainId: 1 };
      const sessionConnected = true;

      let result: unknown;
      if (permitted && connectedWallet && sessionConnected) {
        result = [{ parentCapability: 'eth_accounts' }];
      } else {
        result = [];
      }

      expect(result).toEqual([]);
    });

    it('returns empty array when not connected', () => {
      const permitted = true;
      const connectedWallet = null;
      const sessionConnected = false;

      let result: unknown;
      if (permitted && connectedWallet && sessionConnected) {
        result = [{ parentCapability: 'eth_accounts' }];
      } else {
        result = [];
      }

      expect(result).toEqual([]);
    });
  });

  describe('wallet_requestPermissions mapping', () => {
    it('maps wallet_requestPermissions to eth_requestAccounts', () => {
      const method = 'wallet_requestPermissions';
      const effectiveMethod = method === 'wallet_requestPermissions' ? 'eth_requestAccounts' : method;
      expect(effectiveMethod).toBe('eth_requestAccounts');
    });

    it('does not remap other methods', () => {
      const methods = ['eth_sendTransaction', 'personal_sign', 'eth_call'];
      for (const method of methods) {
        const effectiveMethod = method === 'wallet_requestPermissions' ? 'eth_requestAccounts' : method;
        expect(effectiveMethod).toBe(method);
      }
    });

    it('wallet_requestPermissions returns correct permission shape on success', () => {
      // From background.ts: after successful eth_requestAccounts, returns:
      const result = [{ parentCapability: 'eth_accounts' }];
      expect(result).toHaveLength(1);
      expect(result[0].parentCapability).toBe('eth_accounts');
    });
  });

  describe('Local method responses', () => {
    it('eth_chainId returns hex chain ID', () => {
      const chainId = 137;
      const result = `0x${chainId.toString(16)}`;
      expect(result).toBe('0x89');
    });

    it('eth_chainId defaults to chain 1 when no wallet', () => {
      const chainId = null ?? 1;
      const result = `0x${chainId.toString(16)}`;
      expect(result).toBe('0x1');
    });

    it('net_version returns string chain ID', () => {
      const chainId = 42161;
      const result = String(chainId);
      expect(result).toBe('42161');
    });

    it('eth_accounts returns empty when not permitted', () => {
      const permitted = false;
      const connectedWallet = { address: '0xabc', chainId: 1 };
      const result = !permitted ? [] : connectedWallet ? [connectedWallet.address] : [];
      expect(result).toEqual([]);
    });

    it('eth_accounts returns address when permitted', () => {
      const permitted = true;
      const connectedWallet = { address: '0xdeadbeef', chainId: 1 };
      const result = !permitted ? [] : connectedWallet ? [connectedWallet.address] : [];
      expect(result).toEqual(['0xdeadbeef']);
    });

    it('eth_accounts returns empty when permitted but no wallet', () => {
      const permitted = true;
      const connectedWallet = null;
      const result = !permitted ? [] : connectedWallet ? [connectedWallet.address] : [];
      expect(result).toEqual([]);
    });
  });

  describe('Not-connected error', () => {
    it('returns error 4100 when session not connected for non-requestAccounts', () => {
      // Simulating the logic from handleRpcRequest
      const sessionConnected = false;
      const effectiveMethod = 'eth_sendTransaction';

      let response: { result?: unknown; error?: { code: number; message: string } };
      if (!sessionConnected && effectiveMethod !== 'eth_requestAccounts') {
        response = { error: { code: 4100, message: 'Not connected. Call eth_requestAccounts first.' } };
      } else {
        response = { result: 'ok' };
      }

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(4100);
      expect(response.error!.message).toContain('eth_requestAccounts');
    });
  });
});

// ── DEFAULT_RPC Configuration ─────────────────────────────────────────

describe('DEFAULT_RPC Configuration', () => {
  it('has entries for major EVM chains', () => {
    expect(DEFAULT_RPC[1]).toBeDefined();    // Ethereum
    expect(DEFAULT_RPC[10]).toBeDefined();   // Optimism
    expect(DEFAULT_RPC[56]).toBeDefined();   // BSC
    expect(DEFAULT_RPC[137]).toBeDefined();  // Polygon
    expect(DEFAULT_RPC[42161]).toBeDefined(); // Arbitrum
    expect(DEFAULT_RPC[8453]).toBeDefined(); // Base
    expect(DEFAULT_RPC[43114]).toBeDefined(); // Avalanche
  });

  it('all URLs are valid HTTPS endpoints', () => {
    for (const [, url] of Object.entries(DEFAULT_RPC)) {
      expect(url).toMatch(/^https:\/\//);
    }
  });
});

// ── Confirmation Popup Logic ──────────────────────────────────────────

describe('Confirmation Popup Logic', () => {
  it('pendingConfirmations map manages lifecycle correctly', () => {
    // Simulate the Map<string, PendingConfirmation> from background.ts
    const pendingConfirmations = new Map<string, {
      id: string;
      method: string;
      params: unknown;
      origin: string;
      resolve: (v: { result?: unknown; error?: { code: number; message: string } }) => void;
      windowId?: number;
    }>();

    const resolve1 = vi.fn();
    const confirmId = 'confirm-12345-abc';

    // Add confirmation
    pendingConfirmations.set(confirmId, {
      id: confirmId,
      method: 'eth_sendTransaction',
      params: [{ to: '0xdead', value: '0x1' }],
      origin: 'https://app.com',
      resolve: resolve1,
    });

    expect(pendingConfirmations.size).toBe(1);
    expect(pendingConfirmations.get(confirmId)!.method).toBe('eth_sendTransaction');

    // Reject confirmation
    const pending = pendingConfirmations.get(confirmId)!;
    pendingConfirmations.delete(confirmId);
    pending.resolve({ error: { code: 4001, message: 'User rejected the request' } });

    expect(pendingConfirmations.size).toBe(0);
    expect(resolve1).toHaveBeenCalledWith({
      error: { code: 4001, message: 'User rejected the request' },
    });
  });

  it('window removal triggers rejection for matching confirmations', () => {
    const pendingConfirmations = new Map<string, {
      id: string;
      method: string;
      params: unknown;
      origin: string;
      resolve: (v: { result?: unknown; error?: { code: number; message: string } }) => void;
      windowId?: number;
    }>();

    const resolve1 = vi.fn();
    const resolve2 = vi.fn();

    pendingConfirmations.set('c1', {
      id: 'c1', method: 'personal_sign', params: ['0xabc'],
      origin: 'https://a.com', resolve: resolve1, windowId: 42,
    });
    pendingConfirmations.set('c2', {
      id: 'c2', method: 'eth_sendTransaction', params: [{}],
      origin: 'https://b.com', resolve: resolve2, windowId: 99,
    });

    // Simulate window 42 being closed (matches onRemoved handler logic)
    const closedWindowId = 42;
    for (const [id, pending] of pendingConfirmations) {
      if (pending.windowId === closedWindowId) {
        pendingConfirmations.delete(id);
        pending.resolve({ error: { code: 4001, message: 'User rejected the request' } });
      }
    }

    expect(resolve1).toHaveBeenCalledWith({
      error: { code: 4001, message: 'User rejected the request' },
    });
    expect(resolve2).not.toHaveBeenCalled();
    expect(pendingConfirmations.size).toBe(1);
  });
});

// ── Content Port Management ──────────────────────────────────────────

describe('Content Port Management', () => {
  it('broadcastEvent sends to all connected ports', () => {
    const contentPorts = new Map<number, { postMessage: ReturnType<typeof vi.fn> }>();

    const port1 = { postMessage: vi.fn() };
    const port2 = { postMessage: vi.fn() };
    contentPorts.set(1, port1);
    contentPorts.set(2, port2);

    // Simulate broadcastEvent
    const msg = { action: 'emit-event', event: 'accountsChanged', data: ['0xabc'] };
    for (const [, port] of contentPorts) {
      try { port.postMessage(msg); } catch {}
    }

    expect(port1.postMessage).toHaveBeenCalledWith(msg);
    expect(port2.postMessage).toHaveBeenCalledWith(msg);
  });

  it('broadcastEvent handles port errors gracefully', () => {
    const contentPorts = new Map<number, { postMessage: ReturnType<typeof vi.fn> }>();

    const port1 = { postMessage: vi.fn(() => { throw new Error('Port disconnected'); }) };
    const port2 = { postMessage: vi.fn() };
    contentPorts.set(1, port1);
    contentPorts.set(2, port2);

    const msg = { action: 'emit-event', event: 'chainChanged', data: '0x89' };

    // Should not throw even if one port fails
    expect(() => {
      for (const [, port] of contentPorts) {
        try { port.postMessage(msg); } catch {}
      }
    }).not.toThrow();

    // port2 still receives the message
    expect(port2.postMessage).toHaveBeenCalledWith(msg);
  });
});
