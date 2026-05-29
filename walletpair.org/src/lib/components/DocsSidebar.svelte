<script lang="ts">
	import { page } from '$app/state';
	import { docsNav } from '$lib/docs/navigation';
</script>

<aside class="sidebar">
	<nav>
		{#each docsNav as item}
			{#if item.separator}
				<div class="separator">{item.title}</div>
			{:else}
				<a
					href={item.href}
					class="sidebar-link"
					class:active={page.url.pathname === item.href}
				>
					{item.title}
				</a>
			{/if}
		{/each}
	</nav>
</aside>

<style>
	.sidebar {
		position: sticky;
		top: 72px;
		width: 200px;
		flex-shrink: 0;
		padding-right: var(--space-6);
		max-height: calc(100vh - 72px);
		overflow-y: auto;
	}

	nav {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.separator {
		font-size: 0.7rem;
		font-weight: 600;
		color: var(--color-text-subtle);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		padding: var(--space-3) var(--space-3) var(--space-1);
		margin-top: var(--space-2);
	}

	.sidebar-link {
		display: block;
		padding: var(--space-2) var(--space-3);
		font-size: 0.85rem;
		color: var(--color-text-muted);
		border-radius: var(--radius-sm);
		text-decoration: none;
		transition:
			color 0.15s,
			background 0.15s;
	}

	.sidebar-link:hover {
		color: var(--color-text);
		background: var(--color-surface);
	}

	.sidebar-link.active {
		color: var(--color-text);
		background: var(--color-surface);
		font-weight: 500;
	}
</style>
