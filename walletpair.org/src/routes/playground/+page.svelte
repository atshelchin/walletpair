<script lang="ts">
	import PlaygroundDApp from '$lib/playground/PlaygroundDApp.svelte';
	import PlaygroundWallet from '$lib/playground/PlaygroundWallet.svelte';
	import ProtocolDApp from '$lib/playground/ProtocolDApp.svelte';
	import ProtocolWallet from '$lib/playground/ProtocolWallet.svelte';
	import { playground } from '$lib/playground/state.svelte';

	let width = $state(0);
	const isMobile = $derived(width < 768);
</script>

<svelte:head>
	<title>Playground — WalletPair</title>
</svelte:head>

<svelte:window bind:innerWidth={width} />

<div class="playground-wrap">
	<div class="playground-header">
		<h1>Playground</h1>
		<p>
			Test the full WalletPair flow in your browser. Connect the dApp panel to the wallet
			panel, send requests, and see encrypted messages in real time.
		</p>
	</div>

	<!-- Mode switcher -->
	<div class="mode-switcher">
		<button
			class="mode-btn"
			class:active={playground.mode === 'protocol'}
			onclick={() => (playground.mode = 'protocol')}
		>
			<span class="mode-label">Protocol</span>
			<span class="mode-desc">Network-agnostic · raw requests & responses</span>
		</button>
		<button
			class="mode-btn"
			class:active={playground.mode === 'evm'}
			onclick={() => (playground.mode = 'evm')}
		>
			<span class="mode-label">EVM</span>
			<span class="mode-desc">Ethereum · signing, accounts, transactions</span>
		</button>
	</div>

	{#if isMobile}
		<!-- Mobile: tabbed view -->
		<div class="tabs">
			<button
				class="tab"
				class:active={playground.activeTab === 'dapp'}
				onclick={() => (playground.activeTab = 'dapp')}
			>
				dApp
			</button>
			<button
				class="tab"
				class:active={playground.activeTab === 'wallet'}
				onclick={() => (playground.activeTab = 'wallet')}
			>
				Wallet
			</button>
		</div>
		{#if playground.activeTab === 'dapp'}
			{#if playground.mode === 'protocol'}
				<ProtocolDApp />
			{:else}
				<PlaygroundDApp />
			{/if}
		{:else}
			{#if playground.mode === 'protocol'}
				<ProtocolWallet />
			{:else}
				<PlaygroundWallet />
			{/if}
		{/if}
	{:else}
		<!-- Desktop: split view -->
		<div class="split">
			{#if playground.mode === 'protocol'}
				<ProtocolDApp />
				<ProtocolWallet />
			{:else}
				<PlaygroundDApp />
				<PlaygroundWallet />
			{/if}
		</div>
	{/if}
</div>

<style>
	.playground-wrap {
		max-width: var(--max-w-playground);
		margin: 0 auto;
		padding: var(--space-8) var(--space-6);
	}

	.playground-header {
		margin-bottom: var(--space-4);
	}

	.playground-header h1 {
		font-family: var(--font-mono);
		font-size: 1.5rem;
		font-weight: 600;
		margin-bottom: var(--space-2);
	}

	.playground-header p {
		color: var(--color-text-muted);
		font-size: 0.9rem;
		max-width: 600px;
	}

	/* ── Mode Switcher ── */
	.mode-switcher {
		display: flex;
		gap: var(--space-3);
		margin-bottom: var(--space-6);
	}

	.mode-btn {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: var(--space-3) var(--space-4);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		text-align: left;
		cursor: pointer;
		transition:
			border-color 0.15s,
			background 0.15s;
	}

	.mode-btn:hover {
		border-color: var(--color-text-subtle);
	}

	.mode-btn.active {
		border-color: var(--color-accent);
		background: var(--color-surface-2);
	}

	.mode-label {
		font-family: var(--font-mono);
		font-size: 0.9rem;
		font-weight: 600;
		color: var(--color-text);
	}

	.mode-desc {
		font-size: 0.75rem;
		color: var(--color-text-subtle);
	}

	/* ── Split ── */
	.split {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-4);
		align-items: start;
	}

	/* ── Tabs (mobile) ── */
	.tabs {
		display: flex;
		gap: 2px;
		margin-bottom: var(--space-4);
		background: var(--color-surface);
		border-radius: var(--radius-md);
		padding: 2px;
		border: 1px solid var(--color-border);
	}

	.tab {
		flex: 1;
		padding: var(--space-2) var(--space-4);
		border: none;
		background: transparent;
		color: var(--color-text-muted);
		font-family: var(--font-mono);
		font-size: 0.85rem;
		border-radius: var(--radius-sm);
		transition:
			background 0.15s,
			color 0.15s;
	}

	.tab.active {
		background: var(--color-surface-2);
		color: var(--color-text);
	}

	@media (max-width: 480px) {
		.mode-switcher {
			flex-direction: column;
		}
	}
</style>
