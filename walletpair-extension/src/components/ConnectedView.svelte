<script lang="ts">
  import type { ConnectedWallet } from '@/lib/types';

  let {
    wallet,
    onDisconnect,
  }: {
    wallet?: ConnectedWallet | null;
    onDisconnect: () => void;
  } = $props();

  let address = $derived(wallet?.address ?? '');
  let shortAddress = $derived(
    address ? `${address.slice(0, 6)}...${address.slice(-4)}` : 'Unknown',
  );
  let chainName = $derived(getChainName(wallet?.chainId ?? 1));
  let copied = $state(false);

  function getChainName(id: number): string {
    const chains: Record<number, string> = {
      1: 'Ethereum',
      10: 'Optimism',
      56: 'BNB Chain',
      100: 'Gnosis',
      137: 'Polygon',
      42161: 'Arbitrum',
      8453: 'Base',
      43114: 'Avalanche',
      250: 'Fantom',
    };
    return chains[id] ?? `Chain ${id}`;
  }

  function copyAddress() {
    if (!address) return;
    navigator.clipboard.writeText(address);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }
</script>

<div class="connected">
  <div class="status-badge green">
    <span class="status-dot green"></span>
    Connected
  </div>

  <div class="wallet-card">
    <div class="wallet-avatar">
      {#if wallet?.icon}
        <img src={wallet.icon} alt="" class="wallet-icon" />
      {:else}
        <div class="avatar-fallback">
          {address ? address.slice(2, 4).toUpperCase() : 'WP'}
        </div>
      {/if}
    </div>

    <div class="wallet-info">
      <span class="wallet-name">{wallet?.name || 'Wallet'}</span>
      <button class="address-btn" onclick={copyAddress} title="Copy address">
        <span class="address">{shortAddress}</span>
        {#if copied}
          <svg viewBox="0 0 16 16" width="12" height="12" fill="var(--green)">
            <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
          </svg>
        {:else}
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" opacity="0.5">
            <path d="M4 4v-2a1 1 0 011-1h7a1 1 0 011 1v8a1 1 0 01-1 1h-2v2a1 1 0 01-1 1H3a1 1 0 01-1-1V5a1 1 0 011-1h1zm1 0h4a1 1 0 011 1v5h1V2H5v2z" />
          </svg>
        {/if}
      </button>
    </div>

    <div class="chain-badge">{chainName}</div>
  </div>

  <div class="trust-footer">
    <svg viewBox="0 0 12 12" width="11" height="11" fill="var(--text-dimmer)">
      <path d="M6 1L2 3.5v3C2 9.8 3.8 12.6 6 13.5c2.2-.9 4-3.7 4-7V3.5L6 1z"/>
    </svg>
    <span>Secured by WalletPair — end-to-end encrypted</span>
  </div>

  <div class="actions">
    <button class="btn-disconnect" onclick={onDisconnect}>Disconnect</button>
  </div>
</div>

<style>
  .connected {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 20px;
    padding-top: 16px;
    animation: fadeInScale 0.3s ease-out;
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
  .status-badge.green {
    background: var(--green-dim);
    color: var(--green);
    box-shadow: 0 0 12px rgba(34, 197, 94, 0.2);
  }

  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }
  .status-dot.green {
    background: var(--green);
  }

  .wallet-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 24px 20px;
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.15);
  }

  .wallet-avatar {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    overflow: hidden;
  }

  .wallet-icon {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .avatar-fallback {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--accent-dim);
    color: var(--accent);
    font-weight: 700;
    font-size: 16px;
    font-family: 'SF Mono', 'Fira Code', monospace;
  }

  .wallet-info {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }

  .wallet-name {
    font-size: 14px;
    font-weight: 600;
  }

  .address-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    background: none;
    padding: 2px 0;
  }

  .address {
    font-size: 13px;
    color: var(--text-dim);
    font-family: 'SF Mono', 'Fira Code', monospace;
  }

  .chain-badge {
    font-size: 11px;
    font-weight: 500;
    color: var(--accent-hover);
    background: var(--accent-dim);
    padding: 4px 10px;
    border-radius: 100px;
  }

  .actions {
    width: 100%;
    margin-top: auto;
    padding-top: 16px;
  }

  .btn-disconnect {
    width: 100%;
    background: var(--bg-card);
    color: var(--text-dim);
    font-size: 13px;
    font-weight: 500;
    padding: 10px 24px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }
  .btn-disconnect:hover {
    color: var(--red);
    border-color: var(--red);
    background: var(--red-dim);
  }

  .trust-footer {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    font-size: 10px;
    color: var(--text-dimmer);
    padding-top: 12px;
  }

  @keyframes fadeInScale {
    from { opacity: 0; transform: scale(0.95); }
    to { opacity: 1; transform: scale(1); }
  }
</style>
