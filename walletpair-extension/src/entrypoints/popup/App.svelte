<script lang="ts">
  import { getExtensionState, onStateUpdate, sendToBackground } from '@/lib/messaging';
  import type { ExtensionState } from '@/lib/types';
  import QrPairing from '@/components/QrPairing.svelte';
  import ConnectedView from '@/components/ConnectedView.svelte';
  import PendingAccept from '@/components/PendingAccept.svelte';
  import SettingsView from '@/components/SettingsView.svelte';
  import { Settings, Link, Info } from 'lucide-svelte';

  let state = $state<ExtensionState>({ phase: 'idle' });
  let loading = $state(false);
  let page = $state<'main' | 'settings'>('main');

  // Fetch initial state
  $effect(() => {
    getExtensionState().then((s) => {
      state = s;
    });
    const unsub = onStateUpdate((s) => {
      // Don't interrupt loading transition — startPairing handles its own state
      if (!loading) {
        state = s;
      }
    });
    return unsub;
  });

  async function startPairing() {
    loading = true;
    const [s] = await Promise.all([
      sendToBackground<ExtensionState>({ action: 'start-pairing' }),
      new Promise((r) => setTimeout(r, 800)), // smooth transition before showing QR
    ]);
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
      <img src="/icon/48.png" alt="WalletPair" class="logo-img" />
      <span class="header-title">WalletPair</span>
    </div>
    {#if page === 'main'}
      <button class="icon-btn" onclick={() => (page = 'settings')} title="Settings">
        <Settings size={18} strokeWidth={1.5} />
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
      
        <div class="hero-text">
          <h2 class="title">Connect Your Wallet</h2>
          <p class="subtitle">
            Pair with your mobile wallet to use dApps on this browser
          </p>
        </div>
        {#if state.error}
          <div class="error-banner">
            <Info size={14} strokeWidth={2} />
            <span>{state.error}</span>
          </div>
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
      <div class="animate-slide">
        <QrPairing uri={state.pairingUri ?? ''} fingerprint={state.sessionFingerprint} onCancel={disconnect} />
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
        <ConnectedView wallet={state.wallet} onDisconnect={disconnect} signingInProgress={state.signingInProgress} />
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
    background: linear-gradient(180deg, rgba(37, 99, 235, 0.03) 0%, transparent 100%);
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .logo-img {
    width: 22px;
    height: 22px;
    border-radius: 5px;
    filter: drop-shadow(0 0 6px rgba(37, 99, 235, 0.3));
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
    background: radial-gradient(circle, rgba(37, 99, 235, 0.08) 0%, transparent 70%);
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
    box-shadow: 0 2px 12px rgba(37, 99, 235, 0.25);
  }
  .btn-primary:hover:not(:disabled) {
    background: var(--accent-hover);
    box-shadow: 0 4px 20px rgba(37, 99, 235, 0.35);
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

</style>
