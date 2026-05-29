<svelte:head>
	<title>Core Concepts — WalletPair</title>
</svelte:head>

<h1>Core Concepts</h1>

<p>
	WalletPair is a two-party channel protocol. One side is the dApp, the other is the wallet. They
	communicate through a relay that can only route encrypted bytes — it cannot read, forge, or
	replay application data.
</p>

<p>
	The core protocol is <strong>network-agnostic</strong>. It handles pairing, encryption, and
	message transport without any knowledge of blockchain specifics. All chain-specific logic
	(signing, transactions, account formats) is delegated to
	<a href="/docs/sub-protocols">sub-protocols</a> — one per blockchain ecosystem.
</p>

<h2 id="pairing">Pairing</h2>

<p>Pairing establishes the encrypted channel:</p>

<ol>
	<li>
		<strong>dApp creates a channel.</strong> It generates an ephemeral X25519 keypair and a random
		channel ID, then sends a <code>create</code> message to the relay.
	</li>
	<li>
		<strong>dApp displays a QR code.</strong> The pairing URI encodes the channel ID, the dApp's
		public key, and the relay URL.
	</li>
	<li>
		<strong>Wallet scans the QR code.</strong> It generates its own ephemeral keypair, derives a
		shared secret via X25519, and sends a <code>join</code> message with a sealed handshake
		payload.
	</li>
	<li>
		<strong>dApp verifies the handshake.</strong> It decrypts the sealed join, derives traffic
		keys, and auto-accepts.
	</li>
	<li>
		<strong>Both sides compute a session fingerprint</strong> — a 4-digit code derived from the
		transcript. Users can compare them out-of-band to detect MITM.
	</li>
</ol>

<p>
	The dApp's public key is delivered via the QR code (a physical out-of-band channel the relay
	cannot intercept). This is the protocol's trust root.
</p>

<h2 id="encryption">Encryption</h2>

<p>All application data is end-to-end encrypted with:</p>

<ul>
	<li>
		<strong>Key exchange:</strong> X25519 ephemeral keypairs (RFC 7748, with all-zero and
		low-order point rejection)
	</li>
	<li><strong>Key derivation:</strong> HKDF-SHA256 with channel ID salt and domain-separated info</li>
	<li>
		<strong>Symmetric encryption:</strong> ChaCha20-Poly1305 AEAD with type-byte AAD
		(<code>0x01</code> request, <code>0x02</code> response, <code>0x03</code> event — prevents cross-type
		confusion)
	</li>
	<li>
		<strong>Replay protection:</strong> Per-peer monotonic sequence counters with HMAC-SHA256
		nonce derivation
	</li>
	<li>
		<strong>JSON canonicalization:</strong> RFC 8785 (JCS) ensures deterministic serialization
	</li>
</ul>

<p>
	Traffic keys are directional: the dApp-to-wallet key differs from the wallet-to-dApp key.
	Reflection attacks are impossible by design.
</p>

<h2 id="transports">Transports</h2>

<p>
	The protocol is transport-agnostic. The SDK ships with two built-in transports:
</p>

<ul>
	<li>
		<strong>WebSocket</strong> (<code>WebSocketTransport</code>) — connect through a relay server.
		Best for cross-device pairing over the internet.
	</li>
	<li>
		<strong>Bluetooth LE</strong> (<code>WebBleCentralTransport</code>) — direct device-to-device
		connection. No relay needed. Currently Chrome-only via WebBluetooth API.
	</li>
</ul>

<p>
	Both transports use identical session APIs. You can switch transports without changing application
	code.
</p>

<h2 id="channels">Channel Lifecycle</h2>

<p>A session progresses through these phases:</p>

<ol>
	<li><strong>idle</strong> — session created, not yet started</li>
	<li><strong>pairing</strong> — channel created on relay, waiting for wallet</li>
	<li><strong>connected</strong> — handshake complete, encrypted communication active</li>
	<li><strong>disconnected</strong> — transport lost, reconnection possible</li>
	<li><strong>closed</strong> — session ended, keys erased</li>
</ol>

<h2 id="multichain">Multi-Network (CAIP-2)</h2>

<p>
	WalletPair uses <a href="https://chainagnostic.org/CAIPs/caip-2" target="_blank" rel="noopener">CAIP-2</a> chain
	identifiers to support any blockchain network. The core protocol doesn't know or care which
	chain you're on — it just routes encrypted bytes.
</p>

<p>Each network ecosystem has its own CAIP-2 prefix:</p>

<table>
	<thead>
		<tr><th>Network</th><th>CAIP-2 Prefix</th><th>Examples</th></tr>
	</thead>
	<tbody>
		<tr><td>EVM</td><td><code>eip155</code></td><td><code>eip155:1</code> (Ethereum), <code>eip155:137</code> (Polygon)</td></tr>
		<tr><td>Solana</td><td><code>solana</code></td><td><code>solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp</code></td></tr>
		<tr><td>Sui</td><td><code>sui</code></td><td><code>sui:mainnet</code></td></tr>
		<tr><td>Tron</td><td><code>tron</code></td><td><code>tron:mainnet</code></td></tr>
		<tr><td>Bitcoin</td><td><code>bip122</code></td><td><code>bip122:000000000019d6689c085ae165831e93</code></td></tr>
	</tbody>
</table>

<p>
	The wallet declares supported chains in <code>capabilities.chains</code>. A single session can
	span multiple chains within the same ecosystem.
</p>

<h2 id="sub-protocols">Sub-Protocols</h2>

<p>
	WalletPair delegates all chain-specific logic to <strong>sub-protocols</strong>. The core protocol
	defines pairing, encryption, and message transport. Sub-protocols define:
</p>

<ul>
	<li>Account and address formats</li>
	<li>Transaction signing methods and parameters</li>
	<li>Message signing standards</li>
	<li>Events (accountsChanged, chainChanged, etc.)</li>
	<li>Data encoding rules</li>
</ul>

<p>
	Currently, the <a href="/docs/evm-methods">EVM sub-protocol</a> is fully specified. Sub-protocols
	for Solana, Sui, and other ecosystems can be authored following the
	<a href="/docs/sub-protocols">sub-protocol specification guide</a>.
</p>

<h2 id="relay">The Relay</h2>

<p>
	The relay is a stateless message router. It holds channels in memory only — no persistent
	storage, no breach risk. The relay:
</p>

<ul>
	<li><strong>Cannot</strong> read encrypted payloads</li>
	<li><strong>Cannot</strong> forge peer messages (it lacks traffic keys)</li>
	<li><strong>Cannot</strong> replay messages (sequence counters prevent this)</li>
	<li><strong>Can</strong> deny service (drop or delay messages)</li>
	<li><strong>Can</strong> observe metadata (timing, message sizes, public keys)</li>
</ul>

<p>
	The relay is network-agnostic — it routes bytes for EVM, Solana, Bitcoin, or any future
	sub-protocol without knowing the difference. You can
	<a href="/docs/relay">self-host the relay</a> for full control, or use the public relay for development.
</p>
