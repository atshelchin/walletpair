import { describe, it, expect, vi } from 'vitest';

/**
 * Provider compliance tests.
 *
 * The actual provider lives inside provider.content.ts and runs in MAIN world,
 * so we cannot import it directly. Instead, we recreate the core patterns
 * (event emitter, ProviderRpcError, interface shape) and verify they conform
 * to the EIP-1193 / MetaMask compatibility contract.
 */

// ── Minimal reimplementation of the event emitter from provider.content.ts ──

function createProviderLike() {
  const eventListeners = new Map<string, Set<(...args: any[]) => void>>();
  let isConnected = false;
  let accounts: string[] = [];
  let chainId = '0x1';

  // Internal emit — not exposed on the provider object
  function emit(event: string, ...args: any[]) {
    eventListeners.get(event)?.forEach((handler) => {
      try { handler(...args); } catch {}
    });
  }

  const provider: Record<string, any> = {
    isWalletPair: true,

    async request(_args: { method: string; params?: unknown }): Promise<unknown> {
      // Stub — real implementation forwards via postMessage
      return undefined;
    },

    on(event: string, handler: (...args: any[]) => void) {
      if (!eventListeners.has(event)) eventListeners.set(event, new Set());
      eventListeners.get(event)!.add(handler);
      return provider;
    },

    addListener(event: string, handler: (...args: any[]) => void) {
      return provider.on(event, handler);
    },

    removeListener(event: string, handler: (...args: any[]) => void) {
      eventListeners.get(event)?.delete(handler);
      return provider;
    },

    once(event: string, handler: (...args: any[]) => void) {
      const wrapped = (...args: any[]) => {
        provider.removeListener(event, wrapped);
        handler(...args);
      };
      return provider.on(event, wrapped);
    },

    listenerCount(event: string) {
      return eventListeners.get(event)?.size ?? 0;
    },

    removeAllListeners(event?: string) {
      if (event) {
        eventListeners.delete(event);
      } else {
        eventListeners.clear();
      }
      return provider;
    },

    enable() {
      return provider.request({ method: 'eth_requestAccounts' });
    },

    send(methodOrPayload: string | { method: string; params?: unknown[] }, callbackOrParams?: unknown) {
      if (typeof methodOrPayload === 'string') {
        // Synchronous fast-path for cached methods
        const syncMethods: Record<string, () => unknown> = {
          eth_accounts: () => isConnected ? [...accounts] : [],
          eth_chainId: () => chainId,
          net_version: () => String(parseInt(chainId, 16)),
          web3_clientVersion: () => 'WalletPair/0.1.0',
        };
        if (methodOrPayload in syncMethods) {
          return {
            id: 1,
            jsonrpc: '2.0' as const,
            result: syncMethods[methodOrPayload](),
          };
        }
        return provider.request({ method: methodOrPayload, params: callbackOrParams as unknown[] });
      }
      if (typeof callbackOrParams === 'function') {
        provider
          .request({ method: methodOrPayload.method, params: methodOrPayload.params })
          .then((result: unknown) =>
            (callbackOrParams as Function)(null, { id: 1, jsonrpc: '2.0', result }),
          )
          .catch((err: Error) => (callbackOrParams as Function)(err));
        return;
      }
      return provider.request({ method: methodOrPayload.method, params: methodOrPayload.params });
    },

    sendAsync(
      payload: { method: string; params?: unknown[]; id?: number },
      callback: (err: Error | null, result?: unknown) => void,
    ) {
      provider
        .request({ method: payload.method, params: payload.params })
        .then((result: unknown) => callback(null, { id: payload.id, jsonrpc: '2.0', result }))
        .catch((err: Error) => callback(err));
    },

    isConnected() {
      return isConnected;
    },

    _metamask: {
      isUnlocked: () => Promise.resolve(false),
    },

    selectedAddress: null as string | null,
    chainId: '0x1',
    networkVersion: '1',
  };

  return { provider, emit };
}

// ── ProviderRpcError ───────────────────────────────────────────────────

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

// ── Tests ──────────────────────────────────────────────────────────────

describe('Provider interface compliance', () => {
  const { provider } = createProviderLike();

  it('has request() method', () => {
    expect(typeof provider.request).toBe('function');
  });

  it('does not expose emit() publicly', () => {
    expect(provider.emit).toBeUndefined();
  });

  it('has all EventEmitter methods (except emit)', () => {
    const methods = ['on', 'once', 'removeListener', 'addListener', 'removeAllListeners', 'listenerCount'];
    for (const m of methods) {
      expect(typeof provider[m]).toBe('function');
    }
  });

  it('has isConnected() method', () => {
    expect(typeof provider.isConnected).toBe('function');
  });

  it('has enable() legacy method', () => {
    expect(typeof provider.enable).toBe('function');
  });

  it('has send() and sendAsync() legacy methods', () => {
    expect(typeof provider.send).toBe('function');
    expect(typeof provider.sendAsync).toBe('function');
  });

  it('has _metamask.isUnlocked()', () => {
    expect(provider._metamask).toBeDefined();
    expect(typeof provider._metamask.isUnlocked).toBe('function');
  });

  it('has selectedAddress, chainId, networkVersion properties', () => {
    expect('selectedAddress' in provider).toBe(true);
    expect('chainId' in provider).toBe(true);
    expect('networkVersion' in provider).toBe(true);
  });

  it('has isWalletPair flag', () => {
    expect(provider.isWalletPair).toBe(true);
  });
});

describe('Event emitter behavior', () => {
  it('on() registers and internal emit fires handlers', () => {
    const { provider: p, emit } = createProviderLike();
    const handler = vi.fn();

    p.on('accountsChanged', handler);
    emit('accountsChanged', ['0xabc']);

    expect(handler).toHaveBeenCalledWith(['0xabc']);
  });

  it('on() returns provider for chaining', () => {
    const { provider: p } = createProviderLike();
    const result = p.on('connect', () => {});
    expect(result).toBe(p);
  });

  it('addListener() is an alias for on()', () => {
    const { provider: p, emit } = createProviderLike();
    const handler = vi.fn();

    p.addListener('chainChanged', handler);
    emit('chainChanged', '0x89');

    expect(handler).toHaveBeenCalledWith('0x89');
  });

  it('once() auto-removes after first call', () => {
    const { provider: p, emit } = createProviderLike();
    const handler = vi.fn();

    p.once('connect', handler);
    expect(p.listenerCount('connect')).toBe(1);

    emit('connect', { chainId: '0x1' });
    expect(handler).toHaveBeenCalledTimes(1);

    // Should be removed now
    expect(p.listenerCount('connect')).toBe(0);

    emit('connect', { chainId: '0x1' });
    expect(handler).toHaveBeenCalledTimes(1); // Still 1
  });

  it('removeListener() removes a specific handler', () => {
    const { provider: p, emit } = createProviderLike();
    const h1 = vi.fn();
    const h2 = vi.fn();

    p.on('disconnect', h1);
    p.on('disconnect', h2);
    expect(p.listenerCount('disconnect')).toBe(2);

    p.removeListener('disconnect', h1);
    expect(p.listenerCount('disconnect')).toBe(1);

    emit('disconnect', new Error('gone'));
    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalled();
  });

  it('removeAllListeners(event) clears handlers for a specific event', () => {
    const { provider: p } = createProviderLike();
    p.on('accountsChanged', vi.fn());
    p.on('accountsChanged', vi.fn());
    p.on('chainChanged', vi.fn());

    p.removeAllListeners('accountsChanged');

    expect(p.listenerCount('accountsChanged')).toBe(0);
    expect(p.listenerCount('chainChanged')).toBe(1);
  });

  it('removeAllListeners() with no arg clears all events', () => {
    const { provider: p } = createProviderLike();
    p.on('accountsChanged', vi.fn());
    p.on('chainChanged', vi.fn());
    p.on('disconnect', vi.fn());

    p.removeAllListeners();

    expect(p.listenerCount('accountsChanged')).toBe(0);
    expect(p.listenerCount('chainChanged')).toBe(0);
    expect(p.listenerCount('disconnect')).toBe(0);
  });

  it('listenerCount() returns correct count', () => {
    const { provider: p } = createProviderLike();
    expect(p.listenerCount('message')).toBe(0);

    p.on('message', vi.fn());
    expect(p.listenerCount('message')).toBe(1);

    p.on('message', vi.fn());
    expect(p.listenerCount('message')).toBe(2);
  });

  it('internal emit() does not throw when a handler throws', () => {
    const { provider: p, emit } = createProviderLike();
    p.on('connect', () => { throw new Error('oops'); });
    const good = vi.fn();
    p.on('connect', good);

    // Should not throw
    expect(() => emit('connect', { chainId: '0x1' })).not.toThrow();
    expect(good).toHaveBeenCalled();
  });
});

describe('ProviderRpcError', () => {
  it('has code, message, and data properties', () => {
    const err = new ProviderRpcError(4001, 'User rejected', { extra: true });
    expect(err.code).toBe(4001);
    expect(err.message).toBe('User rejected');
    expect(err.data).toEqual({ extra: true });
    expect(err.name).toBe('ProviderRpcError');
  });

  it('extends Error', () => {
    const err = new ProviderRpcError(-32603, 'Internal error');
    expect(err).toBeInstanceOf(Error);
  });

  it('data is optional', () => {
    const err = new ProviderRpcError(4200, 'Unsupported');
    expect(err.data).toBeUndefined();
  });
});

describe('Legacy methods', () => {
  it('enable() calls request with eth_requestAccounts', async () => {
    const { provider: p } = createProviderLike();
    const spy = vi.spyOn(p, 'request').mockResolvedValue(['0xabc']);

    const result = await p.enable();

    expect(spy).toHaveBeenCalledWith({ method: 'eth_requestAccounts' });
    expect(result).toEqual(['0xabc']);
  });

  it('send(eth_chainId) returns synchronous JSON-RPC envelope', () => {
    const { provider: p } = createProviderLike();

    const result = p.send('eth_chainId');

    // Should be synchronous, not a Promise
    expect(result).toEqual({ id: 1, jsonrpc: '2.0', result: '0x1' });
  });

  it('send(net_version) returns synchronous JSON-RPC envelope', () => {
    const { provider: p } = createProviderLike();

    const result = p.send('net_version');

    expect(result).toEqual({ id: 1, jsonrpc: '2.0', result: '1' });
  });

  it('send(eth_accounts) returns synchronous JSON-RPC envelope', () => {
    const { provider: p } = createProviderLike();

    const result = p.send('eth_accounts');

    expect(result).toEqual({ id: 1, jsonrpc: '2.0', result: [] });
  });

  it('send(non-cached method) falls through to request()', async () => {
    const { provider: p } = createProviderLike();
    const spy = vi.spyOn(p, 'request').mockResolvedValue('0xabc');

    const result = await p.send('eth_blockNumber');

    expect(spy).toHaveBeenCalledWith({ method: 'eth_blockNumber', params: undefined });
    expect(result).toBe('0xabc');
  });

  it('send(payload, callback) invokes callback with JSON-RPC envelope', async () => {
    const { provider: p } = createProviderLike();
    vi.spyOn(p, 'request').mockResolvedValue('0x5');

    const callback = vi.fn();
    p.send({ method: 'eth_chainId', params: [] }, callback);

    // Wait for the async resolution
    await new Promise((r) => setTimeout(r, 10));

    expect(callback).toHaveBeenCalledWith(null, { id: 1, jsonrpc: '2.0', result: '0x5' });
  });

  it('sendAsync() invokes callback with JSON-RPC envelope', async () => {
    const { provider: p } = createProviderLike();
    vi.spyOn(p, 'request').mockResolvedValue('0xa');

    const callback = vi.fn();
    p.sendAsync({ method: 'eth_blockNumber', id: 42 }, callback);

    await new Promise((r) => setTimeout(r, 10));

    expect(callback).toHaveBeenCalledWith(null, { id: 42, jsonrpc: '2.0', result: '0xa' });
  });

  it('sendAsync() passes error to callback on failure', async () => {
    const { provider: p } = createProviderLike();
    const error = new Error('fail');
    vi.spyOn(p, 'request').mockRejectedValue(error);

    const callback = vi.fn();
    p.sendAsync({ method: 'eth_blockNumber' }, callback);

    await new Promise((r) => setTimeout(r, 10));

    expect(callback).toHaveBeenCalledWith(error);
  });
});
