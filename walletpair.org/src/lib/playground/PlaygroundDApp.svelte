<script lang="ts">
	import { DAppSession, WebSocketTransport } from 'walletpair-sdk';
	import type { DAppPhase } from 'walletpair-sdk';
	import QRCode from 'qrcode';
	import MessageLog from './MessageLog.svelte';
	import { playground, type LogEntry } from './state.svelte';

	let bleSupported = $state(false);
	let bleStatus = $state('');

	$effect(() => {
		import('walletpair-sdk/ble').then(m => { bleSupported = m.isWebBleSupported(); }).catch(() => {});
	});

	const STORAGE_KEY = 'walletpair.playground.evm.dapp';

	let phase: DAppPhase = $state('idle');
	let pairingUri = $state('');
	let sessionFingerprint = $state('------');
	let session: DAppSession | null = $state(null);
	let qrDataUrl = $state('');

	let metaName = $state('EVM Playground');
	let metaUrl = $state('https://walletpair.org');
	let metaIcon = $state('https://walletpair.org/favicon.png');
	let showMeta = $state(true);

	let walletCaps = $state<{ methods?: string[]; events?: string[]; chains?: string[] } | null>(null);
	let peerMeta = $state<{ name?: string; url?: string; icon?: string } | null>(null);
	let method = $state('wallet_getAccounts');
	let params = $state('{}');
	let log = $state<LogEntry[]>([]);

	let showReconnectPrompt = $state(false);

	const persistence = {
		save: (snapshot: string) => localStorage.setItem(STORAGE_KEY, snapshot),
		load: () => localStorage.getItem(STORAGE_KEY),
		clear: () => localStorage.removeItem(STORAGE_KEY)
	};

	$effect(() => {
		const snap = localStorage.getItem(STORAGE_KEY);
		if (snap && phase === 'idle' && !session) {
			showReconnectPrompt = true;
		}
	});

	function addLog(dir: 'out' | 'in' | 'err', type: string, detail = '') {
		const now = new Date();
		const time = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}.${now.getMilliseconds().toString().padStart(3, '0')}`;
		log = [...log, { dir, type, detail, time }];
	}

	async function renderQR(text: string) {
		try {
			qrDataUrl = await QRCode.toDataURL(text, {
				width: 200,
				margin: 2,
				color: { dark: '#e6edf3', light: '#141416' }
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
			playground.pairingUri = uri;
			renderQR(uri);
		});

		(s as any).on('sessionFingerprint', (fingerprint: string) => {
			sessionFingerprint = fingerprint;
			addLog('in', 'fingerprint', fingerprint);
		});

		s.on('walletJoined', ({ capabilities, meta }) => {
			walletCaps = capabilities as typeof walletCaps;
			peerMeta = meta as typeof peerMeta;
			if (walletCaps?.methods?.length) method = walletCaps.methods[0]!;
			addLog(
				'in',
				'join',
				`wallet=${meta?.name || 'unknown'} methods=[${walletCaps?.methods?.join(', ')}]`
			);
		});

		s.on('response', ({ id, ok, result }) => {
			addLog('in', 'res', `id=${id} ok=${ok} ${JSON.stringify(result)}`);
		});

		s.on('event', ({ event, data }) => {
			addLog('in', 'evt', `event=${event} ${JSON.stringify(data)}`);
		});
	}

	function createEvmDAppMeta() {
		return {
			name: metaName || 'EVM Playground',
			description: 'Interactive playground',
			url: metaUrl || 'https://walletpair.org',
			icon: metaIcon || 'https://walletpair.org/favicon.png'
		};
	}

	const evmMethods = ['wallet_getAccounts', 'wallet_signTransaction', 'wallet_signMessage', 'wallet_signTypedData', 'wallet_switchChain'];

	async function connect() {
		showReconnectPrompt = false;

		if (playground.transport === 'ble') {
			await connectBle();
			return;
		}

		const transport = new WebSocketTransport(playground.relayUrl);
		const s = new DAppSession({
			transport,
			meta: createEvmDAppMeta(),
			methods: evmMethods,
			chains: ['eip155:1'],
			persistence
		} as ConstructorParameters<typeof DAppSession>[0]);
		session = s;
		setupSessionEvents(s);

		try {
			await s.createPairing();
			sessionFingerprint = (s as any).sessionFingerprint ?? '------';
			addLog('out', 'create', `ch=${s.channelId.slice(0, 12)}...`);
		} catch (e: any) {
			addLog('err', 'connect', e.message);
		}
	}

	async function connectBle() {
		bleStatus = 'Creating channel...';
		try {
			const { WebBleCentralTransport } = await import('walletpair-sdk/ble');
			const transport = new WebBleCentralTransport();
			const s = new DAppSession({
				transport,
				meta: createEvmDAppMeta(),
				methods: evmMethods,
				chains: ['eip155:1'],
				persistence
			} as ConstructorParameters<typeof DAppSession>[0]);
			session = s;
			setupSessionEvents(s);

			await s.createPairing({ deferTransport: true });
			sessionFingerprint = (s as any).sessionFingerprint ?? '------';
			bleStatus = 'Channel created. Show QR to wallet, then click "Scan for Wallet".';
			addLog('out', 'create', `ch=${s.channelId.slice(0, 12)}... (BLE, deferred)`);
		} catch (e: any) {
			addLog('err', 'ble', e.message);
			bleStatus = `Error: ${e.message}`;
		}
	}

	async function bleScan() {
		if (!session) return;
		bleStatus = 'Scanning for wallet...';
		addLog('out', 'ble', 'Opening BLE device picker...');

		try {
			await session.connectTransport();
			bleStatus = 'BLE connected — waiting for wallet join';
			addLog('in', 'ble', 'Connected to wallet peripheral');
		} catch (e: any) {
			bleStatus = `BLE error: ${e.message}`;
			addLog('err', 'ble', e.message);
		}
	}

	async function sendRequest() {
		if (!session) return;
		const m = method === 'custom' ? prompt('Method name:') : method;
		if (!m) return;
		let p;
		try {
			p = JSON.parse(params);
		} catch {
			addLog('err', 'params', 'Invalid JSON');
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
		playground.pairingUri = '';
		sessionFingerprint = '------';
		qrDataUrl = '';
		walletCaps = null;
		peerMeta = null;
		log = [];
		showReconnectPrompt = false;
		persistence.clear();
	}

	async function reconnectSession() {
		showReconnectPrompt = false;
		const transport = new WebSocketTransport(playground.relayUrl);
		const s = new DAppSession({
			transport,
			meta: {
				name: metaName || 'EVM Playground',
				description: 'Interactive playground',
				url: metaUrl || 'https://walletpair.org',
				icon: metaIcon || 'https://walletpair.org/favicon.png'
			},
			persistence
		} as ConstructorParameters<typeof DAppSession>[0]);
		session = s;
		setupSessionEvents(s);

		try {
			const restored = await s.restoreFromPersistence();
			if (!restored) {
				addLog('err', 'reconnect', 'Failed to restore session');
				persistence.clear();
				session = null;
				return;
			}
			sessionFingerprint = s.sessionFingerprint || '------';
			walletCaps = (s.walletCapabilities as typeof walletCaps) ?? null;
			if (walletCaps?.methods?.length) method = walletCaps.methods[0]!;
			addLog('out', 'reconnect', `ch=${s.channelId.slice(0, 12)}... restoring...`);
			await s.reconnect();
		} catch (e: any) {
			addLog('err', 'reconnect', e.message);
		}
	}

	function dismissReconnect() {
		showReconnectPrompt = false;
		persistence.clear();
	}

	let copied = $state(false);
	function copyUri() {
		navigator.clipboard.writeText(pairingUri);
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}

	function onMethodChange() {
		if (method === 'wallet_signMessage') params = '{"message": "Hello WalletPair!"}';
		else if (method === 'wallet_signTypedData') params = '{}';
		else if (method === 'wallet_sendTransaction')
			params = '{"chain":"eip155:1","address":"0x...","tx":{"to":"0x...","value":"0x0","data":"0x","type":"0x2","chainId":"0x1"}}';
		else params = '{}';
	}
</script>

<div class="panel">
	<div class="panel-header">
		<h3>dApp <span class="badge evm">EVM</span></h3>
		<span class="status">
			<span
				class="dot"
				class:connected={phase === 'connected'}
				class:waiting={phase === 'waiting' || phase === 'pending_accept'}
				class:error={phase === 'closed' || phase === 'disconnected'}
			></span>
			{phase}
		</span>
	</div>

	{#if showReconnectPrompt && phase === 'idle'}
		<div class="reconnect-prompt">
			<div class="reconnect-text">Previous EVM session found. Resume or start fresh?</div>
			<div class="row">
				<button class="btn-primary" onclick={reconnectSession}>Reconnect</button>
				<button class="btn-ghost" onclick={dismissReconnect}>New Session</button>
			</div>
		</div>
	{/if}

	<!-- Transport selector -->
	{#if phase === 'idle'}
		<div class="field">
			<label>Transport</label>
			<div class="row">
				<button class="transport-btn" class:active={playground.transport === 'ws'} onclick={() => (playground.transport = 'ws')}>WebSocket</button>
				<button class="transport-btn" class:active={playground.transport === 'ble'} onclick={() => (playground.transport = 'ble')} disabled={!bleSupported}>
					Bluetooth {!bleSupported ? '(unsupported)' : ''}
				</button>
			</div>
		</div>
	{/if}

	{#if playground.transport === 'ws'}
		<div class="field">
			<label>Relay URL</label>
			<div class="row">
				<input bind:value={playground.relayUrl} placeholder="wss://..." />
				{#if phase === 'idle'}
					<button class="btn-primary" onclick={connect}>Connect</button>
				{:else}
					<button class="btn-danger" onclick={reset}>Reset</button>
				{/if}
			</div>
		</div>
	{:else}
		<div class="field">
			<div class="row">
				{#if phase === 'idle'}
					<button class="btn-primary" onclick={connect}>Create Channel</button>
				{:else}
					<button class="btn-primary" onclick={bleScan} disabled={phase === 'connected'}>Scan for Wallet</button>
					<button class="btn-danger" onclick={reset}>Reset</button>
				{/if}
			</div>
			{#if bleStatus}
				<div class="ble-status">{bleStatus}</div>
			{/if}
		</div>
	{/if}

	<!-- Metadata (collapsible) -->
	<div class="field">
		<button class="meta-toggle" onclick={() => (showMeta = !showMeta)}>
			{showMeta ? '▾' : '▸'} Metadata
		</button>
		{#if showMeta}
			<input bind:value={metaName} placeholder="dApp name" />
			<input bind:value={metaUrl} placeholder="dApp URL (default: current origin)" />
			<input bind:value={metaIcon} placeholder="Icon URL (default: /favicon.png)" />
		{/if}
	</div>

	<!-- QR Code & URI -->
	{#if phase !== 'idle'}
		<div class="field">
			<label>Pairing QR</label>
			{#if qrDataUrl}
				<div class="qr-wrap">
					<img src={qrDataUrl} alt="QR Code" />
				</div>
			{/if}
			<div class="uri-box">{pairingUri || '--'}</div>
			<button class="btn-sm" onclick={copyUri} disabled={!pairingUri}>{copied ? 'Copied!' : 'Copy URI'}</button>
		</div>

		{#if sessionFingerprint !== '------'}
			<div class="field">
				<label>Session Fingerprint</label>
				<div class="fingerprint">{sessionFingerprint}</div>
			</div>
		{/if}
	{/if}

	<!-- Send Requests -->
	{#if phase === 'connected'}
		{#if peerMeta}
			<div class="peer-info">
				<span class="peer-label">Connected to</span>
				<span class="peer-name">{peerMeta.name || 'Unknown Wallet'}</span>
				{#if peerMeta.url}<span class="peer-url">{peerMeta.url}</span>{/if}
			</div>
		{/if}

		{#if walletCaps}
			<div class="field">
				<label>Wallet Capabilities</label>
				<div class="caps-box">
					<div class="caps-row">
						<span class="caps-icon">⚡</span>
						<span class="caps-label">Methods</span>
						<div class="caps-tags">
							{#each walletCaps.methods || [] as m}
								<button class="cap-tag" class:active={method === m} onclick={() => { method = m; onMethodChange(); }}>{m}</button>
							{/each}
						</div>
					</div>
					<div class="caps-row">
						<span class="caps-icon">📡</span>
						<span class="caps-label">Events</span>
						<div class="caps-tags">
							{#each walletCaps.events || [] as e}
								<span class="cap-tag readonly">{e}</span>
							{/each}
						</div>
					</div>
					<div class="caps-row">
						<span class="caps-icon">🔗</span>
						<span class="caps-label">Chains</span>
						<div class="caps-tags">
							{#each walletCaps.chains || [] as c}
								<span class="cap-tag readonly">{c}</span>
							{/each}
						</div>
					</div>
				</div>
			</div>
		{/if}

		<div class="field">
			<label>Send Request — <code>{method}</code></label>
			<select bind:value={method} onchange={onMethodChange}>
				{#if walletCaps?.methods?.length}
					{#each walletCaps.methods as m}
						<option value={m}>{m}</option>
					{/each}
				{:else}
					<option value="wallet_getAccounts">wallet_getAccounts</option>
					<option value="wallet_signMessage">wallet_signMessage</option>
					<option value="wallet_signTypedData">wallet_signTypedData</option>
					<option value="wallet_sendTransaction">wallet_sendTransaction</option>
				{/if}
				<option value="custom">custom...</option>
			</select>
			<textarea bind:value={params} rows="3" placeholder="JSON params"></textarea>
			<div class="row">
				<button class="btn-primary" onclick={sendRequest}>Send</button>
				<button class="btn-sm" onclick={sendPing}>Ping</button>
				<button class="btn-danger" onclick={closeSession}>Close</button>
			</div>
		</div>
	{/if}

	<MessageLog entries={log} />
</div>

<style>
	.panel {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		padding: var(--space-4);
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		overflow: hidden;
	}

	.panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.panel-header h3 {
		font-family: var(--font-mono);
		font-size: 1rem;
		font-weight: 600;
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.badge {
		font-size: 0.65rem;
		font-weight: 500;
		border-radius: var(--radius-sm);
		padding: 1px 6px;
	}

	.badge.evm {
		color: #a78bfa;
		background: rgba(167, 139, 250, 0.1);
		border: 1px solid rgba(167, 139, 250, 0.3);
	}

	.status {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: 0.8rem;
		color: var(--color-text-muted);
		font-family: var(--font-mono);
	}

	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--color-text-subtle);
	}
	.dot.connected {
		background: var(--color-success);
	}
	.dot.waiting {
		background: var(--color-warning);
	}
	.dot.error {
		background: var(--color-error);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	label {
		font-size: 0.75rem;
		color: var(--color-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.row {
		display: flex;
		gap: var(--space-2);
	}

	input,
	select,
	textarea {
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		padding: var(--space-2) var(--space-3);
		color: var(--color-text);
		font-family: var(--font-mono);
		font-size: 0.8rem;
		width: 100%;
	}

	textarea {
		resize: vertical;
		min-height: 60px;
	}

	input:focus,
	select:focus,
	textarea:focus {
		outline: none;
		border-color: var(--color-accent);
	}

	button {
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		background: var(--color-surface-2);
		color: var(--color-text-muted);
		font-size: 0.8rem;
		font-family: var(--font-mono);
		white-space: nowrap;
		transition:
			background 0.15s,
			border-color 0.15s;
	}

	button:hover {
		background: var(--color-border);
	}

	.btn-primary {
		background: var(--color-accent);
		border-color: var(--color-accent);
		color: #fff;
	}
	.btn-primary:hover {
		background: var(--color-accent-hover);
	}

	.btn-danger {
		color: var(--color-error);
		border-color: var(--color-error);
		background: transparent;
	}
	.btn-danger:hover {
		background: rgba(239, 68, 68, 0.1);
	}

	.btn-sm {
		font-size: 0.7rem;
		padding: var(--space-1) var(--space-2);
	}

	.qr-wrap {
		text-align: center;
		padding: var(--space-2) 0;
	}

	.qr-wrap img {
		display: inline-block;
		border-radius: var(--radius-md);
		width: 160px;
		height: 160px;
	}

	.uri-box {
		font-family: var(--font-mono);
		font-size: 0.7rem;
		color: var(--color-text-subtle);
		word-break: break-all;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		padding: var(--space-2);
		max-height: 60px;
		overflow-y: auto;
	}

	.fingerprint {
		font-family: var(--font-mono);
		font-size: 1.5rem;
		font-weight: 600;
		text-align: center;
		color: var(--color-accent);
		letter-spacing: 0.15em;
	}

	.meta-toggle {
		background: none;
		border: none;
		color: var(--color-text-muted);
		font-family: var(--font-mono);
		font-size: 0.75rem;
		padding: 0;
		cursor: pointer;
		text-align: left;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
	.meta-toggle:hover {
		color: var(--color-text);
	}

	.reconnect-prompt { background: var(--color-surface-2); border: 1px solid var(--color-accent); border-radius: var(--radius-md); padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: var(--space-3); }
	.reconnect-text { font-size: 0.85rem; color: var(--color-text); }
	.btn-ghost { background: transparent; border: 1px solid var(--color-border); color: var(--color-text-muted); }
	.btn-ghost:hover { border-color: var(--color-text-subtle); color: var(--color-text); }

	.caps-box { background: var(--color-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: var(--space-3); display: flex; flex-direction: column; gap: var(--space-3); }
	.caps-row { display: flex; align-items: flex-start; gap: var(--space-2); font-size: 0.8rem; }
	.caps-icon { flex-shrink: 0; font-size: 0.75rem; line-height: 1.8; }
	.caps-label { flex-shrink: 0; min-width: 4.5em; font-family: var(--font-mono); font-size: 0.7rem; font-weight: 600; color: var(--color-text-subtle); text-transform: uppercase; letter-spacing: 0.03em; line-height: 1.8; }
	.caps-tags { display: flex; flex-wrap: wrap; gap: 4px; }
	.cap-tag { font-family: var(--font-mono); font-size: 0.7rem; padding: 2px 8px; border-radius: var(--radius-sm); border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-text-muted); cursor: pointer; transition: border-color 0.15s, color 0.15s, background 0.15s; white-space: nowrap; }
	.cap-tag:hover { border-color: var(--color-accent); color: var(--color-text); }
	.cap-tag.active { border-color: var(--color-accent); background: rgba(59, 130, 246, 0.15); color: var(--color-accent); }
	.cap-tag.readonly { cursor: default; }
	.cap-tag.readonly:hover { border-color: var(--color-border); color: var(--color-text-muted); }

	.transport-btn { flex: 1; text-align: center; padding: var(--space-2) var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-surface-2); color: var(--color-text-muted); font-size: 0.8rem; font-family: var(--font-mono); transition: border-color 0.15s, background 0.15s; }
	.transport-btn:hover { border-color: var(--color-text-subtle); }
	.transport-btn.active { border-color: var(--color-accent); background: rgba(59, 130, 246, 0.1); color: var(--color-accent); }
	.transport-btn:disabled { opacity: 0.35; cursor: not-allowed; }
	.ble-status { font-size: 0.75rem; color: var(--color-text-muted); font-family: var(--font-mono); }

	.peer-info { display: flex; flex-direction: column; gap: 2px; padding: var(--space-3); background: var(--color-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md); }
	.peer-label { font-size: 0.65rem; color: var(--color-text-subtle); text-transform: uppercase; letter-spacing: 0.05em; }
	.peer-name { font-family: var(--font-mono); font-size: 0.85rem; font-weight: 600; color: var(--color-text); }
	.peer-url { font-family: var(--font-mono); font-size: 0.7rem; color: var(--color-text-muted); }
</style>
