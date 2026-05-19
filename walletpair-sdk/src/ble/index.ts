/**
 * BLE transport exports.
 *
 * Re-exports framing utilities and provides the Web Bluetooth Central transport.
 * Safe to import on any platform — Web Bluetooth availability is checked at runtime.
 */

export {
  frameMessage,
  Defragmenter,
  DEFAULT_FRAME_PAYLOAD,
  MIN_FRAME_PAYLOAD,
  BLE_SERVICE_UUID,
  BLE_WRITE_CHAR_UUID,
  BLE_NOTIFY_CHAR_UUID,
} from './framing.js';

export { WebBleCentralTransport, isWebBleSupported } from './web-ble-transport.js';
