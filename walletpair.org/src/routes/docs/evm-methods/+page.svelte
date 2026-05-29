<svelte:head>
	<title>EVM Sub-Protocol — WalletPair</title>
</svelte:head>

<h1>EVM Sub-Protocol</h1>

<p>
	The EVM sub-protocol defines how WalletPair sessions interact with EIP-155 compatible chains
	(Ethereum, Polygon, Arbitrum, Base, etc.). It is one of several
	<a href="/docs/sub-protocols">sub-protocols</a> that plug into the chain-agnostic core protocol.
</p>

<p>
	Namespace: <code>evm</code> · Version: <code>1</code> · CAIP-2 prefix: <code>eip155</code>
</p>

<p>
	All methods use the <code>wallet_</code> prefix. Requests and responses are JSON objects
	encrypted end-to-end by the core protocol.
</p>

<h2 id="methods">Methods</h2>

<table>
	<thead>
		<tr>
			<th>Method</th>
			<th>Required</th>
			<th>Description</th>
		</tr>
	</thead>
	<tbody>
		<tr>
			<td><code>wallet_getAccounts</code></td>
			<td>Yes</td>
			<td>Return authorized accounts. Must not prompt.</td>
		</tr>
		<tr>
			<td><code>wallet_signTransaction</code></td>
			<td>Yes</td>
			<td>Sign a transaction without broadcasting. Returns signed RLP.</td>
		</tr>
		<tr>
			<td><code>wallet_sendTransaction</code></td>
			<td>No</td>
			<td>Sign and broadcast. Optional — cold wallets omit this.</td>
		</tr>
		<tr>
			<td><code>wallet_signMessage</code></td>
			<td>Yes</td>
			<td>EIP-191 personal sign. Not chain-bound.</td>
		</tr>
		<tr>
			<td><code>wallet_signTypedData</code></td>
			<td>Yes</td>
			<td>EIP-712 structured data signature.</td>
		</tr>
		<tr>
			<td><code>wallet_switchChain</code></td>
			<td>Yes</td>
			<td>Switch active chain. Must also emit <code>chainChanged</code>.</td>
		</tr>
		<tr>
			<td><code>wallet_addChain</code></td>
			<td>No</td>
			<td>Add a new chain to wallet.</td>
		</tr>
		<tr>
			<td><code>wallet_watchAsset</code></td>
			<td>No</td>
			<td>Track a token (ERC-20/721/1155).</td>
		</tr>
	</tbody>
</table>

<h2 id="events">Events</h2>

<table>
	<thead>
		<tr>
			<th>Event</th>
			<th>Description</th>
		</tr>
	</thead>
	<tbody>
		<tr>
			<td><code>accountsChanged</code></td>
			<td>Accounts list changed. Empty array = all access revoked.</td>
		</tr>
		<tr>
			<td><code>chainChanged</code></td>
			<td>Active chain changed.</td>
		</tr>
		<tr>
			<td><code>disconnect</code></td>
			<td>Wallet-initiated session end. Reasons: <code>user_closed</code>, <code>session_revoked</code>, <code>wallet_locked</code>.</td>
		</tr>
	</tbody>
</table>

<h2 id="errors">Error Codes</h2>

<table>
	<thead>
		<tr>
			<th>Code</th>
			<th>Meaning</th>
		</tr>
	</thead>
	<tbody>
		<tr><td><code>user_rejected</code></td><td>User declined in wallet UI</td></tr>
		<tr><td><code>unauthorized</code></td><td>Account not authorized for this session</td></tr>
		<tr><td><code>invalid_params</code></td><td>Malformed or missing parameters</td></tr>
		<tr><td><code>unsupported_chain</code></td><td>Chain not in capabilities</td></tr>
		<tr><td><code>unsupported_method</code></td><td>Method not in capabilities</td></tr>
		<tr><td><code>insufficient_funds</code></td><td>Balance too low</td></tr>
		<tr><td><code>nonce_too_low</code></td><td>Nonce already used</td></tr>
		<tr><td><code>gas_estimation_failed</code></td><td>Gas estimation reverted</td></tr>
		<tr><td><code>tx_rejected</code></td><td>Network rejected the transaction</td></tr>
		<tr><td><code>internal_error</code></td><td>Unexpected wallet error</td></tr>
	</tbody>
</table>

<h2 id="data-encoding">Data Encoding</h2>

<table>
	<thead>
		<tr>
			<th>Data Type</th>
			<th>Encoding</th>
		</tr>
	</thead>
	<tbody>
		<tr><td>Addresses</td><td><code>0x</code> + 40 hex chars (EIP-55 checksum)</td></tr>
		<tr><td>Values, nonce, gas</td><td><code>0x</code> hex string, no leading zeroes except <code>0x0</code></td></tr>
		<tr><td>Signed transactions</td><td><code>0x</code> hex string (full RLP)</td></tr>
		<tr><td>Signatures</td><td><code>0x</code> hex string, 65 bytes (r + s + v)</td></tr>
		<tr><td>Chain IDs (CAIP-2)</td><td><code>eip155:&lt;decimal&gt;</code></td></tr>
		<tr><td>Chain IDs (tx)</td><td><code>0x</code> hex</td></tr>
	</tbody>
</table>
