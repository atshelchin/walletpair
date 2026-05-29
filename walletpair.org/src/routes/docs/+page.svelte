<svelte:head>
	<title>Documentation — WalletPair</title>
</svelte:head>

<h1>Documentation</h1>

<p>
	WalletPair is a minimal, self-sovereign protocol for connecting dApps with blockchain wallets.
	The core protocol is <strong>network-agnostic</strong> — it handles pairing, encryption, and
	transport. Chain-specific logic is defined in sub-protocols (EVM, Solana, etc.).
</p>

<h2>Core Protocol</h2>

<div class="cards">
	<a href="/docs/getting-started" class="doc-card">
		<h3>Getting Started</h3>
		<p>Install the SDK and run your first pairing in under 5 minutes.</p>
	</a>
	<a href="/docs/core-concepts" class="doc-card">
		<h3>Core Concepts</h3>
		<p>Pairing, encryption, transports, channels, and multi-network support.</p>
	</a>
	<a href="/docs/dapp-integration" class="doc-card">
		<h3>dApp Integration</h3>
		<p>Full guide to integrating WalletPair into your dApp.</p>
	</a>
	<a href="/docs/wallet-integration" class="doc-card">
		<h3>Wallet Integration</h3>
		<p>Handle pairing requests and sign transactions in your wallet.</p>
	</a>
	<a href="/docs/relay" class="doc-card">
		<h3>Self-Hosting Relay</h3>
		<p>Deploy your own relay server with a single Rust binary.</p>
	</a>
	<a href="/docs/security" class="doc-card">
		<h3>Security</h3>
		<p>Cryptography, formal verification, and threat model.</p>
	</a>
</div>

<h2>Sub-Protocols</h2>

<p>
	Sub-protocols define chain-specific methods, events, and data encoding for each blockchain
	ecosystem. The core protocol is unaware of which network you're using.
</p>

<div class="cards">
	<a href="/docs/sub-protocols" class="doc-card">
		<h3>Sub-Protocols Overview</h3>
		<p>Architecture, cross-network differences, and how to author a new sub-protocol.</p>
	</a>
	<a href="/docs/evm-methods" class="doc-card">
		<h3>EVM Sub-Protocol</h3>
		<p>Methods, events, and error codes for Ethereum and EIP-155 chains.</p>
	</a>
	<a href="/docs/wagmi" class="doc-card">
		<h3>Wagmi Connector</h3>
		<p>Drop-in wagmi connector and EIP-1193 provider for EVM dApps.</p>
	</a>
</div>

<style>
	h2 {
		margin-top: var(--space-8);
	}

	.cards {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: var(--space-4);
		margin-top: var(--space-4);
	}

	.doc-card {
		display: block;
		padding: var(--space-4) var(--space-6);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		text-decoration: none;
		transition: border-color 0.15s;
	}

	.doc-card:hover {
		border-color: var(--color-text-subtle);
	}

	.doc-card h3 {
		font-size: 1rem;
		font-weight: 600;
		margin-bottom: var(--space-1);
		color: var(--color-text);
	}

	.doc-card p {
		font-size: 0.85rem;
		color: var(--color-text-muted);
		margin-bottom: 0;
	}

	@media (max-width: 640px) {
		.cards {
			grid-template-columns: 1fr;
		}
	}
</style>
