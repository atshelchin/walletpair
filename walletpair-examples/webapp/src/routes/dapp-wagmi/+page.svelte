<script lang="ts">
	import { onMount } from 'svelte';
	import {
		createConfig,
		http,
		connect,
		disconnect,
		signMessage,
		switchChain,
		watchAccount,
		watchChainId,
		type Config
	} from '@wagmi/core';
	import { mainnet, sepolia, polygon } from 'viem/chains';
	import { walletPair } from 'walletpair-sdk/evm/wagmi';
	import { WebBleCentralTransport, isWebBleSupported } from 'walletpair-sdk/ble';
	import type { WalletPairProvider } from 'walletpair-sdk/evm';
	import QRCode from 'qrcode';
	import MessageLog from '$lib/components/MessageLog.svelte';

	// ---------------------------------------------------------------------------
	// State
	// ---------------------------------------------------------------------------
	let transportMode: 'ws' | 'ble' = $state('ws');
	let relayUrl = $state('ws://localhost:8080/v1');
	let bleSupported = $state(false);
	let bleStatus = $state('');

	let config: Config | null = $state(null);
	let eip1193Provider: WalletPairProvider | null = $state(null);
	let status: 'idle' | 'pairing' | 'ble_scan' | 'connected' | 'error' =
		$state('idle');

	let pairingUri = $state('');
	let sessionFingerprint = $state('');
	let qrDataUrl = $state('');

	let account = $state<{ address: string; chainId: number } | null>(null);
	let currentChainId = $state(0);

	// Request section
	let method = $state('wallet_getAccounts');
	let params = $state('{}');

	// Sign message section
	let signInput = $state('Hello from WalletPair + wagmi!');
	let signResult = $state('');

	// Switch chain
	let targetChainId = $state(11155111);

	let log = $state<{ dir: 'out' | 'in' | 'err'; type: string; detail: string }[]>([]);

	// Promise resolver for bridging BLE scan click → connector flow
	let bleScanResolve: (() => void) | null = $state(null);

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

	function copyUri() {
		navigator.clipboard.writeText(pairingUri);
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
		sessionFingerprint = '';
		qrDataUrl = '';
		signResult = '';
		bleStatus = '';
		bleScanResolve = null;

		const isBle = transportMode === 'ble';
		const transport = isBle ? new WebBleCentralTransport() : undefined;

		const wpConnector = walletPair({
			relayUrl: !isBle ? relayUrl : undefined,
			transport,
			meta: { name: 'WalletPair wagmi dApp', description: 'WalletPair wagmi example', url: location.origin, icon: '' },

			// 1) QR generated
			onPairingUri: (uri) => {
				pairingUri = uri;
				renderQR(uri);
				addLog('in', 'pairing_uri', uri.slice(0, 60) + '...');

				if (isBle) {
					status = 'ble_scan';
					bleStatus = 'Channel created. Show QR to wallet, then click Scan.';
				}
			},

			// 2) Session fingerprint available
			onSessionFingerprint: (fingerprint: string) => {
				sessionFingerprint = fingerprint;
				addLog('in', 'session_fingerprint', fingerprint);
			},

			// 3) BLE only: wait for user to click "Scan for Wallet"
			onBeforeTransportConnect: isBle
				? () =>
						new Promise<void>((resolve) => {
							bleScanResolve = resolve;
						})
				: undefined
		} as Parameters<typeof walletPair>[0]);

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

		// Watch account and chain changes (from wallet push events)
		watchAccount(cfg, {
			onChange: (acc) => {
				if (acc.address) {
					account = { address: acc.address, chainId: acc.chainId ?? 1 };
					addLog('in', 'accountsChanged', `${acc.address.slice(0, 10)}... chain=${acc.chainId}`);
				} else if (account) {
					account = null;
					addLog('in', 'disconnected', '');
				}
			}
		});

		watchChainId(cfg, {
			onChange: (id) => {
				currentChainId = id;
				addLog('in', 'chainChanged', `${id}`);
			}
		});

		// Connect
		try {
			addLog('out', 'connect', `mode=${transportMode}`);
			const result = await connect(cfg, { connector: cfg.connectors[0]! });

			account = { address: result.accounts[0] ?? '', chainId: result.chainId };
			currentChainId = result.chainId;
			status = 'connected';

			// Get the EIP-1193 provider for raw requests + event listening
			const provider = (await cfg.connectors[0]!.getProvider()) as WalletPairProvider;
			eip1193Provider = provider;

			// Listen to wallet push events via EIP-1193
			provider.on('accountsChanged', (accounts: string[]) => {
				addLog('in', 'evt', `accountsChanged ${JSON.stringify(accounts)}`);
			});
			provider.on('chainChanged', (chainId: string) => {
				addLog('in', 'evt', `chainChanged ${chainId}`);
			});

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
	// UI button handlers — bridge clicks into the connector's Promise flow
	// ---------------------------------------------------------------------------
	function triggerBleScan() {
		if (bleScanResolve) {
			addLog('out', 'ble_scan', 'Opening BLE device picker...');
			bleStatus = 'Scanning...';
			bleScanResolve();
			bleScanResolve = null;
		}
	}

	// ---------------------------------------------------------------------------
	// wagmi actions (post-connect)
	// ---------------------------------------------------------------------------

	/** Send arbitrary request via the underlying EIP-1193 provider. */
	async function sendRequest() {
		if (!eip1193Provider) return;
		const m = method === 'custom' ? prompt('Method name:') : method;
		if (!m) return;
		let p;
		try {
			p = JSON.parse(params);
		} catch {
			alert('Invalid JSON params');
			return;
		}
		addLog('out', 'req', `method=${m}`);
		try {
			const result = await eip1193Provider.request({
				method: m,
				params: Object.keys(p).length > 0 ? p : undefined
			});
			addLog('in', 'res', `ok=true ${JSON.stringify(result)}`);
		} catch (e: any) {
			addLog('err', 'res', `ok=false ${e.message}`);
		}
	}

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

	function sendPing() {
		if (!eip1193Provider) return;
		const session = eip1193Provider.getSession();
		session.ping();
		addLog('out', 'ping', '');
	}

	function closeSession() {
		if (!eip1193Provider) return;
		const session = eip1193Provider.getSession();
		session.close();
		addLog('out', 'close', 'normal');
		status = 'idle';
		account = null;
		config = null;
		eip1193Provider = null;
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
		sessionFingerprint = '';
		qrDataUrl = '';
		signResult = '';
		bleStatus = '';
		config = null;
		eip1193Provider = null;
		bleScanResolve = null;
	}

	function onMethodChange() {
		if (method === 'wallet_signMessage') params = '{"message": "Hello WalletPair!"}';
		else params = '{}';
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
				class:waiting={status === 'pairing' || status === 'ble_scan'}
				class:closed={status === 'error'}
			></span>
			<span>{status.charAt(0).toUpperCase() + status.slice(1).replace('_', ' ')}</span>
		</span>
	</header>

	<!-- Step 1: Transport + Connect -->
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

	<!-- Step 2: Pairing -->
	{#if status === 'pairing' || status === 'ble_scan'}
		<section>
			<h3>Pairing</h3>
			{#if qrDataUrl}
				<div style="text-align:center;padding:12px 0">
					<img src={qrDataUrl} alt="QR Code" style="border-radius:8px" />
				</div>
			{/if}
			{#if pairingUri}
				<div class="uri-box">{pairingUri}</div>
				<button onclick={copyUri}>Copy URI</button>
			{/if}

			<!-- BLE: wallet scans QR first, then user clicks Scan -->
			{#if status === 'ble_scan'}
				<div style="color:var(--muted);font-size:12px;margin-top:6px">{bleStatus}</div>
				<button class="primary mt" onclick={triggerBleScan}>Scan for Wallet</button>
			{/if}

			<!-- WS: waiting for wallet to join -->
			{#if status === 'pairing' && !sessionFingerprint}
				<div style="color:var(--muted);font-size:13px;padding:8px 0;text-align:center">
					Waiting for wallet to scan QR and join...
				</div>
			{/if}

			<!-- Session Fingerprint (shown after wallet joins, auto-accepted) -->
			{#if sessionFingerprint}
				<span class="field-label mt">Session Fingerprint (verify with wallet)</span>
				<div class="code">{sessionFingerprint}</div>
			{/if}
		</section>
	{/if}

	<!-- Step 3: Connected -->
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

		<!-- Raw request (like dApp version) -->
		<section>
			<h3>Send Request</h3>
			<label for="method-select">Method</label>
			<select id="method-select" bind:value={method} onchange={onMethodChange}>
				<option value="wallet_getAccounts">wallet_getAccounts</option>
				<option value="wallet_signMessage">wallet_signMessage</option>
				<option value="custom">custom...</option>
			</select>
			<label for="params-input" class="mt">Params (JSON)</label>
			<textarea id="params-input" bind:value={params}></textarea>
			<div class="row mt">
				<button class="primary" onclick={sendRequest}>Send Request</button>
				<button onclick={sendPing}>Ping</button>
				<button class="danger" onclick={closeSession}>Close</button>
			</div>
		</section>

		<!-- wagmi signMessage -->
		<section>
			<h3>Sign Message (wagmi)</h3>
			<label for="sign-input">Message</label>
			<input id="sign-input" bind:value={signInput} />
			<button class="primary mt" onclick={doSignMessage}>Sign</button>
			{#if signResult}
				<span class="field-label mt">Signature</span>
				<div class="uri-box">{signResult}</div>
			{/if}
		</section>

		<!-- wagmi switchChain -->
		<section>
			<h3>Switch Chain (wagmi)</h3>
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
