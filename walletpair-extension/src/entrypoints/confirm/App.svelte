<script lang="ts">
  import {
    formatMethod,
    formatValue,
    shortenAddr,
    truncateHex,
    tryDecodeHex,
    formatTypedData,
  } from '../../lib/confirm-utils.js';

  let method = $state('');
  let origin = $state('');
  let params = $state<any>(null);
  let confirmId = $state('');
  let loading = $state(true);

  // Read confirm ID from URL
  $effect(() => {
    const url = new URL(window.location.href);
    confirmId = url.searchParams.get('id') ?? '';
    if (confirmId) {
      chrome.runtime.sendMessage({ action: 'get-confirmation', id: confirmId }).then((data) => {
        if (data) {
          method = data.method ?? '';
          origin = data.origin ?? '';
          params = data.params ?? null;
        }
        loading = false;
      });
    } else {
      loading = false;
    }
  });

  async function approve() {
    await chrome.runtime.sendMessage({ action: 'approve-confirmation', id: confirmId });
    window.close();
  }

  async function reject() {
    await chrome.runtime.sendMessage({ action: 'reject-confirmation', id: confirmId });
    window.close();
  }
</script>

<div class="confirm">
  <header class="header">
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
      <rect width="24" height="24" rx="6" fill="#6366f1" />
      <path d="M7 12L12 7L17 12L12 17Z" fill="white" opacity="0.9" />
      <circle cx="12" cy="12" r="2.2" fill="#6366f1" />
    </svg>
    <span class="header-title">{formatMethod(method)}</span>
  </header>

  {#if loading}
    <div class="center">
      <span class="spinner"></span>
    </div>
  {:else if !confirmId || !method}
    <div class="center">
      <p class="text-dim">No pending confirmation.</p>
    </div>
  {:else}
    <main class="body">
      <!-- Origin -->
      <div class="origin-badge">{origin}</div>

      <!-- Transaction details -->
      {#if method === 'eth_sendTransaction' || method === 'eth_signTransaction'}
        <div class="detail-card">
          <div class="detail-row">
            <span class="label">To</span>
            <span class="value mono">{shortenAddr(params?.to)}</span>
          </div>
          {#if params?.value && params.value !== '0x0' && params.value !== '0x'}
            <div class="detail-row">
              <span class="label">Value</span>
              <span class="value accent">{formatValue(params.value)}</span>
            </div>
          {/if}
          {#if params?.data && params.data !== '0x'}
            <div class="detail-row col">
              <span class="label">Data</span>
              <span class="value mono small">{truncateHex(params.data)}</span>
            </div>
          {/if}
        </div>

      <!-- Sign message -->
      {:else if method === 'personal_sign'}
        <div class="detail-card">
          <div class="detail-row col">
            <span class="label">Message</span>
            <span class="value msg">{tryDecodeHex(params?.message ?? params?.[0])}</span>
          </div>
        </div>

      <!-- Typed data -->
      {:else if method === 'eth_signTypedData_v4' || method === 'eth_signTypedData_v3'}
        <div class="detail-card">
          <div class="detail-row col">
            <span class="label">Typed Data</span>
            <pre class="value mono small">{formatTypedData(params)}</pre>
          </div>
        </div>
      {/if}

      <div class="actions">
        <button class="btn-reject" onclick={reject}>Reject</button>
        <button class="btn-approve" onclick={approve}>Approve</button>
      </div>
    </main>
  {/if}
</div>


<style>
  .confirm {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    width: 400px;
    max-width: 100vw;
  }

  .header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
  }

  .header-title {
    font-weight: 600;
    font-size: 15px;
  }

  .center {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 40px;
  }

  .body {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 16px;
  }

  .origin-badge {
    font-size: 12px;
    color: var(--accent-hover);
    background: var(--accent-dim);
    padding: 6px 12px;
    border-radius: 100px;
    text-align: center;
    font-weight: 500;
    word-break: break-all;
  }

  .detail-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .detail-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }
  .detail-row.col {
    flex-direction: column;
    align-items: flex-start;
  }

  .label {
    font-size: 12px;
    color: var(--text-dim);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    flex-shrink: 0;
  }

  .value {
    font-size: 13px;
    color: var(--text);
    text-align: right;
  }
  .value.mono {
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 12px;
  }
  .value.small {
    font-size: 11px;
    word-break: break-all;
    text-align: left;
  }
  .value.accent {
    color: var(--accent-hover);
    font-weight: 600;
  }
  .value.msg {
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }

  pre.value {
    margin: 0;
    white-space: pre-wrap;
  }

  .text-dim {
    color: var(--text-dim);
    font-size: 13px;
  }

  .actions {
    display: flex;
    gap: 10px;
    margin-top: auto;
    padding-top: 16px;
  }

  .btn-reject {
    flex: 1;
    background: var(--bg-card);
    color: var(--text-dim);
    font-size: 14px;
    font-weight: 500;
    padding: 12px 20px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
  }
  .btn-reject:hover {
    color: var(--red);
    border-color: var(--red);
    background: var(--red-dim);
  }

  .btn-approve {
    flex: 1.5;
    background: var(--green);
    color: white;
    font-size: 14px;
    font-weight: 600;
    padding: 12px 20px;
    border-radius: var(--radius);
  }
  .btn-approve:hover {
    filter: brightness(1.1);
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
</style>
