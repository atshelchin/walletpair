export interface NavItem {
	title: string;
	href: string;
	separator?: boolean;
}

export const docsNav: NavItem[] = [
	{ title: 'Overview', href: '/docs' },
	{ title: 'Getting Started', href: '/docs/getting-started' },
	{ title: 'Core Concepts', href: '/docs/core-concepts' },
	{ title: 'dApp Integration', href: '/docs/dapp-integration' },
	{ title: 'Wallet Integration', href: '/docs/wallet-integration' },
	{ title: 'Self-Hosting Relay', href: '/docs/relay' },
	{ title: 'Security', href: '/docs/security' },
	{ title: 'Sub-Protocols', href: '', separator: true },
	{ title: 'Sub-Protocols Overview', href: '/docs/sub-protocols' },
	{ title: 'EVM Sub-Protocol', href: '/docs/evm-methods' },
	{ title: 'Wagmi Connector', href: '/docs/wagmi' }
];
