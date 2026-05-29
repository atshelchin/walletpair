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

/** Convert hex chainId "0x89" to CAIP-2 "eip155:137". */
function hexChainToCaip2(hex: string): string {
  return `eip155:${Number.parseInt(hex, 16)}`;
}

const defaultMapper: MethodMapper = {
  mapRequest(method, params) {
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return { method: 'wallet_getAccounts' };
      case 'personal_sign': {
        // personal_sign params: [message, address] where message is hex-encoded bytes
        const p = params as [string, string] | undefined;
        const msg = p?.[0];
        // EIP-1193 personal_sign: message is always hex-encoded bytes.
        // Decode hex to UTF-8 text and route to wallet_signMessage.
        let text = msg ?? '';
        if (msg && msg.startsWith('0x')) {
          try {
            const hex = msg.slice(2);
            const bytes = new Uint8Array(hex.length / 2);
            for (let i = 0; i < bytes.length; i++) {
              bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
            }
            text = new TextDecoder().decode(bytes);
          } catch {
            text = msg;
          }
        }
        return { method: 'wallet_signMessage', params: { message: text, address: p?.[1] } };
      }
      case 'eth_signTypedData_v4': {
        // params: [address, typedDataJSON]
        const p = params as [string, string] | undefined;
        let typedData: unknown;
        try { typedData = typeof p?.[1] === 'string' ? JSON.parse(p[1]) : p?.[1]; }
        catch { typedData = p?.[1]; }
        return { method: 'wallet_signTypedData', params: { address: p?.[0], typedData } };
      }
      case 'eth_sendTransaction': {
        // params: [txObject] — maps to wallet_sendTransaction (sign + broadcast)
        const p = params as [Record<string, unknown>] | undefined;
        const tx = p?.[0];
        return { method: 'wallet_sendTransaction', params: { address: tx?.from, tx } };
      }
      case 'eth_signTransaction': {
        // params: [txObject] — maps to wallet_signTransaction (sign only)
        const p = params as [Record<string, unknown>] | undefined;
        const tx = p?.[0];
        return { method: 'wallet_signTransaction', params: { address: tx?.from, tx } };
      }
      case 'wallet_switchEthereumChain': {
        // params: [{ chainId: "0x89" }] — convert hex to CAIP-2
        const p = params as [{ chainId: string }] | undefined;
        const hexId = p?.[0]?.chainId;
        return { method: 'wallet_switchChain', params: { chain: hexId ? hexChainToCaip2(hexId) : undefined } };
      }
      case 'wallet_addEthereumChain':
        return null; // unsupported — mapRequest returning null triggers unsupported_method error
      default:
        return { method, params };
    }
  },
  mapResponse(method, result) {
    // Unwrap wallet_getAccounts result to EIP-1193 format (string[])
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
      const r = result as { accounts?: { address: string }[] } | undefined;
      if (r?.accounts) return r.accounts.map((a) => a.address);
    }
    // Unwrap wallet_sendTransaction result
    if (method === 'eth_sendTransaction') {
      const r = result as { txHash?: string } | undefined;
      if (r?.txHash) return r.txHash;
    }
    // Unwrap wallet_signTransaction result
    if (method === 'eth_signTransaction') {
      const r = result as { signedTx?: string } | undefined;
      if (r?.signedTx) return r.signedTx;
    }
    // Unwrap signature results
    if (method === 'personal_sign' || method === 'eth_signTypedData_v4') {
      const r = result as { signature?: string } | undefined;
      if (r?.signature) return r.signature;
    }
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
  private disconnected = false;

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
      if (event === 'disconnect') {
        this.connected = false;
        this.disconnected = true;
        this.emitter.emit('disconnect', { code: 4900, message: 'Disconnected by wallet' });
        this.session.close('normal');
        return;
      }
      if (event === 'accountsChanged') {
        // Handle both formats:
        // - Simple: { accounts: ['0x...'] } or just ['0x...']
        // - Sub-protocol: { accounts: [{ address: '0x...', chains?: [...] }] }
        const payload = data as { accounts?: (string | { address: string })[] } | string[];
        const rawAccounts = Array.isArray(payload) ? payload : (payload as any)?.accounts;
        if (Array.isArray(rawAccounts)) {
          this.accounts = rawAccounts.map((a: string | { address: string }) =>
            typeof a === 'string' ? a : a.address,
          );
          this.emitter.emit('accountsChanged', this.accounts);
        }
      } else if (event === 'chainChanged') {
        // Handle multiple formats:
        // - { chainId: 'eip155:137' } or { chainId: '0x89' } or { chainId: 137 }
        // - { chain: 'eip155:137' }
        // - raw string 'eip155:137' or '0x89'
        const raw = typeof data === 'object' && data !== null
          ? (data as any).chainId ?? (data as any).chain
          : data;
        let newChainId: number | null = null;
        if (typeof raw === 'string') {
          if (raw.startsWith('eip155:')) {
            newChainId = evmNumericChainId(raw);
          } else if (raw.startsWith('0x')) {
            newChainId = Number.parseInt(raw, 16);
          } else {
            newChainId = Number.parseInt(raw, 10) || null;
          }
        } else if (typeof raw === 'number') {
          newChainId = raw;
        }
        if (newChainId != null && newChainId !== this.chainId) {
          this.chainId = newChainId;
          this.emitter.emit('chainChanged', `0x${newChainId.toString(16)}`);
        }
      }
    });
  }

  async request(args: EIP1193RequestArgs): Promise<unknown> {
    if (this.disconnected) {
      throw Object.assign(new Error('Provider is disconnected'), { code: 4900 });
    }

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

    // Inject chain for methods that require it per EVM sub-protocol
    const chainRequiredMethods = [
      'wallet_signMessage', 'wallet_signTypedData',
      'wallet_signTransaction', 'wallet_sendTransaction',
      'wallet_getAccounts',
    ];
    if (mapped.params && typeof mapped.params === 'object' && chainRequiredMethods.includes(mapped.method)) {
      const p = mapped.params as Record<string, unknown>;
      if (!p.chain) {
        p.chain = `eip155:${this.chainId}`;
      }
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
