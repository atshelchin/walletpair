/**
 * WalletPair Protocol v1 — crypto & protocol helpers.
 *
 * Aligned with walletpair-protocol-v1.md specification.
 * Pure JS (noble libraries v2), no native modules required.
 */

import canonicalize from 'canonicalize';
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
// Canonical JSON (protocol §6.2 — RFC 8785 compatible)
// ---------------------------------------------------------------------------

export function canonicalJson(value: unknown): string {
  return canonicalize(value) ?? 'null';
}

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

export function generateX25519KeyPair() {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey, publicKeyB64: b64urlEncode(publicKey) };
}

// ---------------------------------------------------------------------------
// Key derivation (protocol §6.2)
// ---------------------------------------------------------------------------

export function computeSharedSecret(
  myPrivateKey: Uint8Array,
  remotePubKey: Uint8Array,
): Uint8Array {
  return x25519.getSharedSecret(myPrivateKey, remotePubKey);
}

export function deriveRootKey(
  sharedSecret: Uint8Array,
  channelIdHex: string,
): Uint8Array {
  return hkdf(sha256, sharedSecret, hexToBytes(channelIdHex), 'walletpair-v1 root', 32);
}

/** Length-prefix a UTF-8 string: uint16_be(byte_length) || utf8_bytes */
function lp(s: string): Uint8Array {
  const bytes = utf8ToBytes(s);
  if (bytes.length > 0xffff) throw new Error('Field exceeds 65535 bytes');
  const len = new Uint8Array(2);
  new DataView(len.buffer).setUint16(0, bytes.length);
  return concatBytes(len, bytes);
}

export function computeTranscriptHash(
  channelIdHex: string,
  dappPubKeyB64: string,
  walletPubKeyB64: string,
  capabilities: unknown,
  walletMeta: unknown,
  dappName: string,
): Uint8Array {
  return sha256(concatBytes(
    utf8ToBytes('walletpair-v1-transcript'),
    hexToBytes(channelIdHex),
    lp(dappPubKeyB64),
    lp(walletPubKeyB64),
    lp(canonicalJson(capabilities ?? null)),
    lp(canonicalJson(walletMeta ?? null)),
    lp(dappName ?? ''),
  ));
}

export interface DirectionalKeys {
  dappToWalletKey: Uint8Array;
  walletToDappKey: Uint8Array;
}

export function deriveDirectionalKeys(
  rootKey: Uint8Array,
  transcriptHash: Uint8Array,
): DirectionalKeys {
  return {
    dappToWalletKey: hkdf(sha256, rootKey, transcriptHash, 'walletpair-v1 dapp-to-wallet', 32),
    walletToDappKey: hkdf(sha256, rootKey, transcriptHash, 'walletpair-v1 wallet-to-dapp', 32),
  };
}

export function deriveJoinEncryptionKey(
  rootKey: Uint8Array,
  channelIdHex: string,
): Uint8Array {
  return hkdf(sha256, rootKey, hexToBytes(channelIdHex), 'walletpair-v1 join-encryption', 32);
}

// ---------------------------------------------------------------------------
// Session fingerprint (protocol §6.3)
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
// Sealed join (protocol §6.5)
// ---------------------------------------------------------------------------

export function sealJoin(
  joinEncryptionKey: Uint8Array,
  channelIdHex: string,
  capabilities: unknown,
  meta: unknown,
): string {
  const plainObj = { capabilities, meta: meta ?? {} };
  const plaintext = utf8ToBytes(canonicalJson(plainObj));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aad = concatBytes(hexToBytes(channelIdHex), new Uint8Array([0x04]));
  const ciphertext = chacha20poly1305(joinEncryptionKey, nonce, aad).encrypt(plaintext);
  return b64urlEncode(concatBytes(nonce, ciphertext));
}

// ---------------------------------------------------------------------------
// AAD header (protocol §6.4)
// ---------------------------------------------------------------------------

export type AadType = 'req' | 'res' | 'evt';

function buildAad(channelIdHex: string, type: AadType, from: string, id: string): Uint8Array {
  const chBytes = hexToBytes(channelIdHex);
  const typeByte = type === 'req' ? 0x01 : type === 'res' ? 0x02 : 0x03;
  return concatBytes(chBytes, new Uint8Array([typeByte]), lp(from), lp(id));
}

// ---------------------------------------------------------------------------
// Encrypt / Decrypt (protocol §6.4)
// ---------------------------------------------------------------------------

export function sealPayload(
  trafficKey: Uint8Array,
  channelIdHex: string,
  seq: number,
  data: unknown,
  aadType: AadType,
  from: string,
  id: string,
): string {
  const seqBytes = new Uint8Array(4);
  new DataView(seqBytes.buffer).setUint32(0, seq);
  const nonce = hmac(sha256, trafficKey, seqBytes).slice(0, 12);
  const plaintext = utf8ToBytes(canonicalJson(data));
  const aad = buildAad(channelIdHex, aadType, from, id);
  const ciphertext = chacha20poly1305(trafficKey, nonce, aad).encrypt(plaintext);
  return b64urlEncode(concatBytes(seqBytes, ciphertext));
}

export function unsealPayload(
  trafficKey: Uint8Array,
  channelIdHex: string,
  sealed: string,
  aadType: AadType,
  from: string,
  id: string,
): { seq: number; data: unknown } {
  const bytes = b64urlDecode(sealed);
  const seqBytes = bytes.slice(0, 4);
  const ciphertext = bytes.slice(4);
  const nonce = hmac(sha256, trafficKey, seqBytes).slice(0, 12);
  const aad = buildAad(channelIdHex, aadType, from, id);
  const plaintext = chacha20poly1305(trafficKey, nonce, aad).decrypt(ciphertext);
  const seq = new DataView(seqBytes.buffer, seqBytes.byteOffset, 4).getUint32(0);
  return { seq, data: JSON.parse(new TextDecoder().decode(plaintext)) };
}

// ---------------------------------------------------------------------------
// Pairing URI parser (protocol §8.1)
// ---------------------------------------------------------------------------

export interface PairingParams {
  ch: string;
  pubkey: string;
  /** Empty string = BLE mode (no relay). */
  relay: string;
  name?: string;
  url?: string;
  icon?: string;
  methods?: string[];
  chains?: string[];
}

export function parsePairingUri(uri: string): PairingParams {
  const qs = uri.replace(/^walletpair:\?/, '');
  const params = new URLSearchParams(qs);
  const ch = params.get('ch');
  const pubkey = params.get('pubkey');
  if (!ch || !pubkey) {
    throw new Error('Invalid pairing URI: missing ch or pubkey');
  }
  const methodsStr = params.get('methods');
  const chainsStr = params.get('chains');
  return {
    ch,
    pubkey,
    relay: params.get('relay') ?? '',
    name: params.get('name') ?? undefined,
    url: params.get('url') ?? undefined,
    icon: params.get('icon') ?? undefined,
    methods: methodsStr ? methodsStr.split(',').filter(Boolean) : undefined,
    chains: chainsStr ? chainsStr.split(',').filter(Boolean) : undefined,
  };
}
