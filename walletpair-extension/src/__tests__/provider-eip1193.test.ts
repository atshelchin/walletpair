import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock window for Node environment
if (typeof globalThis.window === 'undefined') {
  const w: any = {
    postMessage: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    location: { origin: 'http://localhost:3000' },
  };
  (globalThis as any).window = w;
}

/**
 * EIP-1193 provider logic tests.
 *
 * The provider lives inside provider.content.ts's main() and cannot be imported.
 * We recreate the logic patterns and test them in isolation.
 */

// ── ProviderRpcError (mirrored from provider.content.ts) ──

class ProviderRpcError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
    this.name = 'ProviderRpcError';
  }
}

// ── Unsupported methods set (mirrored) ──

const UNSUPPORTED_METHODS = new Set([
  'eth_getEncryptionPublicKey',
  'eth_decrypt',
  'eth_sign',
]);

// ── Full provider factory (mirrors provider.content.ts logic) ──

function createFullProvider(postMessageFn?: (...args: any[]) => void) {
  const MSG_CHANNEL = 'walletpair-ext';
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let reqCounter = 0;
  const eventListeners = new Map<string, Set<(...args: any[]) => void>>();
  let accounts: string[] = [];
  let chainId = '0x1';
  let isConnected = false;

  // Use injected mock instead of window.postMessage (node env has no window)
  const _postMessage = postMessageFn ?? vi.fn();

  const provider: Record<string, any> = {
    isWalletPair: true,

    async request(args: { method: string; params?: unknown }): Promise<unknown> {
      const { method, params } = args;

      if (UNSUPPORTED_METHODS.has(method)) {
        throw new ProviderRpcError(4200, `${method} is not supported`);
      }

      if (method === 'eth_accounts') {
        return isConnected ? [...accounts] : [];
      }
      if (method === 'eth_chainId') {
        return chainId;
      }
      if (method === 'net_version') {
        return String(parseInt(chainId, 16));
      }
      if (method === 'web3_clientVersion') {
        return 'WalletPair/0.1.0';
      }

      // Forward via postMessage
      const id = `wp-${++reqCounter}-${Date.now()}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        _postMessage(
          { type: 'wp-request', id, payload: { method, params }, channel: MSG_CHANNEL },
          '*',
        );
      });
    },

    on(event: string, handler: (...args: any[]) => void) {
      if (!eventListeners.has(event)) eventListeners.set(event, new Set());
      eventListeners.get(event)!.add(handler);
      return provider;
    },

    removeListener(event: string, handler: (...args: any[]) => void) {
      eventListeners.get(event)?.delete(handler);
      return provider;
    },

    emit(event: string, ...args: any[]) {
      eventListeners.get(event)?.forEach((handler) => {
        try { handler(...args); } catch {}
      });
    },

    isConnected() {
      return isConnected;
    },

    selectedAddress: null as string | null,
    chainId,
    networkVersion: '1',
  };

  // Simulate handling of wp-event messages (mirrors the window message listener)
  function simulateEvent(evtName: string, data: unknown) {
    if (evtName === 'accountsChanged' && Array.isArray(data)) {
      accounts = data;
      provider.selectedAddress = accounts[0] ?? null;
      provider.emit('accountsChanged', accounts);
    } else if (evtName === 'chainChanged') {
      chainId = typeof data === 'string' ? data : `0x${Number(data).toString(16)}`;
      provider.chainId = chainId;
      provider.networkVersion = String(parseInt(chainId, 16));
      provider.emit('chainChanged', chainId);
    } else if (evtName === 'disconnect') {
      isConnected = false;
      accounts = [];
      provider.selectedAddress = null;
      provider.emit('disconnect', new ProviderRpcError(4900, 'Disconnected'));
    } else if (evtName === 'connect') {
      if (!isConnected) {
        isConnected = true;
        provider.emit('connect', { chainId });
      }
    }
  }

  // Simulate handling of wp-response for eth_requestAccounts
  function simulateAccountsResponse(result: string[]) {
    if (Array.isArray(result) && result.length > 0) {
      accounts = result;
      provider.selectedAddress = accounts[0];
      if (!isConnected) {
        isConnected = true;
        provider.emit('connect', { chainId });
      }
      provider.emit('accountsChanged', accounts);
    }
  }

  return { provider, simulateEvent, simulateAccountsResponse, pending, _postMessage };
}

// ── Tests ──

describe('ProviderRpcError class', () => {
  it('sets code, message, data, name correctly', () => {
    const err = new ProviderRpcError(4001, 'User rejected', { reason: 'denied' });
    expect(err.code).toBe(4001);
    expect(err.message).toBe('User rejected');
    expect(err.data).toEqual({ reason: 'denied' });
    expect(err.name).toBe('ProviderRpcError');
  });

  it('name is always "ProviderRpcError"', () => {
    const err1 = new ProviderRpcError(4200, 'Unsupported');
    const err2 = new ProviderRpcError(-32603, 'Internal error');
    const err3 = new ProviderRpcError(4900, 'Disconnected');
    expect(err1.name).toBe('ProviderRpcError');
    expect(err2.name).toBe('ProviderRpcError');
    expect(err3.name).toBe('ProviderRpcError');
  });

  it('data is undefined when not provided', () => {
    const err = new ProviderRpcError(4200, 'Unsupported');
    expect(err.data).toBeUndefined();
  });

  it('is instanceof Error', () => {
    const err = new ProviderRpcError(4001, 'Rejected');
    expect(err).toBeInstanceOf(Error);
    expect(err instanceof Error).toBe(true);
  });

  it('has a proper stack trace', () => {
    const err = new ProviderRpcError(4001, 'Rejected');
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain('ProviderRpcError');
  });
});

describe('Unsupported method handling', () => {
  it('eth_sign is in the UNSUPPORTED set', () => {
    expect(UNSUPPORTED_METHODS.has('eth_sign')).toBe(true);
  });

  it('eth_decrypt is in the UNSUPPORTED set', () => {
    expect(UNSUPPORTED_METHODS.has('eth_decrypt')).toBe(true);
  });

  it('eth_getEncryptionPublicKey is in the UNSUPPORTED set', () => {
    expect(UNSUPPORTED_METHODS.has('eth_getEncryptionPublicKey')).toBe(true);
  });

  it('common methods are NOT in the UNSUPPORTED set', () => {
    expect(UNSUPPORTED_METHODS.has('eth_sendTransaction')).toBe(false);
    expect(UNSUPPORTED_METHODS.has('eth_accounts')).toBe(false);
    expect(UNSUPPORTED_METHODS.has('personal_sign')).toBe(false);
  });

  it('request() throws ProviderRpcError with code 4200 for unsupported methods', async () => {
    const { provider } = createFullProvider();

    for (const method of ['eth_sign', 'eth_decrypt', 'eth_getEncryptionPublicKey']) {
      await expect(provider.request({ method })).rejects.toThrow(`${method} is not supported`);
      try {
        await provider.request({ method });
      } catch (err: any) {
        expect(err).toBeInstanceOf(ProviderRpcError);
        expect(err.code).toBe(4200);
      }
    }
  });
});

describe('Request routing logic', () => {
  it('eth_chainId returns cached hex string locally', async () => {
    const { provider } = createFullProvider();
    const result = await provider.request({ method: 'eth_chainId' });
    expect(result).toBe('0x1');
  });

  it('net_version returns cached decimal string locally', async () => {
    const { provider } = createFullProvider();
    const result = await provider.request({ method: 'net_version' });
    expect(result).toBe('1');
  });

  it('web3_clientVersion returns WalletPair version string', async () => {
    const { provider } = createFullProvider();
    const result = await provider.request({ method: 'web3_clientVersion' });
    expect(result).toBe('WalletPair/0.1.0');
  });

  it('eth_accounts returns [] when disconnected', async () => {
    const { provider } = createFullProvider();
    const result = await provider.request({ method: 'eth_accounts' });
    expect(result).toEqual([]);
  });

  it('eth_accounts returns cached accounts when connected', async () => {
    const { provider, simulateEvent } = createFullProvider();

    // Connect and set accounts
    simulateEvent('connect', undefined);
    simulateEvent('accountsChanged', ['0xabc123']);

    const result = await provider.request({ method: 'eth_accounts' });
    expect(result).toEqual(['0xabc123']);
  });

  it('eth_accounts returns a copy of accounts (not the same reference)', async () => {
    const { provider, simulateEvent } = createFullProvider();
    simulateEvent('connect', undefined);
    simulateEvent('accountsChanged', ['0xabc123']);

    const result1 = await provider.request({ method: 'eth_accounts' });
    const result2 = await provider.request({ method: 'eth_accounts' });
    expect(result1).toEqual(result2);
    expect(result1).not.toBe(result2); // different array instances
  });

  it('other methods forward via postMessage', async () => {
    const mockPostMessage = vi.fn();
    const { provider, pending } = createFullProvider(mockPostMessage);

    // Start the request (it won't resolve because postMessage is mocked)
    const promise = provider.request({ method: 'eth_sendTransaction', params: [{ to: '0x123' }] });

    // Verify postMessage was called
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'wp-request',
        channel: 'walletpair-ext',
        payload: { method: 'eth_sendTransaction', params: [{ to: '0x123' }] },
      }),
      '*',
    );

    // Verify a pending entry was created
    expect(pending.size).toBe(1);

    // Resolve the pending to clean up
    const [id] = [...pending.keys()];
    pending.get(id)!.resolve('0xtxhash');
    pending.delete(id);

    const result = await promise;
    expect(result).toBe('0xtxhash');
  });
});

describe('State update logic', () => {
  it('accountsChanged updates accounts and selectedAddress', () => {
    const { provider, simulateEvent } = createFullProvider();
    const handler = vi.fn();
    provider.on('accountsChanged', handler);

    simulateEvent('accountsChanged', ['0xnewaccount']);

    expect(handler).toHaveBeenCalledWith(['0xnewaccount']);
    expect(provider.selectedAddress).toBe('0xnewaccount');
  });

  it('accountsChanged with empty array sets selectedAddress to null', () => {
    const { provider, simulateEvent } = createFullProvider();
    simulateEvent('accountsChanged', ['0xabc']);
    expect(provider.selectedAddress).toBe('0xabc');

    simulateEvent('accountsChanged', []);
    expect(provider.selectedAddress).toBeNull();
  });

  it('chainChanged updates chainId and networkVersion', () => {
    const { provider, simulateEvent } = createFullProvider();
    const handler = vi.fn();
    provider.on('chainChanged', handler);

    simulateEvent('chainChanged', '0x89'); // Polygon

    expect(handler).toHaveBeenCalledWith('0x89');
    expect(provider.chainId).toBe('0x89');
    expect(provider.networkVersion).toBe('137');
  });

  it('chainChanged handles numeric data by converting to hex', () => {
    const { provider, simulateEvent } = createFullProvider();

    simulateEvent('chainChanged', 56); // BSC as number

    expect(provider.chainId).toBe('0x38');
    expect(provider.networkVersion).toBe('56');
  });

  it('disconnect clears accounts, selectedAddress, and isConnected', () => {
    const { provider, simulateEvent } = createFullProvider();
    const disconnectHandler = vi.fn();
    provider.on('disconnect', disconnectHandler);

    // First connect
    simulateEvent('connect', undefined);
    simulateEvent('accountsChanged', ['0xabc']);
    expect(provider.isConnected()).toBe(true);

    // Then disconnect
    simulateEvent('disconnect', undefined);

    expect(provider.isConnected()).toBe(false);
    expect(provider.selectedAddress).toBeNull();
    expect(disconnectHandler).toHaveBeenCalledTimes(1);
    const errArg = disconnectHandler.mock.calls[0][0];
    expect(errArg).toBeInstanceOf(ProviderRpcError);
    expect(errArg.code).toBe(4900);
  });

  it('connect event only fires on disconnected-to-connected transition', () => {
    const { provider, simulateEvent } = createFullProvider();
    const connectHandler = vi.fn();
    provider.on('connect', connectHandler);

    // First connect
    simulateEvent('connect', undefined);
    expect(connectHandler).toHaveBeenCalledTimes(1);

    // Second connect while already connected -- should NOT fire
    simulateEvent('connect', undefined);
    expect(connectHandler).toHaveBeenCalledTimes(1);
  });

  it('connect fires again after disconnect-then-connect', () => {
    const { provider, simulateEvent } = createFullProvider();
    const connectHandler = vi.fn();
    provider.on('connect', connectHandler);

    simulateEvent('connect', undefined);
    expect(connectHandler).toHaveBeenCalledTimes(1);

    simulateEvent('disconnect', undefined);

    simulateEvent('connect', undefined);
    expect(connectHandler).toHaveBeenCalledTimes(2);
  });

  it('eth_requestAccounts response triggers connect on first call', () => {
    const { provider, simulateAccountsResponse } = createFullProvider();
    const connectHandler = vi.fn();
    const accountsHandler = vi.fn();
    provider.on('connect', connectHandler);
    provider.on('accountsChanged', accountsHandler);

    simulateAccountsResponse(['0xdeadbeef']);

    expect(connectHandler).toHaveBeenCalledTimes(1);
    expect(accountsHandler).toHaveBeenCalledWith(['0xdeadbeef']);
    expect(provider.selectedAddress).toBe('0xdeadbeef');
  });

  it('eth_requestAccounts response does not re-emit connect when already connected', () => {
    const { provider, simulateAccountsResponse } = createFullProvider();
    const connectHandler = vi.fn();
    provider.on('connect', connectHandler);

    simulateAccountsResponse(['0xfirst']);
    simulateAccountsResponse(['0xsecond']);

    expect(connectHandler).toHaveBeenCalledTimes(1);
  });

  it('net_version reflects updated chain after chainChanged', async () => {
    const { provider, simulateEvent } = createFullProvider();

    simulateEvent('chainChanged', '0xa'); // chain 10
    const version = await provider.request({ method: 'net_version' });
    expect(version).toBe('10');
  });

  it('eth_chainId reflects updated chain after chainChanged', async () => {
    const { provider, simulateEvent } = createFullProvider();

    simulateEvent('chainChanged', '0x89');
    const result = await provider.request({ method: 'eth_chainId' });
    expect(result).toBe('0x89');
  });
});

describe('window.ethereum injection logic', () => {
  let originalEthereum: any;

  beforeEach(() => {
    originalEthereum = (window as any).ethereum;
    // Clean up
    try {
      delete (window as any).ethereum;
    } catch {
      Object.defineProperty(window, 'ethereum', { value: undefined, writable: true, configurable: true });
    }
  });

  afterEach(() => {
    try {
      delete (window as any).ethereum;
    } catch {
      Object.defineProperty(window, 'ethereum', { value: undefined, writable: true, configurable: true });
    }
    if (originalEthereum !== undefined) {
      (window as any).ethereum = originalEthereum;
    }
  });

  it('claims window.ethereum when no existing provider', () => {
    const provider = { isWalletPair: true };

    // Simulate the injection logic from provider.content.ts
    const existingProvider = (window as any).ethereum;
    if (!existingProvider) {
      Object.defineProperty(window, 'ethereum', {
        value: provider,
        writable: false,
        configurable: true,
      });
    }

    expect((window as any).ethereum).toBe(provider);
    expect((window as any).ethereum.isWalletPair).toBe(true);
  });

  it('uses providers[] array pattern when existing provider exists', () => {
    const existingProvider: any = { isMetaMask: true };
    (window as any).ethereum = existingProvider;

    const walletPairProvider = { isWalletPair: true };

    // Simulate the injection logic
    const existing = (window as any).ethereum;
    if (existing) {
      if (!existing.providers) {
        existing.providers = [existing];
      }
      existing.providers.push(walletPairProvider);
    }

    expect((window as any).ethereum.providers).toBeDefined();
    expect((window as any).ethereum.providers).toHaveLength(2);
    expect((window as any).ethereum.providers[0]).toBe(existingProvider);
    expect((window as any).ethereum.providers[1]).toBe(walletPairProvider);
  });

  it('appends to existing providers[] array if already present', () => {
    const first: any = { isFirst: true };
    const second: any = { isSecond: true };
    const existingProvider: any = { providers: [first, second] };
    (window as any).ethereum = existingProvider;

    const walletPairProvider = { isWalletPair: true };

    const existing = (window as any).ethereum;
    if (existing) {
      if (!existing.providers) {
        existing.providers = [existing];
      }
      existing.providers.push(walletPairProvider);
    }

    expect((window as any).ethereum.providers).toHaveLength(3);
    expect((window as any).ethereum.providers[2]).toBe(walletPairProvider);
  });
});

describe('EIP-6963 announcement', () => {
  const PROVIDER_UUID = 'e3a10000-7770-4270-8000-000077700001';

  const icon =
    'data:image/svg+xml,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="24" fill="#6366f1"/><path d="M27 48 L48 27 L69 48 L48 69Z" fill="white" opacity="0.9"/><circle cx="48" cy="48" r="9" fill="#6366f1"/></svg>`,
    );

  const info = Object.freeze({
    uuid: PROVIDER_UUID,
    name: 'WalletPair',
    icon,
    rdns: 'org.walletpair.extension',
  });

  it('info has correct uuid', () => {
    expect(info.uuid).toBe('e3a10000-7770-4270-8000-000077700001');
  });

  it('info has correct name', () => {
    expect(info.name).toBe('WalletPair');
  });

  it('icon is a data:image/svg+xml URI', () => {
    expect(info.icon).toMatch(/^data:image\/svg\+xml,/);
  });

  it('rdns is org.walletpair.extension', () => {
    expect(info.rdns).toBe('org.walletpair.extension');
  });

  it('info object is frozen', () => {
    expect(Object.isFrozen(info)).toBe(true);
  });

  it('detail object is frozen', () => {
    const provider = { isWalletPair: true };
    const detail = Object.freeze({ info, provider });
    expect(Object.isFrozen(detail)).toBe(true);
  });

  it('info object has exactly the EIP-6963 required fields', () => {
    const keys = Object.keys(info).sort();
    expect(keys).toEqual(['icon', 'name', 'rdns', 'uuid']);
  });

  it('detail contains both info and provider', () => {
    const provider = { isWalletPair: true };
    const detail = Object.freeze({ info, provider });
    expect(detail.info).toBe(info);
    expect(detail.provider).toBe(provider);
  });
});
