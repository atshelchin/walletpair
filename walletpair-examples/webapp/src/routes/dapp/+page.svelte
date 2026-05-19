<script lang="ts">
	import { DAppSession, WebSocketTransport } from 'walletpair-sdk';
	import { WebBleCentralTransport, isWebBleSupported } from 'walletpair-sdk/ble';
	import type { DAppPhase } from 'walletpair-sdk';
	import QRCode from 'qrcode';
	import MessageLog from '$lib/components/MessageLog.svelte';

	// ---------------------------------------------------------------------------
	// State
	// ---------------------------------------------------------------------------
	let transportMode: 'ws' | 'ble' = $state('ws');
	let relayUrl = $state('ws://localhost:8080/v1');
	let phase: DAppPhase = $state('idle');
	let pairingUri = $state('');
	let pairingCode = $state('------');
	let session: DAppSession | null = $state(null);
	let qrDataUrl = $state('');
	let bleSupported = $state(false);
	let bleStatus = $state('');

	let method = $state('wallet_getAccounts');
	let params = $state('{}');
	let log = $state<{ dir: 'out' | 'in' | 'err'; type: string; detail: string }[]>([]);

	// Check BLE support on mount
	$effect(() => {
		bleSupported = isWebBleSupported();
	});

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

	function setupSessionEvents(s: DAppSession) {
		s.on('phase', (p) => {
			phase = p;
			addLog('in', 'phase', p);
		});

		s.on('pairingUri', (uri) => {
			pairingUri = uri;
			renderQR(uri);
		});

		s.on('pairingCode', (code) => {
			pairingCode = code;
			addLog('in', 'pairing_code', code);
		});

		s.on('walletJoined', ({ pubkey, capabilities }) => {
			addLog(
				'in',
				'join',
				`peer=${pubkey?.slice(0, 12)}... chains=${JSON.stringify(capabilities?.chains || [])}`
			);
		});

		s.on('response', ({ id, ok, data }) => {
			addLog('in', 'res', `id=${id} ok=${ok} ${JSON.stringify(data)}`);
		});

		s.on('event', ({ event, data }) => {
			addLog('in', 'evt', `event=${event} ${JSON.stringify(data)}`);
		});
	}

	// ---------------------------------------------------------------------------
	// WebSocket Connect
	// ---------------------------------------------------------------------------
	async function connectWs() {
		const transport = new WebSocketTransport(relayUrl);
		const s = new DAppSession({ transport, name: 'WalletPair dApp' });
		session = s;
		setupSessionEvents(s);

		try {
			await s.createPairing();
			addLog('out', 'create', `ch=${s.channelId.slice(0, 12)}...`);
		} catch (e: any) {
			addLog('err', 'connect', e.message);
		}
	}

	// ---------------------------------------------------------------------------
	// BLE Connect
	// ---------------------------------------------------------------------------
	async function connectBleCreate() {
		// For BLE, the dApp creates a channel locally (no relay), then scans for the wallet
		const transport = new WebBleCentralTransport();
		const s = new DAppSession({ transport, name: 'WalletPair dApp' });
		session = s;
		setupSessionEvents(s);

		// BLE mode: we generate the channel/keys but don't connect transport yet
		// The session will build a URI without relay param
		try {
			await s.createPairing();
			addLog('out', 'create', `ch=${s.channelId.slice(0, 12)}... (BLE)`);
			bleStatus = 'Channel created. Show QR to wallet, then click Scan.';
		} catch (e: any) {
			addLog('err', 'ble_create', e.message);
			bleStatus = `Error: ${e.message}`;
		}
	}

	async function bleScan() {
		if (!session) return;
		bleStatus = 'Scanning for wallet...';
		addLog('out', 'ble', 'Requesting BLE device...');

		// The transport's connect() triggers the browser's BLE device picker
		try {
			// Re-create session with BLE transport and scan
			const transport = new WebBleCentralTransport();
			const s = new DAppSession({ transport, name: 'WalletPair dApp' });

			// Copy the existing channel state
			const serialized = session.serialize();
			session.destroy();
			session = s;
			s.restore(serialized);
			setupSessionEvents(s);

			await transport.connect();
			bleStatus = 'BLE connected - waiting for wallet join';
			addLog('in', 'ble', 'Connected to wallet peripheral');
		} catch (e: any) {
			bleStatus = `BLE error: ${e.message}`;
			addLog('err', 'ble', e.message);
		}
	}

	// ---------------------------------------------------------------------------
	// Actions
	// ---------------------------------------------------------------------------
	function acceptWallet() {
		session?.acceptWallet();
		addLog('out', 'accept', '');
	}

	function rejectWallet() {
		session?.rejectWallet();
		addLog('out', 'reject', 'user_rejected');
	}

	async function sendRequest() {
		if (!session) return;
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
			await session.request(m, Object.keys(p).length > 0 ? p : undefined);
		} catch (e: any) {
			addLog('err', 'req_error', e.message);
		}
	}

	function sendPing() {
		session?.ping();
		addLog('out', 'ping', '');
	}

	function closeSession() {
		session?.close();
		addLog('out', 'close', 'normal');
	}

	function reset() {
		session?.destroy();
		session = null;
		phase = 'idle';
		pairingUri = '';
		pairingCode = '------';
		qrDataUrl = '';
		bleStatus = '';
	}

	function copyUri() {
		navigator.clipboard.writeText(pairingUri);
	}

	function onMethodChange() {
		if (method === 'wallet_signMessage') params = '{"message": "Hello WalletPair!"}';
		else params = '{}';
	}
</script>

<main>
	<header>
		<span>WalletPair &mdash; dApp</span>
		<span class="status">
			<span class="dot {phase === 'connected' ? 'connected' : phase === 'closed' ? 'closed' : phase === 'idle' ? '' : phase === 'disconnected' ? 'disconnected' : 'waiting'}"></span>
			<span>{phase.charAt(0).toUpperCase() + phase.slice(1).replace('_', ' ')}</span>
		</span>
	</header>

	<section>
		<h3>Transport</h3>
		<div class="row" style="margin-bottom:8px">
			<button class:primary={transportMode === 'ws'} onclick={() => (transportMode = 'ws')}>
				WebSocket
			</button>
			<button class:primary={transportMode === 'ble'} onclick={() => (transportMode = 'ble')}>
				Bluetooth
			</button>
		</div>

		{#if transportMode === 'ws'}
			<div class="row">
				<input bind:value={relayUrl} placeholder="ws://..." />
				{#if phase === 'idle'}
					<button class="primary" onclick={connectWs}>Connect</button>
				{/if}
			</div>
		{:else}
			{#if !bleSupported}
				<div style="color:var(--muted);font-size:12px">
					Web Bluetooth not supported in this browser (use Chrome)
				</div>
			{:else}
				<div class="row">
					<button class="primary" onclick={connectBleCreate} disabled={phase !== 'idle'}>
						Create Channel
					</button>
					<button
						class="primary"
						onclick={bleScan}
						disabled={phase === 'idle' || phase === 'connected'}
					>
						Scan for Wallet
					</button>
				</div>
				{#if bleStatus}
					<div style="color:var(--muted);font-size:12px;margin-top:6px">{bleStatus}</div>
				{/if}
			{/if}
		{/if}

		{#if phase !== 'idle'}
			<button class="danger mt" onclick={reset}>Reset</button>
		{/if}
	</section>

	<section>
		<h3>Pairing</h3>
		<span class="field-label">Pairing URI (share with wallet)</span>
		{#if qrDataUrl}
			<div style="text-align:center;padding:12px 0">
				<img src={qrDataUrl} alt="QR Code" style="border-radius:8px" />
			</div>
		{/if}
		<div class="uri-box">{pairingUri || '--'}</div>
		<button onclick={copyUri} disabled={!pairingUri}>Copy URI</button>

		{#if phase === 'pending_accept'}
			<span class="field-label mt">Pairing Code (verify with wallet)</span>
			<div class="code">{pairingCode}</div>
			<div class="row mt">
				<button class="primary" onclick={acceptWallet}>Accept Wallet</button>
				<button class="danger" onclick={rejectWallet}>Reject</button>
			</div>
		{/if}
	</section>

	{#if phase === 'connected'}
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
	{/if}

	<MessageLog entries={log} />
</main>
