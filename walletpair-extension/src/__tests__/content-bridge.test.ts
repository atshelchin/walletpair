import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Content script bridge tests.
 *
 * Tests the ISOLATED world content script logic that bridges
 * page (window.postMessage) <-> background (chrome.runtime).
 *
 * Since the code runs inside defineContentScript's main(), we recreate
 * the bridging logic and test it with mocked chrome APIs.
 */

const MSG_CHANNEL = 'walletpair-ext';

// ── Chrome API mocks ──

function createMockPort() {
  const messageListeners: Array<(msg: any) => void> = [];
  const disconnectListeners: Array<() => void> = [];

  return {
    postMessage: vi.fn(),
    onMessage: {
      addListener: vi.fn((cb: (msg: any) => void) => messageListeners.push(cb)),
      removeListener: vi.fn(),
    },
    onDisconnect: {
      addListener: vi.fn((cb: () => void) => disconnectListeners.push(cb)),
      removeListener: vi.fn(),
    },
    disconnect: vi.fn(),
    name: 'walletpair-content',
    // Helpers for testing
    _simulateMessage(msg: any) {
      messageListeners.forEach((cb) => cb(msg));
    },
    _simulateDisconnect() {
      disconnectListeners.forEach((cb) => cb());
    },
  };
}

function setupChromeRuntime() {
  const broadcastListeners: Array<(msg: any, sender?: any, sendResponse?: any) => void> = [];

  const runtime = {
    connect: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    onMessage: {
      addListener: vi.fn((cb: any) => broadcastListeners.push(cb)),
      removeListener: vi.fn(),
    },
    lastError: null as { message?: string } | null,
    _broadcastListeners: broadcastListeners,
  };

  (globalThis as any).chrome = { runtime };
  return runtime;
}

// ── Recreate content script bridge logic ──

function createBridge() {
  const origin = 'https://example.com';
  let port: ReturnType<typeof createMockPort> | null = null;
  let portDead = false;

  const pageMessages: any[] = []; // collect messages sent to page

  function getPort() {
    if (portDead) return null;
    if (port) return port;

    try {
      port = chrome.runtime.connect({ name: 'walletpair-content' }) as any;
      port!.onMessage.addListener(handleBackgroundMessage);
      port!.onDisconnect.addListener(() => {
        port = null;
        if (chrome.runtime.lastError?.message?.includes('Extension context invalidated')) {
          portDead = true;
        }
      });
      return port;
    } catch {
      portDead = true;
      return null;
    }
  }

  function sendToPage(msg: any) {
    pageMessages.push(msg);
  }

  function sendErrorToPage(id: string, code: number, message: string) {
    sendToPage({
      type: 'wp-response',
      id,
      error: { code, message },
      channel: MSG_CHANNEL,
    });
  }

  function sendToBackground(msg: Record<string, unknown>): void {
    const p = getPort();
    if (p) {
      try {
        p.postMessage(msg);
        return;
      } catch {
        port = null;
      }
    }

    if (!portDead) {
      chrome.runtime.sendMessage(msg).then((response: any) => {
        if (response) handleBackgroundMessage(response);
      }).catch(() => {
        if (msg.action === 'rpc-request') {
          sendErrorToPage(msg.id as string, -32603, 'Extension not available');
        }
      });
    } else if (msg.action === 'rpc-request') {
      sendErrorToPage(msg.id as string, -32603, 'Extension was updated. Please refresh the page.');
    }
  }

  function handleBackgroundMessage(msg: any) {
    if (msg.action === 'rpc-response') {
      sendToPage({
        type: 'wp-response',
        id: msg.id,
        result: msg.result,
        error: msg.error,
        method: msg.method,
        channel: MSG_CHANNEL,
      });
    }

    if (msg.action === 'emit-event') {
      sendToPage({
        type: 'wp-event',
        event: msg.event,
        data: msg.data,
        channel: MSG_CHANNEL,
      });
    }

    if (msg.action === 'state-update' || msg.action === 'get-state') {
      const state = msg.state ?? msg;
      if (state.phase === 'connected' && state.wallet) {
        sendToPage({
          type: 'wp-event',
          event: 'connect',
          data: { chainId: `0x${(state.wallet.chainId ?? 1).toString(16)}` },
          channel: MSG_CHANNEL,
        });
        sendToPage({
          type: 'wp-event',
          event: 'accountsChanged',
          data: [state.wallet.address],
          channel: MSG_CHANNEL,
        });
      }
    }
  }

  function handlePageMessage(data: any) {
    if (data?.channel !== MSG_CHANNEL) return;

    if (data.type === 'wp-request') {
      sendToBackground({
        action: 'rpc-request',
        id: data.id,
        payload: data.payload,
        origin,
      });
    }

    if (data.type === 'wp-get-state') {
      sendToBackground({ action: 'get-state' });
    }
  }

  return {
    handlePageMessage,
    handleBackgroundMessage,
    sendToBackground,
    getPort,
    pageMessages,
    get portDead() { return portDead; },
    set portDead(v: boolean) { portDead = v; },
    get port() { return port; },
    set port(v: any) { port = v; },
  };
}

// ── Tests ──

describe('Content bridge - message filtering', () => {
  let runtime: ReturnType<typeof setupChromeRuntime>;
  let mockPort: ReturnType<typeof createMockPort>;

  beforeEach(() => {
    runtime = setupChromeRuntime();
    mockPort = createMockPort();
    runtime.connect.mockReturnValue(mockPort);
  });

  afterEach(() => {
    delete (globalThis as any).chrome;
  });

  it('ignores messages with wrong channel', () => {
    const bridge = createBridge();

    bridge.handlePageMessage({ type: 'wp-request', channel: 'wrong-channel', id: '1', payload: {} });

    // No port should have been created (nothing forwarded)
    expect(runtime.connect).not.toHaveBeenCalled();
  });

  it('ignores messages with no channel', () => {
    const bridge = createBridge();

    bridge.handlePageMessage({ type: 'wp-request', id: '1', payload: {} });

    expect(runtime.connect).not.toHaveBeenCalled();
  });

  it('ignores messages with wrong type but correct channel', () => {
    const bridge = createBridge();

    bridge.handlePageMessage({ type: 'some-other-type', channel: MSG_CHANNEL });

    // Port may be lazily created, but no message forwarded
    expect(mockPort.postMessage).not.toHaveBeenCalled();
  });
});

describe('Content bridge - wp-request forwarding', () => {
  let runtime: ReturnType<typeof setupChromeRuntime>;
  let mockPort: ReturnType<typeof createMockPort>;

  beforeEach(() => {
    runtime = setupChromeRuntime();
    mockPort = createMockPort();
    runtime.connect.mockReturnValue(mockPort);
  });

  afterEach(() => {
    delete (globalThis as any).chrome;
  });

  it('forwards wp-request messages to background via port', () => {
    const bridge = createBridge();

    bridge.handlePageMessage({
      type: 'wp-request',
      channel: MSG_CHANNEL,
      id: 'wp-1-12345',
      payload: { method: 'eth_sendTransaction', params: [{ to: '0x123' }] },
    });

    expect(runtime.connect).toHaveBeenCalledWith({ name: 'walletpair-content' });
    expect(mockPort.postMessage).toHaveBeenCalledWith({
      action: 'rpc-request',
      id: 'wp-1-12345',
      payload: { method: 'eth_sendTransaction', params: [{ to: '0x123' }] },
      origin: 'https://example.com',
    });
  });

  it('includes origin in forwarded messages', () => {
    const bridge = createBridge();

    bridge.handlePageMessage({
      type: 'wp-request',
      channel: MSG_CHANNEL,
      id: 'wp-2',
      payload: { method: 'eth_chainId' },
    });

    const sentMsg = mockPort.postMessage.mock.calls[0][0];
    expect(sentMsg.origin).toBe('https://example.com');
  });
});

describe('Content bridge - response forwarding to page', () => {
  let runtime: ReturnType<typeof setupChromeRuntime>;
  let mockPort: ReturnType<typeof createMockPort>;

  beforeEach(() => {
    runtime = setupChromeRuntime();
    mockPort = createMockPort();
    runtime.connect.mockReturnValue(mockPort);
  });

  afterEach(() => {
    delete (globalThis as any).chrome;
  });

  it('forwards rpc-response to page as wp-response', () => {
    const bridge = createBridge();

    bridge.handleBackgroundMessage({
      action: 'rpc-response',
      id: 'wp-1-12345',
      result: '0x1',
      method: 'eth_chainId',
    });

    expect(bridge.pageMessages).toHaveLength(1);
    expect(bridge.pageMessages[0]).toEqual({
      type: 'wp-response',
      id: 'wp-1-12345',
      result: '0x1',
      error: undefined,
      method: 'eth_chainId',
      channel: MSG_CHANNEL,
    });
  });

  it('forwards rpc-response with error to page', () => {
    const bridge = createBridge();

    bridge.handleBackgroundMessage({
      action: 'rpc-response',
      id: 'wp-2',
      error: { code: 4001, message: 'User rejected' },
    });

    expect(bridge.pageMessages).toHaveLength(1);
    expect(bridge.pageMessages[0].type).toBe('wp-response');
    expect(bridge.pageMessages[0].error).toEqual({ code: 4001, message: 'User rejected' });
  });

  it('forwards emit-event to page as wp-event', () => {
    const bridge = createBridge();

    bridge.handleBackgroundMessage({
      action: 'emit-event',
      event: 'accountsChanged',
      data: ['0xabc'],
    });

    expect(bridge.pageMessages).toHaveLength(1);
    expect(bridge.pageMessages[0]).toEqual({
      type: 'wp-event',
      event: 'accountsChanged',
      data: ['0xabc'],
      channel: MSG_CHANNEL,
    });
  });

  it('forwards chainChanged event to page', () => {
    const bridge = createBridge();

    bridge.handleBackgroundMessage({
      action: 'emit-event',
      event: 'chainChanged',
      data: '0x89',
    });

    expect(bridge.pageMessages).toHaveLength(1);
    expect(bridge.pageMessages[0].event).toBe('chainChanged');
    expect(bridge.pageMessages[0].data).toBe('0x89');
  });

  it('handles state-update with connected wallet', () => {
    const bridge = createBridge();

    bridge.handleBackgroundMessage({
      action: 'state-update',
      state: {
        phase: 'connected',
        wallet: { address: '0xdeadbeef', chainId: 137 },
      },
    });

    // Should produce connect + accountsChanged events
    expect(bridge.pageMessages).toHaveLength(2);
    expect(bridge.pageMessages[0]).toEqual({
      type: 'wp-event',
      event: 'connect',
      data: { chainId: '0x89' },
      channel: MSG_CHANNEL,
    });
    expect(bridge.pageMessages[1]).toEqual({
      type: 'wp-event',
      event: 'accountsChanged',
      data: ['0xdeadbeef'],
      channel: MSG_CHANNEL,
    });
  });

  it('state-update with non-connected phase produces no events', () => {
    const bridge = createBridge();

    bridge.handleBackgroundMessage({
      action: 'state-update',
      state: { phase: 'idle' },
    });

    expect(bridge.pageMessages).toHaveLength(0);
  });
});

describe('Content bridge - port lifecycle', () => {
  let runtime: ReturnType<typeof setupChromeRuntime>;
  let mockPort: ReturnType<typeof createMockPort>;

  beforeEach(() => {
    runtime = setupChromeRuntime();
    mockPort = createMockPort();
    runtime.connect.mockReturnValue(mockPort);
  });

  afterEach(() => {
    delete (globalThis as any).chrome;
  });

  it('reconnects port after disconnect', () => {
    const bridge = createBridge();

    // First connection
    bridge.handlePageMessage({
      type: 'wp-request',
      channel: MSG_CHANNEL,
      id: 'wp-1',
      payload: { method: 'eth_chainId' },
    });
    expect(runtime.connect).toHaveBeenCalledTimes(1);

    // Simulate disconnect
    mockPort._simulateDisconnect();

    // New mock port for reconnection
    const mockPort2 = createMockPort();
    runtime.connect.mockReturnValue(mockPort2);

    // Should reconnect on next message
    bridge.handlePageMessage({
      type: 'wp-request',
      channel: MSG_CHANNEL,
      id: 'wp-2',
      payload: { method: 'eth_chainId' },
    });
    expect(runtime.connect).toHaveBeenCalledTimes(2);
    expect(mockPort2.postMessage).toHaveBeenCalled();
  });

  it('sets portDead on extension context invalidation', () => {
    const bridge = createBridge();

    // First connection to create port
    bridge.handlePageMessage({
      type: 'wp-request',
      channel: MSG_CHANNEL,
      id: 'wp-1',
      payload: { method: 'eth_chainId' },
    });

    // Simulate extension context invalidation
    runtime.lastError = { message: 'Extension context invalidated' };
    mockPort._simulateDisconnect();

    expect(bridge.portDead).toBe(true);
  });

  it('returns null from getPort when portDead is true', () => {
    const bridge = createBridge();
    bridge.portDead = true;

    const result = bridge.getPort();
    expect(result).toBeNull();
    expect(runtime.connect).not.toHaveBeenCalled();
  });
});

describe('Content bridge - error handling when extension unavailable', () => {
  let runtime: ReturnType<typeof setupChromeRuntime>;

  beforeEach(() => {
    runtime = setupChromeRuntime();
  });

  afterEach(() => {
    delete (globalThis as any).chrome;
  });

  it('sends error to page when port is dead and request is rpc-request', () => {
    const bridge = createBridge();
    bridge.portDead = true;

    bridge.sendToBackground({ action: 'rpc-request', id: 'wp-99' });

    expect(bridge.pageMessages).toHaveLength(1);
    expect(bridge.pageMessages[0]).toEqual({
      type: 'wp-response',
      id: 'wp-99',
      error: { code: -32603, message: 'Extension was updated. Please refresh the page.' },
      channel: MSG_CHANNEL,
    });
  });

  it('does not send error for non-rpc-request when port is dead', () => {
    const bridge = createBridge();
    bridge.portDead = true;

    bridge.sendToBackground({ action: 'get-state' });

    expect(bridge.pageMessages).toHaveLength(0);
  });

  it('falls back to sendMessage when port.postMessage throws', async () => {
    const mockPort = createMockPort();
    mockPort.postMessage.mockImplementation(() => { throw new Error('Port closed'); });
    runtime.connect.mockReturnValue(mockPort);
    runtime.sendMessage.mockResolvedValue({ action: 'rpc-response', id: 'wp-5', result: '0x1' });

    const bridge = createBridge();

    bridge.sendToBackground({ action: 'rpc-request', id: 'wp-5', payload: { method: 'eth_chainId' } });

    // Should have tried port first, then fallen back to sendMessage
    expect(mockPort.postMessage).toHaveBeenCalled();
    expect(runtime.sendMessage).toHaveBeenCalled();
  });

  it('sends error when sendMessage also fails', async () => {
    runtime.connect.mockImplementation(() => { throw new Error('No connection'); });
    runtime.sendMessage.mockRejectedValue(new Error('Extension unavailable'));

    const bridge = createBridge();

    bridge.sendToBackground({ action: 'rpc-request', id: 'wp-10' });

    // Wait for the async rejection
    await new Promise((r) => setTimeout(r, 10));

    const errorMsg = bridge.pageMessages.find(
      (m) => m.type === 'wp-response' && m.error,
    );
    expect(errorMsg).toBeDefined();
    expect(errorMsg!.error.code).toBe(-32603);
  });
});

describe('Content bridge - broadcast listener', () => {
  let runtime: ReturnType<typeof setupChromeRuntime>;

  beforeEach(() => {
    runtime = setupChromeRuntime();
    const mockPort = createMockPort();
    runtime.connect.mockReturnValue(mockPort);
  });

  afterEach(() => {
    delete (globalThis as any).chrome;
  });

  it('handles emit-event broadcast from background', () => {
    const bridge = createBridge();

    // Simulate a broadcast message like chrome.runtime.onMessage would deliver
    bridge.handleBackgroundMessage({
      action: 'emit-event',
      event: 'accountsChanged',
      data: ['0xnew'],
    });

    expect(bridge.pageMessages).toHaveLength(1);
    expect(bridge.pageMessages[0].type).toBe('wp-event');
    expect(bridge.pageMessages[0].event).toBe('accountsChanged');
  });

  it('handles state-update broadcast from background', () => {
    const bridge = createBridge();

    bridge.handleBackgroundMessage({
      action: 'state-update',
      state: {
        phase: 'connected',
        wallet: { address: '0xbroadcast', chainId: 1 },
      },
    });

    expect(bridge.pageMessages.length).toBeGreaterThanOrEqual(2);
    expect(bridge.pageMessages[0].event).toBe('connect');
    expect(bridge.pageMessages[1].event).toBe('accountsChanged');
    expect(bridge.pageMessages[1].data).toEqual(['0xbroadcast']);
  });
});
