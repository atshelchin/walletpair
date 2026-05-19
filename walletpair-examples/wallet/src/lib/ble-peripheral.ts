/**
 * BLE Peripheral transport for WalletPair wallet.
 *
 * Uses our custom Expo native module (modules/ble-peripheral) with:
 * - Dynamic MTU negotiation (adapts frame size to device capability)
 * - Batch send (all frames in one native call, no JS↔Native round-trips per frame)
 * - Queue-based flow control on iOS (drainQueue + peripheralManagerIsReady)
 */

import {
  BLE_SERVICE_UUID,
  BLE_WRITE_CHAR_UUID,
  BLE_NOTIFY_CHAR_UUID,
  DEFAULT_FRAME_PAYLOAD,
  frameMessage,
  Defragmenter,
} from './ble-framing';

export { BLE_SERVICE_UUID, BLE_WRITE_CHAR_UUID, BLE_NOTIFY_CHAR_UUID };

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    chunks.push(String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 8192))));
  }
  return btoa(chunks.join(''));
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// BLE Peripheral Transport
// ---------------------------------------------------------------------------

export class BlePeripheralTransport {
  private defragmenter = new Defragmenter();
  private subscribed = false;
  private started = false;
  private starting = false;
  private subscriptions: { remove(): void }[] = [];
  private mtuPayload = DEFAULT_FRAME_PAYLOAD; // updated by onMtuChanged

  private _onMessage: ((msg: Record<string, unknown>) => void) | null = null;
  private _onConnected: (() => void) | null = null;
  private _onDisconnected: (() => void) | null = null;

  onMessage(handler: (msg: Record<string, unknown>) => void) { this._onMessage = handler; }
  onConnected(handler: () => void) { this._onConnected = handler; }
  onDisconnected(handler: () => void) { this._onDisconnected = handler; }

  async start(deviceName = 'WalletPair'): Promise<void> {
    if (this.starting || this.started) return;
    this.starting = true;

    try { await this.stop(); } catch { /* ok */ }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    let Ble: typeof import('../../modules/ble-peripheral');
    try { Ble = require('../../modules/ble-peripheral'); }
    catch (e: any) { throw new Error(`BLE not available: ${e.message}`); }

    this.subscriptions.push(
      Ble.onWrite((event) => {
        const bytes = base64ToBytes(event.value);
        const json = this.defragmenter.push(new Uint8Array(bytes));
        if (json && this._onMessage) {
          try { this._onMessage(JSON.parse(json)); } catch { /* bad json */ }
        }
      }),
      Ble.onSubscribe(() => {
        this.subscribed = true;
        this._onConnected?.();
      }),
      Ble.onUnsubscribe(() => {
        this.subscribed = false;
        this._onDisconnected?.();
      }),
      Ble.onDisconnect(() => {
        this.subscribed = false;
        this._onDisconnected?.();
      }),
      Ble.onMtuChanged((event) => {
        // MTU = max bytes per notification. Frame header is 3 bytes.
        this.mtuPayload = Math.max(event.mtu - 3, 20);
        console.log(`[BLE] MTU negotiated: ${event.mtu}, frame payload: ${this.mtuPayload}`);
      }),
    );

    await Ble.start(BLE_SERVICE_UUID, BLE_WRITE_CHAR_UUID, BLE_NOTIFY_CHAR_UUID, deviceName);
    this.started = true;
    this.starting = false;
  }

  async sendMessage(msg: Record<string, unknown>): Promise<void> {
    if (!this.started || !this.subscribed) return;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Ble: typeof import('../../modules/ble-peripheral') = require('../../modules/ble-peripheral');

    const frames = frameMessage(JSON.stringify(msg), this.mtuPayload);
    const b64Frames = frames.map(f => bytesToBase64(f));

    // Single native call for all frames — no per-frame JS↔Native overhead
    await Ble.sendBatch(b64Frames);
  }

  isConnected(): boolean { return this.subscribed; }

  async stop(): Promise<void> {
    for (const sub of this.subscriptions) sub.remove();
    this.subscriptions = [];
    if (this.started) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Ble: typeof import('../../modules/ble-peripheral') = require('../../modules/ble-peripheral');
        await Ble.stop();
      } catch { /* best effort */ }
    }
    this.started = false;
    this.starting = false;
    this.subscribed = false;
    this.mtuPayload = DEFAULT_FRAME_PAYLOAD;
    this.defragmenter.reset();
  }
}
