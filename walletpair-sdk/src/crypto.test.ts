import { describe, it, expect } from 'vitest';
import {
  b64urlEncode,
  b64urlDecode,
  generateX25519KeyPair,
  getPublicKey,
  computeSharedSecret,
  deriveSessionKey,
  deriveJoinEncryptionKey,
  computeSessionFingerprint,
  sealPayload,
  unsealPayload,
  sealJoin,
  unsealJoin,
  generateChannelId,
  buildPairingUri,
  parsePairingUri,
  bytesToHex,
  hexToBytes,
} from './crypto.js';

// ---------------------------------------------------------------------------
// Base64url
// ---------------------------------------------------------------------------

describe('b64url', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 128, 64, 32, 16]);
    expect(b64urlDecode(b64urlEncode(bytes))).toEqual(bytes);
  });

  it('produces no padding characters', () => {
    const encoded = b64urlEncode(new Uint8Array([1, 2, 3]));
    expect(encoded).not.toContain('=');
  });

  it('uses URL-safe alphabet (no + or /)', () => {
    // Encode bytes that would produce + and / in standard base64
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const encoded = b64urlEncode(bytes);
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
  });

  it('handles empty input', () => {
    expect(b64urlEncode(new Uint8Array(0))).toBe('');
    expect(b64urlDecode('')).toEqual(new Uint8Array(0));
  });

  it('decodes known value', () => {
    // "Hello" in base64url = "SGVsbG8"
    const decoded = b64urlDecode('SGVsbG8');
    expect(new TextDecoder().decode(decoded)).toBe('Hello');
  });
});

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

describe('generateX25519KeyPair', () => {
  it('returns 32-byte private and public keys', () => {
    const kp = generateX25519KeyPair();
    expect(kp.privateKey).toHaveLength(32);
    expect(kp.publicKey).toHaveLength(32);
    expect(typeof kp.publicKeyB64).toBe('string');
    expect(kp.publicKeyB64.length).toBeGreaterThan(0);
  });

  it('generates unique key pairs', () => {
    const a = generateX25519KeyPair();
    const b = generateX25519KeyPair();
    expect(bytesToHex(a.privateKey)).not.toBe(bytesToHex(b.privateKey));
  });

  it('publicKeyB64 decodes back to publicKey', () => {
    const kp = generateX25519KeyPair();
    expect(b64urlDecode(kp.publicKeyB64)).toEqual(kp.publicKey);
  });
});

describe('getPublicKey', () => {
  it('derives the same public key as generateX25519KeyPair', () => {
    const kp = generateX25519KeyPair();
    const derived = getPublicKey(kp.privateKey);
    expect(derived).toEqual(kp.publicKey);
  });
});

// ---------------------------------------------------------------------------
// Shared secret & session key derivation
// ---------------------------------------------------------------------------

describe('key exchange', () => {
  it('both peers derive the same shared secret (X25519 DH)', () => {
    const alice = generateX25519KeyPair();
    const bob = generateX25519KeyPair();

    const secretA = computeSharedSecret(alice.privateKey, bob.publicKey);
    const secretB = computeSharedSecret(bob.privateKey, alice.publicKey);

    expect(secretA).toEqual(secretB);
    expect(secretA).toHaveLength(32);
  });

  it('both peers derive the same session key', () => {
    const alice = generateX25519KeyPair();
    const bob = generateX25519KeyPair();
    const channelId = generateChannelId();

    const shared = computeSharedSecret(alice.privateKey, bob.publicKey);
    const skA = deriveSessionKey(shared, channelId);
    const skB = deriveSessionKey(computeSharedSecret(bob.privateKey, alice.publicKey), channelId);

    expect(skA).toEqual(skB);
    expect(skA).toHaveLength(32);
  });

  it('different channel IDs produce different session keys', () => {
    const alice = generateX25519KeyPair();
    const bob = generateX25519KeyPair();
    const shared = computeSharedSecret(alice.privateKey, bob.publicKey);

    const sk1 = deriveSessionKey(shared, generateChannelId());
    const sk2 = deriveSessionKey(shared, generateChannelId());

    expect(bytesToHex(sk1)).not.toBe(bytesToHex(sk2));
  });
});

// ---------------------------------------------------------------------------
// Session fingerprint
// ---------------------------------------------------------------------------

describe('computeSessionFingerprint', () => {
  it('returns a 4-digit string', () => {
    const channelId = generateChannelId();
    const kp = generateX25519KeyPair();

    const code = computeSessionFingerprint(channelId, kp.publicKeyB64);
    expect(code).toMatch(/^\d{4}$/);
  });

  it('is deterministic for same inputs', () => {
    const ch = '00'.repeat(32);
    const pubB64 = b64urlEncode(new Uint8Array(32).fill(42));
    expect(computeSessionFingerprint(ch, pubB64)).toBe(computeSessionFingerprint(ch, pubB64));
  });

  it('different channel IDs produce different fingerprints', () => {
    const kp = generateX25519KeyPair();
    const ch1 = generateChannelId();
    const ch2 = generateChannelId();
    expect(computeSessionFingerprint(ch1, kp.publicKeyB64)).not.toBe(
      computeSessionFingerprint(ch2, kp.publicKeyB64),
    );
  });

  it('different dApp pubkeys produce different fingerprints', () => {
    const ch = generateChannelId();
    const kp1 = generateX25519KeyPair();
    const kp2 = generateX25519KeyPair();
    expect(computeSessionFingerprint(ch, kp1.publicKeyB64)).not.toBe(
      computeSessionFingerprint(ch, kp2.publicKeyB64),
    );
  });

  it('pads with leading zeros when necessary', () => {
    // We can't force a specific output, but verify format consistency
    const results = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const ch = generateChannelId();
      const kp = generateX25519KeyPair();
      const code = computeSessionFingerprint(ch, kp.publicKeyB64);
      expect(code).toHaveLength(4);
      results.add(code);
    }
    // Very unlikely all 20 are the same
    expect(results.size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Seal / Unseal (encryption round-trip)
// ---------------------------------------------------------------------------

describe('seal/unseal', () => {
  const sessionKey = new Uint8Array(32);
  crypto.getRandomValues(sessionKey);
  const channelId = generateChannelId();

  it('round-trips a simple object', () => {
    const data = { hello: 'world', num: 42 };
    const sealed = sealPayload(sessionKey, channelId, 0, data);
    const { seq, data: decrypted } = unsealPayload(sessionKey, channelId, sealed);

    expect(seq).toBe(0);
    expect(decrypted).toEqual(data);
  });

  it('round-trips with different sequence numbers', () => {
    for (const seqNum of [0, 1, 100, 65535, 2 ** 31 - 1]) {
      const data = { seq: seqNum };
      const sealed = sealPayload(sessionKey, channelId, seqNum, data);
      const { seq, data: decrypted } = unsealPayload(sessionKey, channelId, sealed);
      expect(seq).toBe(seqNum);
      expect(decrypted).toEqual(data);
    }
  });

  it('round-trips arrays, strings, numbers, null', () => {
    for (const data of [[1, 2, 3], 'hello', 42, null, { nested: { deep: true } }]) {
      const sealed = sealPayload(sessionKey, channelId, 0, data);
      const { data: decrypted } = unsealPayload(sessionKey, channelId, sealed);
      expect(decrypted).toEqual(data);
    }
  });

  it('round-trips empty object', () => {
    const sealed = sealPayload(sessionKey, channelId, 0, {});
    const { data } = unsealPayload(sessionKey, channelId, sealed);
    expect(data).toEqual({});
  });

  it('round-trips unicode text', () => {
    const data = { text: '你好世界 🌍 émojis' };
    const sealed = sealPayload(sessionKey, channelId, 0, data);
    const { data: decrypted } = unsealPayload(sessionKey, channelId, sealed);
    expect(decrypted).toEqual(data);
  });

  it('fails to decrypt with wrong session key', () => {
    const sealed = sealPayload(sessionKey, channelId, 0, { secret: true });
    const wrongKey = new Uint8Array(32);
    crypto.getRandomValues(wrongKey);
    expect(() => unsealPayload(wrongKey, channelId, sealed)).toThrow();
  });

  it('fails to decrypt with wrong channel ID', () => {
    const sealed = sealPayload(sessionKey, channelId, 0, { secret: true });
    const wrongCh = generateChannelId();
    expect(() => unsealPayload(sessionKey, wrongCh, sealed)).toThrow();
  });

  it('fails to decrypt tampered ciphertext', () => {
    const sealed = sealPayload(sessionKey, channelId, 0, { secret: true });
    const bytes = b64urlDecode(sealed);
    // Flip a byte in the ciphertext portion
    bytes[10]! ^= 0xff;
    const tampered = b64urlEncode(bytes);
    expect(() => unsealPayload(sessionKey, channelId, tampered)).toThrow();
  });

  it('different sequence numbers produce different ciphertexts', () => {
    const data = { same: 'data' };
    const s0 = sealPayload(sessionKey, channelId, 0, data);
    const s1 = sealPayload(sessionKey, channelId, 1, data);
    expect(s0).not.toBe(s1);
  });
});

describe('sealJoin/unsealJoin', () => {
  it('round-trips capabilities and metadata with a nonce-prefixed envelope', () => {
    const joinKey = deriveJoinEncryptionKey(new Uint8Array(32).fill(7), '11'.repeat(32));
    const capabilities = { methods: ['wallet_getAccounts'], events: ['accountsChanged'], chains: ['eip155:1'] };
    const meta = { name: 'Test Wallet' };

    const sealed = sealJoin(joinKey, '11'.repeat(32), capabilities, meta);
    const envelope = b64urlDecode(sealed);
    expect(envelope.length).toBeGreaterThan(12 + 16);

    expect(unsealJoin(joinKey, '11'.repeat(32), sealed)).toEqual({ capabilities, meta });
  });

  it('uses a fresh nonce for each sealed_join encryption', () => {
    const joinKey = deriveJoinEncryptionKey(new Uint8Array(32).fill(9), '22'.repeat(32));
    const capabilities = { methods: ['wallet_getAccounts'], events: [], chains: ['eip155:1'] };

    const a = sealJoin(joinKey, '22'.repeat(32), capabilities, {});
    const b = sealJoin(joinKey, '22'.repeat(32), capabilities, {});

    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Channel ID generation
// ---------------------------------------------------------------------------

describe('generateChannelId', () => {
  it('returns 64 hex characters (32 bytes)', () => {
    const id = generateChannelId();
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 10 }, () => generateChannelId()));
    expect(ids.size).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Pairing URI
// ---------------------------------------------------------------------------

describe('buildPairingUri', () => {
  it('builds URI with all parameters', () => {
    const uri = buildPairingUri({
      channelId: 'abcd1234',
      pubkeyB64: 'AQID',
      relayUrl: 'wss://relay.example.com/v1',
      name: 'My dApp',
    });
    expect(uri).toContain('walletpair:?ch=abcd1234');
    expect(uri).toContain('&pubkey=AQID');
    expect(uri).toContain('&relay=');
    expect(uri).toContain('&name=My%20dApp');
  });

  it('omits relay when not provided', () => {
    const uri = buildPairingUri({ channelId: 'abcd', pubkeyB64: 'XY', name: 'Test', url: 'https://test.com', icon: 'https://test.com/icon.png' });
    expect(uri).not.toContain('relay');
  });
});

describe('parsePairingUri', () => {
  it('parses a full URI', () => {
    const uri = 'walletpair:?ch=abc123&pubkey=AQID&relay=wss%3A%2F%2Frelay.example.com%2Fv1&name=Test';
    const params = parsePairingUri(uri);
    expect(params.ch).toBe('abc123');
    expect(params.pubkey).toBe('AQID');
    expect(params.relay).toBe('wss://relay.example.com/v1');
    expect(params.name).toBe('Test');
  });

  it('parses BLE URI (no relay)', () => {
    const uri = 'walletpair:?ch=abc123&pubkey=AQID';
    const params = parsePairingUri(uri);
    expect(params.ch).toBe('abc123');
    expect(params.pubkey).toBe('AQID');
    expect(params.relay).toBe('');
    expect(params.name).toBeUndefined();
  });

  it('throws on missing ch', () => {
    expect(() => parsePairingUri('walletpair:?pubkey=AQID')).toThrow('missing ch or pubkey');
  });

  it('throws on missing pubkey', () => {
    expect(() => parsePairingUri('walletpair:?ch=abc')).toThrow('missing ch or pubkey');
  });

  it('round-trips with buildPairingUri', () => {
    const original = {
      channelId: generateChannelId(),
      pubkeyB64: b64urlEncode(generateX25519KeyPair().publicKey),
      relayUrl: 'wss://relay.walletpair.org/v1',
      name: 'Test dApp',
    };
    const uri = buildPairingUri(original);
    const parsed = parsePairingUri(uri);
    expect(parsed.ch).toBe(original.channelId);
    expect(parsed.pubkey).toBe(original.pubkeyB64);
    expect(parsed.relay).toBe(original.relayUrl);
    expect(parsed.name).toBe(original.name);
  });
});

// ---------------------------------------------------------------------------
// hex helpers
// ---------------------------------------------------------------------------

describe('hex helpers', () => {
  it('bytesToHex / hexToBytes round-trip', () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 255]);
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
  });

  it('bytesToHex produces lowercase', () => {
    expect(bytesToHex(new Uint8Array([0xff, 0x0a]))).toBe('ff0a');
  });
});
