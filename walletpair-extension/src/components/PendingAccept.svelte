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
  <div class="steps">
    <div class="step completed">
      <span class="step-num">1</span>
      <span class="step-label">Scan</span>
    </div>
    <div class="step-line completed"></div>
    <div class="step active">
      <span class="step-num">2</span>
      <span class="step-label">Verify</span>
    </div>
    <div class="step-line"></div>
    <div class="step">
      <span class="step-num">3</span>
      <span class="step-label">Done</span>
    </div>
  </div>

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
    animation: fadeIn 0.3s ease-out;
  }

  .steps {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0;
    margin-bottom: 8px;
    width: 100%;
    max-width: 240px;
  }
  .step {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }
  .step-num {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 700;
    background: var(--bg-card);
    border: 1px solid var(--border);
    color: var(--text-dim);
  }
  .step.active .step-num {
    background: var(--accent);
    border-color: var(--accent);
    color: white;
  }
  .step.completed .step-num {
    background: var(--green);
    border-color: var(--green);
    color: white;
  }
  .step-label {
    font-size: 9px;
    color: var(--text-dimmer);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .step.active .step-label {
    color: var(--accent-hover);
  }
  .step.completed .step-label {
    color: var(--green);
  }
  .step-line {
    flex: 1;
    height: 1px;
    background: var(--border);
    margin: 0 6px;
    margin-bottom: 14px;
  }
  .step-line.completed {
    background: var(--green);
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
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
