/**
 * Web Bluetooth Central transport for dApp side.
 *
 * The dApp acts as BLE Central and connects to the wallet's GATT Peripheral.
 * Safe to import anywhere — checks Web Bluetooth availability at runtime.
 */

import type { Transport, TransportState, ProtocolMessage } from '../types.js';
import {
  BLE_SERVICE_UUID,
  BLE_WRITE_CHAR_UUID,
  BLE_NOTIFY_CHAR_UUID,
  frameMessage,
  Defragmenter,
} from './framing.js';

export function isWebBleSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

export class WebBleCentralTransport implements Transport {
  state: TransportState = 'disconnected';

  private device: BluetoothDevice | null = null;
  private writeChar: BluetoothRemoteGATTCharacteristic | null = null;
  private notifyChar: BluetoothRemoteGATTCharacteristic | null = null;
  private defrag = new Defragmenter();
  private mtuPayload = 509;

  private messageHandler: ((msg: ProtocolMessage) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private openHandler: (() => void) | null = null;

  onMessage(handler: (msg: ProtocolMessage) => void): void { this.messageHandler = handler; }
  onClose(handler: () => void): void { this.closeHandler = handler; }
  onOpen(handler: () => void): void { this.openHandler = handler; }

  async connect(): Promise<void> {
    if (!isWebBleSupported()) {
      throw new Error('Web Bluetooth is not supported in this environment');
    }

    this.state = 'connecting';

    const device = await navigator.bluetooth!.requestDevice({
      filters: [
        { namePrefix: 'WalletPair' },
        { services: [BLE_SERVICE_UUID] },
      ],
      optionalServices: [BLE_SERVICE_UUID],
    });

    this.device = device;
    device.addEventListener('gattserverdisconnected', this.onDisconnect);

    const server = await device.gatt!.connect();
    const service = await server.getPrimaryService(BLE_SERVICE_UUID);

    this.writeChar = await service.getCharacteristic(BLE_WRITE_CHAR_UUID);
    this.notifyChar = await service.getCharacteristic(BLE_NOTIFY_CHAR_UUID);

    await this.notifyChar.startNotifications();
    this.notifyChar.addEventListener('characteristicvaluechanged', this.onNotification);

    this.state = 'connected';
    this.openHandler?.();
  }

  send(msg: ProtocolMessage): void {
    if (!this.writeChar || this.state !== 'connected') return;
    const frames = frameMessage(JSON.stringify(msg), this.mtuPayload);
    // Send frames sequentially
    let chain = Promise.resolve();
    for (const frame of frames) {
      chain = chain.then(() => this.writeChar!.writeValueWithoutResponse(frame as unknown as ArrayBuffer));
    }
  }

  disconnect(): void {
    if (this.device?.gatt?.connected) {
      this.device.gatt.disconnect();
    }
    this.cleanup();
  }

  private onNotification = (event: Event): void => {
    const target = event.target as BluetoothRemoteGATTCharacteristic;
    const dv = target.value!;
    const data = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    const json = this.defrag.push(data);
    if (json && this.messageHandler) {
      try { this.messageHandler(JSON.parse(json)); } catch { /* bad json */ }
    }
  };

  private onDisconnect = (): void => {
    this.cleanup();
    this.closeHandler?.();
  };

  private cleanup(): void {
    if (this.notifyChar) {
      this.notifyChar.removeEventListener('characteristicvaluechanged', this.onNotification);
    }
    if (this.device) {
      this.device.removeEventListener('gattserverdisconnected', this.onDisconnect);
    }
    this.device = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.defrag.reset();
    this.state = 'disconnected';
  }
}
