<script lang="ts">
	import { WalletSession, WebSocketTransport, hexToBytes, bytesToHex } from 'walletpair-sdk';
	import type { WalletPhase } from 'walletpair-sdk';
	import MessageLog from './MessageLog.svelte';
	import { playground, type LogEntry } from './state.svelte';

	// ── Ethereum crypto (lazy-loaded) ──
	async function loadEthCrypto() {
		const [{ secp256k1 }, { keccak_256 }, { utf8ToBytes, concatBytes }] = await Promise.all([
			import('@noble/curves/secp256k1.js'),
			import('@noble/hashes/sha3.js'),
			import('@noble/hashes/utils.js')
		]);
		return { secp256k1, keccak_256, utf8ToBytes, concatBytes, bytesToHex };
	}

	function privateKeyToAddress(privKeyHex: string, secp256k1: any, keccak_256: any): string {
		const pubKey = secp256k1.getPublicKey(hexToBytes(privKeyHex), false);
		return '0x' + bytesToHex(keccak_256(pubKey.slice(1)).slice(-20));
	}

	function personalSign(
		privKeyHex: string,
		message: string,
		secp256k1: any,
		keccak_256: any,
		utf8ToBytes: any,
		concatBytes: any
	): string {
		const msgBytes = utf8ToBytes(message);
		const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${msgBytes.length}`);
		const hash = keccak_256(concatBytes(prefix, msgBytes));
		const privKey = hexToBytes(privKeyHex);
		const sigBytes = secp256k1.sign(hash, privKey);
		const sig = secp256k1.Signature.fromBytes(sigBytes);
		const pubKey = secp256k1.getPublicKey(privKey, false);
		const pubHex = bytesToHex(pubKey);
		let recovery = 0;
		for (let v = 0; v <= 1; v++) {
			try {
				const recovered = sig.addRecoveryBit(v).recoverPublicKey(hash);
				if (bytesToHex(recovered.toBytes(false)) === pubHex) {
					recovery = v;
					break;
				}
			} catch {
				/* try next */
			}
		}
		const r = sig.r.toString(16).padStart(64, '0');
		const s = sig.s.toString(16).padStart(64, '0');
		const vHex = (recovery + 27).toString(16).padStart(2, '0');
		return '0x' + r + s + vHex;
	}

	// ── State ──
	let ethKey = $state('');
	let ethAddr = $state('--');
	let pairingUriInput = $state('');
	let phase: WalletPhase = $state('idle');
	let sessionFingerprint = $state('------');
	let session: WalletSession | null = $state(null);
	let pendingReqs = $state<{ id: string; method: string; params: unknown }[]>([]);
	let eventName = $state('accountsChanged');
	let log = $state<LogEntry[]>([]);

	let ethCrypto: Awaited<ReturnType<typeof loadEthCrypto>> | null = null;

	function addLog(dir: 'out' | 'in' | 'err', type: string, detail = '') {
		log = [...log, { dir, type, detail }];
	}

	// ── Key management ──
	async function ensureCrypto() {
		if (!ethCrypto) ethCrypto = await loadEthCrypto();
		return ethCrypto;
	}

	async function updateEthKey() {
		const hex = ethKey.replace(/^0x/, '').trim();
		if (hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) {
			ethAddr = 'Invalid key (need 32 hex bytes)';
			return;
		}
		const crypto = await ensureCrypto();
		ethKey = hex.toLowerCase();
		ethAddr = privateKeyToAddress(ethKey, crypto.secp256k1, crypto.keccak_256);
	}

	async function generateKey() {
		ethKey = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
		await updateEthKey();
	}

	// ── Auto-fill from dApp ──
	function fillFromDApp() {
		pairingUriInput = playground.pairingUri;
	}

	// ── Join ──
	async function joinChannel() {
		if (!ethKey || ethAddr === '--') {
			addLog('err', 'key', 'Generate or enter an ETH key first');
			return;
		}

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
			capabilities: {
				methods: [
					'wallet_getAccounts',
					'wallet_signTransaction',
					'wallet_signMessage',
					'wallet_signTypedData',
					'wallet_switchChain'
				],
				events: ['accountsChanged', 'chainChanged', 'disconnect'],
				chains: ['eip155:1']
			},
			meta: {
				name: 'Playground Wallet',
				description: 'WalletPair playground wallet',
				url: location.origin,
				icon: ''
			}
		});
		session = s;

		s.on('phase', (p) => {
			phase = p;
			addLog('in', 'phase', p);
		});

		(s as any).on('sessionFingerprint', (fingerprint: string) => {
			sessionFingerprint = fingerprint;
		});

		s.on('request', ({ id, method, params }) => {
			addLog('in', 'req', `id=${id} method=${method}`);
			pendingReqs = [...pendingReqs, { id, method, params }];
		});

		try {
			const code = await s.joinFromUri(pairingUriInput);
			addLog('out', 'join', `ch=${s.channelId.slice(0, 12)}... code=${code}`);
		} catch (e: any) {
			addLog('err', 'join', e.message);
		}
	}

	// ── Request handling ──
	async function approveRequest(reqId: string) {
		if (!session) return;
		const req = pendingReqs.find((r) => r.id === reqId);
		if (!req) return;

		const cr = await ensureCrypto();
		let result: unknown;
		switch (req.method) {
			case 'wallet_getAccounts':
				result = { accounts: [{ address: ethAddr, chains: ['eip155:1'] }] };
				break;
			case 'wallet_signMessage': {
				const message = (req.params as any)?.message || '';
				result = {
					signature: personalSign(
						ethKey,
						message,
						cr.secp256k1,
						cr.keccak_256,
						cr.utf8ToBytes,
						cr.concatBytes
					)
				};
				break;
			}
			default:
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

	// ── Events ──
	function pushEvent() {
		if (!session) return;
		const data =
			eventName === 'accountsChanged'
				? { accounts: [{ address: ethAddr, chains: ['eip155:1'] }] }
				: { chain: 'eip155:1' };
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
		<h3>Wallet <span class="badge evm">EVM</span></h3>
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

	<!-- EOA Key -->
	<div class="field">
		<label>Private Key (hex)</label>
		<div class="row">
			<input
				bind:value={ethKey}
				placeholder="paste or generate..."
				oninput={updateEthKey}
				type="password"
			/>
			<button class="btn-primary" onclick={generateKey}>Generate</button>
		</div>
		<div class="addr">{ethAddr}</div>
	</div>

	<!-- Pairing URI -->
	<div class="field">
		<label>Pairing URI</label>
		<div class="row">
			<input bind:value={pairingUriInput} placeholder="walletpair:?ch=...&pubkey=...&relay=..." />
		</div>
		<div class="row">
			{#if playground.pairingUri && !pairingUriInput}
				<button class="btn-sm" onclick={fillFromDApp}>Use dApp's URI</button>
			{/if}
			{#if phase === 'idle'}
				<button
					class="btn-primary"
					onclick={joinChannel}
					disabled={!pairingUriInput || !ethKey}
				>
					Join
				</button>
			{:else}
				<button class="btn-danger" onclick={reset}>Reset</button>
			{/if}
		</div>
	</div>

	<!-- Fingerprint -->
	{#if sessionFingerprint !== '------'}
		<div class="field">
			<label>Session Fingerprint</label>
			<div class="fingerprint">{sessionFingerprint}</div>
		</div>
	{/if}

	<!-- Incoming Requests -->
	{#if phase === 'connected'}
		<div class="field">
			<label>Incoming Requests</label>
			{#if pendingReqs.length === 0}
				<div class="empty">No pending requests</div>
			{:else}
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

		<div class="field">
			<label>Push Event</label>
			<div class="row">
				<select bind:value={eventName}>
					<option value="accountsChanged">accountsChanged</option>
					<option value="chainChanged">chainChanged</option>
				</select>
				<button class="btn-primary" onclick={pushEvent}>Push</button>
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
	select {
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		padding: var(--space-2) var(--space-3);
		color: var(--color-text);
		font-family: var(--font-mono);
		font-size: 0.8rem;
		width: 100%;
	}

	input:focus,
	select:focus {
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

	button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
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

	.btn-success {
		color: var(--color-success);
		border-color: var(--color-success);
		background: transparent;
	}

	.btn-sm {
		font-size: 0.7rem;
		padding: var(--space-1) var(--space-2);
	}

	.addr {
		font-family: var(--font-mono);
		font-size: 0.75rem;
		color: var(--color-success);
		word-break: break-all;
	}

	.fingerprint {
		font-family: var(--font-mono);
		font-size: 1.5rem;
		font-weight: 600;
		text-align: center;
		color: var(--color-accent);
		letter-spacing: 0.15em;
	}

	.empty {
		font-size: 0.8rem;
		color: var(--color-text-subtle);
		font-style: italic;
	}

	.req-card {
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		padding: var(--space-3);
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.req-method {
		font-family: var(--font-mono);
		font-size: 0.85rem;
		font-weight: 600;
	}

	.req-id {
		font-weight: 400;
		color: var(--color-text-subtle);
	}

	.req-params {
		font-family: var(--font-mono);
		font-size: 0.7rem;
		color: var(--color-text-subtle);
		word-break: break-all;
	}
</style>
