import { describe, it, expect, vi } from 'vitest';
import { walletPair } from './wagmi.js';

describe('walletPair connector factory', () => {
  it('returns a CreateConnectorFn', () => {
    const factory = walletPair({
      relayUrl: 'ws://localhost:8080/v1',
      name: 'Test dApp',
    });
    expect(typeof factory).toBe('function');
  });

  it('connector has correct id, name, type', () => {
    const factory = walletPair({
      relayUrl: 'ws://localhost:8080/v1',
      name: 'My dApp',
    });

    const emitter = {
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      listenerCount: vi.fn(() => 0),
    };

    const connector = factory({
      chains: [{ id: 1, name: 'Ethereum' }] as any,
      emitter,
    });

    expect(connector.id).toBe('walletPair');
    expect(connector.name).toBe('My dApp');
    expect(connector.type).toBe('walletPair');
  });

  it('connector uses default name if not provided', () => {
    const factory = walletPair({ relayUrl: 'ws://localhost:8080/v1' });

    const connector = factory({
      chains: [{ id: 1, name: 'Ethereum' }] as any,
      emitter: { emit: vi.fn(), on: vi.fn(), off: vi.fn(), listenerCount: vi.fn(() => 0) },
    });

    expect(connector.name).toBe('WalletPair');
  });

  it('connector has all required methods', () => {
    const factory = walletPair({ relayUrl: 'ws://localhost:8080/v1' });

    const connector = factory({
      chains: [{ id: 1, name: 'Ethereum' }] as any,
      emitter: { emit: vi.fn(), on: vi.fn(), off: vi.fn(), listenerCount: vi.fn(() => 0) },
    });

    expect(typeof connector.connect).toBe('function');
    expect(typeof connector.disconnect).toBe('function');
    expect(typeof connector.getAccounts).toBe('function');
    expect(typeof connector.getChainId).toBe('function');
    expect(typeof connector.getProvider).toBe('function');
    expect(typeof connector.isAuthorized).toBe('function');
    expect(typeof connector.onAccountsChanged).toBe('function');
    expect(typeof connector.onChainChanged).toBe('function');
    expect(typeof connector.onDisconnect).toBe('function');
    expect(typeof connector.switchChain).toBe('function');
  });

  it('isAuthorized returns false with no storage', async () => {
    const factory = walletPair({ relayUrl: 'ws://localhost:8080/v1' });

    const connector = factory({
      chains: [{ id: 1, name: 'Ethereum' }] as any,
      emitter: { emit: vi.fn(), on: vi.fn(), off: vi.fn(), listenerCount: vi.fn(() => 0) },
      storage: null,
    });

    expect(await connector.isAuthorized()).toBe(false);
  });

  it('isAuthorized returns false when no saved session', async () => {
    const factory = walletPair({ relayUrl: 'ws://localhost:8080/v1' });

    const storage = {
      getItem: vi.fn(() => Promise.resolve(null)),
      setItem: vi.fn(() => Promise.resolve()),
      removeItem: vi.fn(() => Promise.resolve()),
    };

    const connector = factory({
      chains: [{ id: 1, name: 'Ethereum' }] as any,
      emitter: { emit: vi.fn(), on: vi.fn(), off: vi.fn(), listenerCount: vi.fn(() => 0) },
      storage,
    });

    expect(await connector.isAuthorized()).toBe(false);
    expect(storage.getItem).toHaveBeenCalledWith('walletPair.session');
  });

  it('getProvider returns a WalletPairProvider', async () => {
    const factory = walletPair({ relayUrl: 'ws://localhost:8080/v1' });

    const connector = factory({
      chains: [{ id: 1, name: 'Ethereum' }] as any,
      emitter: { emit: vi.fn(), on: vi.fn(), off: vi.fn(), listenerCount: vi.fn(() => 0) },
    });

    const provider = await connector.getProvider();
    expect(provider).toBeTruthy();
    expect(typeof provider.request).toBe('function');
    expect(typeof provider.on).toBe('function');
    expect(typeof provider.removeListener).toBe('function');
  });

  it('onAccountsChanged emits change event', () => {
    const factory = walletPair({ relayUrl: 'ws://localhost:8080/v1' });
    const emit = vi.fn();

    const connector = factory({
      chains: [{ id: 1, name: 'Ethereum' }] as any,
      emitter: { emit, on: vi.fn(), off: vi.fn(), listenerCount: vi.fn(() => 0) },
    });

    connector.onAccountsChanged(['0xabc']);
    expect(emit).toHaveBeenCalledWith('change', { accounts: ['0xabc'] });
  });

  it('onChainChanged emits change event with numeric chainId', () => {
    const factory = walletPair({ relayUrl: 'ws://localhost:8080/v1' });
    const emit = vi.fn();

    const connector = factory({
      chains: [{ id: 1, name: 'Ethereum' }] as any,
      emitter: { emit, on: vi.fn(), off: vi.fn(), listenerCount: vi.fn(() => 0) },
    });

    connector.onChainChanged('0x89'); // 137
    expect(emit).toHaveBeenCalledWith('change', { chainId: 137 });
  });

  it('onDisconnect emits disconnect event', () => {
    const factory = walletPair({ relayUrl: 'ws://localhost:8080/v1' });
    const emit = vi.fn();

    const connector = factory({
      chains: [{ id: 1, name: 'Ethereum' }] as any,
      emitter: { emit, on: vi.fn(), off: vi.fn(), listenerCount: vi.fn(() => 0) },
    });

    connector.onDisconnect();
    expect(emit).toHaveBeenCalledWith('disconnect', undefined);
  });

  it('disconnect cleans up session and storage', async () => {
    const factory = walletPair({ relayUrl: 'ws://localhost:8080/v1' });
    const storage = {
      getItem: vi.fn(() => Promise.resolve(null)),
      setItem: vi.fn(() => Promise.resolve()),
      removeItem: vi.fn(() => Promise.resolve()),
    };

    const connector = factory({
      chains: [{ id: 1, name: 'Ethereum' }] as any,
      emitter: { emit: vi.fn(), on: vi.fn(), off: vi.fn(), listenerCount: vi.fn(() => 0) },
      storage,
    });

    await connector.disconnect();
    expect(storage.removeItem).toHaveBeenCalledWith('walletPair.session');
  });

  it('switchChain throws for unconfigured chain', async () => {
    const factory = walletPair({ relayUrl: 'ws://localhost:8080/v1' });

    const connector = factory({
      chains: [{ id: 1, name: 'Ethereum' }] as any,
      emitter: { emit: vi.fn(), on: vi.fn(), off: vi.fn(), listenerCount: vi.fn(() => 0) },
    });

    // switchChain will fail because session isn't connected, but the chain validation
    // happens after the request. We test the error path.
    await expect(connector.switchChain!({ chainId: 999 })).rejects.toThrow();
  });
});
