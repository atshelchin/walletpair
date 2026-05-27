<script lang="ts">
  let {
    code,
    walletName,
    onAccept,
    onReject,
  }: {
    code: string;
    walletName?: string;
    onAccept: () => void;
    onReject: () => void;
  } = $props();

  // Split code into pairs for display
  let codePairs = $derived(
    code ? [code.slice(0, 2), code.slice(2, 4)] : [],
  );
</script>

<div class="pending">
  <div class="status-badge green">
    <span class="status-dot green"></span>
    Wallet Found
  </div>

  {#if walletName}
    <p class="wallet-name">{walletName}</p>
  {/if}

  <p class="label">Verify this code matches your wallet</p>

  <div class="code-display">
    {#each codePairs as pair}
      <span class="code-pair">{pair}</span>
    {/each}
  </div>

  <div class="actions">
    <button class="btn-accept" onclick={onAccept}>Confirm & Connect</button>
    <button class="btn-reject" onclick={onReject}>Reject</button>
  </div>
</div>

<style>
  .pending {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    text-align: center;
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
  }

  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }
  .status-dot.green {
    background: var(--green);
    animation: pulse 1.5s ease-in-out infinite;
  }

  .wallet-name {
    font-size: 16px;
    font-weight: 600;
  }

  .label {
    font-size: 13px;
    color: var(--text-dim);
  }

  .code-display {
    display: flex;
    gap: 8px;
    margin: 8px 0;
  }

  .code-pair {
    font-size: 28px;
    font-weight: 700;
    font-family: 'SF Mono', 'Fira Code', monospace;
    letter-spacing: 0.05em;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 16px;
    min-width: 64px;
    text-align: center;
  }

  .actions {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
    max-width: 280px;
    margin-top: 8px;
  }

  .btn-accept {
    background: var(--green);
    color: white;
    font-size: 14px;
    font-weight: 500;
    padding: 12px 24px;
    border-radius: var(--radius);
    width: 100%;
  }
  .btn-accept:hover {
    filter: brightness(1.1);
  }

  .btn-reject {
    background: none;
    color: var(--text-dim);
    font-size: 13px;
    font-weight: 500;
    padding: 8px 24px;
    border-radius: var(--radius-sm);
  }
  .btn-reject:hover {
    color: var(--red);
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.4;
    }
  }
</style>
