/**
 * Wagmi connector for WalletPair.
 *
 * Usage:
 *   import { walletPair } from 'walletpair-sdk/evm/wagmi'
 *   import { createConfig } from 'wagmi'
 *
 *   const config = createConfig({
 *     connectors: [
 *       walletPair({
 *         relayUrl: 'wss://relay.walletpair.org/v1',
 *         meta: { name: 'MyDApp', description: 'A dApp', url: 'https://mydapp.com', icon: 'https://mydapp.com/icon.png' },
 *         onPairingUri: (uri) => { showQrCode(uri) },
 *         onSessionFingerprint: (fp) => { showFingerprint(fp) },
 *       }),
 *     ],
 *   })
 */

import { DAppSession } from '../dapp-session.js';
import { WalletPairProvider } from './eip1193.js';
import { WebSocketTransport } from '../ws-transport.js';
import { evmNumericChainId } from '../types.js';
import type { Transport } from '../types.js';

// ---------------------------------------------------------------------------
// Wagmi types (minimal subset to avoid hard dependency)
// ---------------------------------------------------------------------------

interface Chain {
  id: number;
  name: string;
  [key: string]: unknown;
}

interface ConnectorEventMap {
  change: { accounts?: readonly string[] | undefined; chainId?: number | undefined };
  connect: { accounts: readonly string[]; chainId: number };
  disconnect: never;
  error: { error: Error };
  message: { type: string; data?: unknown | undefined };
}

interface WagmiEmitter {
  emit<K extends keyof ConnectorEventMap>(event: K, data: ConnectorEventMap[K]): void;
  on<K extends keyof ConnectorEventMap>(event: K, handler: (data: ConnectorEventMap[K]) => void): void;
  off<K extends keyof ConnectorEventMap>(event: K, handler: (data: ConnectorEventMap[K]) => void): void;
  listenerCount(event: keyof ConnectorEventMap): number;
}

interface Storage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

interface ConnectorConfig {
  chains: readonly [Chain, ...Chain[]];
  emitter: WagmiEmitter;
  storage?: Storage | null | undefined;
}

type CreateConnectorFn = (config: ConnectorConfig) => {
  id: string;
  name: string;
  type: string;
  icon?: string | undefined;
  connect(params?: { chainId?: number | undefined; isReconnecting?: boolean | undefined }): Promise<{ accounts: readonly string[]; chainId: number }>;
  disconnect(): Promise<void>;
  getAccounts(): Promise<readonly string[]>;
  getChainId(): Promise<number>;
  getProvider(params?: { chainId?: number | undefined }): Promise<WalletPairProvider>;
  isAuthorized(): Promise<boolean>;
  onAccountsChanged(accounts: string[]): void;
  onChainChanged(chainId: string): void;
  onConnect?(connectInfo: { chainId: string }): void;
  onDisconnect(error?: Error | undefined): void;
  setup?(): Promise<void>;
  switchChain?(params: { chainId: number }): Promise<Chain>;
};

// ---------------------------------------------------------------------------
// Connector options
// ---------------------------------------------------------------------------

export interface WalletPairConnectorOptions {
  /** WebSocket relay URL. Used when `transport` is not provided. */
  relayUrl?: string | undefined;
  /** Custom transport instance. Overrides relayUrl when provided. */
  transport?: Transport | undefined;
  /** DApp metadata (name, description, url, icon). */
  meta: { name: string; description: string; url: string; icon: string };
  /** Request timeout in ms. */
  requestTimeout?: number | undefined;
  /** Called when a pairing URI is generated (display QR code). */
  onPairingUri?: ((uri: string) => void) | undefined;
  /** Called when the session fingerprint is ready (display alongside QR). */
  onSessionFingerprint?: ((fingerprint: string) => void) | undefined;
  /**
   * Called after QR is shown but before transport connects (BLE mode).
   * The returned Promise must resolve when the user is ready to scan.
   * This gives the wallet time to scan the QR before the BLE device picker opens.
   * Only relevant when using a custom transport (e.g. WebBleCentralTransport).
   */
  onBeforeTransportConnect?: (() => Promise<void>) | undefined;
}

// ---------------------------------------------------------------------------
// Connector factory
// ---------------------------------------------------------------------------

export function walletPair(options: WalletPairConnectorOptions): CreateConnectorFn {
  let session: DAppSession | null = null;
  let provider: WalletPairProvider | null = null;

  function getOrCreateSession(): DAppSession {
    if (!session) {
      const transport = options.transport ?? new WebSocketTransport(options.relayUrl!);
      session = new DAppSession({
        transport,
        meta: options.meta,
        requestTimeout: options.requestTimeout,
      });
    }
    return session;
  }

  function getOrCreateProvider(chainId?: number): WalletPairProvider {
    if (!provider) {
      provider = new WalletPairProvider({
        session: getOrCreateSession(),
        chainId,
      });
    }
    return provider;
  }

  return (config: ConnectorConfig) => {
    return {
      id: 'walletPair',
      name: options.meta.name,
      type: 'walletPair',

      async connect(params) {
        const chainId = params?.chainId ?? config.chains[0].id;
        const s = getOrCreateSession();
        const p = getOrCreateProvider(chainId);

        // Bridge WalletPair events → wagmi emitter
        s.on('event', ({ event, data }) => {
          if (event === 'accountsChanged') {
            const accts = (data as { accounts?: string[] })?.accounts ?? (data as string[]);
            if (Array.isArray(accts)) {
              config.emitter.emit('change', { accounts: accts });
            }
          } else if (event === 'chainChanged') {
            const raw = (data as { chainId?: string | number })?.chainId ?? data;
            let newId: number;
            if (typeof raw === 'string' && raw.startsWith('eip155:')) {
              newId = evmNumericChainId(raw) ?? chainId;
            } else if (typeof raw === 'string') {
              newId = Number.parseInt(raw, raw.startsWith('0x') ? 16 : 10);
            } else {
              newId = raw as number;
            }
            config.emitter.emit('change', { chainId: newId });
          }
        });

        // Start pairing flow
        // If onBeforeTransportConnect is set (BLE mode), defer transport connection
        // so the wallet can scan the QR before the BLE device picker opens.
        const deferTransport = !!options.onBeforeTransportConnect;
        const uri = await s.createPairing({ deferTransport });
        options.onPairingUri?.(uri);

        if (deferTransport && options.onBeforeTransportConnect) {
          await options.onBeforeTransportConnect();
          await s.connectTransport();
        }

        // Emit session fingerprint for display alongside QR
        options.onSessionFingerprint?.(s.sessionFingerprint);

        // Wait for wallet to join (auto-accepted after sealed_join verification)
        const accounts = await new Promise<readonly string[]>((resolve, reject) => {
          const cleanup: (() => void)[] = [];

          cleanup.push(s.on('phase', async (phase) => {
            if (phase === 'connected') {
              try {
                const accts = await p.request({ method: 'eth_requestAccounts' }) as string[];
                for (const off of cleanup) off();
                resolve(accts);
              } catch (e) {
                for (const off of cleanup) off();
                reject(e);
              }
            } else if (phase === 'closed') {
              for (const off of cleanup) off();
              reject(new Error('Session closed'));
            }
          }));
        });

        // Persist session for reconnect
        if (config.storage) {
          await config.storage.setItem('walletPair.session', s.serialize());
        }

        return { accounts, chainId };
      },

      async disconnect() {
        session?.close();
        session = null;
        provider = null;
        if (config.storage) {
          await config.storage.removeItem('walletPair.session');
        }
      },

      async getAccounts() {
        return getOrCreateProvider().getAccounts();
      },

      async getChainId() {
        return Number.parseInt(getOrCreateProvider().getChainId(), 16);
      },

      async getProvider() {
        return getOrCreateProvider();
      },

      async isAuthorized() {
        if (!config.storage) return false;
        const saved = await config.storage.getItem('walletPair.session');
        if (!saved) return false;
        return getOrCreateSession().restore(saved);
      },

      onAccountsChanged(accounts: string[]) {
        config.emitter.emit('change', { accounts });
      },

      onChainChanged(chainId: string) {
        config.emitter.emit('change', { chainId: Number.parseInt(chainId, 16) });
      },

      onDisconnect() {
        config.emitter.emit('disconnect', undefined as never);
      },

      async switchChain(params) {
        const p = getOrCreateProvider();
        await p.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: `0x${params.chainId.toString(16)}` }],
        });
        config.emitter.emit('change', { chainId: params.chainId });
        const chain = config.chains.find(c => c.id === params.chainId);
        if (!chain) throw new Error(`Chain ${params.chainId} not configured`);
        return chain;
      },
    };
  };
}
