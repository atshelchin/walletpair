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
	let sessionFingerprint = $state('------');
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

		(s as unknown as { on: (event: string, handler: (data: string) => void) => void }).on('sessionFingerprint', (fingerprint) => {
			sessionFingerprint = fingerprint;
			addLog('in', 'session_fingerprint', fingerprint);
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
		const s = new DAppSession({ transport, meta: { name: 'WalletPair dApp', description: 'WalletPair example dApp', url: location.origin, icon: '' } } as ConstructorParameters<typeof DAppSession>[0]);
		session = s;
		setupSessionEvents(s);

		try {
			await s.createPairing();
			sessionFingerprint = (s as unknown as { sessionFingerprint: string }).sessionFingerprint ?? '------';
			addLog('out', 'create', `ch=${s.channelId.slice(0, 12)}...`);
		} catch (e: any) {
			addLog('err', 'connect', e.message);
		}
	}

	// ---------------------------------------------------------------------------
	// BLE Connect (two-phase: create channel first, scan later)
	// ---------------------------------------------------------------------------
	async function connectBleCreate() {
		const transport = new WebBleCentralTransport();
		const s = new DAppSession({ transport, meta: { name: 'WalletPair dApp', description: 'WalletPair example dApp', url: location.origin, icon: '' } } as ConstructorParameters<typeof DAppSession>[0]);
		session = s;
		setupSessionEvents(s);

		try {
			// Phase 1: create channel + keys, show QR, but DON'T connect BLE yet
			await s.createPairing({ deferTransport: true });
			sessionFingerprint = (s as unknown as { sessionFingerprint: string }).sessionFingerprint ?? '------';
			addLog('out', 'create', `ch=${s.channelId.slice(0, 12)}... (BLE, deferred)`);
			bleStatus = 'Channel created. Show QR to wallet, then click Scan.';
		} catch (e: any) {
			addLog('err', 'ble_create', e.message);
			bleStatus = `Error: ${e.message}`;
		}
	}

	async function bleScan() {
		if (!session) return;
		bleStatus = 'Scanning for wallet...';
		addLog('out', 'ble', 'Opening BLE device picker...');

		try {
			// Phase 2: now connect transport (triggers browser BLE device picker)
			await session.connectTransport();
			bleStatus = 'BLE connected — waiting for wallet join';
			addLog('in', 'ble', 'Connected to wallet peripheral');
		} catch (e: any) {
			bleStatus = `BLE error: ${e.message}`;
			addLog('err', 'ble', e.message);
		}
	}

	// ---------------------------------------------------------------------------
	// Actions
	// ---------------------------------------------------------------------------
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
		sessionFingerprint = '------';
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

		{#if sessionFingerprint !== '------'}
			<span class="field-label mt">Session Fingerprint (verify with wallet)</span>
			<div class="code">{sessionFingerprint}</div>
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
