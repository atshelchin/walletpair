/**
 * EIP-1193 provider factory.
 *
 * Extracted from provider.content.ts so the core logic can be tested
 * without requiring the browser extension content script environment.
 */

const MSG_CHANNEL = 'walletpair-ext';
const PROVIDER_UUID = 'e3a10000-7770-4270-8000-000077700001';

export class ProviderRpcError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
    this.name = 'ProviderRpcError';
  }
}

export const UNSUPPORTED_METHODS = new Set([
  'eth_getEncryptionPublicKey',
  'eth_decrypt',
  'eth_sign',
  'wallet_addEthereumChain',
]);

export interface PostMessageFn {
  (message: any, targetOrigin: string): void;
}

export interface ProviderState {
  accounts: string[];
  chainId: string;
  isConnected: boolean;
}

/**
 * Create a WalletPair EIP-1193 provider.
 *
 * @param postMessage - function used to send messages to the content bridge
 *                      (defaults to window.postMessage)
 */
export function createProvider(postMessage: PostMessageFn) {
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let reqCounter = 0;
  const eventListeners = new Map<string, Set<(...args: any[]) => void>>();

  const state: ProviderState = {
    accounts: [],
    chainId: '0x1',
    isConnected: false,
  };

  function emit(event: string, ...args: any[]) {
    eventListeners.get(event)?.forEach((handler) => {
      try { handler(...args); } catch {}
    });
  }

  const provider: Record<string, any> = {
    isWalletPair: true,

    async request(args: { method: string; params?: unknown }): Promise<unknown> {
      const { method, params } = args;

      if (UNSUPPORTED_METHODS.has(method)) {
        throw new ProviderRpcError(4200, `${method} is not supported`);
      }

      if (method === 'eth_accounts') {
        return state.isConnected ? [...state.accounts] : [];
      }
      if (method === 'eth_chainId') {
        return state.chainId;
      }
      if (method === 'net_version') {
        return String(parseInt(state.chainId, 16));
      }
      if (method === 'web3_clientVersion') {
        return 'WalletPair/0.1.0';
      }

      const id = `wp-${++reqCounter}-${Date.now()}`;
      return new Promise((resolve, reject) => {
        // Fix #3: Store timer handle so we can clear it when response arrives
        const timer = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new ProviderRpcError(-32603, 'Request timed out'));
          }
        }, 60_000);

        pending.set(id, { resolve, reject, timer });
        postMessage(
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

    send(methodOrPayload: string | { method: string; params?: unknown[]; id?: number }, callbackOrParams?: unknown) {
      if (typeof methodOrPayload === 'string') {
        const syncMethods: Record<string, () => unknown> = {
          eth_accounts: () => state.isConnected ? [...state.accounts] : [],
          eth_chainId: () => state.chainId,
          net_version: () => String(parseInt(state.chainId, 16)),
          web3_clientVersion: () => 'WalletPair/0.1.0',
        };
        if (methodOrPayload in syncMethods) {
          return {
            id: ++reqCounter,
            jsonrpc: '2.0' as const,
            result: syncMethods[methodOrPayload](),
          };
        }
        return provider.request({ method: methodOrPayload, params: callbackOrParams as unknown[] });
      }
      // Fix #12: Use request id from payload, or generate a unique one
      const rpcId = methodOrPayload.id ?? ++reqCounter;
      if (typeof callbackOrParams === 'function') {
        provider
          .request({ method: methodOrPayload.method, params: methodOrPayload.params })
          .then((result: unknown) =>
            (callbackOrParams as Function)(null, { id: rpcId, jsonrpc: '2.0', result }),
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
      const rpcId = payload.id ?? ++reqCounter;
      provider
        .request({ method: payload.method, params: payload.params })
        .then((result: unknown) => callback(null, { id: rpcId, jsonrpc: '2.0', result }))
        .catch((err: Error) => callback(err));
    },

    isConnected() {
      return state.isConnected;
    },

    _metamask: {
      isUnlocked: () => Promise.resolve(state.isConnected),
    },

    selectedAddress: null as string | null,
    chainId: state.chainId,
    networkVersion: '1',
  };

  /**
   * Handle incoming messages from the content bridge.
   * Call this from a window 'message' event listener.
   */
  function handleMessage(msg: any) {
    if (msg.channel !== MSG_CHANNEL) return;

    if (msg.type === 'wp-response') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer); // Fix #3: prevent leaked timeout

      if (msg.error) {
        p.reject(new ProviderRpcError(
          msg.error.code ?? -32603,
          msg.error.message ?? 'Internal error',
          msg.error.data,
        ));
      } else {
        if (msg.method === 'eth_requestAccounts' || msg.method === 'wallet_getAccounts') {
          if (Array.isArray(msg.result) && msg.result.length > 0) {
            state.accounts = msg.result;
            provider.selectedAddress = state.accounts[0];
            if (!state.isConnected) {
              state.isConnected = true;
              emit('connect', { chainId: state.chainId });
            }
            emit('accountsChanged', state.accounts);
          }
        }
        p.resolve(msg.result);
      }
    }

    if (msg.type === 'wp-event') {
      const { event: evtName, data } = msg;
      if (evtName === 'accountsChanged' && Array.isArray(data)) {
        state.accounts = data;
        provider.selectedAddress = state.accounts[0] ?? null;
        emit('accountsChanged', state.accounts);
      } else if (evtName === 'chainChanged') {
        state.chainId = typeof data === 'string' ? data : `0x${Number(data).toString(16)}`;
        provider.chainId = state.chainId;
        provider.networkVersion = String(parseInt(state.chainId, 16));
        emit('chainChanged', state.chainId);
      } else if (evtName === 'disconnect') {
        state.isConnected = false;
        state.accounts = [];
        provider.selectedAddress = null;
        emit('disconnect', new ProviderRpcError(4900, 'Disconnected'));
      } else if (evtName === 'connect') {
        if (!state.isConnected) {
          state.isConnected = true;
          emit('connect', { chainId: state.chainId });
        }
      } else if (evtName === 'message') {
        emit('message', data);
      }
    }

    if (msg.type === 'wp-init-state') {
      const { connected, accounts: initAccounts, chainId: initChainId } = msg;
      if (connected && Array.isArray(initAccounts) && initAccounts.length > 0) {
        state.accounts = initAccounts;
        state.chainId = initChainId || state.chainId;
        provider.selectedAddress = state.accounts[0];
        provider.chainId = state.chainId;
        provider.networkVersion = String(parseInt(state.chainId, 16));
        if (!state.isConnected) {
          state.isConnected = true;
          emit('connect', { chainId: state.chainId });
        }
      }
    }
  }

  return { provider, handleMessage, pending, state };
}

export const PROVIDER_ICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="24" fill="#2563eb"/><path d="M27 48 L48 27 L69 48 L48 69Z" fill="white" opacity="0.9"/><circle cx="48" cy="48" r="9" fill="#2563eb"/></svg>`,
  );

export const PROVIDER_INFO = Object.freeze({
  uuid: PROVIDER_UUID,
  name: 'WalletPair',
  icon: PROVIDER_ICON,
  rdns: 'org.walletpair.extension',
});
