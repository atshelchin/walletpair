/**
 * WalletPair Protocol v1 — crypto & protocol helpers.
 *
 * Pure JS (noble libraries v2), no native modules required.
 */

import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import {
  bytesToHex,
  hexToBytes,
  utf8ToBytes,
  concatBytes,
} from '@noble/hashes/utils.js';

// ---------------------------------------------------------------------------
// Base64url (no padding)
// ---------------------------------------------------------------------------

export function b64urlEncode(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    chunks.push(String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 8192))));
  }
  return btoa(chunks.join(''))
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
// Re-exports
// ---------------------------------------------------------------------------

export { bytesToHex, hexToBytes };

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

export function generateX25519KeyPair() {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey, publicKeyB64: b64urlEncode(publicKey) };
}

// ---------------------------------------------------------------------------
// Session key derivation (protocol Section 7.2)
// ---------------------------------------------------------------------------

const INFO_SESSION = utf8ToBytes('walletpair-v1');
const INFO_PAIRING = utf8ToBytes('walletpair-pairing-code');

export function deriveSessionKey(
  sharedSecret: Uint8Array,
  channelIdHex: string,
): Uint8Array {
  return hkdf(sha256, sharedSecret, hexToBytes(channelIdHex), INFO_SESSION, 32);
}

export function computeSharedSecret(
  myPrivateKey: Uint8Array,
  remotePubKey: Uint8Array,
): Uint8Array {
  return x25519.getSharedSecret(myPrivateKey, remotePubKey);
}

// ---------------------------------------------------------------------------
// Session fingerprint (protocol Section 7.3)
// ---------------------------------------------------------------------------

export function computeSessionFingerprint(
  channelIdHex: string,
  dappPubKeyB64: string,
): string {
  const hash = sha256(concatBytes(
    utf8ToBytes('walletpair-v1-session-fingerprint'),
    hexToBytes(channelIdHex),
    b64urlDecode(dappPubKeyB64),
  ));
  const view = new DataView(hash.buffer, hash.byteOffset, 4);
  return (view.getUint32(0) % 10000).toString().padStart(4, '0');
}

// ---------------------------------------------------------------------------
// Encrypt / Decrypt (protocol Section 7.4)
// ---------------------------------------------------------------------------

export function sealPayload(
  sessionKey: Uint8Array,
  channelIdHex: string,
  seq: number,
  data: unknown,
): string {
  const seqBytes = new Uint8Array(4);
  new DataView(seqBytes.buffer).setUint32(0, seq);
  const nonce = hmac(sha256, sessionKey, seqBytes).slice(0, 12);
  const plaintext = utf8ToBytes(JSON.stringify(data));
  const aad = hexToBytes(channelIdHex);
  const ciphertext = chacha20poly1305(sessionKey, nonce, aad).encrypt(plaintext);
  return b64urlEncode(concatBytes(seqBytes, ciphertext));
}

export function unsealPayload(
  sessionKey: Uint8Array,
  channelIdHex: string,
  sealed: string,
): { seq: number; data: unknown } {
  const bytes = b64urlDecode(sealed);
  const seqBytes = bytes.slice(0, 4);
  const ciphertext = bytes.slice(4);
  const nonce = hmac(sha256, sessionKey, seqBytes).slice(0, 12);
  const aad = hexToBytes(channelIdHex);
  const plaintext = chacha20poly1305(sessionKey, nonce, aad).decrypt(ciphertext);
  const seq = new DataView(seqBytes.buffer, seqBytes.byteOffset, 4).getUint32(0);
  return { seq, data: JSON.parse(new TextDecoder().decode(plaintext)) };
}

// ---------------------------------------------------------------------------
// Pairing URI parser
// ---------------------------------------------------------------------------

export interface PairingParams {
  ch: string;
  pubkey: string;
  /** Empty string = BLE mode (no relay). */
  relay: string;
  name?: string;
}

export function parsePairingUri(uri: string): PairingParams {
  const qs = uri.replace(/^walletpair:\?/, '');
  const params = new URLSearchParams(qs);
  const ch = params.get('ch');
  const pubkey = params.get('pubkey');
  if (!ch || !pubkey) {
    throw new Error('Invalid pairing URI: missing ch or pubkey');
  }
  return {
    ch,
    pubkey,
    relay: params.get('relay') ?? '',
    name: params.get('name') ?? undefined,
  };
}
