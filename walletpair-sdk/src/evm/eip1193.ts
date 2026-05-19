/**
 * EIP-1193 Provider — wraps a DAppSession for Ethereum/EVM dApps.
 *
 * Maps standard Ethereum JSON-RPC methods to WalletPair protocol requests.
 * Emits standard EIP-1193 events: connect, disconnect, chainChanged, accountsChanged.
 *
 * Usage:
 *   import { WalletPairProvider } from 'walletpair-sdk/evm'
 *   const provider = new WalletPairProvider({ session })
 */

import type { DAppSession } from '../dapp-session.js';
import { evmNumericChainId } from '../types.js';
import { Emitter } from '../emitter.js';

// ---------------------------------------------------------------------------
// EIP-1193 types
// ---------------------------------------------------------------------------

export interface EIP1193RequestArgs {
  method: string;
  params?: unknown[] | Record<string, unknown>;
}

export interface EIP1193ProviderEvents {
  [key: string]: unknown;
  connect: { chainId: string };
  disconnect: { code: number; message: string };
  chainChanged: string;
  accountsChanged: string[];
  message: { type: string; data?: unknown | undefined };
}

export interface EIP1193Provider {
  request(args: EIP1193RequestArgs): Promise<unknown>;
  on(event: string, handler: (...args: any[]) => void): void;
  removeListener(event: string, handler: (...args: any[]) => void): void;
}

// ---------------------------------------------------------------------------
// Method mapping: EVM JSON-RPC → WalletPair protocol methods
// ---------------------------------------------------------------------------

export interface MethodMapper {
  mapRequest(method: string, params?: unknown): { method: string; params?: unknown | undefined } | null;
  mapResponse(method: string, result: unknown): unknown;
}

const defaultMapper: MethodMapper = {
  mapRequest(method, params) {
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return { method: 'wallet_getAccounts' };
      case 'personal_sign': {
        const p = params as [string, string] | undefined;
        return { method: 'wallet_signMessage', params: { message: p?.[0], address: p?.[1] } };
      }
      case 'eth_signTypedData_v4': {
        const p = params as [string, string] | undefined;
        return { method: 'wallet_signTypedData', params: { address: p?.[0], data: p?.[1] } };
      }
      case 'eth_sendTransaction': {
        const p = params as [unknown] | undefined;
        return { method: 'wallet_signTransaction', params: p?.[0] };
      }
      case 'wallet_switchEthereumChain': {
        const p = params as [{ chainId: string }] | undefined;
        return { method: 'wallet_switchChain', params: { chainId: p?.[0]?.chainId } };
      }
      case 'wallet_addEthereumChain': {
        const p = params as [unknown] | undefined;
        return { method: 'wallet_addChain', params: p?.[0] };
      }
      default:
        return { method, params };
    }
  },
  mapResponse(_method, result) {
    return result;
  },
};

// ---------------------------------------------------------------------------
// WalletPairProvider
// ---------------------------------------------------------------------------

export interface WalletPairProviderOptions {
  session: DAppSession;
  /** Initial EVM chain ID (numeric). Default 1 (mainnet). */
  chainId?: number | undefined;
  /** Custom method mapper. */
  mapper?: MethodMapper | undefined;
}

export class WalletPairProvider implements EIP1193Provider {
  private session: DAppSession;
  private mapper: MethodMapper;
  private emitter = new Emitter<EIP1193ProviderEvents>();
  private chainId: number;
  private accounts: string[] = [];
  private connected = false;

  constructor(options: WalletPairProviderOptions) {
    this.session = options.session;
    this.mapper = options.mapper ?? defaultMapper;
    this.chainId = options.chainId ?? 1;

    this.session.on('phase', (phase) => {
      if (phase === 'connected' && !this.connected) {
        this.connected = true;
        this.emitter.emit('connect', { chainId: `0x${this.chainId.toString(16)}` });
      } else if ((phase === 'closed' || phase === 'disconnected') && this.connected) {
        this.connected = false;
        this.emitter.emit('disconnect', { code: 4900, message: 'Disconnected' });
      }
    });

    this.session.on('event', ({ event, data }) => {
      if (event === 'accountsChanged') {
        const accts = (data as { accounts?: string[] })?.accounts ?? (data as string[]);
        if (Array.isArray(accts)) {
          this.accounts = accts;
          this.emitter.emit('accountsChanged', accts);
        }
      } else if (event === 'chainChanged') {
        const raw = (data as { chainId?: string | number })?.chainId ?? data;
        let newChainId: number;
        if (typeof raw === 'string' && raw.startsWith('eip155:')) {
          newChainId = evmNumericChainId(raw) ?? this.chainId;
        } else if (typeof raw === 'string') {
          newChainId = Number.parseInt(raw, raw.startsWith('0x') ? 16 : 10);
        } else {
          newChainId = raw as number;
        }
        if (newChainId !== this.chainId) {
          this.chainId = newChainId;
          this.emitter.emit('chainChanged', `0x${newChainId.toString(16)}`);
        }
      }
    });
  }

  async request(args: EIP1193RequestArgs): Promise<unknown> {
    const { method, params } = args;

    if (method === 'eth_chainId') {
      return `0x${this.chainId.toString(16)}`;
    }
    if (method === 'net_version') {
      return String(this.chainId);
    }

    const mapped = this.mapper.mapRequest(method, params);
    if (!mapped) {
      throw Object.assign(new Error(`Unsupported method: ${method}`), { code: 4200 });
    }

    const result = await this.session.request(mapped.method, mapped.params);
    const mappedResult = this.mapper.mapResponse(method, result);

    if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
      if (Array.isArray(mappedResult)) this.accounts = mappedResult;
    }

    return mappedResult;
  }

  on(event: string, handler: (...args: any[]) => void): void {
    this.emitter.on(event as keyof EIP1193ProviderEvents, handler as any);
  }

  removeListener(event: string, handler: (...args: any[]) => void): void {
    this.emitter.off(event as keyof EIP1193ProviderEvents, handler as any);
  }

  getChainId(): string {
    return `0x${this.chainId.toString(16)}`;
  }

  getAccounts(): string[] {
    return this.accounts;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getSession(): DAppSession {
    return this.session;
  }
}
