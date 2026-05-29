<script lang="ts">
	import { WalletSession, WebSocketTransport } from 'walletpair-sdk';
	import type { WalletPhase } from 'walletpair-sdk';
	import MessageLog from './MessageLog.svelte';
	import { playground, type LogEntry } from './state.svelte';

	let metaName = $state('Protocol Wallet');
	let metaUrl = $state('https://walletpair.org');
	let metaIcon = $state('https://walletpair.org/favicon.png');
	let showMeta = $state(true);

	// Editable capabilities
	let capMethods = $state('myapp.getData, myapp.setData, myapp.deleteData');
	let capEvents = $state('dataChanged');
	let capChains = $state('myapp:mainnet');

	let pairingUriInput = $state('');
	let phase: WalletPhase = $state('idle');
	let sessionFingerprint = $state('------');
	let session: WalletSession | null = $state(null);
	let pendingReqs = $state<{ id: string; method: string; params: unknown }[]>([]);
	let resultJson = $state('{ "status": "ok" }');
	let eventName = $state('dataChanged');
	let eventData = $state('{ "key": "value" }');
	let log = $state<LogEntry[]>([]);

	function addLog(dir: 'out' | 'in' | 'err', type: string, detail = '') {
		log = [...log, { dir, type, detail }];
	}

	function fillFromDApp() {
		pairingUriInput = playground.pairingUri;
	}

	function parseCsv(s: string): string[] {
		return s.split(',').map((x) => x.trim()).filter(Boolean);
	}

	// Step 1: prepareJoin — derive keys, show fingerprint
	async function prepareJoinChannel() {
		const methods = parseCsv(capMethods);
		const events = parseCsv(capEvents);
		const chains = parseCsv(capChains);

		const transport = new WebSocketTransport(
			pairingUriInput.includes('relay=')
				? decodeURIComponent(
						pairingUriInput
							.replace(/^walletpair:\?/, '')
							.split('&')
							.find((p) => p.startsWith('relay='))
							?.slice(6) || ''
					)
				: playground.relayUrl
		);

		const s = new WalletSession({
			transport,
			capabilities: { methods, events, chains },
			meta: {
				name: metaName || 'Protocol Wallet',
				description: 'Network-agnostic playground wallet',
				url: metaUrl || 'https://walletpair.org',
				icon: metaIcon || 'https://walletpair.org/favicon.png'
			}
		});
		session = s;

		s.on('phase', (p) => {
			phase = p;
			addLog('in', 'phase', p);
		});

		s.on('request', ({ id, method, params }) => {
			addLog('in', 'req', `id=${id} method=${method}`);
			pendingReqs = [...pendingReqs, { id, method, params }];
		});

		try {
			const code = s.prepareJoin(pairingUriInput);
			sessionFingerprint = code;
			addLog('in', 'fingerprint', code);
		} catch (e: any) {
			addLog('err', 'prepare', e.message);
		}
	}

	// Step 2: confirmJoin — user verified fingerprint, send join
	async function confirmJoinChannel() {
		if (!session) return;
		try {
			await session.confirmJoin();
			addLog('out', 'join', `ch=${session.channelId.slice(0, 12)}...`);
		} catch (e: any) {
			addLog('err', 'join', e.message);
		}
	}

	function approveRequest(reqId: string) {
		if (!session) return;
		let result: unknown;
		try {
			result = JSON.parse(resultJson);
		} catch {
			result = { status: 'approved' };
		}
		session.approve(reqId, result);
		addLog('out', 'res', `id=${reqId} ok=true`);
		pendingReqs = pendingReqs.filter((r) => r.id !== reqId);
	}

	function rejectRequest(reqId: string) {
		if (!session) return;
		session.reject(reqId);
		addLog('out', 'res', `id=${reqId} ok=false`);
		pendingReqs = pendingReqs.filter((r) => r.id !== reqId);
	}

	function pushEvent() {
		if (!session) return;
		let data: unknown;
		try {
			data = JSON.parse(eventData);
		} catch {
			data = {};
		}
		session.pushEvent(eventName, data);
		addLog('out', 'evt', `event=${eventName}`);
	}

	function closeSession() {
		session?.close();
		addLog('out', 'close', 'normal');
	}

	function reset() {
		session?.destroy();
		session = null;
		phase = 'idle';
		sessionFingerprint = '------';
		pendingReqs = [];
		log = [];
	}
</script>

<div class="panel">
	<div class="panel-header">
		<h3>Wallet <span class="badge">Protocol</span></h3>
		<span class="status">
			<span
				class="dot"
				class:connected={phase === 'connected'}
				class:waiting={phase !== 'idle' && phase !== 'connected' && phase !== 'closed' && phase !== 'disconnected'}
				class:error={phase === 'closed' || phase === 'disconnected'}
			></span>
			{phase}
		</span>
	</div>

	<!-- Metadata (collapsible) -->
	<div class="field">
		<button class="meta-toggle" onclick={() => (showMeta = !showMeta)}>
			{showMeta ? '▾' : '▸'} Metadata
		</button>
		{#if showMeta}
			<input bind:value={metaName} placeholder="Wallet name" />
			<input bind:value={metaUrl} placeholder="Wallet URL" />
			<input bind:value={metaIcon} placeholder="Icon URL (must be https)" />
		{/if}
	</div>

	<!-- Capabilities -->
	{#if phase === 'idle'}
		<div class="field">
			<label>Capabilities (comma-separated)</label>
			<input bind:value={capMethods} placeholder="Methods: method1, method2, ..." />
			<input bind:value={capEvents} placeholder="Events: event1, event2, ..." />
			<input bind:value={capChains} placeholder="Chains: myapp:mainnet, ..." />
		</div>
	{/if}

	<!-- Pairing URI + two-step join -->
	<div class="field">
		<label>Pairing URI</label>
		<div class="row">
			<input bind:value={pairingUriInput} placeholder="walletpair:?ch=...&pubkey=...&relay=..." />
		</div>
		<div class="row">
			{#if playground.pairingUri && !pairingUriInput}
				<button class="btn-sm" onclick={fillFromDApp}>Use dApp's URI</button>
			{/if}
			{#if phase === 'idle' && sessionFingerprint === '------'}
				<button class="btn-primary" onclick={prepareJoinChannel} disabled={!pairingUriInput}>
					Prepare Join
				</button>
			{/if}
			{#if phase !== 'idle'}
				<button class="btn-danger" onclick={reset}>Reset</button>
			{/if}
		</div>
	</div>

	<!-- Session Fingerprint + Confirm -->
	{#if sessionFingerprint !== '------'}
		<div class="field">
			<label>Session Fingerprint (verify with dApp before confirming)</label>
			<div class="fingerprint">{sessionFingerprint}</div>
			{#if phase === 'idle'}
				<div class="row">
					<button class="btn-primary" onclick={confirmJoinChannel}>Confirm Join</button>
					<button class="btn-danger" onclick={reset}>Reject</button>
				</div>
			{/if}
		</div>
	{/if}

	{#if phase === 'connected'}
		<!-- Incoming Requests -->
		<div class="field">
			<label>Incoming Requests</label>
			{#if pendingReqs.length === 0}
				<div class="empty">No pending requests</div>
			{:else}
				<div class="field">
					<label>Response JSON (for approval)</label>
					<textarea bind:value={resultJson} rows="2"></textarea>
				</div>
				{#each pendingReqs as req}
					<div class="req-card">
						<div class="req-method">{req.method} <span class="req-id">#{req.id}</span></div>
						<div class="req-params">{JSON.stringify(req.params)}</div>
						<div class="row">
							<button class="btn-success" onclick={() => approveRequest(req.id)}>Approve</button>
							<button class="btn-danger" onclick={() => rejectRequest(req.id)}>Reject</button>
						</div>
					</div>
				{/each}
			{/if}
		</div>

		<!-- Push Event -->
		<div class="field">
			<label>Push Event</label>
			<div class="row">
				<input bind:value={eventName} placeholder="event name" />
			</div>
			<textarea bind:value={eventData} rows="2" placeholder="event data JSON"></textarea>
			<div class="row">
				<button class="btn-primary" onclick={pushEvent}>Push Event</button>
				<button class="btn-danger" onclick={closeSession}>Close</button>
			</div>
		</div>
	{/if}

	<MessageLog entries={log} />
</div>

<style>
	.panel {
		background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg);
		padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-4); overflow: hidden;
	}

	.panel-header { display: flex; align-items: center; justify-content: space-between; }
	.panel-header h3 { font-family: var(--font-mono); font-size: 1rem; font-weight: 600; display: flex; align-items: center; gap: var(--space-2); }

	.badge { font-size: 0.65rem; font-weight: 500; color: var(--color-accent); background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.3); border-radius: var(--radius-sm); padding: 1px 6px; }

	.status { display: flex; align-items: center; gap: var(--space-2); font-size: 0.8rem; color: var(--color-text-muted); font-family: var(--font-mono); }
	.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--color-text-subtle); }
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
	textarea { resize: vertical; min-height: 48px; }
	input:focus, textarea:focus { outline: none; border-color: var(--color-accent); }

	button {
		padding: var(--space-2) var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm);
		background: var(--color-surface-2); color: var(--color-text-muted); font-size: 0.8rem; font-family: var(--font-mono);
		white-space: nowrap; transition: background 0.15s, border-color 0.15s;
	}
	button:hover { background: var(--color-border); }
	button:disabled { opacity: 0.4; cursor: not-allowed; }
	.btn-primary { background: var(--color-accent); border-color: var(--color-accent); color: #fff; }
	.btn-primary:hover { background: var(--color-accent-hover); }
	.btn-danger { color: var(--color-error); border-color: var(--color-error); background: transparent; }
	.btn-success { color: var(--color-success); border-color: var(--color-success); background: transparent; }
	.btn-sm { font-size: 0.7rem; padding: var(--space-1) var(--space-2); }

	.fingerprint { font-family: var(--font-mono); font-size: 1.5rem; font-weight: 600; text-align: center; color: var(--color-accent); letter-spacing: 0.15em; }
	.empty { font-size: 0.8rem; color: var(--color-text-subtle); font-style: italic; }

	.req-card { background: var(--color-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: var(--space-3); display: flex; flex-direction: column; gap: var(--space-2); }
	.req-method { font-family: var(--font-mono); font-size: 0.85rem; font-weight: 600; }
	.req-id { font-weight: 400; color: var(--color-text-subtle); }
	.req-params { font-family: var(--font-mono); font-size: 0.7rem; color: var(--color-text-subtle); word-break: break-all; }

	.meta-toggle { background: none; border: none; color: var(--color-text-muted); font-family: var(--font-mono); font-size: 0.75rem; padding: 0; cursor: pointer; text-align: left; text-transform: uppercase; letter-spacing: 0.05em; }
	.meta-toggle:hover { color: var(--color-text); }
</style>
