/**
 * ISOLATED world content script - bridges between:
 *   - MAIN world provider (window.postMessage)
 *   - Background service worker (chrome.runtime)
 *
 * Handles port lifecycle, reconnection, and state queries.
 */
import { MSG_CHANNEL } from '@/lib/constants';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',

  main() {
    const origin = window.location.origin;

    // Port connection with auto-reconnect
    let port: chrome.runtime.Port | null = null;
    let portDead = false; // true if extension context invalidated (e.g., extension updated)
    let portConnecting = false; // Fix #2: guard against concurrent port creation

    function getPort(): chrome.runtime.Port | null {
      if (portDead) return null;
      if (port) return port;
      if (portConnecting) return null; // another call is already creating a port

      try {
        portConnecting = true;
        port = chrome.runtime.connect({ name: 'walletpair-content' });
        port.onMessage.addListener(handleBackgroundMessage);
        port.onDisconnect.addListener(() => {
          port = null;
          portConnecting = false;
          // Check if extension context was invalidated
          if (chrome.runtime.lastError?.message?.includes('Extension context invalidated')) {
            portDead = true;
          }
        });
        return port;
      } catch {
        portDead = true;
        portConnecting = false;
        return null;
      }
    }

    // Send message to background, with port → sendMessage fallback
    function sendToBackground(msg: Record<string, unknown>): void {
      const p = getPort();
      if (p) {
        try {
          p.postMessage(msg);
          return; // Fix #4: only return on success, don't fall through
        } catch {
          port = null;
          portConnecting = false;
          // Fall through to sendMessage fallback — message was NOT sent via port
        }
      }

      // Fallback to one-shot sendMessage
      if (!portDead) {
        chrome.runtime.sendMessage(msg).then((response) => {
          if (response) handleBackgroundMessage(response);
        }).catch(() => {
          // Extension truly unavailable
          if (msg.action === 'rpc-request') {
            sendErrorToPage(msg.id as string, -32603, 'Extension not available');
          }
        });
      } else if (msg.action === 'rpc-request') {
        sendErrorToPage(msg.id as string, -32603, 'Extension was updated. Please refresh the page.');
      }
    }

    function sendErrorToPage(id: string, code: number, message: string) {
      window.postMessage({
        type: 'wp-response',
        id,
        error: { code, message },
        channel: MSG_CHANNEL,
      }, '*');
    }

    // Forward RPC requests from page -> background
    window.addEventListener('message', (event) => {
      if (event.source !== window || event.data?.channel !== MSG_CHANNEL) return;

      const msg = event.data;

      if (msg.type === 'wp-request') {
        sendToBackground({
          action: 'rpc-request',
          id: msg.id,
          payload: msg.payload,
          origin,
        });
      }

      // Provider asking for current state (on initialization)
      if (msg.type === 'wp-get-state') {
        sendToBackground({ action: 'get-state' });
      }

      // Provider signals it's ready — respond with current state
      if (msg.type === 'wp-provider-ready') {
        sendToBackground({ action: 'get-state' });
      }
    });

    // Forward responses and events from background -> page
    function handleBackgroundMessage(msg: any) {
      if (msg.action === 'rpc-response') {
        window.postMessage({
          type: 'wp-response',
          id: msg.id,
          result: msg.result,
          error: msg.error,
          method: msg.method,
          channel: MSG_CHANNEL,
        }, '*');
      }

      if (msg.action === 'emit-event') {
        window.postMessage({
          type: 'wp-event',
          event: msg.event,
          data: msg.data,
          channel: MSG_CHANNEL,
        }, '*');
      }

      // State response for provider initialization
      if (msg.action === 'state-update' || msg.action === 'get-state') {
        const state = msg.state ?? msg;
        const isConnected = state.phase === 'connected' && state.wallet;
        const hexChainId = isConnected
          ? `0x${(state.wallet.chainId ?? 1).toString(16)}`
          : '0x1';

        // Send wp-init-state so the MAIN world provider can hydrate in one shot
        window.postMessage({
          type: 'wp-init-state',
          connected: !!isConnected,
          accounts: isConnected ? [state.wallet.address] : [],
          chainId: hexChainId,
          channel: MSG_CHANNEL,
        }, '*');

        // Also emit standard events so already-registered listeners are notified
        if (isConnected) {
          window.postMessage({
            type: 'wp-event',
            event: 'connect',
            data: { chainId: hexChainId },
            channel: MSG_CHANNEL,
          }, '*');
          window.postMessage({
            type: 'wp-event',
            event: 'accountsChanged',
            data: [state.wallet.address],
            channel: MSG_CHANNEL,
          }, '*');
        }
      }
    }

    // Listen for broadcast messages from background (for events that go to all tabs)
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.action === 'emit-event' || msg.action === 'state-update') {
        handleBackgroundMessage(msg);
      }
    });
  },
});
