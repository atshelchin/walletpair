<script lang="ts">
	import { WalletSession, WebSocketTransport, hexToBytes, bytesToHex } from 'walletpair-sdk';
	import type { WalletPhase } from 'walletpair-sdk';
	import MessageLog from '$lib/components/MessageLog.svelte';

	// ---------------------------------------------------------------------------
	// Ethereum helpers (inline, same as wallet.html)
	// ---------------------------------------------------------------------------
	async function loadEthCrypto() {
		const [{ secp256k1 }, { keccak_256 }, { utf8ToBytes, concatBytes }] = await Promise.all([
			import('@noble/curves/secp256k1.js'),
			import('@noble/hashes/sha3.js'),
			import('@noble/hashes/utils.js')
		]);
		return { secp256k1, keccak_256, utf8ToBytes, concatBytes, bytesToHex };
	}

	function privateKeyToAddress(
		privKeyHex: string,
		secp256k1: any,
		keccak_256: any
	): string {
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

	// ---------------------------------------------------------------------------
	// State
	// ---------------------------------------------------------------------------
	let ethKey = $state('');
	let ethAddr = $state('--');
	let pairingUriInput = $state('');
	let phase: WalletPhase = $state('idle');
	let sessionFingerprint = $state('------');
	let session: WalletSession | null = $state(null);
	let pendingReqs = $state<{ id: string; method: string; params: unknown }[]>([]);
	let eventName = $state('accountsChanged');
	let log = $state<{ dir: 'out' | 'in' | 'err'; type: string; detail: string }[]>([]);

	// Crypto libs (loaded lazily)
	let ethCrypto: Awaited<ReturnType<typeof loadEthCrypto>> | null = null;

	// ---------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------
	function addLog(dir: 'out' | 'in' | 'err', type: string, detail = '') {
		log = [...log, { dir, type, detail }];
	}

	// ---------------------------------------------------------------------------
	// ETH Key Management
	// ---------------------------------------------------------------------------
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

	// ---------------------------------------------------------------------------
	// Join
	// ---------------------------------------------------------------------------
	async function joinChannel() {
		if (!ethKey || ethAddr === '--') {
			alert('Generate or enter an ETH private key first');
			return;
		}

		const transport = new WebSocketTransport(pairingUriInput.includes('relay=')
			? decodeURIComponent(pairingUriInput.replace(/^walletpair:\?/, '').split('&').find(p => p.startsWith('relay='))?.slice(6) || '')
			: 'ws://localhost:8080/v1'
		);

		const s = new WalletSession({
			transport,
			capabilities: {
				methods: ['wallet_getAccounts', 'wallet_signMessage'],
				events: ['accountsChanged', 'chainChanged'],
				chains: ['eip155:1']
			},
			meta: { name: 'WalletPair EOA Wallet', description: 'WalletPair example wallet', url: location.origin, icon: '' }
		});
		session = s;

		s.on('phase', (p) => {
			phase = p;
			addLog('in', 'phase', p);
		});

		(s as unknown as { on: (event: string, handler: (data: string) => void) => void }).on('sessionFingerprint', (fingerprint) => {
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

	// ---------------------------------------------------------------------------
	// Request handling
	// ---------------------------------------------------------------------------
	async function approveRequest(reqId: string) {
		if (!session) return;
		const req = pendingReqs.find((r) => r.id === reqId);
		if (!req) return;

		const crypto = await ensureCrypto();
		let result: unknown;
		switch (req.method) {
			case 'wallet_getAccounts':
				result = {
					accounts: [{ address: ethAddr, chains: ['eip155:1'] }]
				};
				break;
			case 'wallet_signMessage': {
				const message = (req.params as any)?.message || '';
				result = {
					signature: personalSign(
						ethKey,
						message,
						crypto.secp256k1,
						crypto.keccak_256,
						crypto.utf8ToBytes,
						crypto.concatBytes
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

	// ---------------------------------------------------------------------------
	// Events
	// ---------------------------------------------------------------------------
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
	}
</script>

<main>
	<header>
		<span>WalletPair &mdash; Wallet</span>
		<span class="status">
			<span class="dot {phase === 'connected' ? 'connected' : phase === 'closed' ? 'closed' : phase === 'idle' ? '' : phase === 'disconnected' ? 'disconnected' : 'waiting'}"></span>
			<span>{phase.charAt(0).toUpperCase() + phase.slice(1).replace('_', ' ')}</span>
		</span>
	</header>

	<section>
		<h3>EOA Wallet</h3>
		<span class="field-label">Private Key (hex, 32 bytes)</span>
		<div class="row">
			<input id="ethkey-input" bind:value={ethKey} placeholder="paste or generate..." oninput={updateEthKey} />
			<button onclick={generateKey}>Generate</button>
		</div>
		<div class="addr">{ethAddr}</div>
	</section>

	<section>
		<h3>Pairing</h3>
		<span class="field-label">Paste Pairing URI from dApp</span>
		<div class="row">
			<input id="pairing-uri-input" bind:value={pairingUriInput} placeholder="walletpair:?ch=...&pubkey=...&relay=..." />
			{#if phase === 'idle'}
				<button class="primary" onclick={joinChannel} disabled={!pairingUriInput || !ethKey}>
					Join
				</button>
			{:else}
				<button class="danger" onclick={reset}>Reset</button>
			{/if}
		</div>
		{#if sessionFingerprint !== '------'}
			<span class="field-label mt">Session Fingerprint (verify with dApp)</span>
			<div class="code">{sessionFingerprint}</div>
		{/if}
	</section>

	{#if phase === 'connected'}
		<section>
			<h3>Incoming Requests</h3>
			{#if pendingReqs.length === 0}
				<span style="color:var(--muted);font-size:13px">No pending requests</span>
			{:else}
				{#each pendingReqs as req}
					<div class="req-card">
						<div class="method">
							{req.method}
							<span style="color:var(--muted);font-weight:400">#{req.id}</span>
						</div>
						<div class="params">{JSON.stringify(req.params)}</div>
						<div class="row">
							<button class="success" onclick={() => approveRequest(req.id)}>Approve</button>
							<button class="danger" onclick={() => rejectRequest(req.id)}>Reject</button>
						</div>
					</div>
				{/each}
			{/if}
		</section>

		<section>
			<h3>Push Event</h3>
			<div class="row">
				<select bind:value={eventName} style="width:auto;flex:1">
					<option value="accountsChanged">accountsChanged</option>
					<option value="chainChanged">chainChanged</option>
				</select>
				<button class="primary" onclick={pushEvent}>Push</button>
				<button class="danger" onclick={closeSession}>Close</button>
			</div>
		</section>
	{/if}

	<MessageLog entries={log} />
</main>
