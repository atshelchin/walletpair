/**
 * Session persistence via AsyncStorage.
 *
 * Stores all state needed to survive page refresh / app restart
 * and reconnect to the relay (with or without resume token).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { bytesToHex, hexToBytes } from './walletpair';

const KEY = 'wp_wallet_session';

export interface SessionData {
  channelId: string;
  privKeyHex: string; // X25519 private key
  pubKeyB64: string; // X25519 public key base64url
  remotePubKeyB64: string; // dApp's X25519 public key
  sessionKeyHex: string;
  sendSeq: number;
  resumeToken: string | null;
  relayUrl: string;
  ethKeyHex: string;
}

export async function saveSession(data: SessionData): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(data));
}

export async function loadSession(): Promise<SessionData | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d.channelId || !d.privKeyHex || !d.sessionKeyHex) return null;
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
    sessionKey: hexToBytes(d.sessionKeyHex),
  };
}
