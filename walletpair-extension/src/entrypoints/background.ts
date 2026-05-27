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
} from '@/lib/storage';
import { READ_ONLY_METHODS, proxyRpcCall } from '@/lib/rpc-proxy';
import type { ExtensionState, ConnectedWallet, BackgroundMessage, EIP1193Request, PendingConfirmationInfo } from '@/lib/types';

// ── Constants ───────────────────────────────────────────────────────────

/** Deferred request timeout (5 minutes) */
const DEFERRED_TIMEOUT_MS = 5 * 60 * 1000;

// ── State ────────────────────────────────────────────────────────────────

let session: DAppSession | null = null;
let evmProvider: WalletPairProvider | null = null;
let transport: WebSocketTransport | null = null;
let state: ExtensionState = { phase: 'idle' };
let connectedWallet: ConnectedWallet | null = null;
let pairingInProgress = false;

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
}
const pendingConfirmations = new Map<string, PendingConfirmation>();

/** Methods that require user confirmation before forwarding to wallet */
const CONFIRMATION_METHODS = new Set([
  'eth_sendTransaction',
  'eth_signTransaction',
  'personal_sign',
  'eth_signTypedData_v4',
  'eth_signTypedData_v3',
]);

// Map of connected content script ports
const contentPorts = new Map<number, chrome.runtime.Port>();

// ── State Management ─────────────────────────────────────────────────────

function updateState(patch: Partial<ExtensionState>) {
  state = { ...state, ...patch };
  // Broadcast to popup/options via runtime message
  chrome.runtime.sendMessage({ action: 'state-update', state }).catch(() => {});
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

function attachSessionListeners(autoAccepted: boolean) {
  if (!session) return;

  session.on('phase', (phase) => {
    switch (phase) {
      case 'waiting':
        updateState({ phase: 'pairing', pairingUri: session!.pairingUri });
        break;
      case 'pending_accept':
        updateState({ phase: 'pending_accept' });
        break;
      case 'connected':
        updateState({ phase: 'connected' });
        pairingInProgress = false;
        saveSessionState(session!.serialize()).catch(() => {});
        // Start keepalive alarm (survives SW termination)
        chrome.alarms.create('walletpair-keepalive', { periodInMinutes: 0.33 });
        flushDeferredRequests();
        break;
      case 'disconnected':
        updateState({ phase: 'disconnected' });
        break;
      case 'closed':
        handleSessionClosed();
        break;
    }
  });

  session.on('sessionFingerprint', (code) => {
    updateState({ sessionFingerprint: code as string });
  });

  session.on('walletJoined', ({ meta }) => {
    updateState({ walletMeta: meta ? { name: meta.name, icon: meta.icon } : undefined });
  });

  // Use the SDK provider's event handling to keep state in sync
  if (evmProvider) {
    evmProvider.on('accountsChanged', (accounts: string[]) => {
      if (accounts.length > 0) {
        connectedWallet = {
          address: accounts[0]!,
          chainId: connectedWallet?.chainId ?? 1,
          name: session?.walletMeta?.name,
        };
        saveConnectedWallet(connectedWallet).catch(() => {});
        updateState({ wallet: { ...connectedWallet } });
      }
      broadcastEvent('accountsChanged', accounts);
    });

    evmProvider.on('chainChanged', (hexChainId: string) => {
      const numericChainId = parseInt(hexChainId, 16);
      if (connectedWallet) {
        connectedWallet.chainId = numericChainId;
        saveConnectedWallet(connectedWallet).catch(() => {});
        updateState({ wallet: { ...connectedWallet } });
      }
      broadcastEvent('chainChanged', hexChainId);
    });

    evmProvider.on('disconnect', () => {
      broadcastEvent('disconnect', undefined);
    });

    evmProvider.on('connect', (info: { chainId: string }) => {
      broadcastEvent('connect', info);
    });
  }
}

function handleSessionClosed() {
  pairingInProgress = false;
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
  saveSessionState(null).catch(() => {});
  saveConnectedWallet(null).catch(() => {});
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
    requestTimeout: 300_000,
  });

  // Use SDK's EVM provider for method mapping
  evmProvider = new WalletPairProvider({ session, chainId: 1 });

  attachSessionListeners(false);
  await session.createPairing();
}

async function tryReconnect(): Promise<boolean> {
  const saved = await getSessionState();
  if (!saved) return false;

  try {
    const settings = await getSettings();
    transport = new WebSocketTransport(settings.relayUrl || DEFAULT_RELAY_URL);
    session = new DAppSession({
      transport,
      meta: { name: 'WalletPair Extension', description: 'Browser extension for WalletPair', url: 'https://walletpair.org', icon: 'https://walletpair.org/icon.png' },
      requestTimeout: 300_000,
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

function requestUserConfirmation(
  method: string,
  params: unknown,
  origin: string,
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  const confirmId = `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return new Promise((resolve) => {
    pendingConfirmations.set(confirmId, { id: confirmId, method, params, origin, resolve });

    chrome.windows.create({
      url: chrome.runtime.getURL(`/confirm.html?id=${confirmId}`),
      type: 'popup',
      width: 400,
      height: 520,
      focused: true,
    }).then(
      (win: { id?: number }) => {
        const pending = pendingConfirmations.get(confirmId);
        if (pending) pending.windowId = win?.id;
      },
      () => {
        // If popup fails to open, reject the request
        pendingConfirmations.delete(confirmId);
        resolve({ error: { code: -32603, message: 'Failed to open confirmation popup' } });
      },
    );
  });
}

async function forwardToWallet(
  method: string,
  params: unknown,
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  try {
    const result = await evmProvider!.request({ method, params });
    return { result };
  } catch (err: any) {
    return { error: { code: err.code ?? -32603, message: err.message ?? 'Request failed' } };
  }
}

// ── RPC Request Handling ─────────────────────────────────────────────────

async function handleRpcRequest(
  id: string,
  payload: EIP1193Request,
  origin?: string,
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  const { method, params } = payload;
  const permitted = origin ? await isPermitted(origin) : true;

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

  // ── Read-only methods → proxy to public RPC ───────────────────────────
  if (READ_ONLY_METHODS.has(method)) {
    const chainId = connectedWallet?.chainId ?? 1;
    try {
      const result = await proxyRpcCall(chainId, method, params);
      return { result };
    } catch (err: any) {
      return { error: { code: err.code ?? -32603, message: err.message ?? 'RPC proxy error' } };
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
            grantPermission(origin).catch(() => {});
          }
          resolve(response);
        }, origin);
      });
    }

    return { error: { code: 4100, message: 'Not connected. Call eth_requestAccounts first.' } };
  }

  // ── wallet_watchAsset: forward to wallet, silent success on failure ───
  if (method === 'wallet_watchAsset') {
    try {
      const result = await evmProvider!.request({ method, params });
      return { result };
    } catch {
      // Wallet doesn't support it — silent success
      return { result: true };
    }
  }

  // ── wallet_requestPermissions: trigger accounts request ───────────────
  if (method === 'wallet_requestPermissions') {
    try {
      await evmProvider!.request({ method: 'eth_requestAccounts', params: [] });
      return { result: [{ parentCapability: 'eth_accounts' }] };
    } catch (err: any) {
      return { error: { code: err.code ?? -32603, message: err.message ?? 'Request failed' } };
    }
  }

  // ── Methods requiring user confirmation popup ─────────────────────────
  if (CONFIRMATION_METHODS.has(method) && origin) {
    return requestUserConfirmation(method, params, origin);
  }

  // ── Forward all other wallet methods via SDK provider ──────────────────
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
        };
        saveConnectedWallet(connectedWallet).catch(() => {});
        updateState({ wallet: { ...connectedWallet } });
        // Grant permission on successful eth_requestAccounts
        if (origin) grantPermission(origin).catch(() => {});
      }
    }

    return { result };
  } catch (err: any) {
    return {
      error: { code: err.code ?? -32603, message: err.message ?? 'Request failed' },
    };
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

function openPopup() {
  chrome.action.openPopup().catch(() => {
    chrome.windows.create({
      url: chrome.runtime.getURL('/popup.html'),
      type: 'popup',
      width: 380,
      height: 600,
      focused: true,
    }).catch(() => {});
  });
}

// ── Port & Message Handlers ──────────────────────────────────────────────

export default defineBackground(() => {
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
    (async () => {
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
            const response = await forwardToWallet(pending.method, pending.params);
            pending.resolve(response);
          }
          sendResponse({ ok: true });
          break;
        }

        case 'reject-confirmation': {
          const pending = pendingConfirmations.get(msg.id);
          if (pending) {
            pendingConfirmations.delete(msg.id);
            pending.resolve({ error: { code: 4001, message: 'User rejected the request' } });
            if (pending.windowId) {
              chrome.windows.remove(pending.windowId).catch(() => {});
            }
          }
          sendResponse({ ok: true });
          break;
        }

        default:
          sendResponse({ error: 'Unknown action' });
      }
    })();
    return true; // Keep channel open for async
  });

  // Handle confirmation popup closed without user action
  chrome.windows.onRemoved.addListener((windowId: number) => {
    for (const [id, pending] of pendingConfirmations) {
      if (pending.windowId === windowId) {
        pendingConfirmations.delete(id);
        pending.resolve({ error: { code: 4001, message: 'User rejected the request' } });
      }
    }
  });

  // Handle keepalive alarm (fires even after SW restart)
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'walletpair-keepalive') {
      if (session?.phase === 'connected') {
        session.ping();
      }
    }
  });

  // On SW start, try to restore session
  tryReconnect().then((ok) => {
    if (ok) {
      console.log('[WalletPair] Session restored after SW wake');
      chrome.alarms.create('walletpair-keepalive', { periodInMinutes: 0.33 });
    }
  });
});
