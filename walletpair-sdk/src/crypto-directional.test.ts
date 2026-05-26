/**
 * Directional session key derivation tests.
 *
 * Covers: deriveDirectionalSessionKeys asymmetry, cross-side consistency,
 * transcript hash determinism, canonicalJson ordering, context sensitivity,
 * and cross-key decryption failures.
 */

import { describe, it, expect } from 'vitest';
import {
  generateX25519KeyPair,
  generateChannelId,
  computeSharedSecret,
  deriveSessionKey,
  sealPayload,
  unsealPayload,
  bytesToHex,
  b64urlEncode,
} from './crypto.js';
import {
  deriveDirectionalSessionKeys,
  computeHandshakeTranscriptHash,
} from './crypto.js';
import type { SessionCryptoContext } from './crypto.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides?: Partial<SessionCryptoContext>): SessionCryptoContext {
  return {
    dappPubKeyB64: overrides?.dappPubKeyB64 ?? 'dappPubKey123',
    walletPubKeyB64: overrides?.walletPubKeyB64 ?? 'walletPubKey456',
    capabilities: overrides?.capabilities ?? { methods: ['wallet_getAccounts'], events: [], chains: ['eip155:1'] },
    walletMeta: overrides?.walletMeta ?? { name: 'TestWallet' },
    dappName: overrides?.dappName ?? 'TestDApp',
  };
}

function makeRootKey(): Uint8Array {
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  return key;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Directional session keys', () => {

  it('deriveDirectionalSessionKeys produces different keys for each direction', () => {
    const rootKey = makeRootKey();
    const channelId = generateChannelId();
    const context = makeContext();

    const keys = deriveDirectionalSessionKeys(rootKey, channelId, context);

    expect(keys.dappToWalletKey).toHaveLength(32);
    expect(keys.walletToDappKey).toHaveLength(32);
    expect(bytesToHex(keys.dappToWalletKey)).not.toBe(bytesToHex(keys.walletToDappKey));
  });

  it('dappToWalletKey != walletToDappKey (even with identical root key and context)', () => {
    const rootKey = new Uint8Array(32).fill(0x42);
    const channelId = '00'.repeat(32);
    const context = makeContext();

    const keys = deriveDirectionalSessionKeys(rootKey, channelId, context);

    // They must differ because different HKDF info strings are used
    expect(bytesToHex(keys.dappToWalletKey)).not.toBe(bytesToHex(keys.walletToDappKey));
  });

  it('same keys derived from both sides (dApp and wallet perspectives)', () => {
    // Simulate full key exchange: both sides derive the same shared secret,
    // then the same directional keys.
    const dappKp = generateX25519KeyPair();
    const walletKp = generateX25519KeyPair();
    const channelId = generateChannelId();

    const capabilities = { methods: ['wallet_getAccounts'], events: ['accountsChanged'], chains: ['eip155:1'] };
    const walletMeta = { name: 'My Wallet' };
    const dappName = 'My dApp';

    // DApp side
    const sharedDapp = computeSharedSecret(dappKp.privateKey, walletKp.publicKey);
    const rootKeyDapp = deriveSessionKey(sharedDapp, channelId);
    const contextDapp: SessionCryptoContext = {
      dappPubKeyB64: dappKp.publicKeyB64,
      walletPubKeyB64: walletKp.publicKeyB64,
      capabilities,
      walletMeta,
      dappName,
    };
    const keysDapp = deriveDirectionalSessionKeys(rootKeyDapp, channelId, contextDapp);

    // Wallet side (same context fields, same shared secret via DH symmetry)
    const sharedWallet = computeSharedSecret(walletKp.privateKey, dappKp.publicKey);
    const rootKeyWallet = deriveSessionKey(sharedWallet, channelId);
    const contextWallet: SessionCryptoContext = {
      dappPubKeyB64: dappKp.publicKeyB64,
      walletPubKeyB64: walletKp.publicKeyB64,
      capabilities,
      walletMeta,
      dappName,
    };
    const keysWallet = deriveDirectionalSessionKeys(rootKeyWallet, channelId, contextWallet);

    // Both sides must agree on all keys
    expect(bytesToHex(keysDapp.dappToWalletKey)).toBe(bytesToHex(keysWallet.dappToWalletKey));
    expect(bytesToHex(keysDapp.walletToDappKey)).toBe(bytesToHex(keysWallet.walletToDappKey));
    expect(bytesToHex(keysDapp.transcriptHash)).toBe(bytesToHex(keysWallet.transcriptHash));
  });

  it('different capabilities produce different directional keys', () => {
    const rootKey = makeRootKey();
    const channelId = generateChannelId();

    const context1 = makeContext({ capabilities: { methods: ['wallet_getAccounts'], events: [], chains: ['eip155:1'] } });
    const context2 = makeContext({ capabilities: { methods: ['wallet_signMessage'], events: [], chains: ['eip155:1'] } });

    const keys1 = deriveDirectionalSessionKeys(rootKey, channelId, context1);
    const keys2 = deriveDirectionalSessionKeys(rootKey, channelId, context2);

    expect(bytesToHex(keys1.dappToWalletKey)).not.toBe(bytesToHex(keys2.dappToWalletKey));
    expect(bytesToHex(keys1.walletToDappKey)).not.toBe(bytesToHex(keys2.walletToDappKey));
  });

  it('different walletMeta produce different directional keys', () => {
    const rootKey = makeRootKey();
    const channelId = generateChannelId();

    const context1 = makeContext({ walletMeta: { name: 'Wallet A' } });
    const context2 = makeContext({ walletMeta: { name: 'Wallet B' } });

    const keys1 = deriveDirectionalSessionKeys(rootKey, channelId, context1);
    const keys2 = deriveDirectionalSessionKeys(rootKey, channelId, context2);

    expect(bytesToHex(keys1.dappToWalletKey)).not.toBe(bytesToHex(keys2.dappToWalletKey));
  });
});

describe('computeHandshakeTranscriptHash', () => {

  it('is deterministic for the same inputs', () => {
    const channelId = generateChannelId();
    const context = makeContext();

    const hash1 = computeHandshakeTranscriptHash(channelId, context);
    const hash2 = computeHandshakeTranscriptHash(channelId, context);

    expect(bytesToHex(hash1)).toBe(bytesToHex(hash2));
  });

  it('canonicalJson ordering is consistent regardless of object key insertion order', () => {
    const channelId = generateChannelId();

    // Two contexts with same data but different key insertion order
    const context1: SessionCryptoContext = {
      dappPubKeyB64: 'abc',
      walletPubKeyB64: 'def',
      capabilities: { methods: ['a'], events: ['b'], chains: ['c'] },
      walletMeta: { name: 'W', address: '0x1' },
      dappName: 'D',
    };

    const context2: SessionCryptoContext = {
      walletPubKeyB64: 'def',
      dappName: 'D',
      dappPubKeyB64: 'abc',
      walletMeta: { address: '0x1', name: 'W' },
      capabilities: { chains: ['c'], events: ['b'], methods: ['a'] },
    };

    const hash1 = computeHandshakeTranscriptHash(channelId, context1);
    const hash2 = computeHandshakeTranscriptHash(channelId, context2);

    expect(bytesToHex(hash1)).toBe(bytesToHex(hash2));
  });

  it('changing any context field changes the transcript hash', () => {
    const channelId = generateChannelId();
    const baseContext = makeContext();
    const baseHash = bytesToHex(computeHandshakeTranscriptHash(channelId, baseContext));

    // Change dappPubKeyB64
    const h1 = bytesToHex(computeHandshakeTranscriptHash(channelId, makeContext({ dappPubKeyB64: 'differentDappKey' })));
    expect(h1).not.toBe(baseHash);

    // Change walletPubKeyB64
    const h2 = bytesToHex(computeHandshakeTranscriptHash(channelId, makeContext({ walletPubKeyB64: 'differentWalletKey' })));
    expect(h2).not.toBe(baseHash);

    // Change capabilities
    const h3 = bytesToHex(computeHandshakeTranscriptHash(channelId, makeContext({ capabilities: { methods: ['other_method'], events: [], chains: [] } })));
    expect(h3).not.toBe(baseHash);

    // Change walletMeta
    const h4 = bytesToHex(computeHandshakeTranscriptHash(channelId, makeContext({ walletMeta: { name: 'DifferentWallet' } })));
    expect(h4).not.toBe(baseHash);

    // Change dappName
    const h5 = bytesToHex(computeHandshakeTranscriptHash(channelId, makeContext({ dappName: 'DifferentDApp' })));
    expect(h5).not.toBe(baseHash);

    // Change channelId
    const h6 = bytesToHex(computeHandshakeTranscriptHash(generateChannelId(), baseContext));
    expect(h6).not.toBe(baseHash);

    // All hashes must be unique
    const allHashes = [baseHash, h1, h2, h3, h4, h5, h6];
    expect(new Set(allHashes).size).toBe(allHashes.length);
  });
});

describe('Cross-key decryption', () => {
  const channelId = generateChannelId();
  const rootKey = makeRootKey();
  const context = makeContext();
  const keys = deriveDirectionalSessionKeys(rootKey, channelId, context);

  it('sealPayload with dappToWalletKey can be unsealed with dappToWalletKey', () => {
    const data = { action: 'test' };
    const sealed = sealPayload(keys.dappToWalletKey, channelId, 0, data);
    const { data: decrypted } = unsealPayload(keys.dappToWalletKey, channelId, sealed);
    expect(decrypted).toEqual(data);
  });

  it('sealPayload with dappToWalletKey cannot be unsealed with walletToDappKey', () => {
    const data = { secret: 'from-dapp' };
    const sealed = sealPayload(keys.dappToWalletKey, channelId, 0, data);

    // Attempting to decrypt with the wrong directional key must fail
    expect(() => unsealPayload(keys.walletToDappKey, channelId, sealed)).toThrow();
  });

  it('cross-key decryption fails: wallet key cannot decrypt dapp-encrypted message', () => {
    const data = { request: 'wallet_getAccounts', params: {} };
    const hdr = { type: 'req' as const, from: 'dapp', id: 'req-1', method: 'wallet_getAccounts' };

    const sealed = sealPayload(keys.dappToWalletKey, channelId, 0, data, hdr);

    // walletToDappKey must not be able to open it
    expect(() => unsealPayload(keys.walletToDappKey, channelId, sealed, hdr)).toThrow();

    // But dappToWalletKey can
    const { data: decrypted } = unsealPayload(keys.dappToWalletKey, channelId, sealed, hdr);
    expect(decrypted).toEqual(data);
  });

  it('walletToDappKey sealed message cannot be opened with dappToWalletKey', () => {
    const data = { result: ['0xabc'] };
    const hdr = { type: 'res' as const, from: 'wallet', id: 'req-1' };

    const sealed = sealPayload(keys.walletToDappKey, channelId, 0, data, hdr);

    expect(() => unsealPayload(keys.dappToWalletKey, channelId, sealed, hdr)).toThrow();

    const { data: decrypted } = unsealPayload(keys.walletToDappKey, channelId, sealed, hdr);
    expect(decrypted).toEqual(data);
  });
});
