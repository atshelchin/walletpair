<script lang="ts">
	import { DAppSession, WebSocketTransport } from 'walletpair-sdk';
	import type { DAppPhase } from 'walletpair-sdk';
	import QRCode from 'qrcode';
	import MessageLog from './MessageLog.svelte';
	import { playground, type LogEntry } from './state.svelte';

	let phase: DAppPhase = $state('idle');
	let pairingUri = $state('');
	let sessionFingerprint = $state('------');
	let session: DAppSession | null = $state(null);
	let qrDataUrl = $state('');

	let metaName = $state('Protocol Playground');
	let metaUrl = $state('https://walletpair.org');
	let metaIcon = $state('https://walletpair.org/favicon.png');
	let showMeta = $state(true);

	let walletCaps = $state<{ methods?: string[]; events?: string[]; chains?: string[] } | null>(null);
	let method = $state('');
	let params = $state('{}');
	let log = $state<LogEntry[]>([]);

	function addLog(dir: 'out' | 'in' | 'err', type: string, detail = '') {
		log = [...log, { dir, type, detail }];
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

	async function connect() {
		const transport = new WebSocketTransport(playground.relayUrl);
		const s = new DAppSession({
			transport,
			meta: {
				name: metaName || 'Protocol Playground',
				description: 'Network-agnostic playground',
				url: metaUrl || location.origin,
				icon: metaIcon || 'https://walletpair.org/favicon.png'
			}
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

	async function sendRequest() {
		if (!session) return;
		let p;
		try {
			p = JSON.parse(params);
		} catch {
			addLog('err', 'params', 'Invalid JSON');
			return;
		}
		addLog('out', 'req', `method=${method}`);
		try {
			await session.request(method, Object.keys(p).length > 0 ? p : undefined);
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
		method = '';
		log = [];
	}

	let copied = $state(false);
	function copyUri() {
		navigator.clipboard.writeText(pairingUri);
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}
</script>

<div class="panel">
	<div class="panel-header">
		<h3>dApp <span class="badge">Protocol</span></h3>
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

	{#if phase === 'connected'}
		<!-- Negotiated capabilities -->
		{#if walletCaps}
			<div class="field">
				<label>Negotiated Capabilities</label>
				<div class="caps">
					<span class="cap-label">Methods:</span> {walletCaps.methods?.join(', ') || 'none'}
				</div>
				<div class="caps">
					<span class="cap-label">Events:</span> {walletCaps.events?.join(', ') || 'none'}
				</div>
				<div class="caps">
					<span class="cap-label">Chains:</span> {walletCaps.chains?.join(', ') || 'none'}
				</div>
			</div>
		{/if}

		<div class="field">
			<label>Send Request</label>
			{#if walletCaps?.methods?.length}
				<select bind:value={method}>
					{#each walletCaps.methods as m}
						<option value={m}>{m}</option>
					{/each}
				</select>
			{:else}
				<input bind:value={method} placeholder="method name" />
			{/if}
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
		color: var(--color-accent);
		background: rgba(59, 130, 246, 0.1);
		border: 1px solid rgba(59, 130, 246, 0.3);
		border-radius: var(--radius-sm);
		padding: 1px 6px;
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
	.dot.connected { background: var(--color-success); }
	.dot.waiting { background: var(--color-warning); }
	.dot.error { background: var(--color-error); }

	.field { display: flex; flex-direction: column; gap: var(--space-2); }
	label { font-size: 0.75rem; color: var(--color-text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
	.row { display: flex; gap: var(--space-2); }

	input, textarea {
		background: var(--color-bg); border: 1px solid var(--color-border); border-radius: var(--radius-sm);
		padding: var(--space-2) var(--space-3); color: var(--color-text); font-family: var(--font-mono); font-size: 0.8rem; width: 100%;
	}
	textarea { resize: vertical; min-height: 60px; }
	input:focus, textarea:focus { outline: none; border-color: var(--color-accent); }

	button {
		padding: var(--space-2) var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm);
		background: var(--color-surface-2); color: var(--color-text-muted); font-size: 0.8rem; font-family: var(--font-mono);
		white-space: nowrap; transition: background 0.15s, border-color 0.15s;
	}
	button:hover { background: var(--color-border); }
	.btn-primary { background: var(--color-accent); border-color: var(--color-accent); color: #fff; }
	.btn-primary:hover { background: var(--color-accent-hover); }
	.btn-danger { color: var(--color-error); border-color: var(--color-error); background: transparent; }
	.btn-danger:hover { background: rgba(239, 68, 68, 0.1); }
	.btn-sm { font-size: 0.7rem; padding: var(--space-1) var(--space-2); }

	.qr-wrap { text-align: center; padding: var(--space-2) 0; }
	.qr-wrap img { display: inline-block; border-radius: var(--radius-md); width: 160px; height: 160px; }
	.uri-box { font-family: var(--font-mono); font-size: 0.7rem; color: var(--color-text-subtle); word-break: break-all; background: var(--color-bg); border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: var(--space-2); max-height: 60px; overflow-y: auto; }
	.fingerprint { font-family: var(--font-mono); font-size: 1.5rem; font-weight: 600; text-align: center; color: var(--color-accent); letter-spacing: 0.15em; }

	.meta-toggle { background: none; border: none; color: var(--color-text-muted); font-family: var(--font-mono); font-size: 0.75rem; padding: 0; cursor: pointer; text-align: left; text-transform: uppercase; letter-spacing: 0.05em; }
	.meta-toggle:hover { color: var(--color-text); }

	.caps { font-family: var(--font-mono); font-size: 0.75rem; color: var(--color-text-muted); padding: var(--space-1) 0; }
	.cap-label { color: var(--color-text-subtle); font-weight: 600; }
</style>
