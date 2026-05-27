/**
 * MAIN world content script - injects EIP-1193 provider + EIP-6963 into the page.
 * Also injects as window.ethereum for legacy dApps.
 *
 * This runs in the page's JS context, NOT the extension's isolated world.
 * Communication with extension is via window.postMessage only.
 */
import { createProvider, PROVIDER_INFO } from '../lib/provider-factory.js';

export default defineContentScript({
  matches: ['<all_urls>'],
  world: 'MAIN',
  runAt: 'document_start',

  main() {
    const MSG_CHANNEL = 'walletpair-ext';

    const { provider, handleMessage } = createProvider(
      (message, targetOrigin) => window.postMessage(message, targetOrigin),
    );

    // --- Listen for responses and events from content script bridge ---
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      handleMessage(event.data);
    });

    // --- EIP-6963: Announce provider ---
    const detail = Object.freeze({ info: PROVIDER_INFO, provider });

    function announceProvider() {
      window.dispatchEvent(
        new CustomEvent('eip6963:announceProvider', { detail }),
      );
    }

    window.addEventListener('eip6963:requestProvider', announceProvider);
    announceProvider();

    // --- window.ethereum injection (legacy support) ---
    const existingProvider = (window as any).ethereum;

    if (!existingProvider) {
      Object.defineProperty(window, 'ethereum', {
        value: provider,
        writable: false,
        configurable: true,
      });
    } else {
      if (!existingProvider.providers) {
        (existingProvider as any).providers = [existingProvider];
      }
      (existingProvider as any).providers.push(provider);
    }

    // Always set window.walletpair for direct access
    Object.defineProperty(window, 'walletpair', {
      value: provider,
      writable: false,
      configurable: false,
    });

    // Notify content script bridge that provider is ready
    window.postMessage({ type: 'wp-provider-ready', channel: MSG_CHANNEL }, '*');
  },
});
