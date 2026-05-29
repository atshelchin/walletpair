<svelte:head>
	<title>Sub-Protocols — WalletPair</title>
</svelte:head>

<h1>Sub-Protocols</h1>

<p>
	WalletPair's core protocol handles pairing, encryption, and message transport. It is deliberately
	<strong>network-agnostic</strong> — it does not define any blockchain-specific logic.
</p>

<p>
	All chain-specific behavior is defined in <strong>sub-protocols</strong>, one per blockchain
	ecosystem. Each sub-protocol specifies methods, events, data encoding, and security requirements
	for its network.
</p>

<h2 id="architecture">Architecture</h2>

<table>
	<thead>
		<tr><th>Layer</th><th>Responsibility</th><th>Network-Aware?</th></tr>
	</thead>
	<tbody>
		<tr>
			<td><strong>Core Protocol</strong></td>
			<td>Pairing, key exchange, encryption, transport, relay routing</td>
			<td>No</td>
		</tr>
		<tr>
			<td><strong>Sub-Protocol</strong></td>
			<td>Methods, events, account formats, tx signing, data encoding</td>
			<td>Yes</td>
		</tr>
	</tbody>
</table>

<p>
	The core protocol only sees opaque JSON payloads inside encrypted messages. The sub-protocol
	defines the schema of those payloads.
</p>

<h2 id="available">Available Sub-Protocols</h2>

<table>
	<thead>
		<tr><th>Sub-Protocol</th><th>Namespace</th><th>CAIP-2 Prefix</th><th>Status</th></tr>
	</thead>
	<tbody>
		<tr>
			<td><a href="/docs/evm-methods">EVM</a></td>
			<td><code>evm</code></td>
			<td><code>eip155</code></td>
			<td>Release Candidate</td>
		</tr>
		<tr>
			<td>Solana</td>
			<td><code>solana</code></td>
			<td><code>solana</code></td>
			<td>Planned</td>
		</tr>
		<tr>
			<td>Sui</td>
			<td><code>sui</code></td>
			<td><code>sui</code></td>
			<td>Planned</td>
		</tr>
		<tr>
			<td>Bitcoin</td>
			<td><code>bitcoin</code></td>
			<td><code>bip122</code></td>
			<td>Planned</td>
		</tr>
		<tr>
			<td>Tron</td>
			<td><code>tron</code></td>
			<td><code>tron</code></td>
			<td>Planned</td>
		</tr>
	</tbody>
</table>

<h2 id="cross-network">Cross-Network Differences</h2>

<p>
	Each blockchain ecosystem has fundamentally different primitives. Sub-protocols abstract these
	differences behind a consistent request/response pattern:
</p>

<table>
	<thead>
		<tr><th>Aspect</th><th>EVM</th><th>Solana</th><th>Sui</th><th>Bitcoin</th></tr>
	</thead>
	<tbody>
		<tr>
			<td>Address format</td>
			<td><code>0x</code> hex, 20B</td>
			<td>base58, 32B</td>
			<td><code>0x</code> hex, 32B</td>
			<td>bech32 / base58check</td>
		</tr>
		<tr>
			<td>Tx format</td>
			<td>RLP / JSON</td>
			<td>bincode / base64</td>
			<td>BCS / base64</td>
			<td>PSBT / raw hex</td>
		</tr>
		<tr>
			<td>Signature</td>
			<td>secp256k1, 65B</td>
			<td>Ed25519, 64B</td>
			<td>Ed25519 / secp256k1</td>
			<td>ECDSA / Schnorr</td>
		</tr>
		<tr>
			<td>Fee model</td>
			<td>gas × gasPrice</td>
			<td>priority fee + CU</td>
			<td>gas budget (SUI)</td>
			<td>sat/vB × weight</td>
		</tr>
		<tr>
			<td>Nonce model</td>
			<td>per-account seq</td>
			<td>recent blockhash</td>
			<td>per-object seq</td>
			<td>UTXO (no nonce)</td>
		</tr>
	</tbody>
</table>

<h2 id="capabilities">Capability Declaration</h2>

<p>
	The wallet declares which sub-protocols it supports via the <code>capabilities.version</code>
	field during pairing:
</p>

<pre><code>{`{
  "capabilities": {
    "version": { "evm": 1 },
    "methods": ["wallet_getAccounts", "wallet_signMessage", ...],
    "events": ["accountsChanged", "chainChanged"],
    "chains": ["eip155:1", "eip155:137"]
  }
}`}</code></pre>

<p>
	A wallet that supports multiple ecosystems could declare multiple versions:
</p>

<pre><code>{`{
  "capabilities": {
    "version": { "evm": 1, "solana": 1 },
    "chains": ["eip155:1", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]
  }
}`}</code></pre>

<h2 id="authoring">Authoring a Sub-Protocol</h2>

<p>
	To add WalletPair support for a new blockchain ecosystem, author a sub-protocol specification
	covering:
</p>

<table>
	<thead>
		<tr><th>Topic</th><th>What to Define</th></tr>
	</thead>
	<tbody>
		<tr><td>Namespace & version</td><td>Identifier (e.g., <code>solana</code>), version integer, CAIP-2 prefix</td></tr>
		<tr><td>Chain identification</td><td>CAIP-2 format, chain ID encoding in params</td></tr>
		<tr><td>Account identification</td><td>Address format, length, checksum, forbidden values</td></tr>
		<tr><td>Capabilities</td><td>Required vs. optional methods, events, chains</td></tr>
		<tr><td>Data encoding</td><td>Binary, integer, address, tx, signature encoding within JSON</td></tr>
		<tr><td>Methods</td><td>Params schema, result schema, validation, user confirmation</td></tr>
		<tr><td>Events</td><td>Data schema, trigger conditions, dApp handling</td></tr>
		<tr><td>Error codes</td><td>Standard + sub-protocol-specific error codes</td></tr>
		<tr><td>Security requirements</td><td>Confirmation UI, blind-sign policy, replay rules</td></tr>
	</tbody>
</table>

<p>
	See the <a href="/docs/evm-methods">EVM sub-protocol</a> as a reference implementation.
</p>
