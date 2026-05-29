<script lang="ts">
	import type { LogEntry } from './state.svelte';

	let { entries }: { entries: LogEntry[] } = $props();

	let logEl: HTMLDivElement | undefined = $state();
	let expandedSet = $state(new Set<number>());

	$effect(() => {
		if (entries.length && logEl) {
			logEl.scrollTop = logEl.scrollHeight;
		}
	});

	function toggleExpand(i: number) {
		const next = new Set(expandedSet);
		if (next.has(i)) next.delete(i);
		else next.add(i);
		expandedSet = next;
	}

	const TRUNCATE = 80;
</script>

<div class="log-section">
	<h4>Message Log <span class="log-count">{entries.length}</span></h4>
	<div class="log-wrap" bind:this={logEl}>
		{#each entries as entry, i}
			<div class="log-entry" class:err={entry.dir === 'err'}>
				<span class="time">{entry.time}</span>
				<span class="dir {entry.dir}">
					{entry.dir === 'out' ? '→' : entry.dir === 'in' ? '←' : '✕'}
				</span>
				<span class="type">{entry.type}</span>
				{#if entry.detail.length > TRUNCATE && !expandedSet.has(i)}
					<span class="body truncated" onclick={() => toggleExpand(i)} role="button" tabindex="0" onkeydown={(e) => e.key === 'Enter' && toggleExpand(i)}>
						{entry.detail.slice(0, TRUNCATE)}…
					</span>
				{:else if entry.detail.length > TRUNCATE}
					<span class="body expanded" onclick={() => toggleExpand(i)} role="button" tabindex="0" onkeydown={(e) => e.key === 'Enter' && toggleExpand(i)}>
						{entry.detail}
					</span>
				{:else}
					<span class="body">{entry.detail}</span>
				{/if}
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
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.log-count {
		font-size: 0.65rem;
		background: var(--color-surface-2);
		color: var(--color-text-subtle);
		padding: 0 5px;
		border-radius: 8px;
		font-weight: 400;
	}

	.log-wrap {
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		padding: var(--space-3);
		max-height: 300px;
		overflow-y: auto;
		font-family: var(--font-mono);
		font-size: 0.7rem;
		line-height: 1.5;
	}

	.log-entry {
		display: flex;
		gap: var(--space-1);
		padding: 2px 0;
		border-bottom: 1px solid transparent;
	}

	.log-entry.err {
		background: rgba(239, 68, 68, 0.05);
		border-radius: 2px;
	}

	.time {
		flex-shrink: 0;
		color: var(--color-text-subtle);
		opacity: 0.6;
		font-size: 0.65rem;
		min-width: 7em;
	}

	.dir {
		flex-shrink: 0;
		width: 1.2em;
		text-align: center;
	}

	.dir.out { color: var(--color-accent); }
	.dir.in { color: var(--color-success); }
	.dir.err { color: var(--color-error); }

	.type {
		color: var(--color-text-muted);
		flex-shrink: 0;
		min-width: 6em;
	}

	.body {
		color: var(--color-text-subtle);
		word-break: break-all;
	}

	.body.truncated {
		cursor: pointer;
	}

	.body.truncated::after {
		content: ' ▸';
		color: var(--color-accent);
		font-size: 0.6rem;
	}

	.body.expanded {
		cursor: pointer;
		color: var(--color-text-muted);
	}

	.body.expanded::after {
		content: ' ▾';
		color: var(--color-accent);
		font-size: 0.6rem;
	}

	.empty {
		color: var(--color-text-subtle);
		font-style: italic;
	}
</style>
