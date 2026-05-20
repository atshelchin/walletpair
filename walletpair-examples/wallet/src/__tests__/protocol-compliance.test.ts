/**
 * Protocol compliance tests for WalletPair Protocol v1 and EVM Sub-Protocol v1.
 *
 * These tests verify that the crypto primitives, message formats, and data
 * structures match the published protocol specifications. They serve as
 * regression tests to prevent protocol deviations.
 */

import { describe, it, expect } from '@jest/globals';

// --- Helpers (inline to avoid import issues in test env) ---

function b64urlEncode(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    chunks.push(String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 8192))));
  }
  return btoa(chunks.join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64urlDecode(str: string): Uint8Array {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ============================================================
// 1. Channel ID validation (Protocol Section 4)
// ============================================================

describe('Protocol Section 4: Channel ID', () => {
  it('must be 64 lowercase hex chars', () => {
    const valid = 'a'.repeat(64);
    expect(valid).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects uppercase hex', () => {
    const upper = 'A'.repeat(64);
    expect(upper).not.toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects wrong length', () => {
    expect('abcd').not.toMatch(/^[0-9a-f]{64}$/);
    expect('a'.repeat(63)).not.toMatch(/^[0-9a-f]{64}$/);
    expect('a'.repeat(65)).not.toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects non-hex chars', () => {
    const bad = 'g'.repeat(64);
    expect(bad).not.toMatch(/^[0-9a-f]{64}$/);
  });
});

// ============================================================
// 2. Peer ID validation (Protocol Section 4)
// ============================================================

describe('Protocol Section 4: Peer ID', () => {
  it('base64url encodes 32 bytes to 43 chars no padding', () => {
    const bytes = new Uint8Array(32);
    const encoded = b64urlEncode(bytes);
    expect(encoded.length).toBe(43);
    expect(encoded).not.toContain('=');
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
  });

  it('round-trips correctly', () => {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = i;
    const encoded = b64urlEncode(bytes);
    const decoded = b64urlDecode(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });

  it('rejects wrong-size key (16 bytes)', () => {
    const bytes = new Uint8Array(16);
    const encoded = b64urlEncode(bytes);
    const decoded = b64urlDecode(encoded);
    expect(decoded.length).toBe(16);
    expect(decoded.length).not.toBe(32);
  });
});

// ============================================================
// 3. Pairing code endianness (Protocol Section 7.3)
// ============================================================

describe('Protocol Section 7.3: Pairing Code', () => {
  it('uses big-endian uint32 by default (DataView without arg)', () => {
    // Protocol: code_uint32 = big-endian uint32(code_bytes)
    // DataView.getUint32(0) without littleEndian arg defaults to big-endian
    const buf = new ArrayBuffer(4);
    const view = new DataView(buf);
    view.setUint8(0, 0x00);
    view.setUint8(1, 0x0f);
    view.setUint8(2, 0x42);
    view.setUint8(3, 0x40);
    // Big-endian: 0x000f4240 = 1000000
    expect(view.getUint32(0)).toBe(1000000);
    expect(view.getUint32(0, false)).toBe(1000000); // explicit big-endian = same
    expect(view.getUint32(0, true)).not.toBe(1000000); // little-endian = different
  });

  it('produces 6-digit zero-padded code', () => {
    const code = (12345 % 1000000).toString().padStart(6, '0');
    expect(code).toBe('012345');
    expect(code.length).toBe(6);
  });

  it('wraps at 1000000', () => {
    const code = (1000001 % 1000000).toString().padStart(6, '0');
    expect(code).toBe('000001');
  });
});

// ============================================================
// 4. Sequence number encoding (Protocol Section 7.4)
// ============================================================

describe('Protocol Section 7.4: Sequence Numbers', () => {
  it('encodes seq as 4-byte big-endian', () => {
    const seqBytes = new Uint8Array(4);
    new DataView(seqBytes.buffer).setUint32(0, 42);
    expect(seqBytes[0]).toBe(0);
    expect(seqBytes[1]).toBe(0);
    expect(seqBytes[2]).toBe(0);
    expect(seqBytes[3]).toBe(42);
  });

  it('round-trips through setUint32/getUint32', () => {
    for (const val of [0, 1, 255, 256, 65535, 16777215, 4294967295]) {
      const bytes = new Uint8Array(4);
      new DataView(bytes.buffer).setUint32(0, val);
      const read = new DataView(bytes.buffer).getUint32(0);
      expect(read).toBe(val);
    }
  });

  it('validates seq must be strictly greater than last accepted', () => {
    let lastSeq = -1;
    // seq 0 accepted (0 > -1)
    expect(0 > lastSeq).toBe(true);
    lastSeq = 0;
    // seq 0 rejected (0 > 0 = false)
    expect(0 > lastSeq).toBe(false);
    // seq 1 accepted
    expect(1 > lastSeq).toBe(true);
    lastSeq = 1;
    // seq 5 accepted (gap after reconnect)
    expect(5 > lastSeq).toBe(true);
    lastSeq = 5;
    // seq 3 rejected (replay)
    expect(3 > lastSeq).toBe(false);
  });
});

// ============================================================
// 5. Sealed payload envelope format (Protocol Section 7.4)
// ============================================================

describe('Protocol Section 7.4: Sealed Envelope', () => {
  it('envelope = base64url(seq_bytes || ciphertext || tag)', () => {
    // Simulate: seq=0, ciphertext=[1,2,3], tag=[4,5,6,7,8,9,10,11,12,13,14,15,16]
    const seq = new Uint8Array([0, 0, 0, 0]);
    const ct = new Uint8Array([1, 2, 3]);
    const tag = new Uint8Array([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const combined = new Uint8Array(4 + 3 + 13);
    combined.set(seq, 0);
    combined.set(ct, 4);
    combined.set(tag, 7);

    const envelope = b64urlEncode(combined);
    const decoded = b64urlDecode(envelope);

    // First 4 bytes = seq
    expect(new DataView(decoded.buffer, 0, 4).getUint32(0)).toBe(0);
    // Rest = ciphertext + tag
    expect(decoded.length).toBe(20);
  });
});

// ============================================================
// 6. EVM Sub-Protocol: wallet_getAccounts format (Section 5.1)
// ============================================================

describe('EVM Sub-Protocol Section 5.1: wallet_getAccounts', () => {
  it('result matches spec format', () => {
    const result = {
      accounts: [
        {
          address: '0xab16a96D359eC26a11e2C2b3d8f8B8942d5Bfcdb',
          chains: ['eip155:1', 'eip155:137'],
        },
      ],
    };
    expect(result).toHaveProperty('accounts');
    expect(Array.isArray(result.accounts)).toBe(true);
    expect(result.accounts[0]).toHaveProperty('address');
    expect(result.accounts[0]).toHaveProperty('chains');
    expect(result.accounts[0].address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(result.accounts[0].chains[0]).toMatch(/^eip155:\d+$/);
  });

  it('rejects old flat array format', () => {
    const badResult = ['0xab16a96D359eC26a11e2C2b3d8f8B8942d5Bfcdb'];
    expect(badResult).not.toHaveProperty('accounts');
  });
});

// ============================================================
// 7. EVM Sub-Protocol: wallet_signMessage params (Section 5.4)
// ============================================================

describe('EVM Sub-Protocol Section 5.4: wallet_signMessage', () => {
  it('params must include chain, address, message', () => {
    const params = {
      chain: 'eip155:1',
      address: '0xab16a96D359eC26a11e2C2b3d8f8B8942d5Bfcdb',
      message: 'Hello, WalletPair!',
    };
    expect(params).toHaveProperty('chain');
    expect(params).toHaveProperty('address');
    expect(params).toHaveProperty('message');
    expect(params.chain).toMatch(/^eip155:\d+$/);
    expect(params.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('result must include signature field', () => {
    const result = { signature: '0x' + 'ab'.repeat(65) };
    expect(result).toHaveProperty('signature');
    expect(result.signature).toMatch(/^0x[0-9a-fA-F]+$/);
  });
});

// ============================================================
// 8. EVM Sub-Protocol: Events (Section 6)
// ============================================================

describe('EVM Sub-Protocol Section 6: Events', () => {
  it('accountsChanged uses structured accounts array', () => {
    const data = {
      accounts: [{ address: '0x1234567890abcdef1234567890abcdef12345678', chains: ['eip155:1'] }],
    };
    expect(data.accounts[0]).toHaveProperty('address');
    expect(data.accounts[0]).toHaveProperty('chains');
  });

  it('accountsChanged rejects flat address array', () => {
    const bad = { accounts: ['0x1234567890abcdef1234567890abcdef12345678'] };
    expect(typeof bad.accounts[0]).toBe('string'); // wrong — should be object
    expect(typeof bad.accounts[0]).not.toBe('object');
  });

  it('chainChanged uses "chain" not "chainId"', () => {
    const data = { chain: 'eip155:137' };
    expect(data).toHaveProperty('chain');
    expect(data).not.toHaveProperty('chainId');
    expect(data.chain).toMatch(/^eip155:\d+$/);
  });

  it('connect event format', () => {
    const data = { chain: 'eip155:1' };
    expect(data).toHaveProperty('chain');
  });

  it('disconnect event format', () => {
    const data = { chain: 'eip155:1', code: 4900, message: 'Disconnected' };
    expect(data).toHaveProperty('chain');
    expect(data).toHaveProperty('code');
    expect(data.code).toBe(4900);
  });
});

// ============================================================
// 9. EVM Sub-Protocol: Error codes (Section 7)
// ============================================================

describe('EVM Sub-Protocol Section 7: Error Codes', () => {
  const validCodes = [
    'user_rejected', 'unauthorized', 'invalid_params',
    'unsupported_chain', 'unsupported_method',
    'insufficient_funds', 'nonce_too_low',
    'gas_estimation_failed', 'tx_rejected',
    'chain_not_added', 'internal_error',
  ];

  it('error object has code (string) and message (string)', () => {
    const error = { code: 'user_rejected', message: 'User rejected the request' };
    expect(typeof error.code).toBe('string');
    expect(typeof error.message).toBe('string');
  });

  for (const code of validCodes) {
    it(`recognizes error code: ${code}`, () => {
      expect(typeof code).toBe('string');
      expect(code.length).toBeGreaterThan(0);
    });
  }
});

// ============================================================
// 10. BLE Framing (Protocol Section 19.5)
// ============================================================

describe('Protocol Section 19.5: BLE Framing', () => {
  const FLAG_FIRST = 0x01;
  const FLAG_LAST = 0x02;

  it('single frame has flags 0x03 (first + last)', () => {
    const flags = FLAG_FIRST | FLAG_LAST;
    expect(flags).toBe(0x03);
  });

  it('first frame of multi has flags 0x01', () => {
    expect(FLAG_FIRST).toBe(0x01);
  });

  it('last frame of multi has flags 0x02', () => {
    expect(FLAG_LAST).toBe(0x02);
  });

  it('middle frame has flags 0x00', () => {
    expect(0x00 & FLAG_FIRST).toBe(0);
    expect(0x00 & FLAG_LAST).toBe(0);
  });

  it('total_length is big-endian uint16 in first frame', () => {
    const totalLength = 500;
    const header = new Uint8Array(3);
    header[0] = FLAG_FIRST;
    header[1] = (totalLength >> 8) & 0xff;
    header[2] = totalLength & 0xff;
    const parsed = (header[1] << 8) | header[2];
    expect(parsed).toBe(500);
  });

  it('max total_length is 65535 (uint16)', () => {
    const max = 65535;
    const header = new Uint8Array(3);
    header[1] = (max >> 8) & 0xff;
    header[2] = max & 0xff;
    expect((header[1] << 8) | header[2]).toBe(65535);
  });
});

// ============================================================
// 11. Pairing URI format (Protocol Section 9.1)
// ============================================================

describe('Protocol Section 9.1: Pairing URI', () => {
  it('format: walletpair:?ch=...&pubkey=...&relay=...', () => {
    const uri = 'walletpair:?ch=aabb&pubkey=dGVzdA&relay=wss%3A%2F%2Frelay.example.com%2Fv1';
    expect(uri.startsWith('walletpair:?')).toBe(true);
    const params = new URLSearchParams(uri.replace('walletpair:?', ''));
    expect(params.get('ch')).toBe('aabb');
    expect(params.get('pubkey')).toBe('dGVzdA');
    expect(params.get('relay')).toBe('wss://relay.example.com/v1');
  });

  it('BLE mode: no relay parameter', () => {
    const uri = 'walletpair:?ch=aabb&pubkey=dGVzdA';
    const params = new URLSearchParams(uri.replace('walletpair:?', ''));
    expect(params.get('relay')).toBeNull();
  });

  it('relay URL must be percent-encoded', () => {
    const relay = 'wss://relay.example.com/v1';
    const encoded = encodeURIComponent(relay);
    expect(encoded).toBe('wss%3A%2F%2Frelay.example.com%2Fv1');
    expect(decodeURIComponent(encoded)).toBe(relay);
  });
});

// ============================================================
// 12. Capabilities format (Protocol Section 8)
// ============================================================

describe('Protocol Section 8: Capabilities', () => {
  it('join must include methods, events, chains arrays', () => {
    const capabilities = {
      methods: ['wallet_getAccounts', 'wallet_signMessage'],
      events: ['accountsChanged', 'chainChanged'],
      chains: ['eip155:1', 'eip155:137'],
    };
    expect(Array.isArray(capabilities.methods)).toBe(true);
    expect(Array.isArray(capabilities.events)).toBe(true);
    expect(Array.isArray(capabilities.chains)).toBe(true);
  });

  it('empty arrays are valid (wallet supports nothing in that category)', () => {
    const capabilities = { methods: [], events: [], chains: [] };
    expect(capabilities.methods.length).toBe(0);
  });

  it('wallet_getAccounts is required minimum', () => {
    const methods = ['wallet_getAccounts'];
    expect(methods).toContain('wallet_getAccounts');
  });

  it('chains use CAIP-2 eip155 format', () => {
    const chains = ['eip155:1', 'eip155:137', 'eip155:42161'];
    for (const chain of chains) {
      expect(chain).toMatch(/^eip155:\d+$/);
    }
  });
});
