/**
 * BLE message framing per WalletPair Protocol Section 19.5.
 *
 * Frame format: [1 byte flags] [2 bytes total_length BE] [payload fragment]
 *
 *   flags bit 0: first fragment
 *   flags bit 1: last fragment
 *
 * MTU-aware: frame payload size adapts to negotiated MTU.
 * Default 509 bytes (512 MTU - 3 byte header) for modern devices.
 */

const FLAG_FIRST = 0x01;
const FLAG_LAST = 0x02;

/** Default max payload per fragment. Conservative fallback if MTU unknown. */
export const DEFAULT_FRAME_PAYLOAD = 509;

/** Minimum safe payload (for devices that don't negotiate MTU). */
export const MIN_FRAME_PAYLOAD = 20;

// ---------------------------------------------------------------------------
// Fragmenting (sender side)
// ---------------------------------------------------------------------------

/** Split a JSON string into BLE frames. `maxPayload` = MTU - 3 (header). */
export function frameMessage(
  jsonStr: string,
  maxPayload = DEFAULT_FRAME_PAYLOAD,
): Uint8Array[] {
  const payload = new TextEncoder().encode(jsonStr);
  const frames: Uint8Array[] = [];

  if (payload.length === 0) {
    const frame = new Uint8Array(3);
    frame[0] = FLAG_FIRST | FLAG_LAST;
    return [frame];
  }

  const chunkSize = Math.max(maxPayload, MIN_FRAME_PAYLOAD);

  for (let offset = 0; offset < payload.length; offset += chunkSize) {
    const isFirst = offset === 0;
    const end = Math.min(offset + chunkSize, payload.length);
    const isLast = end === payload.length;
    const fragment = payload.subarray(offset, end); // subarray = no copy

    const frame = new Uint8Array(3 + fragment.length);
    frame[0] = (isFirst ? FLAG_FIRST : 0) | (isLast ? FLAG_LAST : 0);
    if (isFirst) {
      frame[1] = (payload.length >> 8) & 0xff;
      frame[2] = payload.length & 0xff;
    }
    frame.set(fragment, 3);
    frames.push(frame);
  }

  return frames;
}

// ---------------------------------------------------------------------------
// Defragmenting (receiver side)
// ---------------------------------------------------------------------------

/** Accumulates BLE frames and emits complete JSON strings. */
export class Defragmenter {
  private buffer: Uint8Array | null = null;
  private offset = 0;

  /**
   * Push a received BLE frame. Returns the complete JSON string when the
   * last fragment arrives, or null if more fragments are expected.
   */
  push(data: Uint8Array): string | null {
    if (data.length < 3) return null;

    const flags = data[0];
    const isFirst = !!(flags & FLAG_FIRST);
    const isLast = !!(flags & FLAG_LAST);
    const fragment = data.subarray(3);

    if (isFirst) {
      // Pre-allocate buffer using total_length from header
      const totalLength = (data[1] << 8) | data[2];
      this.buffer = new Uint8Array(totalLength || fragment.length);
      this.offset = 0;
    }

    if (this.buffer) {
      // Copy fragment into pre-allocated buffer
      if (this.offset + fragment.length <= this.buffer.length) {
        this.buffer.set(fragment, this.offset);
      } else {
        // Buffer too small (shouldn't happen with correct total_length) — grow
        const grown = new Uint8Array(this.offset + fragment.length);
        grown.set(this.buffer.subarray(0, this.offset));
        grown.set(fragment, this.offset);
        this.buffer = grown;
      }
      this.offset += fragment.length;
    }

    if (isLast && this.buffer) {
      const result = new TextDecoder().decode(this.buffer.subarray(0, this.offset));
      this.buffer = null;
      this.offset = 0;
      return result;
    }

    return null;
  }

  reset(): void {
    this.buffer = null;
    this.offset = 0;
  }
}

// ---------------------------------------------------------------------------
// BLE UUIDs
// ---------------------------------------------------------------------------

export const BLE_SERVICE_UUID = 'e3a10001-7770-4270-8000-000077700001';
export const BLE_WRITE_CHAR_UUID = 'e3a10002-7770-4270-8000-000077700001';
export const BLE_NOTIFY_CHAR_UUID = 'e3a10003-7770-4270-8000-000077700001';
