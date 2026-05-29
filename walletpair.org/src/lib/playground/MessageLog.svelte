<script lang="ts">
	import type { LogEntry } from './state.svelte';

	let { entries }: { entries: LogEntry[] } = $props();

	let logEl: HTMLDivElement | undefined = $state();

	$effect(() => {
		if (entries.length && logEl) {
			logEl.scrollTop = logEl.scrollHeight;
		}
	});
</script>

<div class="log-section">
	<h4>Message Log</h4>
	<div class="log-wrap" bind:this={logEl}>
		{#each entries as entry}
			<div class="log-entry">
				<span class="dir {entry.dir}">
					{entry.dir === 'out' ? '→' : entry.dir === 'in' ? '←' : '✕'}
				</span>
				<span class="type">{entry.type}</span>
				<span class="body">{entry.detail}</span>
			</div>
		{/each}
		{#if entries.length === 0}
			<div class="empty">No messages yet</div>
		{/if}
	</div>
</div>

<style>
	h4 {
		font-size: 0.8rem;
		color: var(--color-text-muted);
		margin-bottom: var(--space-2);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.log-wrap {
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		padding: var(--space-3);
		max-height: 240px;
		overflow-y: auto;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		line-height: 1.5;
	}

	.log-entry {
		display: flex;
		gap: var(--space-2);
		padding: 1px 0;
	}

	.dir {
		flex-shrink: 0;
		width: 1.2em;
		text-align: center;
	}

	.dir.out {
		color: var(--color-accent);
	}
	.dir.in {
		color: var(--color-success);
	}
	.dir.err {
		color: var(--color-error);
	}

	.type {
		color: var(--color-text-muted);
		flex-shrink: 0;
		min-width: 5em;
	}

	.body {
		color: var(--color-text-subtle);
		word-break: break-all;
	}

	.empty {
		color: var(--color-text-subtle);
		font-style: italic;
	}
</style>
