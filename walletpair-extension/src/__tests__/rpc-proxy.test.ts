import { describe, it, expect, beforeEach, vi } from 'vitest';
import { READ_ONLY_METHODS, proxyRpcCall, DEFAULT_RPC } from '../lib/rpc-proxy';

// ── Mock chrome.storage.local (needed by getSettings) ──────────────────

const store: Record<string, unknown> = {};

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: vi.fn(async (key: string) => ({ [key]: store[key] })),
      set: vi.fn(async (items: Record<string, unknown>) => Object.assign(store, items)),
      remove: vi.fn(async (key: string) => { delete store[key]; }),
    },
  },
});

// ── Mock global fetch ──────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

/** Helper: build a mock Response matching our proxyRpcCall expectations. */
function mockJsonResponse(body: unknown, opts?: { ok?: boolean; status?: number; statusText?: string }) {
  const text = JSON.stringify(body);
  return {
    ok: opts?.ok ?? true,
    status: opts?.status ?? 200,
    statusText: opts?.statusText ?? 'OK',
    headers: {
      get: (key: string) => key.toLowerCase() === 'content-length' ? String(text.length) : null,
    },
    text: async () => text,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('READ_ONLY_METHODS', () => {
  it('contains common read-only Ethereum JSON-RPC methods', () => {
    const expected = [
      'eth_blockNumber',
      'eth_call',
      'eth_estimateGas',
      'eth_getBalance',
      'eth_getTransactionByHash',
      'eth_getTransactionReceipt',
      'eth_getLogs',
      'eth_getBlockByNumber',
      'eth_gasPrice',
      'eth_syncing',
    ];
    for (const method of expected) {
      expect(READ_ONLY_METHODS.has(method)).toBe(true);
    }
  });

  it('does not contain wallet-interaction methods', () => {
    const walletMethods = [
      'eth_sendTransaction',
      'eth_requestAccounts',
      'personal_sign',
      'eth_signTypedData_v4',
      'wallet_switchEthereumChain',
    ];
    for (const method of walletMethods) {
      expect(READ_ONLY_METHODS.has(method)).toBe(false);
    }
  });

  it('includes eth_sendRawTransaction (pre-signed, no wallet needed)', () => {
    expect(READ_ONLY_METHODS.has('eth_sendRawTransaction')).toBe(true);
  });
});

describe('proxyRpcCall', () => {
  beforeEach(() => {
    for (const key of Object.keys(store)) delete store[key];
    vi.clearAllMocks();
  });

  it('sends a correct JSON-RPC POST request', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({ jsonrpc: '2.0', id: 1, result: '0x10' }),
    );

    const result = await proxyRpcCall(1, 'eth_blockNumber', []);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://eth.llamarpc.com');
    expect(options.method).toBe('POST');
    expect(options.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(options.body);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.method).toBe('eth_blockNumber');
    expect(body.params).toEqual([]);

    expect(result).toBe('0x10');
  });

  it('uses user-configured RPC URL over default', async () => {
    store['settings'] = { rpcUrls: { 1: 'https://custom-rpc.example.com' } };

    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({ jsonrpc: '2.0', id: 1, result: '0x5' }),
    );

    await proxyRpcCall(1, 'eth_blockNumber', []);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://custom-rpc.example.com');
  });

  it('falls back to DEFAULT_RPC when settings have no URL for chain', async () => {
    store['settings'] = { rpcUrls: {} };

    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({ jsonrpc: '2.0', id: 1, result: '0x1' }),
    );

    await proxyRpcCall(137, 'eth_blockNumber', []);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(DEFAULT_RPC[137]);
  });

  it('throws with code -32601 when no RPC URL for chain', async () => {
    store['settings'] = { rpcUrls: {} };

    try {
      await proxyRpcCall(99999, 'eth_blockNumber', []);
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.message).toContain('No RPC URL configured for chain 99999');
      expect(err.code).toBe(-32601);
    }
  });

  it('throws with code -32603 on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
    });

    try {
      await proxyRpcCall(1, 'eth_blockNumber', []);
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.message).toContain('502');
      expect(err.code).toBe(-32603);
    }
  });

  it('throws with RPC error code when JSON-RPC response contains error', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32000, message: 'execution reverted' },
      }),
    );

    try {
      await proxyRpcCall(1, 'eth_call', [{ to: '0x0', data: '0x' }, 'latest']);
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.message).toBe('execution reverted');
      expect(err.code).toBe(-32000);
    }
  });

  it('passes params through to the RPC body', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({ jsonrpc: '2.0', id: 1, result: '0x0' }),
    );

    const params = [{ to: '0xdead', data: '0x1234' }, 'latest'];
    await proxyRpcCall(1, 'eth_call', params);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.params).toEqual(params);
  });

  it('defaults params to empty array when null/undefined', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({ jsonrpc: '2.0', id: 1, result: '0x5' }),
    );

    await proxyRpcCall(1, 'eth_blockNumber', null);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.params).toEqual([]);
  });

  it('includes AbortSignal for timeout', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({ jsonrpc: '2.0', id: 1, result: '0x1' }),
    );

    await proxyRpcCall(1, 'eth_blockNumber', []);

    const [, options] = mockFetch.mock.calls[0];
    expect(options.signal).toBeDefined();
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('throws on oversized response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: {
        get: (key: string) => key.toLowerCase() === 'content-length' ? '10000000' : null,
      },
      text: async () => 'x'.repeat(10000000),
    });

    try {
      await proxyRpcCall(1, 'eth_blockNumber', []);
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.message).toContain('too large');
      expect(err.code).toBe(-32603);
    }
  });
});
