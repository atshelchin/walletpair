import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketTransport } from './ws-transport.js';

// Mock WebSocket for Node.js environment
class MockWebSocket {
  static instances: MockWebSocket[] = [];

  url: string;
  protocols: string[];
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sentMessages: string[] = [];

  constructor(url: string, protocols?: string[]) {
    this.url = url;
    this.protocols = protocols ?? [];
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close() {
    this.readyState = 3; // CLOSED
    this.onclose?.();
  }

  // Test helpers
  simulateOpen() {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }

  simulateMessage(data: string) {
    this.onmessage?.({ data });
  }

  simulateClose() {
    this.readyState = 3;
    this.onclose?.();
  }

  simulateError() {
    this.onerror?.();
  }
}

describe('WebSocketTransport', () => {
  let originalWebSocket: typeof globalThis.WebSocket;

  beforeEach(() => {
    MockWebSocket.instances = [];
    originalWebSocket = globalThis.WebSocket;
    (globalThis as any).WebSocket = MockWebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  it('starts disconnected', () => {
    const t = new WebSocketTransport('ws://localhost:8080/v1');
    expect(t.state).toBe('disconnected');
  });

  it('accepts string URL constructor', () => {
    const t = new WebSocketTransport('ws://localhost:8080/v1');
    expect(t.state).toBe('disconnected');
  });

  it('accepts options object constructor', () => {
    const t = new WebSocketTransport({ url: 'ws://localhost:8080/v1', protocols: ['custom'] });
    expect(t.state).toBe('disconnected');
  });

  describe('connect', () => {
    it('resolves on successful connection', async () => {
      const t = new WebSocketTransport('ws://localhost:8080/v1');

      const connectPromise = t.connect();

      // Simulate WebSocket open
      const ws = MockWebSocket.instances[0]!;
      expect(ws.url).toBe('ws://localhost:8080/v1');
      expect(ws.protocols).toEqual(['walletpair.v1']);

      ws.simulateOpen();

      await connectPromise;
      expect(t.state).toBe('connected');
    });

    it('rejects on connection failure', async () => {
      const t = new WebSocketTransport('ws://localhost:8080/v1');

      const connectPromise = t.connect();

      const ws = MockWebSocket.instances[0]!;
      ws.simulateError();
      ws.simulateClose();

      await expect(connectPromise).rejects.toThrow('WebSocket connection failed');
      expect(t.state).toBe('disconnected');
    });

    it('calls onOpen handler on successful connection', async () => {
      const t = new WebSocketTransport('ws://localhost:8080/v1');
      const openHandler = vi.fn();
      t.onOpen(openHandler);

      const promise = t.connect();
      MockWebSocket.instances[0]!.simulateOpen();
      await promise;

      expect(openHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe('send', () => {
    it('sends JSON-serialized message', async () => {
      const t = new WebSocketTransport('ws://localhost:8080/v1');
      const promise = t.connect();
      MockWebSocket.instances[0]!.simulateOpen();
      await promise;

      const msg = { v: 1, t: 'ping', ch: 'abc', ts: 123 } as any;
      t.send(msg);

      const ws = MockWebSocket.instances[0]!;
      expect(ws.sentMessages).toHaveLength(1);
      expect(JSON.parse(ws.sentMessages[0]!)).toEqual(msg);
    });

    it('does nothing when not connected', () => {
      const t = new WebSocketTransport('ws://localhost:8080/v1');
      // Not connected, should not throw
      t.send({ v: 1, t: 'ping', ch: 'abc', ts: 123 } as any);
    });
  });

  describe('receive', () => {
    it('calls message handler on incoming messages', async () => {
      const t = new WebSocketTransport('ws://localhost:8080/v1');
      const handler = vi.fn();
      t.onMessage(handler);

      const promise = t.connect();
      MockWebSocket.instances[0]!.simulateOpen();
      await promise;

      const msg = { v: 1, t: 'ready', ch: 'abc', state: 'waiting' };
      MockWebSocket.instances[0]!.simulateMessage(JSON.stringify(msg));

      expect(handler).toHaveBeenCalledWith(msg);
    });

    it('ignores malformed JSON', async () => {
      const t = new WebSocketTransport('ws://localhost:8080/v1');
      const handler = vi.fn();
      t.onMessage(handler);

      const promise = t.connect();
      MockWebSocket.instances[0]!.simulateOpen();
      await promise;

      MockWebSocket.instances[0]!.simulateMessage('not json');
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('disconnect', () => {
    it('transitions to disconnected', async () => {
      const t = new WebSocketTransport('ws://localhost:8080/v1');
      const promise = t.connect();
      MockWebSocket.instances[0]!.simulateOpen();
      await promise;

      t.disconnect();
      expect(t.state).toBe('disconnected');
    });

    it('does not call close handler on intentional disconnect', async () => {
      const t = new WebSocketTransport('ws://localhost:8080/v1');
      const closeHandler = vi.fn();
      t.onClose(closeHandler);

      const promise = t.connect();
      MockWebSocket.instances[0]!.simulateOpen();
      await promise;

      t.disconnect();
      expect(closeHandler).not.toHaveBeenCalled();
    });
  });

  describe('unexpected close', () => {
    it('calls close handler on unexpected transport close', async () => {
      const t = new WebSocketTransport('ws://localhost:8080/v1');
      const closeHandler = vi.fn();
      t.onClose(closeHandler);

      const promise = t.connect();
      MockWebSocket.instances[0]!.simulateOpen();
      await promise;

      // Simulate unexpected close (e.g., network drop)
      MockWebSocket.instances[0]!.simulateClose();

      expect(closeHandler).toHaveBeenCalledTimes(1);
      expect(t.state).toBe('disconnected');
    });
  });

  describe('setUrl', () => {
    it('updates the URL for next connection', async () => {
      const t = new WebSocketTransport('ws://localhost:8080/v1');
      t.setUrl('ws://other:9090/v1');

      const promise = t.connect();
      const ws = MockWebSocket.instances[0]!;
      expect(ws.url).toBe('ws://other:9090/v1');

      ws.simulateOpen();
      await promise;
    });
  });
});
