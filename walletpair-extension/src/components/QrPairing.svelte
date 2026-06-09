<script lang="ts">
  import QRCode from 'qrcode';
  import { Copy, Check } from 'lucide-svelte';

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

  <button class="copy-btn" onclick={copyUri}>
    {#if copied}
      <Check size={13} strokeWidth={2} color="var(--green)" />
      Copied
    {:else}
      <Copy size={13} strokeWidth={1.5} />
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
    gap: 14px;
    animation: fadeIn 0.3s ease-out;
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
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
</style>
