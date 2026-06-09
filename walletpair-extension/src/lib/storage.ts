import { STORAGE_KEYS, DEFAULT_RELAY_URL } from './constants';
import type { ConnectedWallet, ExtensionSettings, OriginPermission, ActivityEntry } from './types';

const defaults: ExtensionSettings = {
  relayUrl: DEFAULT_RELAY_URL,
  autoConnect: true,
  rpcUrls: {},
};

/** Get extension settings from chrome.storage.local */
export async function getSettings(): Promise<ExtensionSettings> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  return { ...defaults, ...result[STORAGE_KEYS.SETTINGS] };
}

/** Save extension settings */
export async function saveSettings(settings: Partial<ExtensionSettings>): Promise<void> {
  const current = await getSettings();
  await chrome.storage.local.set({
    [STORAGE_KEYS.SETTINGS]: { ...current, ...settings },
  });
}

/** Get saved session state (for reconnection) */
export async function getSessionState(): Promise<string | null> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.SESSION_STATE);
  return result[STORAGE_KEYS.SESSION_STATE] ?? null;
}

/** Save session state */
export async function saveSessionState(state: string | null): Promise<void> {
  if (state) {
    await chrome.storage.local.set({ [STORAGE_KEYS.SESSION_STATE]: state });
  } else {
    await chrome.storage.local.remove(STORAGE_KEYS.SESSION_STATE);
  }
}

/** Get connected wallet info */
export async function getConnectedWallet(): Promise<ConnectedWallet | null> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.CONNECTED_WALLET);
  return result[STORAGE_KEYS.CONNECTED_WALLET] ?? null;
}

/** Save connected wallet info */
export async function saveConnectedWallet(wallet: ConnectedWallet | null): Promise<void> {
  if (wallet) {
    await chrome.storage.local.set({ [STORAGE_KEYS.CONNECTED_WALLET]: wallet });
  } else {
    await chrome.storage.local.remove(STORAGE_KEYS.CONNECTED_WALLET);
  }
}

// ── Per-origin permissions ──────────────────────────────────────────────

// Fix #5: Serialize concurrent read-modify-write operations to prevent data loss
let permissionMutex: Promise<void> = Promise.resolve();

function withPermissionLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = permissionMutex;
  let resolve: () => void;
  permissionMutex = new Promise<void>((r) => { resolve = r; });
  return prev.then(fn).finally(() => resolve!());
}

/** Get all origin permissions */
export async function getPermissions(): Promise<Record<string, OriginPermission>> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.PERMISSIONS);
  return result[STORAGE_KEYS.PERMISSIONS] ?? {};
}

/** Grant permission for an origin */
export function grantPermission(origin: string): Promise<void> {
  return withPermissionLock(async () => {
    const perms = await getPermissions();
    perms[origin] = { origin, granted: true, grantedAt: Date.now() };
    await chrome.storage.local.set({ [STORAGE_KEYS.PERMISSIONS]: perms });
  });
}

/** Revoke permission for an origin */
export function revokePermission(origin: string): Promise<void> {
  return withPermissionLock(async () => {
    const perms = await getPermissions();
    delete perms[origin];
    await chrome.storage.local.set({ [STORAGE_KEYS.PERMISSIONS]: perms });
  });
}

/** Check if an origin is permitted */
export async function isPermitted(origin: string): Promise<boolean> {
  const perms = await getPermissions();
  return perms[origin]?.granted === true;
}

// ── Session timestamp ─────────────────────────────────────────────────

/** Save the timestamp when the session entered connected state */
export async function saveConnectedAt(ts: number | null): Promise<void> {
  if (ts) {
    await chrome.storage.local.set({ [STORAGE_KEYS.CONNECTED_AT]: ts });
  } else {
    await chrome.storage.local.remove(STORAGE_KEYS.CONNECTED_AT);
  }
}

/** Get the timestamp when the session entered connected state */
export async function getConnectedAt(): Promise<number | null> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.CONNECTED_AT);
  return result[STORAGE_KEYS.CONNECTED_AT] ?? null;
}

// ── Activity Log ─────────────────────────────────────────────────────

const ACTIVITY_KEY = 'activityLog';
const MAX_ACTIVITY = 50;

// Fix #5: Serialize activity log mutations to prevent data loss
let activityMutex: Promise<void> = Promise.resolve();

function withActivityLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = activityMutex;
  let resolve: () => void;
  activityMutex = new Promise<void>((r) => { resolve = r; });
  return prev.then(fn).finally(() => resolve!());
}

export async function getActivityLog(): Promise<ActivityEntry[]> {
  const result = await chrome.storage.local.get(ACTIVITY_KEY);
  return result[ACTIVITY_KEY] ?? [];
}

export function addActivityEntry(entry: ActivityEntry): Promise<void> {
  return withActivityLock(async () => {
    const log = await getActivityLog();
    log.unshift(entry); // newest first
    if (log.length > MAX_ACTIVITY) log.length = MAX_ACTIVITY;
    await chrome.storage.local.set({ [ACTIVITY_KEY]: log });
  });
}

export function updateActivityStatus(
  id: string,
  status: ActivityEntry['status'],
  response?: { result?: unknown; error?: { code: number; message: string } },
): Promise<void> {
  return withActivityLock(async () => {
    const log = await getActivityLog();
    const entry = log.find(e => e.id === id);
    if (entry) {
      entry.status = status;
      if (response?.result !== undefined) entry.result = response.result;
      if (response?.error) entry.error = response.error;
      await chrome.storage.local.set({ [ACTIVITY_KEY]: log });
    }
  });
}

export async function clearActivityLog(): Promise<void> {
  await chrome.storage.local.remove(ACTIVITY_KEY);
}
