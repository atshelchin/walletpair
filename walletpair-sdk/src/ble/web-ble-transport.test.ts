import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebBleCentralTransport, isWebBleSupported } from './web-ble-transport.js';

// ── Mock Web Bluetooth API ──────────────────────────────────────────

function createMockCharacteristic() {
  const listeners = new Map<string, Function>();
  return {
    writeValueWithoutResponse: vi.fn().mockResolvedValue(undefined),
    startNotifications: vi.fn().mockResolvedValue(undefined),
    addEventListener: vi.fn((evt: string, fn: Function) => { listeners.set(evt, fn); }),
    removeEventListener: vi.fn((evt: string) => { listeners.delete(evt); }),
    _fire: (evt: string, data: any) => listeners.get(evt)?.(data),
    value: null as DataView | null,
  };
}

function createMockBleDevice() {
  const listeners = new Map<string, Function>();
  const writeChar = createMockCharacteristic();
  const notifyChar = createMockCharacteristic();

  const service = {
    getCharacteristic: vi.fn((uuid: string) => {
      // BLE_WRITE_CHAR_UUID = 'e3a10002-...'
      if (uuid.includes('10002')) return Promise.resolve(writeChar);
      if (uuid.includes('10003')) return Promise.resolve(notifyChar);
      return Promise.reject(new Error('unknown characteristic'));
    }),
  };

  const server = {
    connect: vi.fn().mockResolvedValue(undefined),
    getPrimaryService: vi.fn().mockResolvedValue(service),
    connected: true,
  };

  // Make connect() return the server with getPrimaryService
  server.connect.mockResolvedValue(server);

  const device = {
    gatt: {
      connect: vi.fn().mockResolvedValue(server),
      connected: true,
      disconnect: vi.fn(),
    },
    addEventListener: vi.fn((evt: string, fn: Function) => { listeners.set(evt, fn); }),
    removeEventListener: vi.fn((evt: string) => { listeners.delete(evt); }),
    _fireDisconnect: () => listeners.get('gattserverdisconnected')?.({} as Event),
  };

  return { device, writeChar, notifyChar, server };
}

function mockNavigatorBluetooth(device: any) {
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      bluetooth: {
        requestDevice: vi.fn().mockResolvedValue(device),
      },
    },
    writable: true,
    configurable: true,
  });
}

function clearNavigatorBluetooth() {
  Object.defineProperty(globalThis, 'navigator', {
    value: undefined,
    writable: true,
    configurable: true,
  });
}

// ── isWebBleSupported ───────────────────────────────────────────────

describe('isWebBleSupported', () => {
  it('returns false when navigator is undefined', () => {
    clearNavigatorBluetooth();
    expect(isWebBleSupported()).toBe(false);
  });

  it('returns false when navigator.bluetooth is missing', () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      writable: true,
      configurable: true,
    });
    expect(isWebBleSupported()).toBe(false);
  });

  it('returns true when navigator.bluetooth exists', () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { bluetooth: {} },
      writable: true,
      configurable: true,
    });
    expect(isWebBleSupported()).toBe(true);
  });
});

// ── WebBleCentralTransport ──────────────────────────────────────────

describe('WebBleCentralTransport', () => {
  let transport: WebBleCentralTransport;

  beforeEach(() => {
    transport = new WebBleCentralTransport();
    clearNavigatorBluetooth();
  });

  it('starts in disconnected state', () => {
    expect(transport.state).toBe('disconnected');
  });

  it('connect() throws when Web Bluetooth is not supported', async () => {
    await expect(transport.connect()).rejects.toThrow('Web Bluetooth is not supported');
  });

  it('connect() transitions through connecting to connected', async () => {
    const { device } = createMockBleDevice();
    mockNavigatorBluetooth(device);

    const openHandler = vi.fn();
    transport.onOpen(openHandler);

    await transport.connect();

    expect(transport.state).toBe('connected');
    expect(openHandler).toHaveBeenCalledTimes(1);
  });

  it('connect() sets up GATT characteristics', async () => {
    const { device, notifyChar } = createMockBleDevice();
    mockNavigatorBluetooth(device);

    await transport.connect();

    expect(notifyChar.startNotifications).toHaveBeenCalled();
    expect(notifyChar.addEventListener).toHaveBeenCalledWith(
      'characteristicvaluechanged',
      expect.any(Function),
    );
  });

  it('disconnect() calls gatt.disconnect and cleans up', async () => {
    const { device } = createMockBleDevice();
    mockNavigatorBluetooth(device);

    await transport.connect();
    transport.disconnect();

    expect(device.gatt.disconnect).toHaveBeenCalled();
    expect(transport.state).toBe('disconnected');
  });

  it('disconnect() is safe to call when not connected', () => {
    expect(() => transport.disconnect()).not.toThrow();
    expect(transport.state).toBe('disconnected');
  });

  it('send() does nothing when not connected', () => {
    transport.send({ v: 1, t: 'ping', ch: 'abc' } as any);
    // Should not throw
  });

  it('onClose handler fires on GATT disconnect', async () => {
    const { device } = createMockBleDevice();
    mockNavigatorBluetooth(device);

    const closeHandler = vi.fn();
    transport.onClose(closeHandler);

    await transport.connect();
    device._fireDisconnect();

    expect(closeHandler).toHaveBeenCalledTimes(1);
    expect(transport.state).toBe('disconnected');
  });

  it('handler registration methods work', () => {
    const msgHandler = vi.fn();
    const closeHandler = vi.fn();
    const openHandler = vi.fn();

    transport.onMessage(msgHandler);
    transport.onClose(closeHandler);
    transport.onOpen(openHandler);

    // No throws — handlers registered
  });
});
