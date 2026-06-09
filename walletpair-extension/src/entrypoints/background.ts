/**
 * Background service worker - manages WalletPair session via SDK.
 *
 * Uses WalletPairProvider from walletpair-sdk for method mapping,
 * instead of reimplementing it.
 */
import { DAppSession, WebSocketTransport } from 'walletpair-sdk';
import { WalletPairProvider } from 'walletpair-sdk/evm/eip1193';
import { DEFAULT_RELAY_URL } from '@/lib/constants';
import {
  getSettings,
  getSessionState,
  saveSessionState,
  saveConnectedWallet,
  getConnectedWallet,
  isPermitted,
  grantPermission,
  revokePermission,
  getPermissions,
  saveConnectedAt,
  getConnectedAt,
  addActivityEntry,
  updateActivityStatus,
} from '@/lib/storage';
import { READ_ONLY_METHODS, proxyRpcCall } from '@/lib/rpc-proxy';
import { getHandler } from '@/lib/protocols/registry';
import type { ExtensionState, ConnectedWallet, BackgroundMessage, EIP1193Request, PendingConfirmationInfo, ActivityEntry } from '@/lib/types';

// ── Constants ───────────────────────────────────────────────────────────

/** Deferred request timeout (5 minutes) */
const DEFERRED_TIMEOUT_MS = 5 * 60 * 1000;

/** Maximum session age (24 hours) */
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// ── State ────────────────────────────────────────────────────────────────

let session: DAppSession | null = null;
let evmProvider: WalletPairProvider | null = null;
let transport: WebSocketTransport | null = null;
let state: ExtensionState = { phase: 'idle' };
let connectedWallet: ConnectedWallet | null = null;
let pairingInProgress = false;

/** RPC URLs received from the wallet via capabilities (CAIP-2 keyed, e.g. "eip155:1") */
let walletRpcUrls: Record<string, string> = {};

// Exponential backoff state for reconnection
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

function scheduleReconnect() {
  if (reconnectTimer) return; // already scheduled
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt), RECONNECT_MAX_MS);
  reconnectAttempt++;
  console.warn(`[WalletPair] Scheduling reconnect in ${delay}ms (attempt ${reconnectAttempt})`);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    const ok = await tryReconnect();
    if (ok) {
      reconnectAttempt = 0;
      console.log('[WalletPair] Reconnected successfully');
    } else {
      scheduleReconnect();
    }
  }, delay);
}

function resetReconnectBackoff() {
  reconnectAttempt = 0;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

// Pending RPC requests waiting for pairing to complete
const deferredRequests: Array<{
  id: string;
  payload: EIP1193Request;
  origin?: string;
  resolve: (v: { result?: unknown; error?: { code: number; message: string } }) => void;
  timer: ReturnType<typeof setTimeout>;
}> = [];

// Pending tx/sign confirmations awaiting user approval
interface PendingConfirmation {
  id: string;
  method: string;
  params: unknown;
  origin: string;
  resolve: (v: { result?: unknown; error?: { code: number; message: string } }) => void;
  windowId?: number;
  timeoutTimer?: ReturnType<typeof setTimeout>;
}
const pendingConfirmations = new Map<string, PendingConfirmation>();

/** Methods that require user confirmation before forwarding to wallet.
 * Sourced from the protocol handler for the connected wallet's protocol. */
const CONFIRMATION_METHODS = getHandler('ethereum').confirmationMethods;

// Map of connected content script ports
const contentPorts = new Map<number, chrome.runtime.Port>();

// ── State Management ─────────────────────────────────────────────────────

function updateState(patch: Partial<ExtensionState>) {
  state = { ...state, ...patch };
  // Broadcast to popup/options via runtime message
  chrome.runtime.sendMessage({ action: 'state-update', state }).catch((e) => console.warn('[WalletPair]', e));
}

function broadcastEvent(event: string, data: unknown) {
  const msg = { action: 'emit-event', event, data };
  for (const [, port] of contentPorts) {
    try { port.postMessage(msg); } catch {}
  }
}

// ── Deferred Request Helpers ────────────────────────────────────────────

function rejectAllDeferred(code: number, message: string) {
  while (deferredRequests.length > 0) {
    const req = deferredRequests.shift()!;
    clearTimeout(req.timer);
    req.resolve({ error: { code, message } });
  }
}

function addDeferredRequest(
  id: string,
  payload: EIP1193Request,
  resolve: (v: { result?: unknown; error?: { code: number; message: string } }) => void,
  origin?: string,
) {
  const timer = setTimeout(() => {
    const idx = deferredRequests.findIndex((r) => r.id === id);
    if (idx !== -1) {
      const [req] = deferredRequests.splice(idx, 1);
      req!.resolve({ error: { code: 4001, message: 'Request timed out waiting for wallet pairing' } });
    }
  }, DEFERRED_TIMEOUT_MS);

  deferredRequests.push({ id, payload, origin, resolve, timer });
}

// ── Session Management ───────────────────────────────────────────────────

// Track listener removers so we can clean up before re-attaching
let cleanupSessionListeners: (() => void) | null = null;

function attachSessionListeners(autoAccepted: boolean) {
  if (!session) return;

  // Remove any previously attached listeners to avoid duplicates on reconnect
  if (cleanupSessionListeners) {
    cleanupSessionListeners();
    cleanupSessionListeners = null;
  }

  const sessionRef = session;
  const evmRef = evmProvider;

  // Phase handler
  const onPhase = (phase: string) => {
    switch (phase) {
      case 'waiting':
        updateState({ phase: 'pairing', pairingUri: sessionRef.pairingUri });
        break;
      case 'pending_accept':
        updateState({ phase: 'pending_accept' });
        break;
      case 'connected':
        updateState({ phase: 'connected' });
        pairingInProgress = false;
        resetReconnectBackoff();
        saveSessionState(sessionRef.serialize()).catch((e) => console.warn('[WalletPair]', e));
        saveConnectedAt(Date.now()).catch((e) => console.warn('[WalletPair]', e));
        // Clear any existing keepalive alarm before creating new one (Fix #11)
        chrome.alarms.clear('walletpair-keepalive', () => {
          chrome.alarms.create('walletpair-keepalive', { periodInMinutes: 0.33 });
        });
        flushDeferredRequests();
        break;
      case 'disconnected':
        updateState({ phase: 'disconnected' });
        scheduleReconnect();
        break;
      case 'closed':
        handleSessionClosed();
        break;
    }
  };
  sessionRef.on('phase', onPhase);

  const onFingerprint = (code: unknown) => {
    updateState({ sessionFingerprint: code as string });
  };
  sessionRef.on('sessionFingerprint', onFingerprint);

  const onWalletJoined = ({ meta, capabilities }: { meta?: { name?: string; icon?: string }; capabilities?: { rpcUrls?: Record<string, string> } }) => {
    console.log('[WalletPair] walletJoined meta:', JSON.stringify(meta));
    updateState({ walletMeta: meta ? { name: meta.name, icon: meta.icon } : undefined });

    // Capture RPC URLs from wallet capabilities for local read-only proxying
    if (capabilities?.rpcUrls) {
      walletRpcUrls = capabilities.rpcUrls;
      console.log('[WalletPair] Received wallet RPC URLs:', Object.keys(walletRpcUrls).join(', '));
    }
  };
  sessionRef.on('walletJoined', onWalletJoined);

  // EVM provider event handlers
  const onAccountsChanged = (accounts: string[]) => {
    if (accounts.length > 0) {
      connectedWallet = {
        address: accounts[0]!,
        chainId: connectedWallet?.chainId ?? 1,
        name: sessionRef.walletMeta?.name,
        icon: sessionRef.walletMeta?.icon,
      };
      saveConnectedWallet(connectedWallet).catch((e) => console.warn('[WalletPair]', e));
      updateState({ wallet: { ...connectedWallet } });
    }
    broadcastEvent('accountsChanged', accounts);
  };

  const onChainChanged = (hexChainId: string) => {
    const numericChainId = parseInt(hexChainId, 16);
    if (connectedWallet) {
      connectedWallet.chainId = numericChainId;
      saveConnectedWallet(connectedWallet).catch((e) => console.warn('[WalletPair]', e));
      updateState({ wallet: { ...connectedWallet } });
    }
    broadcastEvent('chainChanged', hexChainId);
  };

  const onDisconnect = () => {
    broadcastEvent('disconnect', undefined);
  };

  const onConnect = (info: { chainId: string }) => {
    broadcastEvent('connect', info);
  };

  if (evmRef) {
    evmRef.on('accountsChanged', onAccountsChanged);
    evmRef.on('chainChanged', onChainChanged);
    evmRef.on('disconnect', onDisconnect);
    evmRef.on('connect', onConnect);
  }

  // Store cleanup function to remove all listeners before next attach
  cleanupSessionListeners = () => {
    sessionRef.off('phase', onPhase);
    sessionRef.off('sessionFingerprint', onFingerprint);
    sessionRef.off('walletJoined', onWalletJoined);
    if (evmRef) {
      evmRef.removeListener('accountsChanged', onAccountsChanged);
      evmRef.removeListener('chainChanged', onChainChanged);
      evmRef.removeListener('disconnect', onDisconnect);
      evmRef.removeListener('connect', onConnect);
    }
  };
}

function handleSessionClosed() {
  pairingInProgress = false;
  walletRpcUrls = {};
  // Reject all deferred requests since session is gone
  rejectAllDeferred(4001, 'Session closed');

  // Clear keepalive alarm
  chrome.alarms.clear('walletpair-keepalive');

  updateState({
    phase: 'idle',
    pairingUri: undefined,
    sessionFingerprint: undefined,
    wallet: undefined,
    walletMeta: undefined,
  });
  connectedWallet = null;
  saveSessionState(null).catch((e) => console.warn('[WalletPair]', e));
  saveConnectedWallet(null).catch((e) => console.warn('[WalletPair]', e));
  saveConnectedAt(null).catch((e) => console.warn('[WalletPair]', e));
  broadcastEvent('disconnect', undefined);
}

async function createSession(): Promise<void> {
  const settings = await getSettings();
  const relayUrl = settings.relayUrl || DEFAULT_RELAY_URL;

  // Clean up existing
  if (session) session.destroy();

  transport = new WebSocketTransport(relayUrl);
  session = new DAppSession({
    transport,
    meta: { name: 'WalletPair Extension', description: 'Browser extension for WalletPair', url: 'https://walletpair.org', icon: 'https://walletpair.org/icon.png' },
    requestTimeout: 60_000,
  });

  // Use SDK's EVM provider for method mapping
  evmProvider = new WalletPairProvider({ session, chainId: 1 });

  attachSessionListeners(false);
  await session.createPairing();
}

async function tryReconnect(): Promise<boolean> {
  const saved = await getSessionState();
  if (!saved) return false;

  // Check if session has expired (24-hour limit)
  const connectedAt = await getConnectedAt();
  if (connectedAt && Date.now() - connectedAt > SESSION_MAX_AGE_MS) {
    saveSessionState(null).catch((e) => console.warn('[WalletPair]', e));
    saveConnectedWallet(null).catch((e) => console.warn('[WalletPair]', e));
    saveConnectedAt(null).catch((e) => console.warn('[WalletPair]', e));
    return false;
  }

  try {
    const settings = await getSettings();
    transport = new WebSocketTransport(settings.relayUrl || DEFAULT_RELAY_URL);
    session = new DAppSession({
      transport,
      meta: { name: 'WalletPair Extension', description: 'Browser extension for WalletPair', url: 'https://walletpair.org', icon: 'https://walletpair.org/icon.png' },
      requestTimeout: 60_000,
    });

    evmProvider = new WalletPairProvider({ session, chainId: 1 });
    attachSessionListeners(true);

    const ok = session.restore(saved);
    if (!ok) return false;

    await session.reconnect();

    // Restore connected wallet from storage and broadcast to all tabs
    const savedWallet = await getConnectedWallet();
    if (savedWallet) {
      connectedWallet = savedWallet;
      updateState({ wallet: { ...connectedWallet } });
      broadcastEvent('accountsChanged', [connectedWallet.address]);
    }

    return true;
  } catch {
    return false;
  }
}

// ── Confirmation Popup ──────────────────────────────────────────────────

/** Confirmation popup timeout (5 minutes) */
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

function requestUserConfirmation(
  method: string,
  params: unknown,
  origin: string,
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  const confirmId = `confirm-${Array.from(buf, b => b.toString(16).padStart(2, '0')).join('')}`;

  return new Promise((resolve) => {
    // Fix #8: Timeout so popups don't hang forever if user ignores them
    const timeoutTimer = setTimeout(() => {
      const pending = pendingConfirmations.get(confirmId);
      if (pending) {
        pendingConfirmations.delete(confirmId);
        if (pending.windowId) {
          chrome.windows.remove(pending.windowId).catch(() => {});
        }
        resolve({ error: { code: 4001, message: 'Confirmation timed out' } });
      }
    }, CONFIRM_TIMEOUT_MS);

    pendingConfirmations.set(confirmId, { id: confirmId, method, params, origin, resolve, timeoutTimer });

    chrome.windows.create({
      url: chrome.runtime.getURL(`/confirm.html?id=${confirmId}`),
      type: 'popup',
      width: 400,
      height: 520,
      focused: true,
    }).then(
      (win: { id?: number }) => {
        const pending = pendingConfirmations.get(confirmId);
        // Fix #9: If confirmation was already resolved (e.g. by timeout), skip
        if (pending) pending.windowId = win?.id;
      },
      () => {
        // If popup fails to open, reject the request
        clearTimeout(timeoutTimer);
        pendingConfirmations.delete(confirmId);
        resolve({ error: { code: -32603, message: 'Failed to open confirmation popup' } });
      },
    );
  });
}

async function forwardToWallet(
  method: string,
  params: unknown[] | Record<string, unknown> | undefined,
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  try {
    const result = await evmProvider!.request({ method, params });
    return { result };
  } catch (err: any) {
    return { error: { code: err.code ?? -32603, message: err.message ?? 'Request failed' } };
  }
}

// ── Activity Logging ────────────────────────────────────────────────────

function classifyMethod(method: string): ActivityEntry['category'] {
  if (['eth_requestAccounts', 'wallet_requestPermissions'].includes(method)) return 'auth';
  if (['personal_sign', 'eth_signTypedData_v4', 'eth_signTypedData_v3'].includes(method)) return 'sign';
  if (['eth_sendTransaction', 'eth_signTransaction'].includes(method)) return 'tx';
  if (['eth_chainId', 'net_version', 'web3_clientVersion', 'eth_accounts', 'wallet_getPermissions', 'wallet_getCapabilities'].includes(method)) return 'local';
  return 'read';
}

// ── RPC Request Handling ─────────────────────────────────────────────────

async function handleRpcRequest(
  id: string,
  payload: EIP1193Request,
  origin?: string,
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  let { method, params } = payload;
  const permitted = origin ? await isPermitted(origin) : true;

  // Activity logging setup
  const category = classifyMethod(method);
  const activityId = `act-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const shouldLog = category !== 'local';

  if (shouldLog) {
    addActivityEntry({
      id: activityId,
      timestamp: Date.now(),
      origin: origin || 'unknown',
      method,
      category,
      status: 'pending',
      params,
    }).catch(() => {});
  }

  if (category === 'sign' || category === 'tx') {
    updateState({ signingInProgress: { method, origin: origin || 'unknown' } });
  }

  // Normalize v3 → v4 (v4 is a superset of v3)
  if (method === 'eth_signTypedData_v3') {
    method = 'eth_signTypedData_v4';
  }

  // ── Local methods (always answerable) ──────────────────────────────────
  if (method === 'eth_chainId') {
    const chainId = connectedWallet?.chainId ?? 1;
    return { result: `0x${chainId.toString(16)}` };
  }
  if (method === 'net_version') {
    return { result: String(connectedWallet?.chainId ?? 1) };
  }
  if (method === 'eth_accounts') {
    // Only return accounts if the origin is permitted
    if (!permitted) return { result: [] };
    return { result: connectedWallet ? [connectedWallet.address] : [] };
  }

  // ── wallet_getPermissions (local) ──────────────────────────────────────
  if (method === 'wallet_getPermissions') {
    if (permitted && connectedWallet && session?.phase === 'connected') {
      return { result: [{ parentCapability: 'eth_accounts' }] };
    }
    return { result: [] };
  }

  // ── wallet_getCapabilities (EIP-5792, local) ──────────────────────────
  if (method === 'wallet_getCapabilities') {
    return { result: {} };
  }

  // ── Read-only methods → proxy to public RPC ───────────────────────────
  if (READ_ONLY_METHODS.has(method)) {
    const chainId = connectedWallet?.chainId ?? 1;
    try {
      const result = await proxyRpcCall(chainId, method, params, walletRpcUrls);
      if (shouldLog) updateActivityStatus(activityId, 'success', { result }).catch(() => {});
      return { result };
    } catch (err: any) {
      const error = { code: err.code ?? -32603, message: err.message ?? 'RPC proxy error' };
      if (shouldLog) updateActivityStatus(activityId, 'error', { error }).catch(() => {});
      return { error };
    }
  }

  // ── Wallet methods: require connected session ─────────────────────────

  // wallet_requestPermissions acts like eth_requestAccounts
  const effectiveMethod = method === 'wallet_requestPermissions' ? 'eth_requestAccounts' : method;

  if (!session || session.phase !== 'connected') {
    if (effectiveMethod === 'eth_requestAccounts') {
      // If already permitted, skip the popup approval — just start pairing if needed
      if (!pairingInProgress && (!session || session.phase === 'idle' || session.phase === 'closed')) {
        pairingInProgress = true;
        await createSession();
        // Always open popup so user can see pairing QR / approve wallet
        openPopup();
      }
      // Defer until connected (with timeout); grant permission on resolve
      return new Promise((resolve) => {
        addDeferredRequest(id, payload, (response) => {
          // On successful connection, grant the origin permission
          if (origin && response.result && !response.error) {
            grantPermission(origin).catch((e) => console.warn('[WalletPair]', e));
          }
          if (shouldLog) {
            updateActivityStatus(activityId, response.error ? 'error' : 'success', response).catch(() => {});
          }
          resolve(response);
        }, origin);
      });
    }

    const notConnectedError = { code: 4100, message: 'Not connected. Call eth_requestAccounts first.' };
    if (shouldLog) updateActivityStatus(activityId, 'error', { error: notConnectedError }).catch(() => {});
    if (category === 'sign' || category === 'tx') updateState({ signingInProgress: undefined });
    return { error: notConnectedError };
  }

  // ── wallet_requestPermissions: trigger accounts request ───────────────
  if (method === 'wallet_requestPermissions') {
    try {
      await evmProvider!.request({ method: 'eth_requestAccounts', params: [] });
      const permResult = [{ parentCapability: 'eth_accounts' }];
      if (shouldLog) updateActivityStatus(activityId, 'success', { result: permResult }).catch(() => {});
      return { result: permResult };
    } catch (err: any) {
      const error = { code: err.code ?? -32603, message: err.message ?? 'Request failed' };
      if (shouldLog) updateActivityStatus(activityId, 'error', { error }).catch(() => {});
      return { error };
    }
  }

  // ── Forward wallet methods directly (no double confirmation) ────────────
  // Signing and transaction confirmation happens in the real wallet, not here.
  // The extension is a transparent bridge — it only forwards requests.
  if (!permitted && method !== 'eth_requestAccounts') {
    const notPermittedError = { code: 4100, message: 'Not permitted. Call eth_requestAccounts first.' };
    if (shouldLog) updateActivityStatus(activityId, 'error', { error: notPermittedError }).catch(() => {});
    if (category === 'sign' || category === 'tx') updateState({ signingInProgress: undefined });
    return { error: notPermittedError };
  }
  try {
    const result = await evmProvider!.request({ method, params });

    // Update local wallet state after account requests
    if (method === 'eth_requestAccounts') {
      const accounts = result as string[];
      if (accounts?.length > 0) {
        connectedWallet = {
          address: accounts[0]!,
          chainId: connectedWallet?.chainId ?? 1,
          name: session.walletMeta?.name,
          icon: session.walletMeta?.icon,
        };
        saveConnectedWallet(connectedWallet).catch((e) => console.warn('[WalletPair]', e));
        updateState({ wallet: { ...connectedWallet } });
        // Grant permission on successful eth_requestAccounts
        if (origin) grantPermission(origin).catch((e) => console.warn('[WalletPair]', e));
      }
    }

    if (shouldLog) updateActivityStatus(activityId, 'success', { result }).catch(() => {});
    if (category === 'sign' || category === 'tx') updateState({ signingInProgress: undefined });
    return { result };
  } catch (err: any) {
    const error = { code: err.code ?? -32603, message: err.message ?? 'Request failed' };
    if (shouldLog) {
      const status = err.code === 4001 ? 'rejected' : 'error';
      updateActivityStatus(activityId, status, { error }).catch(() => {});
    }
    if (category === 'sign' || category === 'tx') updateState({ signingInProgress: undefined });
    return { error };
  }
}

function flushDeferredRequests() {
  while (deferredRequests.length > 0) {
    const req = deferredRequests.shift()!;
    clearTimeout(req.timer);
    handleRpcRequest(req.id, req.payload, req.origin).then((response) => {
      req.resolve(response);
    });
  }
}

async function openPopup() {
  // Prefer side panel; fall back to popup window
  try {
    const win = await chrome.windows.getCurrent();
    if (win.id != null) {
      await (chrome.sidePanel as any).open({ windowId: win.id });
      return;
    }
  } catch { /* side panel not available */ }

  chrome.action.openPopup().catch(() => {
    chrome.windows.create({
      url: chrome.runtime.getURL('/popup.html'),
      type: 'popup',
      width: 380,
      height: 600,
      focused: true,
    }).catch((e: any) => console.warn('[WalletPair]', e));
  });
}

// ── Port & Message Handlers ──────────────────────────────────────────────

export default defineBackground(() => {
  // Default to side panel mode: clicking the extension icon opens side panel
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

  // Handle port connections from content scripts
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'walletpair-content') return;

    const tabId = port.sender?.tab?.id;
    if (tabId !== undefined) contentPorts.set(tabId, port);

    port.onMessage.addListener(async (msg) => {
      if (msg.action === 'rpc-request') {
        const response = await handleRpcRequest(msg.id, msg.payload, msg.origin);
        try {
          port.postMessage({
            action: 'rpc-response',
            id: msg.id,
            method: msg.payload.method,
            ...response,
          });
        } catch {}
      }
    });

    port.onDisconnect.addListener(() => {
      if (tabId !== undefined) contentPorts.delete(tabId);
    });
  });

  // Handle messages from popup and fallback from content scripts
  chrome.runtime.onMessage.addListener((msg: BackgroundMessage, sender, sendResponse) => {
    (async () => { try {
      switch (msg.action) {
        case 'get-state':
          sendResponse(state);
          break;

        case 'start-pairing':
          await createSession();
          sendResponse(state);
          break;

        case 'reject-wallet':
          session?.rejectWallet();
          rejectAllDeferred(4001, 'User rejected wallet');
          sendResponse({ ok: true });
          break;

        case 'accept-wallet':
          session?.acceptWallet();
          sendResponse({ ok: true });
          break;

        case 'disconnect':
          // Fix #7: Full cleanup on disconnect
          if (cleanupSessionListeners) {
            cleanupSessionListeners();
            cleanupSessionListeners = null;
          }
          resetReconnectBackoff();
          // Reject all pending confirmations
          for (const [cid, pc] of pendingConfirmations) {
            if (pc.timeoutTimer) clearTimeout(pc.timeoutTimer);
            pc.resolve({ error: { code: 4001, message: 'Disconnected' } });
            pendingConfirmations.delete(cid);
          }
          if (session) {
            session.close();
            session = null;
            evmProvider = null;
          }
          handleSessionClosed();
          sendResponse({ ok: true });
          break;

        case 'get-pairing-uri':
          sendResponse({ uri: state.pairingUri });
          break;

        case 'rpc-request': {
          const response = await handleRpcRequest(msg.id, msg.payload, msg.origin);
          sendResponse({
            action: 'rpc-response',
            id: msg.id,
            method: msg.payload.method,
            ...response,
          });
          break;
        }

        case 'get-permissions': {
          const perms = await getPermissions();
          sendResponse(perms);
          break;
        }

        case 'revoke-permission': {
          await revokePermission(msg.origin);
          sendResponse({ ok: true });
          break;
        }

        case 'get-confirmation': {
          const pending = pendingConfirmations.get(msg.id);
          if (pending) {
            sendResponse({ method: pending.method, params: pending.params, origin: pending.origin });
          } else {
            sendResponse(null);
          }
          break;
        }

        case 'approve-confirmation': {
          const pending = pendingConfirmations.get(msg.id);
          if (pending) {
            pendingConfirmations.delete(msg.id);
            if (pending.timeoutTimer) clearTimeout(pending.timeoutTimer);
            const response = await forwardToWallet(pending.method, pending.params as unknown[] | Record<string, unknown> | undefined);
            pending.resolve(response);
          }
          sendResponse({ ok: true });
          break;
        }

        case 'reject-confirmation': {
          const pending = pendingConfirmations.get(msg.id);
          if (pending) {
            pendingConfirmations.delete(msg.id);
            if (pending.timeoutTimer) clearTimeout(pending.timeoutTimer);
            pending.resolve({ error: { code: 4001, message: 'User rejected the request' } });
            if (pending.windowId) {
              chrome.windows.remove(pending.windowId).catch((e) => console.warn('[WalletPair]', e));
            }
          }
          sendResponse({ ok: true });
          break;
        }

        default:
          sendResponse({ error: 'Unknown action' });
      }
    } catch (err) {
      // Fix #6: Catch unhandled errors so sendResponse is always called
      console.error('[WalletPair] Unhandled error in message handler:', err);
      sendResponse({ error: { code: -32603, message: 'Internal error' } });
    } })();
    return true; // Keep channel open for async
  });

  // Handle confirmation popup closed without user action
  chrome.windows.onRemoved.addListener((windowId: number) => {
    for (const [id, pending] of pendingConfirmations) {
      if (pending.windowId === windowId) {
        pendingConfirmations.delete(id);
        if (pending.timeoutTimer) clearTimeout(pending.timeoutTimer);
        pending.resolve({ error: { code: 4001, message: 'User rejected the request' } });
      }
    }
  });

  // Handle keepalive alarm (fires even after SW restart)
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'walletpair-keepalive') {
      if (session?.phase === 'connected') {
        // Check 24-hour session expiry
        const connectedAt = await getConnectedAt();
        if (connectedAt && Date.now() - connectedAt > SESSION_MAX_AGE_MS) {
          session.close();
          session = null;
          evmProvider = null;
          handleSessionClosed();
          return;
        }
        session.ping();
      }
    }
  });

  // On SW start, try to restore session
  tryReconnect().then((ok) => {
    if (ok) {
      console.log('[WalletPair] Session restored after SW wake');
      // Alarm is already created in the 'connected' phase handler; no duplicate needed
    }
  });
});
