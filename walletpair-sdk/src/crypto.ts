/**
 * WalletPair Protocol v1 — crypto & protocol helpers.
 *
 * Pure JS (noble libraries v2), no native modules required.
 */

import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import {
  bytesToHex,
  hexToBytes,
  utf8ToBytes,
  concatBytes,
} from '@noble/hashes/utils';

import type { PairingParams } from './types.js';

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { bytesToHex, hexToBytes };

// ---------------------------------------------------------------------------
// Base64url (no padding)
// ---------------------------------------------------------------------------

export function b64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

export function b64urlDecode(str: string): Uint8Array {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

export interface X25519KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  publicKeyB64: string;
}

export function generateX25519KeyPair(): X25519KeyPair {
  const privateKey = x25519.utils.randomPrivateKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey, publicKeyB64: b64urlEncode(publicKey) };
}

export function getPublicKey(privateKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(privateKey);
}

// ---------------------------------------------------------------------------
// Session key derivation (protocol Section 7.2)
// ---------------------------------------------------------------------------

export function computeSharedSecret(
  myPrivateKey: Uint8Array,
  remotePubKey: Uint8Array,
): Uint8Array {
  return x25519.getSharedSecret(myPrivateKey, remotePubKey);
}

export function deriveSessionKey(
  sharedSecret: Uint8Array,
  channelIdHex: string,
): Uint8Array {
  return hkdf(sha256, sharedSecret, hexToBytes(channelIdHex), 'walletpair-v1', 32);
}

// ---------------------------------------------------------------------------
// Pairing code (protocol Section 7.3)
// ---------------------------------------------------------------------------

export function computePairingCode(
  sessionKey: Uint8Array,
  channelIdHex: string,
): string {
  const codeBytes = hkdf(sha256, sessionKey, hexToBytes(channelIdHex), 'walletpair-pairing-code', 4);
  const view = new DataView(codeBytes.buffer, codeBytes.byteOffset, 4);
  return (view.getUint32(0) % 1000000).toString().padStart(6, '0');
}

// ---------------------------------------------------------------------------
// Encrypt / Decrypt (protocol Section 7.4)
// ---------------------------------------------------------------------------

/**
 * AAD header for authenticated encryption.
 * Uses length-prefixed binary encoding per protocol §7.4.
 */
export type AadHeader =
  | { type: 'req'; from: string; id: string; method: string }
  | { type: 'res'; from: string; id: string; ok: boolean }
  | { type: 'evt'; from: string; event: string; id?: string };

/** Length-prefix a UTF-8 string: uint16_be(byte_length) || utf8_bytes */
function lp(s: string): Uint8Array {
  const bytes = utf8ToBytes(s);
  const len = new Uint8Array(2);
  new DataView(len.buffer).setUint16(0, bytes.length);
  return concatBytes(len, bytes);
}

/**
 * Build AEAD AAD = channel_id_bytes || type_byte || lp(fields...)
 */
function buildAad(channelIdHex: string, header?: AadHeader): Uint8Array {
  const chBytes = hexToBytes(channelIdHex);
  if (!header) return chBytes;
  switch (header.type) {
    case 'req':
      return concatBytes(chBytes, new Uint8Array([0x01]), lp(header.from), lp(header.id), lp(header.method));
    case 'res':
      return concatBytes(chBytes, new Uint8Array([0x02]), lp(header.from), lp(header.id), new Uint8Array([header.ok ? 0x01 : 0x00]));
    case 'evt':
      return concatBytes(chBytes, new Uint8Array([0x03]), lp(header.from), lp(header.event), lp(header.id ?? ''));
  }
}

export function sealPayload(
  sessionKey: Uint8Array,
  channelIdHex: string,
  seq: number,
  data: unknown,
  header?: AadHeader,
): string {
  const seqBytes = new Uint8Array(4);
  new DataView(seqBytes.buffer).setUint32(0, seq);
  const nonce = hmac(sha256, sessionKey, seqBytes).slice(0, 12);
  const plaintext = utf8ToBytes(JSON.stringify(data));
  const aad = buildAad(channelIdHex, header);
  const ciphertext = chacha20poly1305(sessionKey, nonce, aad).encrypt(plaintext);
  return b64urlEncode(concatBytes(seqBytes, ciphertext));
}

export function unsealPayload(
  sessionKey: Uint8Array,
  channelIdHex: string,
  sealed: string,
  header?: AadHeader,
): { seq: number; data: unknown } {
  const bytes = b64urlDecode(sealed);
  const seqBytes = bytes.slice(0, 4);
  const ciphertext = bytes.slice(4);
  const nonce = hmac(sha256, sessionKey, seqBytes).slice(0, 12);
  const aad = buildAad(channelIdHex, header);
  const plaintext = chacha20poly1305(sessionKey, nonce, aad).decrypt(ciphertext);
  const seq = new DataView(seqBytes.buffer, seqBytes.byteOffset, 4).getUint32(0);
  return { seq, data: JSON.parse(new TextDecoder().decode(plaintext)) };
}

// ---------------------------------------------------------------------------
// Channel ID generation
// ---------------------------------------------------------------------------

export function generateChannelId(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

// ---------------------------------------------------------------------------
// Pairing URI
// ---------------------------------------------------------------------------

export function buildPairingUri(params: {
  channelId: string;
  pubkeyB64: string;
  relayUrl?: string | undefined;
  name?: string | undefined;
}): string {
  let uri = `walletpair:?ch=${params.channelId}&pubkey=${params.pubkeyB64}`;
  if (params.relayUrl) uri += `&relay=${encodeURIComponent(params.relayUrl)}`;
  if (params.name) uri += `&name=${encodeURIComponent(params.name)}`;
  return uri;
}

export function parsePairingUri(uri: string): PairingParams {
  const qs = uri.replace(/^walletpair:\?/, '');
  const params = new URLSearchParams(qs);
  const ch = params.get('ch');
  const pubkey = params.get('pubkey');
  if (!ch || !pubkey) throw new Error('Invalid pairing URI: missing ch or pubkey');
  return {
    ch,
    pubkey,
    relay: params.get('relay') ?? '',
    name: params.get('name') ?? undefined,
  };
}
