<script lang="ts">
	import FeatureCard from '$lib/components/FeatureCard.svelte';
	import SequenceDiagram from '$lib/components/SequenceDiagram.svelte';
	import { Braces, Lock, ArrowLeftRight, Diamond, ShieldCheck, Settings, Download } from 'lucide-svelte';

	const features = [
		{
			icon: Braces,
			title: 'Zero Registration',
			description: 'No API keys, project IDs, or accounts. Deploy a relay and start pairing.'
		},
		{
			icon: Lock,
			title: 'End-to-End Encrypted',
			description: 'ChaCha20-Poly1305 AEAD. The relay routes only opaque bytes it cannot read.'
		},
		{
			icon: ArrowLeftRight,
			title: 'Transport Agnostic',
			description: 'WebSocket, Bluetooth, local TCP — same protocol, same code.'
		},
		{
			icon: Diamond,
			title: 'Multi-Network',
			description:
				'Chain-agnostic core with sub-protocols for EVM, Solana, Sui, and more via CAIP-2.'
		},
		{
			icon: ShieldCheck,
			title: 'Formally Verified',
			description: 'ProVerif-proven under Dolev-Yao threat model. 7/7 security properties hold.'
		},
		{
			icon: Settings,
			title: 'Self-Hostable',
			description: 'One Rust binary. No vendor lock-in. Your infrastructure, your rules.'
		}
	];

	const dappCode = `import { DAppSession, WebSocketTransport } from 'walletpair-sdk';

const transport = new WebSocketTransport('wss://relay.walletpair.org/v1');
const session = new DAppSession({ transport, meta: { name: 'My dApp' } });

const uri = await session.createPairing();
// Display uri as QR code for wallet to scan

session.on('phase', async (phase) => {
  if (phase !== 'connected') return;
  const accounts = await session.request('wallet_getAccounts');
});`;

	const walletCode = `import { WalletSession, WebSocketTransport } from 'walletpair-sdk';

const transport = new WebSocketTransport('wss://relay.walletpair.org/v1');
const session = new WalletSession({
  transport,
  capabilities: {
    methods: ['wallet_getAccounts', 'wallet_signMessage'],
    events: ['accountsChanged', 'chainChanged'],
    chains: ['eip155:1', 'eip155:137'],
  },
});

await session.joinFromUri(pairingUri);

session.on('request', ({ id, method, params }) => {
  // Handle request and approve or reject
  session.approve(id, result);
});`;
</script>

<!-- Hero -->
<section class="hero">
	<h1 class="hero-title">WalletPair</h1>
	<p class="hero-sub">
		Connect dApps to wallets.<br />
		No registration. No middleman. Just crypto.
	</p>
	<div class="hero-actions">
		<a href="/docs/getting-started" class="btn btn-primary">Get Started</a>
		<a href="/docs/install-extension" class="btn btn-ghost"><Download size={16} strokeWidth={1.5} /> Install Extension</a>
		<a href="/playground" class="btn btn-ghost">Try the Playground →</a>
	</div>
</section>

<!-- Features -->
<section class="section">
	<h2 class="section-title">Why WalletPair</h2>
	<div class="features-grid">
		{#each features as f}
			<FeatureCard title={f.title} description={f.description} icon={f.icon} />
		{/each}
	</div>
</section>

<!-- How It Works -->
<section class="section">
	<h2 class="section-title">How It Works</h2>
	<p class="section-desc">
		The dApp creates a channel, displays a QR code. The wallet scans it. After a cryptographic
		handshake with visual fingerprint verification, they communicate over an end-to-end encrypted
		session. The relay never sees your data.
	</p>
	<SequenceDiagram />
</section>

<!-- Dual Path -->
<section class="section">
	<h2 class="section-title">Start Integrating</h2>
	<div class="dual-grid">
		<div class="path-card">
			<h3 class="path-title">For dApp Developers</h3>
			<ul class="path-list">
				<li>Create a pairing URI and display it as a QR code</li>
				<li>Send JSON-RPC requests over the encrypted channel</li>
				<li>Wagmi connector and EIP-1193 provider included</li>
			</ul>
			<pre class="code-block"><code>{dappCode}</code></pre>
			<a href="/docs/dapp-integration" class="path-link">Read the dApp guide →</a>
		</div>
		<div class="path-card">
			<h3 class="path-title">For Wallet Developers</h3>
			<ul class="path-list">
				<li>Scan a pairing QR code and join the session</li>
				<li>Handle incoming requests — approve or reject</li>
				<li>Push events like accountsChanged and chainChanged</li>
			</ul>
			<pre class="code-block"><code>{walletCode}</code></pre>
			<a href="/docs/wallet-integration" class="path-link">Read the wallet guide →</a>
		</div>
	</div>
</section>

<style>
	/* ── Hero ── */
	.hero {
		text-align: center;
		padding: var(--space-24) var(--space-6) var(--space-16);
		max-width: var(--max-w-wide);
		margin: 0 auto;
	}

	.hero-title {
		font-family: var(--font-mono);
		font-size: 3.5rem;
		font-weight: 600;
		letter-spacing: -0.04em;
		margin-bottom: var(--space-4);
		background: linear-gradient(135deg, var(--color-text) 60%, var(--color-accent));
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
		background-clip: text;
	}

	.hero-sub {
		font-size: 1.25rem;
		color: var(--color-text-muted);
		line-height: 1.6;
		margin-bottom: var(--space-8);
	}

	.hero-actions {
		display: flex;
		gap: var(--space-4);
		justify-content: center;
		flex-wrap: wrap;
	}

	/* ── Buttons ── */
	.btn {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-3) var(--space-6);
		border-radius: var(--radius-md);
		font-size: 0.95rem;
		font-weight: 500;
		text-decoration: none;
		transition:
			background 0.15s,
			border-color 0.15s;
	}

	.btn-primary {
		background: var(--color-accent);
		color: #fff;
	}

	.btn-primary:hover {
		background: var(--color-accent-hover);
		color: #fff;
	}

	.btn-ghost {
		background: transparent;
		border: 1px solid var(--color-border);
		color: var(--color-text-muted);
	}

	.btn-ghost:hover {
		border-color: var(--color-text-subtle);
		color: var(--color-text);
	}

	/* ── Sections ── */
	.section {
		max-width: var(--max-w-wide);
		margin: 0 auto;
		padding: var(--space-16) var(--space-6) 0;
	}

	.section-title {
		font-size: 1.5rem;
		font-weight: 600;
		letter-spacing: -0.02em;
		margin-bottom: var(--space-4);
		text-align: center;
	}

	.section-desc {
		text-align: center;
		color: var(--color-text-muted);
		max-width: 640px;
		margin: 0 auto var(--space-8);
		line-height: 1.6;
	}

	/* ── Feature Grid ── */
	.features-grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: var(--space-4);
	}

	@media (max-width: 768px) {
		.features-grid {
			grid-template-columns: repeat(2, 1fr);
		}
	}

	@media (max-width: 480px) {
		.features-grid {
			grid-template-columns: 1fr;
		}

		.hero-title {
			font-size: 2.5rem;
		}

		.hero-sub {
			font-size: 1.05rem;
		}
	}

	/* ── Dual Path ── */
	.dual-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-6);
	}

	@media (max-width: 768px) {
		.dual-grid {
			grid-template-columns: 1fr;
		}
	}

	.path-card {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		padding: var(--space-6);
	}

	.path-title {
		font-family: var(--font-mono);
		font-size: 1.1rem;
		font-weight: 600;
		margin-bottom: var(--space-4);
	}

	.path-list {
		list-style: none;
		padding: 0;
		margin-bottom: var(--space-4);
	}

	.path-list li {
		position: relative;
		padding-left: var(--space-4);
		margin-bottom: var(--space-2);
		font-size: 0.9rem;
		color: var(--color-text-muted);
		line-height: 1.5;
	}

	.path-list li::before {
		content: '·';
		position: absolute;
		left: 0;
		color: var(--color-accent);
		font-weight: bold;
	}

	.code-block {
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		padding: var(--space-4);
		margin-bottom: var(--space-4);
		overflow-x: auto;
		font-size: 0.8rem;
		line-height: 1.5;
	}

	.code-block code {
		font-family: var(--font-mono);
		color: var(--color-text-muted);
		white-space: pre;
	}

	.path-link {
		font-size: 0.9rem;
		font-weight: 500;
		color: var(--color-accent);
		text-decoration: none;
	}

	.path-link:hover {
		color: var(--color-accent-hover);
	}
</style>
