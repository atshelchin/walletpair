/**
 * Hardening tests for crypto primitives.
 *
 * Covers edge cases and boundary conditions for:
 * - canonicalJson (RFC 8785 / I-JSON compliance)
 * - seal/unseal with AAD headers (type byte differentiation)
 * - Nonce determinism and uniqueness
 * - sealJoin/unsealJoin error paths
 * - Key separation guarantees
 * - Protocol spec test vector SHA-256 verification
 */

import { describe, expect, it } from 'vitest'
import type { AadHeader, SessionCryptoContext } from './crypto.js'
import {
  b64urlDecode,
  b64urlEncode,
  bytesToHex,
  canonicalJson,
  computeHandshakeTranscriptHash,
  computeSharedSecret,
  deriveDirectionalSessionKeys,
  deriveJoinEncryptionKey,
  deriveSessionKey,
  generateChannelId,
  generateX25519KeyPair,
  sealJoin,
  sealPayload,
  sha256Hex,
  unsealJoin,
  unsealPayload,
} from './crypto.js'

// ═══════════════════════════════════════════════════════════════════════
// canonicalJson — comprehensive edge cases
// ═══════════════════════════════════════════════════════════════════════

describe('canonicalJson — edge cases', () => {
  // --- Object key sorting ---
  it('sorts object keys lexicographically', () => {
    expect(canonicalJson({ z: 1, a: 2, m: 3 })).toBe('{"a":2,"m":3,"z":1}')
  })

  it('sorts nested object keys recursively', () => {
    expect(canonicalJson({ b: { z: 1, a: 2 }, a: 1 })).toBe('{"a":1,"b":{"a":2,"z":1}}')
  })

  it('sorts deeply nested objects (3+ levels)', () => {
    const input = { c: { b: { z: 1, a: 2 }, a: 3 }, a: 0 }
    expect(canonicalJson(input)).toBe('{"a":0,"c":{"a":3,"b":{"a":2,"z":1}}}')
  })

  it('does not sort array elements (preserves order)', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]')
    expect(canonicalJson(['z', 'a', 'm'])).toBe('["z","a","m"]')
  })

  it('sorts keys in objects inside arrays', () => {
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]')
  })

  // --- Primitives ---
  it('handles null', () => {
    expect(canonicalJson(null)).toBe('null')
  })

  it('handles undefined as null', () => {
    expect(canonicalJson(undefined)).toBe('null')
  })

  it('handles booleans', () => {
    expect(canonicalJson(true)).toBe('true')
    expect(canonicalJson(false)).toBe('false')
  })

  it('handles integers', () => {
    expect(canonicalJson(0)).toBe('0')
    expect(canonicalJson(1)).toBe('1')
    expect(canonicalJson(-1)).toBe('-1')
    expect(canonicalJson(42)).toBe('42')
  })

  it('handles floating point numbers', () => {
    expect(canonicalJson(1.5)).toBe('1.5')
    expect(canonicalJson(0.1)).toBe('0.1')
  })

  it('handles negative zero as 0', () => {
    // JSON.stringify(-0) produces "0" in JS
    expect(canonicalJson(-0)).toBe('0')
  })

  // --- Strings ---
  it('handles empty string', () => {
    expect(canonicalJson('')).toBe('""')
  })

  it('handles unicode strings', () => {
    expect(canonicalJson('你好')).toBe('"你好"')
    expect(canonicalJson('🌍')).toBe('"🌍"')
  })

  it('escapes control characters', () => {
    expect(canonicalJson('\n')).toBe('"\\n"')
    expect(canonicalJson('\t')).toBe('"\\t"')
    expect(canonicalJson('\r')).toBe('"\\r"')
  })

  it('escapes backslash and double quote', () => {
    expect(canonicalJson('\\')).toBe('"\\\\"')
    expect(canonicalJson('"')).toBe('"\\""')
  })

  it('does not escape forward slash', () => {
    expect(canonicalJson('a/b')).toBe('"a/b"')
  })

  // --- Empty containers ---
  it('handles empty object', () => {
    expect(canonicalJson({})).toBe('{}')
  })

  it('handles empty array', () => {
    expect(canonicalJson([])).toBe('[]')
  })

  // --- No whitespace ---
  it('produces no whitespace', () => {
    const result = canonicalJson({ a: [1, 2], b: { c: 3 } })
    expect(result).not.toMatch(/\s/)
    expect(result).toBe('{"a":[1,2],"b":{"c":3}}')
  })

  // --- Omits undefined values in objects ---
  it('omits keys with undefined values (matches JSON.stringify)', () => {
    const input = { a: 1, b: undefined, c: 3 }
    const result = canonicalJson(input)
    expect(result).toBe('{"a":1,"c":3}')
  })

  // --- Spec test vector with SHA-256 ---
  it('matches protocol spec test vector byte-for-byte with correct SHA-256', () => {
    const input = {
      methods: ['wallet_signTransaction', 'wallet_signMessage'],
      events: ['accountsChanged', 'chainChanged'],
      chains: ['eip155:1', 'eip155:137'],
    }
    const output = canonicalJson(input)
    const expected =
      '{"chains":["eip155:1","eip155:137"],"events":["accountsChanged","chainChanged"],"methods":["wallet_signTransaction","wallet_signMessage"]}'
    expect(output).toBe(expected)

    // Verify SHA-256 from protocol spec
    const hash = sha256Hex(new TextEncoder().encode(output))
    expect(hash).toBe('4da366e2aae26b47b3d90fff52410752348733350ce2525dce7d64510f571333')
  })

  // --- Determinism ---
  it('is deterministic across multiple calls', () => {
    const obj = { z: [3, 1], a: { y: 'hello', x: true } }
    const r1 = canonicalJson(obj)
    const r2 = canonicalJson(obj)
    const r3 = canonicalJson(JSON.parse(JSON.stringify(obj)))
    expect(r1).toBe(r2)
    expect(r1).toBe(r3)
  })

  // --- Complex mixed structures ---
  it('handles mixed nested structures', () => {
    const input = {
      capabilities: {
        methods: ['wallet_signTransaction'],
        events: ['accountsChanged'],
        chains: ['eip155:1'],
      },
      meta: { name: 'MyWallet' },
    }
    const result = canonicalJson(input)
    // Keys sorted: capabilities < meta; inner keys sorted too
    expect(result).toBe(
      '{"capabilities":{"chains":["eip155:1"],"events":["accountsChanged"],"methods":["wallet_signTransaction"]},"meta":{"name":"MyWallet"}}',
    )
  })

  // --- Matches test vector for join plaintext ---
  it('matches join plaintext test vector from protocol appendix', () => {
    const input = {
      capabilities: {
        methods: ['wallet_signTransaction', 'wallet_signMessage'],
        events: ['accountsChanged', 'chainChanged'],
        chains: ['eip155:1', 'eip155:137'],
      },
      meta: { name: 'MyWallet' },
    }
    const result = canonicalJson(input)
    expect(result).toBe(
      '{"capabilities":{"chains":["eip155:1","eip155:137"],"events":["accountsChanged","chainChanged"],"methods":["wallet_signTransaction","wallet_signMessage"]},"meta":{"name":"MyWallet"}}',
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Nonce determinism and uniqueness
// ═══════════════════════════════════════════════════════════════════════

describe('sealPayload nonce determinism', () => {
  const key = new Uint8Array(32).fill(0xaa)
  const ch = 'bb'.repeat(32)

  it('same key + same seq + same data = same ciphertext (deterministic nonce)', () => {
    const data = { test: true }
    const s1 = sealPayload(key, ch, 0, data)
    const s2 = sealPayload(key, ch, 0, data)
    expect(s1).toBe(s2)
  })

  it('same key + different seq = different ciphertext (different nonce)', () => {
    const data = { test: true }
    const s0 = sealPayload(key, ch, 0, data)
    const s1 = sealPayload(key, ch, 1, data)
    expect(s0).not.toBe(s1)
  })

  it('different key + same seq = different ciphertext (different nonce derivation)', () => {
    const key2 = new Uint8Array(32).fill(0xcc)
    const data = { test: true }
    const s1 = sealPayload(key, ch, 0, data)
    const s2 = sealPayload(key2, ch, 0, data)
    expect(s1).not.toBe(s2)
  })

  it('seq=0 and seq=2^31-1 both work', () => {
    const data = { x: 1 }
    const s0 = sealPayload(key, ch, 0, data)
    const sMax = sealPayload(key, ch, 2 ** 31 - 1, data)
    expect(unsealPayload(key, ch, s0).seq).toBe(0)
    expect(unsealPayload(key, ch, sMax).seq).toBe(2 ** 31 - 1)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// AAD header type differentiation
// ═══════════════════════════════════════════════════════════════════════

describe('seal/unseal with AAD headers', () => {
  const key = new Uint8Array(32).fill(0x55)
  const ch = 'cc'.repeat(32)
  const data = { method: 'eth_sign', params: [] }

  it('req type AAD produces different ciphertext than res type', () => {
    const reqHdr: AadHeader = { type: 'req', from: 'peer1', id: 'r1' }
    const resHdr: AadHeader = { type: 'res', from: 'peer1', id: 'r1' }
    const sealed1 = sealPayload(key, ch, 0, data, reqHdr)
    const sealed2 = sealPayload(key, ch, 0, data, resHdr)
    expect(sealed1).not.toBe(sealed2)
  })

  it('different from in AAD produces different ciphertext', () => {
    const hdr1: AadHeader = { type: 'req', from: 'peerA', id: 'r1' }
    const hdr2: AadHeader = { type: 'req', from: 'peerB', id: 'r1' }
    const sealed1 = sealPayload(key, ch, 0, data, hdr1)
    const sealed2 = sealPayload(key, ch, 0, data, hdr2)
    expect(sealed1).not.toBe(sealed2)
  })

  it('different id in AAD produces different ciphertext', () => {
    const hdr1: AadHeader = { type: 'req', from: 'peer1', id: 'id-1' }
    const hdr2: AadHeader = { type: 'req', from: 'peer1', id: 'id-2' }
    const sealed1 = sealPayload(key, ch, 0, data, hdr1)
    const sealed2 = sealPayload(key, ch, 0, data, hdr2)
    expect(sealed1).not.toBe(sealed2)
  })

  it('decrypt fails if AAD header type mismatches', () => {
    const hdr: AadHeader = { type: 'req', from: 'peer1', id: 'r1' }
    const sealed = sealPayload(key, ch, 0, data, hdr)
    const wrongHdr: AadHeader = { type: 'res', from: 'peer1', id: 'r1' }
    expect(() => unsealPayload(key, ch, sealed, wrongHdr)).toThrow()
  })

  it('decrypt fails if AAD from field mismatches', () => {
    const hdr: AadHeader = { type: 'req', from: 'peerA', id: 'r1' }
    const sealed = sealPayload(key, ch, 0, data, hdr)
    const wrongHdr: AadHeader = { type: 'req', from: 'peerB', id: 'r1' }
    expect(() => unsealPayload(key, ch, sealed, wrongHdr)).toThrow()
  })

  it('decrypt fails if AAD id field mismatches', () => {
    const hdr: AadHeader = { type: 'req', from: 'peer1', id: 'r1' }
    const sealed = sealPayload(key, ch, 0, data, hdr)
    const wrongHdr: AadHeader = { type: 'req', from: 'peer1', id: 'r2' }
    expect(() => unsealPayload(key, ch, sealed, wrongHdr)).toThrow()
  })

  it('decrypt succeeds with matching AAD header', () => {
    const hdr: AadHeader = { type: 'evt', from: 'wallet', id: 'e1' }
    const sealed = sealPayload(key, ch, 5, data, hdr)
    const { seq, data: d } = unsealPayload(key, ch, sealed, hdr)
    expect(seq).toBe(5)
    expect(d).toEqual(data)
  })

  it('sealed with AAD cannot be decrypted without AAD', () => {
    const hdr: AadHeader = { type: 'req', from: 'peer1', id: 'r1' }
    const sealed = sealPayload(key, ch, 0, data, hdr)
    // Decrypt without AAD — should fail because AAD mismatch
    expect(() => unsealPayload(key, ch, sealed)).toThrow()
  })

  it('sealed without AAD cannot be decrypted with AAD', () => {
    const sealed = sealPayload(key, ch, 0, data)
    const hdr: AadHeader = { type: 'req', from: 'peer1', id: 'r1' }
    expect(() => unsealPayload(key, ch, sealed, hdr)).toThrow()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// unsealPayload error paths
// ═══════════════════════════════════════════════════════════════════════

describe('unsealPayload error paths', () => {
  const key = new Uint8Array(32).fill(0x77)
  const ch = 'dd'.repeat(32)

  it('throws on empty sealed string', () => {
    expect(() => unsealPayload(key, ch, '')).toThrow()
  })

  it('throws on truncated sealed (too short for seq + tag)', () => {
    const truncated = b64urlEncode(new Uint8Array(4)) // only seq, no ciphertext
    expect(() => unsealPayload(key, ch, truncated)).toThrow()
  })

  it('throws on tampered seq bytes', () => {
    const sealed = sealPayload(key, ch, 5, { test: true })
    const bytes = b64urlDecode(sealed)
    bytes[0] = (bytes[0] ?? 0) ^ 0xff // tamper seq byte
    const tampered = b64urlEncode(bytes)
    // Changing seq changes nonce → decryption fails
    expect(() => unsealPayload(key, ch, tampered)).toThrow()
  })

  it('throws on single-bit flip in ciphertext', () => {
    const sealed = sealPayload(key, ch, 0, { x: 1 })
    const bytes = b64urlDecode(sealed)
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0x01 // flip 1 bit in tag
    expect(() => unsealPayload(key, ch, b64urlEncode(bytes))).toThrow()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// sealJoin / unsealJoin error paths
// ═══════════════════════════════════════════════════════════════════════

describe('sealJoin / unsealJoin error paths', () => {
  const rootKey = new Uint8Array(32).fill(0x33)
  const ch = 'ee'.repeat(32)
  const joinKey = deriveJoinEncryptionKey(rootKey, ch)

  it('decrypt fails with wrong key', () => {
    const caps = { methods: ['wallet_getAccounts'], events: [], chains: ['eip155:1'] }
    const sealed = sealJoin(joinKey, ch, caps, { name: 'W' })
    const wrongKey = new Uint8Array(32).fill(0x99)
    expect(() => unsealJoin(wrongKey, ch, sealed)).toThrow()
  })

  it('decrypt fails with wrong channel ID', () => {
    const caps = { methods: ['wallet_getAccounts'], events: [], chains: ['eip155:1'] }
    const sealed = sealJoin(joinKey, ch, caps, { name: 'W' })
    const wrongCh = 'ff'.repeat(32)
    expect(() => unsealJoin(joinKey, wrongCh, sealed)).toThrow()
  })

  it('decrypt fails with tampered ciphertext', () => {
    const caps = { methods: ['wallet_getAccounts'], events: [], chains: ['eip155:1'] }
    const sealed = sealJoin(joinKey, ch, caps, { name: 'W' })
    const bytes = b64urlDecode(sealed)
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff
    expect(() => unsealJoin(joinKey, ch, b64urlEncode(bytes))).toThrow()
  })

  it('throws on envelope smaller than nonce + tag', () => {
    const tiny = b64urlEncode(new Uint8Array(10))
    expect(() => unsealJoin(joinKey, ch, tiny)).toThrow('Invalid sealed_join')
  })

  it('round-trips with null meta', () => {
    const caps = { methods: ['test'], events: [], chains: [] }
    const sealed = sealJoin(joinKey, ch, caps)
    const { capabilities, meta } = unsealJoin(joinKey, ch, sealed)
    expect(capabilities).toEqual(caps)
    expect(meta).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Key separation guarantees
// ═══════════════════════════════════════════════════════════════════════

describe('Key separation', () => {
  const alice = generateX25519KeyPair()
  const bob = generateX25519KeyPair()
  const ch = generateChannelId()
  const shared = computeSharedSecret(alice.privateKey, bob.publicKey)
  const rootKey = deriveSessionKey(shared, ch)

  it('joinEncryptionKey differs from rootKey', () => {
    const joinKey = deriveJoinEncryptionKey(rootKey, ch)
    expect(bytesToHex(joinKey)).not.toBe(bytesToHex(rootKey))
  })

  it('dappToWalletKey differs from walletToDappKey', () => {
    const ctx: SessionCryptoContext = {
      dappPubKeyB64: alice.publicKeyB64,
      walletPubKeyB64: bob.publicKeyB64,
      capabilities: { methods: ['test'], events: [], chains: [] },
      dappName: 'Test',
    }
    const keys = deriveDirectionalSessionKeys(rootKey, ch, ctx)
    expect(bytesToHex(keys.dappToWalletKey)).not.toBe(bytesToHex(keys.walletToDappKey))
  })

  it('joinEncryptionKey differs from both directional keys', () => {
    const joinKey = deriveJoinEncryptionKey(rootKey, ch)
    const ctx: SessionCryptoContext = {
      dappPubKeyB64: alice.publicKeyB64,
      walletPubKeyB64: bob.publicKeyB64,
      capabilities: { methods: ['test'], events: [], chains: [] },
      dappName: 'Test',
    }
    const keys = deriveDirectionalSessionKeys(rootKey, ch, ctx)
    expect(bytesToHex(joinKey)).not.toBe(bytesToHex(keys.dappToWalletKey))
    expect(bytesToHex(joinKey)).not.toBe(bytesToHex(keys.walletToDappKey))
  })

  it('different capabilities produce different directional keys', () => {
    const ctx1: SessionCryptoContext = {
      dappPubKeyB64: alice.publicKeyB64,
      walletPubKeyB64: bob.publicKeyB64,
      capabilities: { methods: ['wallet_signMessage'], events: [], chains: [] },
      dappName: 'Test',
    }
    const ctx2: SessionCryptoContext = {
      dappPubKeyB64: alice.publicKeyB64,
      walletPubKeyB64: bob.publicKeyB64,
      capabilities: { methods: ['wallet_sendTransaction'], events: [], chains: [] },
      dappName: 'Test',
    }
    const k1 = deriveDirectionalSessionKeys(rootKey, ch, ctx1)
    const k2 = deriveDirectionalSessionKeys(rootKey, ch, ctx2)
    expect(bytesToHex(k1.dappToWalletKey)).not.toBe(bytesToHex(k2.dappToWalletKey))
  })

  it('different dappName produces different transcript hash', () => {
    const ctx1: SessionCryptoContext = {
      dappPubKeyB64: 'pub1',
      walletPubKeyB64: 'pub2',
      capabilities: null,
      dappName: 'AppA',
    }
    const ctx2: SessionCryptoContext = {
      dappPubKeyB64: 'pub1',
      walletPubKeyB64: 'pub2',
      capabilities: null,
      dappName: 'AppB',
    }
    const h1 = computeHandshakeTranscriptHash(ch, ctx1)
    const h2 = computeHandshakeTranscriptHash(ch, ctx2)
    expect(bytesToHex(h1)).not.toBe(bytesToHex(h2))
  })

  it('cross-direction decryption fails', () => {
    const ctx: SessionCryptoContext = {
      dappPubKeyB64: alice.publicKeyB64,
      walletPubKeyB64: bob.publicKeyB64,
      capabilities: null,
      dappName: 'Test',
    }
    const keys = deriveDirectionalSessionKeys(rootKey, ch, ctx)
    // Encrypt with dapp→wallet key
    const sealed = sealPayload(keys.dappToWalletKey, ch, 0, { msg: 'hello' })
    // Decrypt with wallet→dapp key should fail
    expect(() => unsealPayload(keys.walletToDappKey, ch, sealed)).toThrow()
    // Decrypt with correct key should succeed
    expect(unsealPayload(keys.dappToWalletKey, ch, sealed).data).toEqual({ msg: 'hello' })
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Transcript hash determinism
// ═══════════════════════════════════════════════════════════════════════

describe('transcriptHash determinism', () => {
  it('same inputs always produce same transcript hash', () => {
    const ch = 'aa'.repeat(32)
    const ctx: SessionCryptoContext = {
      dappPubKeyB64: 'dappPub',
      walletPubKeyB64: 'walletPub',
      capabilities: { methods: ['test'], events: [], chains: ['eip155:1'] },
      walletMeta: { name: 'W' },
      dappName: 'D',
    }
    const h1 = bytesToHex(computeHandshakeTranscriptHash(ch, ctx))
    const h2 = bytesToHex(computeHandshakeTranscriptHash(ch, ctx))
    expect(h1).toBe(h2)
  })

  it('different channel ID produces different hash', () => {
    const ctx: SessionCryptoContext = {
      dappPubKeyB64: 'pub1',
      walletPubKeyB64: 'pub2',
      capabilities: null,
      dappName: 'X',
    }
    const h1 = bytesToHex(computeHandshakeTranscriptHash('aa'.repeat(32), ctx))
    const h2 = bytesToHex(computeHandshakeTranscriptHash('bb'.repeat(32), ctx))
    expect(h1).not.toBe(h2)
  })

  it('swapped pub keys produce different hash', () => {
    const ch = 'cc'.repeat(32)
    const ctx1: SessionCryptoContext = {
      dappPubKeyB64: 'keyA',
      walletPubKeyB64: 'keyB',
      capabilities: null,
      dappName: 'X',
    }
    const ctx2: SessionCryptoContext = {
      dappPubKeyB64: 'keyB',
      walletPubKeyB64: 'keyA',
      capabilities: null,
      dappName: 'X',
    }
    const h1 = bytesToHex(computeHandshakeTranscriptHash(ch, ctx1))
    const h2 = bytesToHex(computeHandshakeTranscriptHash(ch, ctx2))
    expect(h1).not.toBe(h2)
  })
})
