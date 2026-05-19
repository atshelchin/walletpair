<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	import '../app.css';
	import { page } from '$app/state';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>WalletPair</title>
</svelte:head>

<nav>
	<a href="/dapp" class:active={page.url.pathname === '/dapp'}>dApp</a>
	<a href="/dapp-wagmi" class:active={page.url.pathname === '/dapp-wagmi'}>dApp (wagmi)</a>
	<a href="/wallet" class:active={page.url.pathname === '/wallet'}>Wallet</a>
</nav>

{@render children()}
