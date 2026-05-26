/**
 * Session persistence via AsyncStorage.
 *
 * Stores all state needed to survive page refresh / app restart
 * and reconnect to the relay.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { bytesToHex, hexToBytes } from './walletpair';

const KEY = 'wp_wallet_session';
const ETH_KEY = 'wp_eth_key';

// ---------------------------------------------------------------------------
// ETH key persistence (independent of session — survives navigation/remount)
// ---------------------------------------------------------------------------

export async function saveEthKey(hex: string): Promise<void> {
  await AsyncStorage.setItem(ETH_KEY, hex);
}

export async function loadEthKey(): Promise<string | null> {
  return AsyncStorage.getItem(ETH_KEY);
}

export async function clearEthKey(): Promise<void> {
  await AsyncStorage.removeItem(ETH_KEY);
}

export interface SessionData {
  channelId: string;
  privKeyHex: string; // X25519 private key
  pubKeyB64: string; // X25519 public key base64url
  remotePubKeyB64: string; // dApp's X25519 public key
  /** wallet→dApp traffic key (hex). */
  sendKeyHex: string;
  /** dApp→wallet traffic key (hex). */
  recvKeyHex: string;
  sendSeq: number;
  recvSeq: number;
  relayUrl: string;
  ethKeyHex: string;
  dappName: string;
}

export async function saveSession(data: SessionData): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(data));
}

export async function loadSession(): Promise<SessionData | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d.channelId || !d.privKeyHex || !d.sendKeyHex || !d.recvKeyHex) return null;
    return d as SessionData;
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
}

/** Helper: convert SessionData fields to Uint8Array crypto values. */
export function hydrateCrypto(d: SessionData) {
  return {
    privKey: hexToBytes(d.privKeyHex),
    sendKey: hexToBytes(d.sendKeyHex),
    recvKey: hexToBytes(d.recvKeyHex),
  };
}
