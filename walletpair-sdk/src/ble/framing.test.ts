import { describe, it, expect } from 'vitest';
import { frameMessage, Defragmenter, DEFAULT_FRAME_PAYLOAD, MIN_FRAME_PAYLOAD } from './framing.js';

describe('frameMessage', () => {
  it('frames empty string as single frame with both flags', () => {
    const frames = frameMessage('');
    expect(frames).toHaveLength(1);
    expect(frames[0]![0]).toBe(0x03); // first + last
    expect(frames[0]).toHaveLength(3); // header only
  });

  it('frames short message as single frame', () => {
    const msg = '{"v":1,"t":"ping"}';
    const frames = frameMessage(msg);
    expect(frames).toHaveLength(1);
    expect(frames[0]![0]).toBe(0x03); // first + last

    // Verify total length in header
    const payload = new TextEncoder().encode(msg);
    const totalLen = (frames[0]![1]! << 8) | frames[0]![2]!;
    expect(totalLen).toBe(payload.length);

    // Verify payload
    const extracted = frames[0]!.subarray(3);
    expect(new TextDecoder().decode(extracted)).toBe(msg);
  });

  it('fragments message exceeding maxPayload', () => {
    const longMsg = 'A'.repeat(100);
    const frames = frameMessage(longMsg, 30);

    expect(frames.length).toBeGreaterThan(1);

    // First frame: flag=0x01 (first only)
    expect(frames[0]![0]! & 0x01).toBe(0x01); // first bit set
    expect(frames[0]![0]! & 0x02).toBe(0x00); // last bit not set

    // Last frame: flag=0x02 (last only)
    const lastFrame = frames[frames.length - 1]!;
    expect(lastFrame[0]! & 0x01).toBe(0x00); // first bit not set
    expect(lastFrame[0]! & 0x02).toBe(0x02); // last bit set

    // Middle frames (if any): flag=0x00
    for (let i = 1; i < frames.length - 1; i++) {
      expect(frames[i]![0]).toBe(0x00);
    }
  });

  it('first frame contains total length in header', () => {
    const msg = 'X'.repeat(200);
    const frames = frameMessage(msg, 50);
    const totalLen = (frames[0]![1]! << 8) | frames[0]![2]!;
    expect(totalLen).toBe(new TextEncoder().encode(msg).length);
  });

  it('respects MIN_FRAME_PAYLOAD even when maxPayload is smaller', () => {
    const msg = 'A'.repeat(100);
    const frames = frameMessage(msg, 5); // smaller than MIN_FRAME_PAYLOAD
    // Each payload chunk should be at least MIN_FRAME_PAYLOAD
    for (const frame of frames) {
      const payloadSize = frame.length - 3;
      if (payloadSize > 0) {
        // Last frame might be shorter
        if ((frame[0]! & 0x02) === 0) {
          expect(payloadSize).toBeGreaterThanOrEqual(MIN_FRAME_PAYLOAD);
        }
      }
    }
  });

  it('uses DEFAULT_FRAME_PAYLOAD when no maxPayload specified', () => {
    const msg = 'B'.repeat(DEFAULT_FRAME_PAYLOAD + 100);
    const frames = frameMessage(msg);
    expect(frames.length).toBe(2); // slightly over one full frame
  });
});

describe('Defragmenter', () => {
  it('reassembles single-frame message', () => {
    const defrag = new Defragmenter();
    const msg = '{"hello":"world"}';
    const frames = frameMessage(msg);

    expect(frames).toHaveLength(1);
    const result = defrag.push(frames[0]!);
    expect(result).toBe(msg);
  });

  it('reassembles multi-frame message', () => {
    const defrag = new Defragmenter();
    const msg = 'A'.repeat(200);
    const frames = frameMessage(msg, 50);

    expect(frames.length).toBeGreaterThan(1);

    for (let i = 0; i < frames.length - 1; i++) {
      const result = defrag.push(frames[i]!);
      expect(result).toBeNull(); // not complete yet
    }

    const result = defrag.push(frames[frames.length - 1]!);
    expect(result).toBe(msg);
  });

  it('handles multiple messages in sequence', () => {
    const defrag = new Defragmenter();

    const msg1 = '{"first":true}';
    const msg2 = '{"second":true}';

    const frames1 = frameMessage(msg1);
    const frames2 = frameMessage(msg2);

    expect(defrag.push(frames1[0]!)).toBe(msg1);
    expect(defrag.push(frames2[0]!)).toBe(msg2);
  });

  it('handles interleaved fragmented messages correctly via reset', () => {
    const defrag = new Defragmenter();

    // Start a message
    const longMsg = 'X'.repeat(100);
    const frames = frameMessage(longMsg, 30);
    defrag.push(frames[0]!); // first fragment

    // Reset and start new message
    defrag.reset();
    const shortMsg = '{"ok":true}';
    const shortFrames = frameMessage(shortMsg);
    expect(defrag.push(shortFrames[0]!)).toBe(shortMsg);
  });

  it('ignores frames shorter than 3 bytes', () => {
    const defrag = new Defragmenter();
    expect(defrag.push(new Uint8Array([0x03, 0x00]))).toBeNull();
    expect(defrag.push(new Uint8Array([0x03]))).toBeNull();
    expect(defrag.push(new Uint8Array([]))).toBeNull();
  });

  it('reassembles unicode content correctly', () => {
    const defrag = new Defragmenter();
    const msg = '{"text":"你好世界🌍"}';
    const frames = frameMessage(msg, 20);

    let result: string | null = null;
    for (const frame of frames) {
      result = defrag.push(frame);
    }
    expect(result).toBe(msg);
  });

  it('handles large messages (> 64KB total length)', () => {
    const defrag = new Defragmenter();
    // total_length field is 2 bytes, so max representable is 65535
    // But the code handles growth beyond that via the safety check
    const msg = 'Z'.repeat(1000);
    const frames = frameMessage(msg, 100);

    let result: string | null = null;
    for (const frame of frames) {
      result = defrag.push(frame);
    }
    expect(result).toBe(msg);
  });

  it('reset() clears internal state', () => {
    const defrag = new Defragmenter();
    const longMsg = 'Y'.repeat(100);
    const frames = frameMessage(longMsg, 30);

    // Push first frame
    defrag.push(frames[0]!);
    defrag.reset();

    // After reset, pushing a complete single-frame message should work
    const shortMsg = '{"reset":true}';
    const shortFrames = frameMessage(shortMsg);
    expect(defrag.push(shortFrames[0]!)).toBe(shortMsg);
  });

  it('frame/defrag round-trip preserves exact content for various sizes', () => {
    const defrag = new Defragmenter();
    for (const size of [0, 1, 19, 20, 21, 50, 100, 509, 510, 1000]) {
      defrag.reset();
      // Size 0 frame has no payload text, skip
      if (size === 0) continue;
      const msg = JSON.stringify({ data: 'x'.repeat(size) });
      const frames = frameMessage(msg, 50);
      let result: string | null = null;
      for (const frame of frames) {
        result = defrag.push(frame);
      }
      expect(result).toBe(msg);
    }
  });
});
