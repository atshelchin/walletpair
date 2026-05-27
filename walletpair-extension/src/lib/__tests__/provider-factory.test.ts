import { describe, it, expect, vi } from 'vitest';
import {
  createProvider,
  ProviderRpcError,
  UNSUPPORTED_METHODS,
  PROVIDER_INFO,
} from '../provider-factory.js';

function setup() {
  const postMessage = vi.fn();
  const result = createProvider(postMessage);
  return { ...result, postMessage };
}

// ── ProviderRpcError ────────────────────────────────────────────────

describe('ProviderRpcError', () => {
  it('sets code, message, data, name', () => {
    const err = new ProviderRpcError(4001, 'Rejected', { reason: 'denied' });
    expect(err.code).toBe(4001);
    expect(err.message).toBe('Rejected');
    expect(err.data).toEqual({ reason: 'denied' });
    expect(err.name).toBe('ProviderRpcError');
  });

  it('is instanceof Error', () => {
    expect(new ProviderRpcError(4001, 'x')).toBeInstanceOf(Error);
  });

  it('data is undefined when omitted', () => {
    expect(new ProviderRpcError(4200, 'x').data).toBeUndefined();
  });
});

// ── Unsupported methods ─────────────────────────────────────────────

describe('UNSUPPORTED_METHODS', () => {
  it('contains deprecated methods', () => {
    expect(UNSUPPORTED_METHODS.has('eth_sign')).toBe(true);
    expect(UNSUPPORTED_METHODS.has('eth_decrypt')).toBe(true);
    expect(UNSUPPORTED_METHODS.has('eth_getEncryptionPublicKey')).toBe(true);
  });

  it('does not contain common methods', () => {
    expect(UNSUPPORTED_METHODS.has('eth_sendTransaction')).toBe(false);
    expect(UNSUPPORTED_METHODS.has('eth_accounts')).toBe(false);
  });
});

// ── request() — local fast paths ────────────────────────────────────

describe('request() local methods', () => {
  it('eth_chainId returns cached value', async () => {
    const { provider } = setup();
    expect(await provider.request({ method: 'eth_chainId' })).toBe('0x1');
  });

  it('net_version returns decimal', async () => {
    const { provider } = setup();
    expect(await provider.request({ method: 'net_version' })).toBe('1');
  });

  it('web3_clientVersion returns WalletPair', async () => {
    const { provider } = setup();
    expect(await provider.request({ method: 'web3_clientVersion' })).toBe('WalletPair/0.1.0');
  });

  it('eth_accounts returns [] when disconnected', async () => {
    const { provider } = setup();
    expect(await provider.request({ method: 'eth_accounts' })).toEqual([]);
  });

  it('eth_accounts returns copy of accounts when connected', async () => {
    const { provider, handleMessage } = setup();
    handleMessage({ channel: 'walletpair-ext', type: 'wp-event', event: 'connect', data: undefined });
    handleMessage({ channel: 'walletpair-ext', type: 'wp-event', event: 'accountsChanged', data: ['0xabc'] });

    const r1 = await provider.request({ method: 'eth_accounts' });
    const r2 = await provider.request({ method: 'eth_accounts' });
    expect(r1).toEqual(['0xabc']);
    expect(r1).not.toBe(r2); // distinct copies
  });

  it('rejects unsupported methods with code 4200', async () => {
    const { provider } = setup();
    for (const method of ['eth_sign', 'eth_decrypt', 'eth_getEncryptionPublicKey']) {
      try {
        await provider.request({ method });
        throw new Error('should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ProviderRpcError);
        expect(err.code).toBe(4200);
      }
    }
  });
});

// ── request() — forwarding via postMessage ──────────────────────────

describe('request() forwarding', () => {
  it('sends wp-request via postMessage for unknown methods', async () => {
    const { provider, postMessage, pending } = setup();

    const promise = provider.request({ method: 'eth_sendTransaction', params: [{ to: '0x1' }] });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'wp-request',
        channel: 'walletpair-ext',
        payload: { method: 'eth_sendTransaction', params: [{ to: '0x1' }] },
      }),
      '*',
    );
    expect(pending.size).toBe(1);

    // Resolve to cleanup
    const [id] = [...pending.keys()];
    pending.get(id)!.resolve('0xhash');
    pending.delete(id);
    expect(await promise).toBe('0xhash');
  });
});

// ── handleMessage — wp-response ─────────────────────────────────────

describe('handleMessage wp-response', () => {
  it('resolves pending request on success', async () => {
    const { provider, postMessage, handleMessage, pending } = setup();

    const promise = provider.request({ method: 'eth_blockNumber' });
    const [id] = [...pending.keys()];

    handleMessage({
      channel: 'walletpair-ext',
      type: 'wp-response',
      id,
      result: '0x1234',
    });

    expect(await promise).toBe('0x1234');
  });

  it('rejects pending request on error', async () => {
    const { provider, handleMessage, pending } = setup();

    const promise = provider.request({ method: 'eth_blockNumber' });
    const [id] = [...pending.keys()];

    handleMessage({
      channel: 'walletpair-ext',
      type: 'wp-response',
      id,
      error: { code: -32000, message: 'Server error' },
    });

    try {
      await promise;
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(ProviderRpcError);
      expect(err.code).toBe(-32000);
      expect(err.message).toBe('Server error');
    }
  });

  it('eth_requestAccounts response triggers connect + accountsChanged', () => {
    const { provider, handleMessage, pending } = setup();
    const connectHandler = vi.fn();
    const accountsHandler = vi.fn();
    provider.on('connect', connectHandler);
    provider.on('accountsChanged', accountsHandler);

    // Create a fake pending entry (simulating provider.request)
    pending.set('test-id', { resolve: vi.fn(), reject: vi.fn() });

    handleMessage({
      channel: 'walletpair-ext',
      type: 'wp-response',
      id: 'test-id',
      method: 'eth_requestAccounts',
      result: ['0xdeadbeef'],
    });

    expect(connectHandler).toHaveBeenCalledTimes(1);
    expect(accountsHandler).toHaveBeenCalledWith(['0xdeadbeef']);
    expect(provider.selectedAddress).toBe('0xdeadbeef');
  });

  it('ignores messages with wrong channel', () => {
    const { handleMessage, pending } = setup();
    pending.set('x', { resolve: vi.fn(), reject: vi.fn() });
    handleMessage({ channel: 'other', type: 'wp-response', id: 'x', result: 'ok' });
    expect(pending.has('x')).toBe(true); // not consumed
  });
});

// ── handleMessage — wp-event ────────────────────────────────────────

describe('handleMessage wp-event', () => {
  it('accountsChanged updates state and emits', () => {
    const { provider, handleMessage } = setup();
    const handler = vi.fn();
    provider.on('accountsChanged', handler);

    handleMessage({ channel: 'walletpair-ext', type: 'wp-event', event: 'accountsChanged', data: ['0xnew'] });
    expect(handler).toHaveBeenCalledWith(['0xnew']);
    expect(provider.selectedAddress).toBe('0xnew');
  });

  it('chainChanged updates chainId and networkVersion', () => {
    const { provider, handleMessage } = setup();
    const handler = vi.fn();
    provider.on('chainChanged', handler);

    handleMessage({ channel: 'walletpair-ext', type: 'wp-event', event: 'chainChanged', data: '0x89' });
    expect(handler).toHaveBeenCalledWith('0x89');
    expect(provider.chainId).toBe('0x89');
    expect(provider.networkVersion).toBe('137');
  });

  it('chainChanged handles numeric data', () => {
    const { provider, handleMessage } = setup();
    handleMessage({ channel: 'walletpair-ext', type: 'wp-event', event: 'chainChanged', data: 56 });
    expect(provider.chainId).toBe('0x38');
  });

  it('disconnect clears state', () => {
    const { provider, handleMessage } = setup();
    const handler = vi.fn();
    provider.on('disconnect', handler);

    // Connect first
    handleMessage({ channel: 'walletpair-ext', type: 'wp-event', event: 'connect', data: undefined });
    handleMessage({ channel: 'walletpair-ext', type: 'wp-event', event: 'accountsChanged', data: ['0xa'] });
    expect(provider.isConnected()).toBe(true);

    // Disconnect
    handleMessage({ channel: 'walletpair-ext', type: 'wp-event', event: 'disconnect', data: undefined });
    expect(provider.isConnected()).toBe(false);
    expect(provider.selectedAddress).toBeNull();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toBeInstanceOf(ProviderRpcError);
    expect(handler.mock.calls[0][0].code).toBe(4900);
  });

  it('connect only fires on transition', () => {
    const { provider, handleMessage } = setup();
    const handler = vi.fn();
    provider.on('connect', handler);

    handleMessage({ channel: 'walletpair-ext', type: 'wp-event', event: 'connect', data: undefined });
    handleMessage({ channel: 'walletpair-ext', type: 'wp-event', event: 'connect', data: undefined });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('message event is forwarded', () => {
    const { provider, handleMessage } = setup();
    const handler = vi.fn();
    provider.on('message', handler);

    handleMessage({ channel: 'walletpair-ext', type: 'wp-event', event: 'message', data: { type: 'eth_subscription', data: {} } });
    expect(handler).toHaveBeenCalledWith({ type: 'eth_subscription', data: {} });
  });
});

// ── handleMessage — wp-init-state ───────────────────────────────────

describe('handleMessage wp-init-state', () => {
  it('restores state from init message', async () => {
    const { provider, handleMessage } = setup();
    const connectHandler = vi.fn();
    provider.on('connect', connectHandler);

    handleMessage({
      channel: 'walletpair-ext',
      type: 'wp-init-state',
      connected: true,
      accounts: ['0xrestored'],
      chainId: '0xa',
    });

    expect(provider.isConnected()).toBe(true);
    expect(provider.selectedAddress).toBe('0xrestored');
    expect(provider.chainId).toBe('0xa');
    expect(provider.networkVersion).toBe('10');
    expect(connectHandler).toHaveBeenCalledTimes(1);

    expect(await provider.request({ method: 'eth_accounts' })).toEqual(['0xrestored']);
    expect(await provider.request({ method: 'eth_chainId' })).toBe('0xa');
  });

  it('ignores init with no accounts', () => {
    const { provider, handleMessage } = setup();
    handleMessage({ channel: 'walletpair-ext', type: 'wp-init-state', connected: true, accounts: [], chainId: '0x1' });
    expect(provider.isConnected()).toBe(false);
  });
});

// ── Event listener methods ──────────────────────────────────────────

describe('event listener API', () => {
  it('on() returns provider for chaining', () => {
    const { provider } = setup();
    expect(provider.on('connect', () => {})).toBe(provider);
  });

  it('addListener() is alias for on()', () => {
    const { provider } = setup();
    const handler = vi.fn();
    provider.addListener('test', handler);
    expect(provider.listenerCount('test')).toBe(1);
  });

  it('once() fires handler only once', () => {
    const { provider, handleMessage } = setup();
    const handler = vi.fn();
    provider.once('chainChanged', handler);

    handleMessage({ channel: 'walletpair-ext', type: 'wp-event', event: 'chainChanged', data: '0x5' });
    handleMessage({ channel: 'walletpair-ext', type: 'wp-event', event: 'chainChanged', data: '0x6' });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('0x5');
  });

  it('removeAllListeners(event) removes only that event', () => {
    const { provider } = setup();
    provider.on('a', () => {});
    provider.on('b', () => {});

    provider.removeAllListeners('a');
    expect(provider.listenerCount('a')).toBe(0);
    expect(provider.listenerCount('b')).toBe(1);
  });

  it('removeAllListeners() removes all', () => {
    const { provider } = setup();
    provider.on('a', () => {});
    provider.on('b', () => {});

    provider.removeAllListeners();
    expect(provider.listenerCount('a')).toBe(0);
    expect(provider.listenerCount('b')).toBe(0);
  });
});

// ── Legacy methods ──────────────────────────────────────────────────

describe('legacy methods', () => {
  it('send() returns sync response for cached methods', () => {
    const { provider } = setup();
    const result = provider.send('eth_chainId');
    expect(result).toEqual({ id: 1, jsonrpc: '2.0', result: '0x1' });
  });

  it('send() forwards unknown methods as promise', async () => {
    const { provider, pending } = setup();
    const promise = provider.send('eth_blockNumber');
    const [id] = [...pending.keys()];
    pending.get(id)!.resolve('0xff');
    pending.delete(id);
    expect(await promise).toBe('0xff');
  });

  it('send(payload, callback) calls back with result', async () => {
    const { provider, pending } = setup();
    const cb = vi.fn();
    provider.send({ method: 'eth_blockNumber' }, cb);

    const [id] = [...pending.keys()];
    pending.get(id)!.resolve('0xff');
    pending.delete(id);

    // Wait for promise chain
    await new Promise((r) => setTimeout(r, 0));
    expect(cb).toHaveBeenCalledWith(null, expect.objectContaining({ result: '0xff' }));
  });

  it('sendAsync calls back with result', async () => {
    const { provider, pending } = setup();
    const cb = vi.fn();
    provider.sendAsync({ method: 'eth_blockNumber', id: 42 }, cb);

    const [id] = [...pending.keys()];
    pending.get(id)!.resolve('0xff');
    pending.delete(id);

    await new Promise((r) => setTimeout(r, 0));
    expect(cb).toHaveBeenCalledWith(null, expect.objectContaining({ id: 42, result: '0xff' }));
  });

  it('_metamask.isUnlocked reflects connection state', async () => {
    const { provider, handleMessage } = setup();
    expect(await provider._metamask.isUnlocked()).toBe(false);

    handleMessage({ channel: 'walletpair-ext', type: 'wp-event', event: 'connect', data: undefined });
    expect(await provider._metamask.isUnlocked()).toBe(true);
  });
});

// ── PROVIDER_INFO ───────────────────────────────────────────────────

describe('PROVIDER_INFO', () => {
  it('has correct EIP-6963 fields', () => {
    expect(PROVIDER_INFO.uuid).toBe('e3a10000-7770-4270-8000-000077700001');
    expect(PROVIDER_INFO.name).toBe('WalletPair');
    expect(PROVIDER_INFO.rdns).toBe('org.walletpair.extension');
    expect(PROVIDER_INFO.icon).toMatch(/^data:image\/svg\+xml,/);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(PROVIDER_INFO)).toBe(true);
  });
});
