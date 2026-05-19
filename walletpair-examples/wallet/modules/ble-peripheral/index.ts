import { requireNativeModule, EventEmitter } from 'expo-modules-core';

export interface WriteEvent { characteristicUuid: string; value: string }
export interface SubscribeEvent { characteristicUuid: string }
export interface ConnectEvent { address: string }
export interface DisconnectEvent { address?: string; error?: string }
export interface MtuEvent { mtu: number }

type Events = {
  onWrite: (event: WriteEvent) => void;
  onSubscribe: (event: SubscribeEvent) => void;
  onUnsubscribe: (event: SubscribeEvent) => void;
  onConnect: (event: ConnectEvent) => void;
  onDisconnect: (event: DisconnectEvent) => void;
  onMtuChanged: (event: MtuEvent) => void;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const native = requireNativeModule<any>('BlePeripheral');
const emitter = new EventEmitter<Events>(native);

export function start(svc: string, w: string, n: string, name = 'WalletPair'): Promise<void> {
  return native.start(svc, w, n, name);
}
export function stop(): Promise<void> { return native.stop(); }
export function sendNotification(b64: string): Promise<void> { return native.sendNotification(b64); }
export function sendBatch(frames: string[]): Promise<void> { return native.sendBatch(frames); }

export function onWrite(h: (e: WriteEvent) => void) { return emitter.addListener('onWrite', h); }
export function onSubscribe(h: (e: SubscribeEvent) => void) { return emitter.addListener('onSubscribe', h); }
export function onUnsubscribe(h: (e: SubscribeEvent) => void) { return emitter.addListener('onUnsubscribe', h); }
export function onConnect(h: (e: ConnectEvent) => void) { return emitter.addListener('onConnect', h); }
export function onDisconnect(h: (e: DisconnectEvent) => void) { return emitter.addListener('onDisconnect', h); }
export function onMtuChanged(h: (e: MtuEvent) => void) { return emitter.addListener('onMtuChanged', h); }
