<script lang="ts">
  import { getExtensionState, onStateUpdate, sendToBackground } from '@/lib/messaging';
  import type { ExtensionState } from '@/lib/types';
  import QrPairing from '@/components/QrPairing.svelte';
  import ConnectedView from '@/components/ConnectedView.svelte';
  import PendingAccept from '@/components/PendingAccept.svelte';
  import SettingsView from '@/components/SettingsView.svelte';

  let state = $state<ExtensionState>({ phase: 'idle' });
  let loading = $state(false);
  let page = $state<'main' | 'settings'>('main');

  // Fetch initial state
  $effect(() => {
    getExtensionState().then((s) => {
      state = s;
    });
    const unsub = onStateUpdate((s) => {
      state = s;
      loading = false;
    });
    return unsub;
  });

  async function startPairing() {
    loading = true;
    const s = await sendToBackground<ExtensionState>({ action: 'start-pairing' });
    state = s;
    loading = false;
  }

  async function disconnect() {
    await sendToBackground({ action: 'disconnect' });
    state = { phase: 'idle' };
  }

  async function acceptWallet() {
    await sendToBackground({ action: 'accept-wallet' });
  }

  async function rejectWallet() {
    await sendToBackground({ action: 'reject-wallet' });
  }
</script>

<div class="popup">
  <header class="header">
    <div class="header-left">
      <div class="logo">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
          <rect width="24" height="24" rx="7" fill="#6366f1" />
          <path d="M7 12L12 7L17 12L12 17Z" fill="white" opacity="0.9" />
          <circle cx="12" cy="12" r="2" fill="#6366f1" />
        </svg>
      </div>
      <span class="header-title">WalletPair</span>
    </div>
    {#if page === 'main'}
      <button class="icon-btn" onclick={() => (page = 'settings')} title="Settings">
        <svg viewBox="0 0 20 20" width="18" height="18" fill="currentColor">
          <path d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z"/>
        </svg>
      </button>
    {/if}
  </header>

  <main class="content">
    {#if page === 'settings'}
      <SettingsView onBack={() => (page = 'main')} />
    {:else if state.phase === 'idle' || state.phase === 'error'}
      <div class="idle-view animate-in">
        <!-- Decorative glow -->
        <div class="hero-glow"></div>
        <div class="hero-icon">
          <svg viewBox="0 0 80 80" width="72" height="72" fill="none">
            <!-- Shield outline -->
            <path d="M40 6L14 20v20c0 16.6 11.1 32.1 26 36 14.9-3.9 26-19.4 26-36V20L40 6z"
                  fill="var(--accent)" opacity="0.1" stroke="var(--accent)" stroke-width="1.5"/>
            <!-- Inner shield -->
            <path d="M40 12L18 24v16c0 13.3 9.4 25.7 22 28.8 12.6-3.1 22-15.5 22-28.8V24L40 12z"
                  fill="var(--accent)" opacity="0.08"/>
            <!-- Chain link icon inside -->
            <path d="M33 36a5 5 0 010-7.07l3.54-3.54a5 5 0 017.07 0l.7.71" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" fill="none"/>
            <path d="M47 44a5 5 0 010 7.07l-3.54 3.54a5 5 0 01-7.07 0l-.7-.71" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" fill="none"/>
            <path d="M44 36L36 44" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </div>
        <div class="hero-text">
          <h2 class="title">Connect Your Wallet</h2>
          <p class="subtitle">
            Scan with any WalletPair-compatible wallet to bridge your wallet to dApps
          </p>
          <div class="trust-row">
            <span class="trust-badge">
              <svg viewBox="0 0 12 12" width="12" height="12" fill="var(--green)"><path d="M6 1a5 5 0 100 10A5 5 0 006 1zm-.5 7.5l-2-2 .7-.7L5.5 7.1l3.3-3.3.7.7-4 4z"/></svg>
              End-to-end encrypted
            </span>
            <span class="trust-badge">
              <svg viewBox="0 0 12 12" width="12" height="12" fill="var(--text-dim)"><path d="M6 0C2.7 0 0 2.7 0 6s2.7 6 6 6 6-2.7 6-6S9.3 0 6 0zM9 6.8H6.8V9H5.2V6.8H3V5.2h2.2V3h1.6v2.2H9v1.6z"/></svg>
              Open source
            </span>
          </div>
        </div>
        {#if state.error}
          <div class="error-banner">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
              <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.75 3.75a.75.75 0 011.5 0v3.5a.75.75 0 01-1.5 0v-3.5zM8 11a1 1 0 100-2 1 1 0 000 2z"/>
            </svg>
            <span>{state.error}</span>
          </div>
        {/if}
        <button class="btn-primary" onclick={startPairing} disabled={loading}>
          {#if loading}
            <span class="spinner"></span>
          {:else}
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M6.5 3.5L3.5 6.5a4.2 4.2 0 000 6l0 0a4.2 4.2 0 006 0L12.5 9.5"/>
              <path d="M9.5 12.5l3-3a4.2 4.2 0 000-6l0 0a4.2 4.2 0 00-6 0L3.5 6.5"/>
            </svg>
            Pair Wallet
          {/if}
        </button>
      </div>
    {:else if state.phase === 'pairing'}
      <div class="animate-slide">
        <QrPairing uri={state.pairingUri ?? ''} fingerprint={state.sessionFingerprint} />
      </div>
    {:else if state.phase === 'pending_accept'}
      <PendingAccept
        code={state.sessionFingerprint ?? ''}
        walletName={state.walletMeta?.name}
        onAccept={acceptWallet}
        onReject={rejectWallet}
      />
    {:else if state.phase === 'connected'}
      <div class="animate-scale">
        <ConnectedView wallet={state.wallet} onDisconnect={disconnect} />
      </div>
    {:else if state.phase === 'disconnected'}
      <div class="disconnected-view">
        <div class="status-badge orange">
          <span class="status-dot orange"></span>
          Reconnecting...
        </div>
        <p class="subtitle">Connection lost. Attempting to reconnect...</p>
        <button class="btn-secondary" onclick={disconnect}>Cancel</button>
      </div>
    {/if}
  </main>
</div>

<style>
  .popup {
    display: flex;
    flex-direction: column;
    min-height: 480px;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    background: linear-gradient(180deg, rgba(99, 102, 241, 0.03) 0%, transparent 100%);
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .logo {
    display: flex;
    filter: drop-shadow(0 0 6px rgba(99, 102, 241, 0.3));
  }

  .header-title {
    font-weight: 700;
    font-size: 15px;
    letter-spacing: -0.02em;
  }

  .icon-btn {
    background: none;
    color: var(--text-dim);
    padding: 8px;
    border-radius: 8px;
    display: flex;
    align-items: center;
  }
  .icon-btn:hover {
    background: var(--bg-hover);
    color: var(--text);
  }

  .content {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: 24px 20px;
  }

  .idle-view,
  .disconnected-view {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    text-align: center;
    position: relative;
  }

  .hero-glow {
    position: absolute;
    top: 20%;
    left: 50%;
    transform: translateX(-50%);
    width: 200px;
    height: 200px;
    background: radial-gradient(circle, rgba(99, 102, 241, 0.08) 0%, transparent 70%);
    pointer-events: none;
  }

  .hero-icon {
    margin-bottom: 4px;
    position: relative;
    z-index: 1;
  }

  .hero-text {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    position: relative;
    z-index: 1;
  }

  .title {
    font-size: 19px;
    font-weight: 700;
    letter-spacing: -0.03em;
  }

  .subtitle {
    font-size: 13.5px;
    color: var(--text-dim);
    max-width: 280px;
    line-height: 1.55;
  }

  .error-banner {
    background: var(--red-dim);
    color: var(--red);
    font-size: 12px;
    padding: 10px 14px;
    border-radius: var(--radius-sm);
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    border: 1px solid rgba(239, 68, 68, 0.15);
  }

  .btn-primary {
    background: var(--accent);
    color: white;
    font-size: 14px;
    font-weight: 600;
    padding: 13px 32px;
    border-radius: var(--radius);
    width: 100%;
    max-width: 280px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin-top: 12px;
    position: relative;
    z-index: 1;
    box-shadow: 0 2px 12px rgba(99, 102, 241, 0.25);
  }
  .btn-primary:hover:not(:disabled) {
    background: var(--accent-hover);
    box-shadow: 0 4px 20px rgba(99, 102, 241, 0.35);
    transform: translateY(-1px);
  }
  .btn-primary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .btn-secondary {
    background: var(--bg-card);
    color: var(--text);
    font-size: 13px;
    font-weight: 500;
    padding: 10px 24px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }
  .btn-secondary:hover {
    background: var(--bg-hover);
  }

  .status-badge {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 500;
    padding: 6px 14px;
    border-radius: 100px;
  }
  .status-badge.orange {
    background: var(--orange-dim);
    color: var(--orange);
  }

  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }
  .status-dot.orange {
    background: var(--orange);
    animation: pulse 1.5s ease-in-out infinite;
  }

  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .trust-row {
    display: flex;
    gap: 12px;
    margin-top: 4px;
  }
  .trust-badge {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--text-dimmer);
  }
</style>
