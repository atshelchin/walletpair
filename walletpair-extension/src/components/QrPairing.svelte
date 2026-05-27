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

  <button class="copy-btn" onclick={copyUri} title="Less secure — same device only">
    {#if copied}
      Copied!
    {:else}
      <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
        <path
          d="M4 4v-2a1 1 0 011-1h7a1 1 0 011 1v8a1 1 0 01-1 1h-2v2a1 1 0 01-1 1H3a1 1 0 01-1-1V5a1 1 0 011-1h1zm1 0h4a1 1 0 011 1v5h1V2H5v2z"
        />
      </svg>
      Copy Link
    {/if}
  </button>
</div>

<style>
  .pairing {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
  }

  .status-badge {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 500;
    padding: 6px 12px;
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
    border-radius: var(--radius);
    padding: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .qr-img {
    width: 240px;
    height: 240px;
    image-rendering: pixelated;
  }

  .qr-placeholder {
    width: 240px;
    height: 240px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .hint {
    font-size: 12px;
    color: var(--text-dim);
  }

  .copy-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--bg-card);
    color: var(--text-dim);
    font-size: 12px;
    font-weight: 500;
    padding: 8px 16px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }
  .copy-btn:hover {
    background: var(--bg-hover);
    color: var(--text);
  }

  .fingerprint {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }

  .fingerprint-label {
    font-size: 11px;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .fingerprint-code {
    display: flex;
    gap: 4px;
  }

  .fp-pair {
    font-size: 20px;
    font-weight: 700;
    font-family: 'SF Mono', 'Fira Code', monospace;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 4px 10px;
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
    to {
      transform: rotate(360deg);
    }
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
