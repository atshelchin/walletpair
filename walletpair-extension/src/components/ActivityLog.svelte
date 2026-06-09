<script lang="ts">
  import type { ActivityEntry } from '@/lib/types';

  let { entries = [] }: { entries: ActivityEntry[] } = $props();
  let expandedId = $state<string | null>(null);

  function relativeTime(ts: number): string {
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 5) return 'now';
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
  }

  function shortMethod(m: string): string {
    return m.replace('eth_', '').replace('wallet_', '').replace('personal_', '');
  }

  function categoryLabel(c: string): string {
    switch (c) {
      case 'sign': return 'Sign';
      case 'tx': return 'Tx';
      case 'auth': return 'Auth';
      case 'read': return 'Read';
      default: return c;
    }
  }

  function shortOrigin(origin: string): string {
    try { return new URL(origin).hostname; } catch { return origin; }
  }

  function formatJson(value: unknown): string {
    if (value === undefined || value === null) return '—';
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function toggleExpand(id: string) {
    expandedId = expandedId === id ? null : id;
  }

  function hasDetail(entry: ActivityEntry): boolean {
    return entry.params !== undefined || entry.result !== undefined || entry.error !== undefined;
  }
</script>

{#if entries.length > 0}
  <div class="activity">
    <h4 class="activity-title">Activity</h4>
    <div class="activity-list">
      {#each entries.slice(0, 20) as entry}
        <button
          class="activity-row"
          class:expandable={hasDetail(entry)}
          class:expanded={expandedId === entry.id}
          onclick={() => hasDetail(entry) && toggleExpand(entry.id)}
          type="button"
        >
          <div class="activity-left">
            <span class="badge {entry.category}">{categoryLabel(entry.category)}</span>
            <span class="method">{shortMethod(entry.method)}</span>
          </div>
          <div class="activity-right">
            <span class="origin">{shortOrigin(entry.origin)}</span>
            <span class="status-icon {entry.status}">
              {#if entry.status === 'pending'}●{:else if entry.status === 'success'}✓{:else if entry.status === 'rejected'}✕{:else}!{/if}
            </span>
            <span class="time">{relativeTime(entry.timestamp)}</span>
          </div>
        </button>
        {#if expandedId === entry.id}
          <div class="detail-panel">
            <div class="detail-field">
              <span class="detail-label">Method</span>
              <code class="detail-value">{entry.method}</code>
            </div>
            <div class="detail-field">
              <span class="detail-label">Origin</span>
              <code class="detail-value">{entry.origin}</code>
            </div>
            {#if entry.params !== undefined}
              <div class="detail-field">
                <span class="detail-label">Params</span>
                <pre class="detail-pre">{formatJson(entry.params)}</pre>
              </div>
            {/if}
            {#if entry.result !== undefined}
              <div class="detail-field">
                <span class="detail-label">Result</span>
                <pre class="detail-pre result">{formatJson(entry.result)}</pre>
              </div>
            {/if}
            {#if entry.error}
              <div class="detail-field">
                <span class="detail-label">Error</span>
                <pre class="detail-pre error">{formatJson(entry.error)}</pre>
              </div>
            {/if}
          </div>
        {/if}
      {/each}
    </div>
  </div>
{/if}

<style>
  .activity {
    width: 100%;
    margin-top: 8px;
  }

  .activity-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-dimmer);
    margin: 0 0 6px 0;
    padding: 0;
  }

  .activity-list {
    max-height: 320px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 1px;
    border-radius: 8px;
    background: var(--bg-card);
    border: 1px solid var(--border);
  }

  .activity-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 28px;
    padding: 0 8px;
    font-size: 12px;
    background: none;
    border: none;
    color: inherit;
    width: 100%;
    cursor: default;
    text-align: left;
    font-family: inherit;
  }

  .activity-row.expandable {
    cursor: pointer;
  }

  .activity-row.expandable:hover {
    background: var(--bg-hover, rgba(128, 128, 128, 0.06));
  }

  .activity-row.expanded {
    background: var(--bg-hover, rgba(128, 128, 128, 0.06));
  }

  .activity-row:not(:last-child) {
    border-bottom: 1px solid var(--border);
  }

  .activity-left {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .activity-right {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  .badge {
    font-size: 9px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    padding: 1px 5px;
    border-radius: 4px;
    flex-shrink: 0;
  }

  .badge.read {
    background: rgba(128, 128, 128, 0.12);
    color: var(--text-dimmer);
  }

  .badge.sign {
    background: var(--orange-dim);
    color: var(--orange);
  }

  .badge.tx {
    background: var(--red-dim);
    color: var(--red);
  }

  .badge.auth {
    background: var(--accent-dim);
    color: var(--accent);
  }

  .method {
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 11px;
    color: var(--text-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .origin {
    font-size: 10px;
    color: var(--text-dimmer);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 80px;
  }

  .status-icon {
    font-size: 11px;
    flex-shrink: 0;
  }

  .status-icon.pending {
    color: var(--orange);
    animation: pulse 1.5s ease-in-out infinite;
  }

  .status-icon.success {
    color: var(--green);
  }

  .status-icon.rejected {
    color: var(--red);
  }

  .status-icon.error {
    color: var(--red);
  }

  .time {
    font-size: 10px;
    color: var(--text-dimmer);
    white-space: nowrap;
    min-width: 32px;
    text-align: right;
  }

  /* Detail panel */
  .detail-panel {
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-hover, rgba(128, 128, 128, 0.03));
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .detail-field {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .detail-label {
    font-size: 9px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-dimmer);
  }

  .detail-value {
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 11px;
    color: var(--text-dim);
    word-break: break-all;
  }

  .detail-pre {
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 10px;
    color: var(--text-dim);
    margin: 0;
    padding: 6px 8px;
    border-radius: 4px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 120px;
    overflow-y: auto;
  }

  .detail-pre.result {
    border-left: 2px solid var(--green);
  }

  .detail-pre.error {
    border-left: 2px solid var(--red);
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
</style>
