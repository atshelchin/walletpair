<script lang="ts">
  import QRCode from 'qrcode';

  let { uri, fingerprint }: { uri: string; fingerprint?: string } = $props();

  let qrDataUrl = $state('');
  let copied = $state(false);

  $effect(() => {
    if (uri) {
      QRCode.toDataURL(uri, {
        width: 240,
        margin: 2,
        color: { dark: '#e8e8f0', light: '#00000000' },
        errorCorrectionLevel: 'M',
      }).then((url: string) => {
        qrDataUrl = url;
      });
    }
  });

  function copyUri() {
    navigator.clipboard.writeText(uri);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }
</script>

<div class="pairing">
  <div class="steps">
    <div class="step active">
      <span class="step-num">1</span>
      <span class="step-label">Scan</span>
    </div>
    <div class="step-line"></div>
    <div class="step">
      <span class="step-num">2</span>
      <span class="step-label">Verify</span>
    </div>
    <div class="step-line"></div>
    <div class="step">
      <span class="step-num">3</span>
      <span class="step-label">Done</span>
    </div>
  </div>

  <div class="status-badge">
    <span class="status-dot"></span>
    Waiting for wallet...
  </div>

  <div class="qr-container">
    {#if qrDataUrl}
      <img src={qrDataUrl} alt="Pairing QR Code" class="qr-img" />
    {:else}
      <div class="qr-placeholder">
        <span class="spinner"></span>
      </div>
    {/if}
  </div>

  {#if fingerprint}
    <div class="fingerprint">
      <span class="fingerprint-label">Session Code</span>
      <div class="fingerprint-code">
        {#each [fingerprint.slice(0, 2), fingerprint.slice(2, 4)] as pair}
          <span class="fp-pair">{pair}</span>
        {/each}
      </div>
    </div>
  {/if}

  <p class="hint">Scan with a WalletPair-compatible wallet</p>

  <div class="copy-row">
    <button class="copy-btn" onclick={copyUri}>
      {#if copied}
        <svg viewBox="0 0 16 16" width="13" height="13" fill="var(--green)"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>
        Copied!
      {:else}
        <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
          <path d="M4 4v-2a1 1 0 011-1h7a1 1 0 011 1v8a1 1 0 01-1 1h-2v2a1 1 0 01-1 1H3a1 1 0 01-1-1V5a1 1 0 011-1h1zm1 0h4a1 1 0 011 1v5h1V2H5v2z" />
        </svg>
        Copy Link
      {/if}
    </button>
  </div>
  <p class="copy-warning">Less secure — same device only</p>
</div>

<style>
  .pairing {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
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
  .step-label {
    font-size: 9px;
    color: var(--text-dimmer);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .step.active .step-label {
    color: var(--accent-hover);
  }
  .step-line {
    flex: 1;
    height: 1px;
    background: var(--border);
    margin: 0 6px;
    margin-bottom: 14px;
  }

  .status-badge {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 500;
    padding: 5px 14px;
    border-radius: 100px;
    background: var(--accent-dim);
    color: var(--accent-hover);
  }

  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    animation: pulse 1.5s ease-in-out infinite;
  }

  .qr-container {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2);
  }

  .qr-img {
    width: 220px;
    height: 220px;
    image-rendering: pixelated;
    border-radius: 8px;
  }

  .qr-placeholder {
    width: 220px;
    height: 220px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .fingerprint {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    margin-top: 2px;
  }

  .fingerprint-label {
    font-size: 10px;
    color: var(--text-dimmer);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 600;
  }

  .fingerprint-code {
    display: flex;
    gap: 6px;
  }

  .fp-pair {
    font-size: 22px;
    font-weight: 700;
    font-family: 'SF Mono', 'Fira Code', monospace;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 6px 14px;
    color: var(--text);
    letter-spacing: 0.05em;
  }

  .hint {
    font-size: 12px;
    color: var(--text-dim);
  }

  .copy-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .copy-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--bg-card);
    color: var(--text-dim);
    font-size: 12px;
    font-weight: 500;
    padding: 7px 14px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }
  .copy-btn:hover {
    background: var(--bg-hover);
    color: var(--text);
  }

  .copy-warning {
    font-size: 10px;
    color: var(--text-dimmer);
    text-align: center;
    line-height: 1.3;
    margin: -4px 0 0;
  }

  .spinner {
    width: 24px;
    height: 24px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
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
