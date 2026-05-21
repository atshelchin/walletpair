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
  <!-- Header -->
  <header class="header">
    <div class="header-left">
      <div class="logo">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
          <rect width="24" height="24" rx="6" fill="#6366f1" />
          <path d="M7 12L12 7L17 12L12 17Z" fill="white" opacity="0.9" />
          <circle cx="12" cy="12" r="2.2" fill="#6366f1" />
        </svg>
      </div>
      <span class="header-title">WalletPair</span>
    </div>
    {#if page === 'main'}
      <button class="icon-btn" onclick={() => (page = 'settings')} title="Settings">
        <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor">
          <path d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z"/>
        </svg>
      </button>
    {/if}
  </header>

  <!-- Content -->
  <main class="content">
    {#if page === 'settings'}
      <SettingsView onBack={() => (page = 'main')} />
    {:else if state.phase === 'idle' || state.phase === 'error'}
      <div class="idle-view">
        <div class="hero-icon">
          <svg viewBox="0 0 64 64" width="80" height="80" fill="none">
            <rect width="64" height="64" rx="20" fill="var(--accent-dim)" />
            <path d="M18 32L32 18L46 32L32 46Z" fill="var(--accent)" opacity="0.6" />
            <circle cx="32" cy="32" r="8" fill="var(--accent)" />
            <circle cx="32" cy="32" r="3" fill="var(--bg)" />
          </svg>
        </div>
        <h2 class="title">Connect Your Wallet</h2>
        <p class="subtitle">
          Scan with any WalletPair-compatible wallet to bridge your wallet to dApps
        </p>
        {#if state.error}
          <div class="error-banner">{state.error}</div>
        {/if}
        <button class="btn-primary" onclick={startPairing} disabled={loading}>
          {#if loading}
            <span class="spinner"></span>
          {:else}
            Pair Wallet
          {/if}
        </button>
      </div>
    {:else if state.phase === 'pairing'}
      <QrPairing uri={state.pairingUri ?? ''} />
    {:else if state.phase === 'pending_accept'}
      <PendingAccept
        code={state.sessionFingerprint ?? ''}
        walletName={state.walletMeta?.name}
        onAccept={acceptWallet}
        onReject={rejectWallet}
      />
    {:else if state.phase === 'connected'}
      <ConnectedView wallet={state.wallet} onDisconnect={disconnect} />
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
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .logo {
    display: flex;
  }

  .header-title {
    font-weight: 600;
    font-size: 15px;
    letter-spacing: -0.01em;
  }

  .icon-btn {
    background: none;
    color: var(--text-dim);
    padding: 6px;
    border-radius: 6px;
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
    gap: 16px;
    text-align: center;
  }

  .hero-icon {
    margin-bottom: 8px;
  }

  .title {
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }

  .subtitle {
    font-size: 13px;
    color: var(--text-dim);
    max-width: 260px;
    line-height: 1.5;
  }

  .error-banner {
    background: var(--red-dim);
    color: var(--red);
    font-size: 12px;
    padding: 8px 14px;
    border-radius: var(--radius-sm);
    width: 100%;
  }

  .btn-primary {
    background: var(--accent);
    color: white;
    font-size: 14px;
    font-weight: 500;
    padding: 12px 32px;
    border-radius: var(--radius);
    width: 100%;
    max-width: 280px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin-top: 8px;
  }
  .btn-primary:hover:not(:disabled) {
    background: var(--accent-hover);
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
    padding: 6px 12px;
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
</style>
