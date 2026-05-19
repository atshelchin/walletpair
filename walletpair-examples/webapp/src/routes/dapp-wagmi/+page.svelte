<script lang="ts">
	import { onMount } from 'svelte';
	import { createConfig, http, connect, disconnect, getAccount, signMessage, getChainId, switchChain, watchAccount, watchChainId, type Config, type Connector } from '@wagmi/core';
	import { mainnet, sepolia, polygon } from 'viem/chains';
	import { WebSocketTransport } from 'walletpair-sdk';
	import { walletPair } from 'walletpair-sdk/evm/wagmi';
	import { WebBleCentralTransport, isWebBleSupported } from 'walletpair-sdk/ble';
	import QRCode from 'qrcode';
	import MessageLog from '$lib/components/MessageLog.svelte';

	// ---------------------------------------------------------------------------
	// State
	// ---------------------------------------------------------------------------
	let transportMode: 'ws' | 'ble' = $state('ws');
	let relayUrl = $state('ws://localhost:8080/v1');
	let bleSupported = $state(false);

	let config: Config | null = $state(null);
	let connector: Connector | null = $state(null);
	let status: 'idle' | 'pairing' | 'confirming' | 'connected' | 'error' = $state('idle');

	let pairingUri = $state('');
	let pairingCode = $state('');
	let qrDataUrl = $state('');

	let account = $state<{ address: string; chainId: number } | null>(null);
	let currentChainId = $state(0);
	let signInput = $state('Hello from WalletPair + wagmi!');
	let signResult = $state('');
	let targetChainId = $state(11155111); // sepolia

	let log = $state<{ dir: 'out' | 'in' | 'err'; type: string; detail: string }[]>([]);

	// ---------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------
	function addLog(dir: 'out' | 'in' | 'err', type: string, detail = '') {
		log = [...log, { dir, type, detail }];
	}

	async function renderQR(text: string) {
		try {
			qrDataUrl = await QRCode.toDataURL(text, {
				width: 200,
				margin: 2,
				color: { dark: '#e6edf3', light: '#161b22' }
			});
		} catch {
			qrDataUrl = '';
		}
	}

	onMount(() => {
		bleSupported = isWebBleSupported();
	});

	// ---------------------------------------------------------------------------
	// Connect with wagmi
	// ---------------------------------------------------------------------------
	async function doConnect() {
		status = 'pairing';
		pairingUri = '';
		pairingCode = '';
		qrDataUrl = '';
		signResult = '';

		// Build transport based on mode
		const transport =
			transportMode === 'ble'
				? new WebBleCentralTransport()
				: undefined; // undefined = use relayUrl

		// Create wagmi config with our walletPair connector
		const wpConnector = walletPair({
			relayUrl: transportMode === 'ws' ? relayUrl : undefined,
			transport,
			name: 'WalletPair wagmi dApp',
			onPairingUri: (uri) => {
				pairingUri = uri;
				renderQR(uri);
				addLog('in', 'pairing_uri', uri.slice(0, 60) + '...');
			},
			onPairingCode: (code) => {
				pairingCode = code;
				status = 'confirming';
				addLog('in', 'pairing_code', code);
			},
			onPairingConfirm: async (code) => {
				// Auto-accept for demo (in production, show confirmation UI)
				addLog('out', 'accept', `code=${code}`);
				return true;
			}
		});

		const cfg = createConfig({
			chains: [mainnet, sepolia, polygon],
			connectors: [wpConnector],
			transports: {
				[mainnet.id]: http(),
				[sepolia.id]: http(),
				[polygon.id]: http()
			}
		});
		config = cfg;

		// Watch account changes
		watchAccount(cfg, {
			onChange: (acc) => {
				if (acc.address) {
					account = { address: acc.address, chainId: acc.chainId ?? 1 };
					addLog('in', 'account', `${acc.address.slice(0, 10)}... chain=${acc.chainId}`);
				} else {
					account = null;
				}
			}
		});

		watchChainId(cfg, {
			onChange: (id) => {
				currentChainId = id;
				addLog('in', 'chainChanged', `${id}`);
			}
		});

		// Connect!
		try {
			addLog('out', 'connect', `mode=${transportMode}`);
			const result = await connect(cfg, { connector: cfg.connectors[0]! });

			account = {
				address: result.accounts[0] ?? '',
				chainId: result.chainId
			};
			currentChainId = result.chainId;
			status = 'connected';
			connector = cfg.connectors[0] ?? null;

			addLog(
				'in',
				'connected',
				`accounts=${result.accounts.join(', ')} chain=${result.chainId}`
			);
		} catch (e: any) {
			status = 'error';
			addLog('err', 'connect', e.message);
		}
	}

	// ---------------------------------------------------------------------------
	// Wagmi actions
	// ---------------------------------------------------------------------------
	async function doSignMessage() {
		if (!config || !account) return;
		addLog('out', 'signMessage', signInput);
		try {
			const sig = await signMessage(config, { message: signInput });
			signResult = sig;
			addLog('in', 'signature', sig.slice(0, 30) + '...');
		} catch (e: any) {
			signResult = `Error: ${e.message}`;
			addLog('err', 'signMessage', e.message);
		}
	}

	async function doSwitchChain() {
		if (!config) return;
		addLog('out', 'switchChain', `${targetChainId}`);
		try {
			await switchChain(config, { chainId: targetChainId });
			addLog('in', 'switchChain', `done → ${targetChainId}`);
		} catch (e: any) {
			addLog('err', 'switchChain', e.message);
		}
	}

	async function doDisconnect() {
		if (!config) return;
		addLog('out', 'disconnect', '');
		try {
			await disconnect(config);
		} catch {
			/* ok */
		}
		status = 'idle';
		account = null;
		pairingUri = '';
		pairingCode = '';
		qrDataUrl = '';
		signResult = '';
		config = null;
		connector = null;
	}

	function chainName(id: number): string {
		if (id === 1) return 'Ethereum';
		if (id === 11155111) return 'Sepolia';
		if (id === 137) return 'Polygon';
		return `Chain ${id}`;
	}
</script>

<main>
	<header>
		<span>WalletPair &mdash; wagmi dApp</span>
		<span class="status">
			<span
				class="dot"
				class:connected={status === 'connected'}
				class:waiting={status === 'pairing' || status === 'confirming'}
				class:closed={status === 'error'}
			></span>
			<span>{status.charAt(0).toUpperCase() + status.slice(1)}</span>
		</span>
	</header>

	{#if status === 'idle'}
		<section>
			<h3>Transport</h3>
			<div class="row" style="margin-bottom:8px">
				<button class:primary={transportMode === 'ws'} onclick={() => (transportMode = 'ws')}>
					WebSocket
				</button>
				<button
					class:primary={transportMode === 'ble'}
					onclick={() => (transportMode = 'ble')}
					disabled={!bleSupported}
				>
					Bluetooth
				</button>
			</div>

			{#if transportMode === 'ws'}
				<div class="row">
					<input bind:value={relayUrl} placeholder="ws://..." />
				</div>
			{:else if !bleSupported}
				<div style="color:var(--muted);font-size:12px">
					Web Bluetooth not supported (use Chrome)
				</div>
			{/if}

			<button class="primary mt" onclick={doConnect}>Connect Wallet</button>
		</section>
	{/if}

	{#if status === 'pairing' || status === 'confirming'}
		<section>
			<h3>Pairing</h3>
			{#if qrDataUrl}
				<div style="text-align:center;padding:12px 0">
					<img src={qrDataUrl} alt="QR Code" style="border-radius:8px" />
				</div>
			{/if}
			{#if pairingUri}
				<div class="uri-box">{pairingUri}</div>
			{/if}
			{#if pairingCode}
				<span class="field-label mt">Pairing Code</span>
				<div class="code">{pairingCode}</div>
				<div style="text-align:center;color:var(--muted);font-size:12px">
					Auto-accepting for demo...
				</div>
			{:else}
				<div style="text-align:center;color:var(--muted);font-size:13px;padding:8px 0">
					Scan the QR code with your WalletPair wallet...
				</div>
			{/if}
		</section>
	{/if}

	{#if status === 'connected' && account}
		<section>
			<h3>Account</h3>
			<span class="field-label">Address</span>
			<div class="addr">{account.address}</div>
			<span class="field-label mt">Chain</span>
			<div style="font-family:var(--mono);font-size:14px;padding:4px 0">
				{chainName(currentChainId)} ({currentChainId})
			</div>
		</section>

		<section>
			<h3>Sign Message</h3>
			<label for="sign-input">Message</label>
			<input id="sign-input" bind:value={signInput} />
			<button class="primary mt" onclick={doSignMessage}>Sign</button>
			{#if signResult}
				<span class="field-label mt">Signature</span>
				<div class="uri-box">{signResult}</div>
			{/if}
		</section>

		<section>
			<h3>Switch Chain</h3>
			<div class="row">
				<select bind:value={targetChainId}>
					<option value={1}>Ethereum (1)</option>
					<option value={11155111}>Sepolia (11155111)</option>
					<option value={137}>Polygon (137)</option>
				</select>
				<button class="primary" onclick={doSwitchChain}>Switch</button>
			</div>
		</section>

		<section>
			<div class="row">
				<button class="danger" onclick={doDisconnect}>Disconnect</button>
			</div>
		</section>
	{/if}

	{#if status === 'error'}
		<section>
			<button class="primary" onclick={() => (status = 'idle')}>Try Again</button>
		</section>
	{/if}

	<MessageLog entries={log} />
</main>
