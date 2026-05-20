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
// Root and directional key derivation (protocol Section 7.2)
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
  return hkdf(sha256, sharedSecret, hexToBytes(channelIdHex), 'walletpair-v1 root', 32);
}

export interface SessionCryptoContext {
  dappPubKeyB64: string;
  walletPubKeyB64: string;
  capabilities?: unknown;
  walletMeta?: unknown;
  dappName?: string | undefined;
}

export interface DirectionalSessionKeys {
  rootKey: Uint8Array;
  dappToWalletKey: Uint8Array;
  walletToDappKey: Uint8Array;
  transcriptHash: Uint8Array;
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`)
    .join(',')}}`;
}

export function computeHandshakeTranscriptHash(
  channelIdHex: string,
  context: SessionCryptoContext,
): Uint8Array {
  return sha256(concatBytes(
    utf8ToBytes('walletpair-v1-transcript'),
    hexToBytes(channelIdHex),
    lp(context.dappPubKeyB64),
    lp(context.walletPubKeyB64),
    lp(canonicalJson(context.capabilities ?? null)),
    lp(canonicalJson(context.walletMeta ?? null)),
    lp(context.dappName ?? ''),
  ));
}

export function deriveDirectionalSessionKeys(
  rootKey: Uint8Array,
  channelIdHex: string,
  context: SessionCryptoContext,
): DirectionalSessionKeys {
  const transcriptHash = computeHandshakeTranscriptHash(channelIdHex, context);
  return {
    rootKey,
    transcriptHash,
    dappToWalletKey: hkdf(sha256, rootKey, transcriptHash, 'walletpair-v1 dapp-to-wallet', 32),
    walletToDappKey: hkdf(sha256, rootKey, transcriptHash, 'walletpair-v1 wallet-to-dapp', 32),
  };
}

// ---------------------------------------------------------------------------
// Pairing code (protocol Section 7.3)
// ---------------------------------------------------------------------------

export function computePairingCode(
  rootKey: Uint8Array,
  channelIdHex: string,
  context?: SessionCryptoContext,
): string {
  const salt = context
    ? computeHandshakeTranscriptHash(channelIdHex, context)
    : hexToBytes(channelIdHex);
  const codeBytes = hkdf(sha256, rootKey, salt, 'walletpair-pairing-code', 4);
  const view = new DataView(codeBytes.buffer, codeBytes.byteOffset, 4);
  return (view.getUint32(0) % 10000).toString().padStart(4, '0');
}

// ---------------------------------------------------------------------------
// Join encryption key (protocol Section 7.5 — private handshake)
// ---------------------------------------------------------------------------

export function deriveJoinEncryptionKey(
  rootKey: Uint8Array,
  channelIdHex: string,
): Uint8Array {
  return hkdf(sha256, rootKey, hexToBytes(channelIdHex), 'walletpair-v1 join-encryption', 32);
}

/**
 * Encrypt capabilities + meta for private handshake (§7.5).
 * Returns base64url(nonce || ciphertext || tag).
 */
export function sealJoin(
  joinEncryptionKey: Uint8Array,
  channelIdHex: string,
  capabilities: unknown,
  meta?: unknown,
): string {
  const plainObj: Record<string, unknown> = { capabilities, meta: meta ?? {} };
  const plaintext = utf8ToBytes(canonicalJson(plainObj));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aad = concatBytes(hexToBytes(channelIdHex), new Uint8Array([0x04]));
  const ciphertext = chacha20poly1305(joinEncryptionKey, nonce, aad).encrypt(plaintext);
  return b64urlEncode(concatBytes(nonce, ciphertext));
}

/**
 * Decrypt sealed_join from a private handshake join message (§7.5).
 * Returns { capabilities, meta }.
 */
export function unsealJoin(
  joinEncryptionKey: Uint8Array,
  channelIdHex: string,
  sealedJoin: string,
): { capabilities: unknown; meta?: unknown } {
  const envelope = b64urlDecode(sealedJoin);
  if (envelope.length < 12 + 16) {
    throw new Error('Invalid sealed_join envelope');
  }
  const nonce = envelope.slice(0, 12);
  const ciphertext = envelope.slice(12);
  const aad = concatBytes(hexToBytes(channelIdHex), new Uint8Array([0x04]));
  const plaintext = chacha20poly1305(joinEncryptionKey, nonce, aad).decrypt(ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

// ---------------------------------------------------------------------------
// Encrypt / Decrypt (protocol Section 7.4)
// ---------------------------------------------------------------------------

/**
 * AAD header for authenticated encryption.
 * Uses length-prefixed binary encoding per protocol §7.4.
 */
export type AadHeader =
  | { type: 'req'; from: string; id: string }
  | { type: 'res'; from: string; id: string; ok: boolean }
  | { type: 'evt'; from: string; id: string };

/** Length-prefix a UTF-8 string: uint16_be(byte_length) || utf8_bytes */
function lp(s: string): Uint8Array {
  const bytes = utf8ToBytes(s);
  if (bytes.length > 0xffff) {
    throw new Error('AAD field exceeds 65535 bytes');
  }
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
      return concatBytes(chBytes, new Uint8Array([0x01]), lp(header.from), lp(header.id));
    case 'res':
      return concatBytes(chBytes, new Uint8Array([0x02]), lp(header.from), lp(header.id), new Uint8Array([header.ok ? 0x01 : 0x00]));
    case 'evt':
      return concatBytes(chBytes, new Uint8Array([0x03]), lp(header.from), lp(header.id));
  }
}

export function sealPayload(
  encryptionKey: Uint8Array,
  channelIdHex: string,
  seq: number,
  data: unknown,
  header?: AadHeader,
): string {
  const seqBytes = new Uint8Array(4);
  new DataView(seqBytes.buffer).setUint32(0, seq);
  const nonce = hmac(sha256, encryptionKey, seqBytes).slice(0, 12);
  const plaintext = utf8ToBytes(JSON.stringify(data));
  const aad = buildAad(channelIdHex, header);
  const ciphertext = chacha20poly1305(encryptionKey, nonce, aad).encrypt(plaintext);
  return b64urlEncode(concatBytes(seqBytes, ciphertext));
}

export function unsealPayload(
  encryptionKey: Uint8Array,
  channelIdHex: string,
  sealed: string,
  header?: AadHeader,
): { seq: number; data: unknown; plaintext: Uint8Array; plaintextJson: string } {
  const bytes = b64urlDecode(sealed);
  const seqBytes = bytes.slice(0, 4);
  const ciphertext = bytes.slice(4);
  const nonce = hmac(sha256, encryptionKey, seqBytes).slice(0, 12);
  const aad = buildAad(channelIdHex, header);
  const plaintext = chacha20poly1305(encryptionKey, nonce, aad).decrypt(ciphertext);
  const seq = new DataView(seqBytes.buffer, seqBytes.byteOffset, 4).getUint32(0);
  const plaintextJson = new TextDecoder().decode(plaintext);
  return { seq, data: JSON.parse(plaintextJson), plaintext, plaintextJson };
}

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
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
  /** Methods the dApp intends to call (§9.1). */
  methods?: string[] | undefined;
  /** CAIP-2 chains the dApp intends to use (§9.1). */
  chains?: string[] | undefined;
}): string {
  let uri = `walletpair:?ch=${params.channelId}&pubkey=${params.pubkeyB64}`;
  if (params.relayUrl) uri += `&relay=${encodeURIComponent(params.relayUrl)}`;
  if (params.name) uri += `&name=${encodeURIComponent(params.name)}`;
  if (params.methods?.length) uri += `&methods=${params.methods.join(',')}`;
  if (params.chains?.length) uri += `&chains=${params.chains.join(',')}`;
  return uri;
}

export function parsePairingUri(uri: string): PairingParams {
  const qs = uri.replace(/^walletpair:\?/, '');
  const params = new URLSearchParams(qs);
  const ch = params.get('ch');
  const pubkey = params.get('pubkey');
  if (!ch || !pubkey) throw new Error('Invalid pairing URI: missing ch or pubkey');
  const methodsStr = params.get('methods');
  const chainsStr = params.get('chains');
  return {
    ch,
    pubkey,
    relay: params.get('relay') ?? '',
    name: params.get('name') ?? undefined,
    methods: methodsStr ? methodsStr.split(',').filter(Boolean) : undefined,
    chains: chainsStr ? chainsStr.split(',').filter(Boolean) : undefined,
  };
}
