/**
 * Minimal EOA wallet — secp256k1 key management & EIP-191 personal_sign.
 *
 * Uses noble-curves v2 API.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import {
  bytesToHex,
  hexToBytes,
  utf8ToBytes,
  concatBytes,
} from '@noble/hashes/utils.js';

export function generatePrivateKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export function privateKeyToAddress(privKeyHex: string): string {
  const pubKey = secp256k1.getPublicKey(hexToBytes(privKeyHex), false); // uncompressed 65 bytes
  const hash = keccak_256(pubKey.slice(1)); // hash of x||y (64 bytes)
  return '0x' + bytesToHex(hash.slice(-20));
}

export function personalSign(privKeyHex: string, message: string): string {
  const msgBytes = utf8ToBytes(message);
  const prefix = utf8ToBytes(
    `\x19Ethereum Signed Message:\n${msgBytes.length}`,
  );
  const hash = keccak_256(concatBytes(prefix, msgBytes));
  const privKey = hexToBytes(privKeyHex);

  // noble v2: sign() returns compact 64-byte signature
  const sigBytes = secp256k1.sign(hash, privKey);
  const sig = secp256k1.Signature.fromBytes(sigBytes);

  // Recover the v bit by trying both recovery values
  const pubKey = secp256k1.getPublicKey(privKey, false);
  const pubHex = bytesToHex(pubKey);
  let recovery = 0;
  for (let v = 0; v <= 1; v++) {
    try {
      const recovered = sig.addRecoveryBit(v).recoverPublicKey(hash);
      if (bytesToHex(recovered.toBytes(false)) === pubHex) {
        recovery = v;
        break;
      }
    } catch {
      /* try next v */
    }
  }

  const r = sig.r.toString(16).padStart(64, '0');
  const s = sig.s.toString(16).padStart(64, '0');
  const vHex = (recovery + 27).toString(16).padStart(2, '0');
  return '0x' + r + s + vHex;
}
