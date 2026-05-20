/**
 * MAIN world content script - injects EIP-1193 provider + EIP-6963 into the page.
 * Also injects as window.ethereum for legacy dApps.
 *
 * This runs in the page's JS context, NOT the extension's isolated world.
 * Communication with extension is via window.postMessage only.
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  world: 'MAIN',
  runAt: 'document_start',

  main() {
    const MSG_CHANNEL = 'walletpair-ext';
    const PROVIDER_UUID = 'e3a10000-7770-4270-8000-000077700001';

    // EIP-1193 ProviderRpcError — ethers.js and viem check instanceof
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

    // Deprecated / unsupported methods → code 4200
    const UNSUPPORTED_METHODS = new Set([
      'eth_getEncryptionPublicKey',
      'eth_decrypt',
      'eth_sign',
    ]);

    // Pending RPC requests waiting for responses
    const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    let reqCounter = 0;

    // Event listeners for EIP-1193 events
    const eventListeners = new Map<string, Set<(...args: any[]) => void>>();

    // Cached state
    let accounts: string[] = [];
    let chainId = '0x1';
    let isConnected = false;

    // Internal emit — not exposed on the provider object so external code cannot fake events
    function emit(event: string, ...args: any[]) {
      eventListeners.get(event)?.forEach((handler) => {
        try {
          handler(...args);
        } catch {}
      });
    }

    // --- EIP-1193 Provider ---
    const provider: Record<string, any> = {
      isWalletPair: true,

      async request(args: { method: string; params?: unknown }): Promise<unknown> {
        const { method, params } = args;

        // Reject unsupported / deprecated methods with code 4200
        if (UNSUPPORTED_METHODS.has(method)) {
          throw new ProviderRpcError(4200, `${method} is not supported`);
        }

        // Local fast-path for cached data
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

        // Forward to background via content script bridge
        const id = `wp-${++reqCounter}-${Date.now()}`;
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          window.postMessage(
            { type: 'wp-request', id, payload: { method, params }, channel: MSG_CHANNEL },
            '*',
          );

          // Timeout after 5 minutes (signing can take time)
          setTimeout(() => {
            if (pending.has(id)) {
              pending.delete(id);
              reject(new ProviderRpcError(-32603, 'Request timed out'));
            }
          }, 300_000);
        });
      },

      on(event: string, handler: (...args: any[]) => void) {
        if (!eventListeners.has(event)) {
          eventListeners.set(event, new Set());
        }
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

      // Legacy methods some dApps still use
      enable() {
        return provider.request({ method: 'eth_requestAccounts' });
      },

      send(methodOrPayload: string | { method: string; params?: unknown[] }, callbackOrParams?: unknown) {
        // Handle both send(method, params) and send(payload, callback) signatures
        if (typeof methodOrPayload === 'string') {
          // Synchronous fast-path for cached methods — legacy dApps expect this
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
        // send({ method, params }, callback) - legacy
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

      // MetaMask compatibility shim — many dApps check this
      _metamask: {
        isUnlocked: () => Promise.resolve(isConnected),
      },

      // Some dApps also check these
      selectedAddress: null as string | null,
      chainId,
      networkVersion: '1',
    };

    // --- Listen for responses and events from content script bridge ---
    window.addEventListener('message', (event) => {
      if (event.source !== window || event.data?.channel !== MSG_CHANNEL) return;

      const msg = event.data;

      if (msg.type === 'wp-response') {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);

        if (msg.error) {
          p.reject(new ProviderRpcError(
            msg.error.code ?? -32603,
            msg.error.message ?? 'Internal error',
            msg.error.data,
          ));
        } else {
          // Update cached state from responses
          if (msg.method === 'eth_requestAccounts' || msg.method === 'wallet_getAccounts') {
            if (Array.isArray(msg.result) && msg.result.length > 0) {
              accounts = msg.result;
              provider.selectedAddress = accounts[0];
              // EIP-1193: only emit connect when transitioning from disconnected
              if (!isConnected) {
                isConnected = true;
                emit('connect', { chainId });
              }
              emit('accountsChanged', accounts);
            }
          }
          p.resolve(msg.result);
        }
      }

      if (msg.type === 'wp-event') {
        const { event: evtName, data } = msg;
        if (evtName === 'accountsChanged' && Array.isArray(data)) {
          accounts = data;
          provider.selectedAddress = accounts[0] ?? null;
          emit('accountsChanged', accounts);
        } else if (evtName === 'chainChanged') {
          chainId = typeof data === 'string' ? data : `0x${Number(data).toString(16)}`;
          provider.chainId = chainId;
          provider.networkVersion = String(parseInt(chainId, 16));
          emit('chainChanged', chainId);
        } else if (evtName === 'disconnect') {
          isConnected = false;
          accounts = [];
          provider.selectedAddress = null;
          emit('disconnect', new ProviderRpcError(4900, 'Disconnected'));
        } else if (evtName === 'connect') {
          if (!isConnected) {
            isConnected = true;
            emit('connect', { chainId });
          }
        } else if (evtName === 'message') {
          // EIP-1193 message event (used for eth_subscription)
          emit('message', data);
        }
      }
    });

    // --- EIP-6963: Announce provider ---
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

    const detail = Object.freeze({ info, provider });

    function announceProvider() {
      window.dispatchEvent(
        new CustomEvent('eip6963:announceProvider', { detail }),
      );
    }

    // Announce on load and on request
    window.addEventListener('eip6963:requestProvider', announceProvider);
    announceProvider();

    // --- window.ethereum injection (legacy support) ---
    // Many dApps check window.ethereum directly. We need to support this.
    const existingProvider = (window as any).ethereum;

    if (!existingProvider) {
      // No other wallet - we claim window.ethereum
      Object.defineProperty(window, 'ethereum', {
        value: provider,
        writable: false,
        configurable: true,
      });
    } else {
      // Another wallet already exists - use the providers array pattern
      // This is the standard multi-wallet coexistence approach
      if (!existingProvider.providers) {
        (existingProvider as any).providers = [existingProvider];
      }
      (existingProvider as any).providers.push(provider);
    }

    // Always set window.walletpair for direct access
    Object.defineProperty(window, 'walletpair', {
      value: provider,
      writable: false,
      configurable: false,
    });

    // Ask content script bridge for current state (handles page reload while connected)
    const onInitState = (event: MessageEvent) => {
      if (
        event.source !== window ||
        event.data?.channel !== MSG_CHANNEL ||
        event.data?.type !== 'wp-init-state'
      )
        return;
      window.removeEventListener('message', onInitState);
      const { connected, accounts: initAccounts, chainId: initChainId } = event.data;
      if (connected && Array.isArray(initAccounts) && initAccounts.length > 0) {
        accounts = initAccounts;
        chainId = initChainId || chainId;
        provider.selectedAddress = accounts[0];
        provider.chainId = chainId;
        provider.networkVersion = String(parseInt(chainId, 16));
        if (!isConnected) {
          isConnected = true;
          emit('connect', { chainId });
        }
      }
    };
    window.addEventListener('message', onInitState);

    // Notify content script bridge that provider is ready
    window.postMessage({ type: 'wp-provider-ready', channel: MSG_CHANNEL }, '*');
  },
});
