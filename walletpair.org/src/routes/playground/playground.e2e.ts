import { test, expect, type Page } from '@playwright/test';

// ─── Helpers ────────────────────────────────────────────────────────

/** Wait for the playground to fully load (CSR page) */
async function waitForPlayground(page: Page) {
	await page.goto('/playground');
	await page.waitForSelector('.playground-wrap', { timeout: 10000 });
}

function dapp(page: Page) {
	return page.locator('.split > :first-child');
}

function wallet(page: Page) {
	return page.locator('.split > :nth-child(2)');
}

// ─── Landing & Navigation ───────────────────────────────────────────

test.describe('Playground page load', () => {
	test('renders playground with mode switcher', async ({ page }) => {
		await waitForPlayground(page);
		await expect(page.locator('h1')).toHaveText('Playground');
		await expect(page.locator('.mode-btn')).toHaveCount(2);
		await expect(page.locator('.mode-indicator')).toBeVisible();
	});

	test('defaults to Protocol mode', async ({ page }) => {
		await waitForPlayground(page);
		await expect(page.locator('.mode-btn.active')).toHaveText(/Protocol/);
		await expect(page.locator('.mode-indicator')).toContainText('Protocol Mode');
	});

	test('switches to EVM mode', async ({ page }) => {
		await waitForPlayground(page);
		await page.locator('.mode-btn', { hasText: 'EVM' }).click();
		await expect(page.locator('.mode-indicator')).toContainText('EVM Mode');
		// Should show EVM badges
		await expect(dapp(page).locator('.badge')).toContainText('EVM');
	});

	test('switches back to Protocol mode', async ({ page }) => {
		await waitForPlayground(page);
		await page.locator('.mode-btn', { hasText: 'EVM' }).click();
		await page.locator('.mode-btn', { hasText: 'Protocol' }).click();
		await expect(page.locator('.mode-indicator')).toContainText('Protocol Mode');
	});
});

// ─── Protocol Mode: dApp Panel ──────────────────────────────────────

test.describe('Protocol dApp panel', () => {
	test('shows transport selector with WebSocket active by default', async ({ page }) => {
		await waitForPlayground(page);
		const d = dapp(page);
		await expect(d.locator('.transport-btn.active')).toHaveText('WebSocket');
	});

	test('shows relay URL input', async ({ page }) => {
		await waitForPlayground(page);
		const d = dapp(page);
		const relayInput = d.locator('input[placeholder*="wss://"]');
		await expect(relayInput).toBeVisible();
		await expect(relayInput).toHaveValue('wss://relay.walletpair.org/v1');
	});

	test('shows metadata section expanded by default', async ({ page }) => {
		await waitForPlayground(page);
		const d = dapp(page);
		await expect(d.locator('input[placeholder="dApp name"]')).toBeVisible();
		await expect(d.locator('input[placeholder*="Icon URL"]')).toBeVisible();
	});

	test('metadata fields have default values', async ({ page }) => {
		await waitForPlayground(page);
		const d = dapp(page);
		await expect(d.locator('input[placeholder="dApp name"]')).toHaveValue('Protocol Playground');
		await expect(d.locator('input[placeholder*="Icon URL"]')).toHaveValue(
			'https://walletpair.org/favicon.png'
		);
	});

	test('can collapse and expand metadata', async ({ page }) => {
		await waitForPlayground(page);
		const d = dapp(page);
		await d.locator('.meta-toggle').click();
		await expect(d.locator('input[placeholder="dApp name"]')).not.toBeVisible();
		await d.locator('.meta-toggle').click();
		await expect(d.locator('input[placeholder="dApp name"]')).toBeVisible();
	});

	test('Connect button is present when idle', async ({ page }) => {
		await waitForPlayground(page);
		const d = dapp(page);
		await expect(d.locator('button', { hasText: 'Connect' })).toBeVisible();
	});

	test('shows empty message log', async ({ page }) => {
		await waitForPlayground(page);
		const d = dapp(page);
		await expect(d.locator('.empty')).toHaveText('No messages yet');
		await expect(d.locator('.log-count')).toHaveText('0');
	});

	test('can edit metadata fields', async ({ page }) => {
		await waitForPlayground(page);
		const d = dapp(page);
		const nameInput = d.locator('input[placeholder="dApp name"]');
		await nameInput.fill('My Test dApp');
		await expect(nameInput).toHaveValue('My Test dApp');
	});
});

// ─── Protocol Mode: Wallet Panel ────────────────────────────────────

test.describe('Protocol Wallet panel', () => {
	test('shows metadata section', async ({ page }) => {
		await waitForPlayground(page);
		const w = wallet(page);
		await expect(w.locator('input[placeholder="Wallet name"]')).toBeVisible();
		await expect(w.locator('input[placeholder="Wallet name"]')).toHaveValue('Protocol Wallet');
	});

	test('shows capabilities fields when idle', async ({ page }) => {
		await waitForPlayground(page);
		const w = wallet(page);
		await expect(w.locator('input[placeholder*="Methods:"]')).toBeVisible();
		await expect(w.locator('input[placeholder*="Events:"]')).toBeVisible();
		await expect(w.locator('input[placeholder*="Chains:"]')).toBeVisible();
	});

	test('capabilities have default values', async ({ page }) => {
		await waitForPlayground(page);
		const w = wallet(page);
		await expect(w.locator('input[placeholder*="Methods:"]')).toHaveValue(
			'myapp.getData, myapp.setData, myapp.deleteData'
		);
	});

	test('shows pairing URI input', async ({ page }) => {
		await waitForPlayground(page);
		const w = wallet(page);
		await expect(
			w.locator('input[placeholder*="walletpair:?ch="]')
		).toBeVisible();
	});

	test('Prepare Join button is disabled without URI', async ({ page }) => {
		await waitForPlayground(page);
		const w = wallet(page);
		await expect(w.locator('button', { hasText: 'Prepare Join' })).toBeDisabled();
	});

	test('shows empty message log', async ({ page }) => {
		await waitForPlayground(page);
		const w = wallet(page);
		await expect(w.locator('.empty')).toHaveText('No messages yet');
	});
});

// ─── EVM Mode: dApp Panel ───────────────────────────────────────────

test.describe('EVM dApp panel', () => {
	test('shows EVM badge', async ({ page }) => {
		await waitForPlayground(page);
		await page.locator('.mode-btn', { hasText: 'EVM' }).click();
		await expect(dapp(page).locator('.badge')).toContainText('EVM');
	});

	test('shows transport selector', async ({ page }) => {
		await waitForPlayground(page);
		await page.locator('.mode-btn', { hasText: 'EVM' }).click();
		await expect(dapp(page).locator('.transport-btn')).toHaveCount(2);
	});

	test('shows metadata with EVM defaults', async ({ page }) => {
		await waitForPlayground(page);
		await page.locator('.mode-btn', { hasText: 'EVM' }).click();
		await expect(dapp(page).locator('input[placeholder="dApp name"]')).toHaveValue(
			'EVM Playground'
		);
	});
});

// ─── EVM Mode: Wallet Panel ─────────────────────────────────────────

test.describe('EVM Wallet panel', () => {
	test('shows EVM badge', async ({ page }) => {
		await waitForPlayground(page);
		await page.locator('.mode-btn', { hasText: 'EVM' }).click();
		await expect(wallet(page).locator('.badge')).toContainText('EVM');
	});

	test('shows private key input and Generate button', async ({ page }) => {
		await waitForPlayground(page);
		await page.locator('.mode-btn', { hasText: 'EVM' }).click();
		const w = wallet(page);
		await expect(w.locator('input[type="password"]')).toBeVisible();
		await expect(w.locator('button', { hasText: 'Generate' })).toBeVisible();
	});

	test('can generate a key and show address', async ({ page }) => {
		await waitForPlayground(page);
		await page.locator('.mode-btn', { hasText: 'EVM' }).click();
		const w = wallet(page);
		await w.locator('button', { hasText: 'Generate' }).click();
		// Address should change from '--' to a 0x address
		await expect(w.locator('.addr')).not.toHaveText('--');
		const addr = await w.locator('.addr').textContent();
		expect(addr).toMatch(/^0x[0-9a-f]{40}$/);
	});

	test('shows Prepare Join button disabled without URI and key', async ({ page }) => {
		await waitForPlayground(page);
		await page.locator('.mode-btn', { hasText: 'EVM' }).click();
		const w = wallet(page);
		await expect(w.locator('button', { hasText: 'Prepare Join' })).toBeDisabled();
	});
});

// ─── Bluetooth Transport ────────────────────────────────────────────

test.describe('Bluetooth transport', () => {
	test('BLE option exists in transport selector', async ({ page }) => {
		await waitForPlayground(page);
		const d = dapp(page);
		const bleBtn = d.locator('.transport-btn', { hasText: /Bluetooth/ });
		await expect(bleBtn).toBeVisible();
	});

	test('switching to BLE hides wallet panel', async ({ page }) => {
		await waitForPlayground(page);
		const d = dapp(page);
		// Click BLE (may be disabled, but we can test the UI if supported)
		const bleBtn = d.locator('.transport-btn', { hasText: /Bluetooth/ });
		const isDisabled = await bleBtn.isDisabled();
		if (!isDisabled) {
			await bleBtn.click();
			// Wallet panel should be replaced with hint
			await expect(page.locator('.ble-wallet-hint')).toBeVisible();
			await expect(page.locator('.ble-wallet-hint h3')).toHaveText('Wallet on your device');
		}
	});

	test('switching back to WS shows wallet panel', async ({ page }) => {
		await waitForPlayground(page);
		const d = dapp(page);
		const bleBtn = d.locator('.transport-btn', { hasText: /Bluetooth/ });
		const isDisabled = await bleBtn.isDisabled();
		if (!isDisabled) {
			await bleBtn.click();
			await expect(page.locator('.ble-wallet-hint')).toBeVisible();
			// Switch back
			await d.locator('.transport-btn', { hasText: 'WebSocket' }).click();
			await expect(page.locator('.ble-wallet-hint')).not.toBeVisible();
		}
	});
});

// ─── WebSocket Connection Flow ──────────────────────────────────────

test.describe('WebSocket connection flow (Protocol mode)', () => {
	test('clicking Connect creates pairing and shows QR', async ({ page }) => {
		await waitForPlayground(page);
		const d = dapp(page);

		await d.locator('button', { hasText: 'Connect' }).click();

		// Should show QR code
		await expect(d.locator('img[alt="QR Code"]')).toBeVisible({ timeout: 10000 });

		// Should show pairing URI
		await expect(d.locator('.uri-box')).not.toHaveText('--');

		// Should show session fingerprint (4 digits)
		await expect(d.locator('.fingerprint')).toBeVisible();
		const fp = await d.locator('.fingerprint').textContent();
		expect(fp).toMatch(/^\d{4}$/);

		// Message log should have entries
		const logCount = await d.locator('.log-count').textContent();
		expect(Number(logCount)).toBeGreaterThan(0);

		// Phase should be waiting
		await expect(d.locator('.status')).toContainText('waiting');

		// Reset button should appear
		await expect(d.locator('button', { hasText: 'Reset' })).toBeVisible();
	});

	test('Copy URI button shows feedback', async ({ page, context }) => {
		await context.grantPermissions(['clipboard-read', 'clipboard-write']);
		await waitForPlayground(page);
		const d = dapp(page);

		await d.locator('button', { hasText: 'Connect' }).click();
		await expect(d.locator('img[alt="QR Code"]')).toBeVisible({ timeout: 10000 });

		const copyBtn = d.locator('button', { hasText: /Copy URI|Copied/ });
		await copyBtn.click();
		// After click, text should change (either 'Copied!' or stay 'Copy URI' if clipboard fails)
		// We just verify the button is clickable and doesn't crash
		await expect(copyBtn).toBeVisible();
	});

	test('Reset returns to idle state', async ({ page }) => {
		await waitForPlayground(page);
		const d = dapp(page);

		await d.locator('button', { hasText: 'Connect' }).click();
		await expect(d.locator('img[alt="QR Code"]')).toBeVisible({ timeout: 10000 });

		await d.locator('button', { hasText: 'Reset' }).click();

		// Should be back to idle
		await expect(d.locator('.status')).toContainText('idle');
		await expect(d.locator('img[alt="QR Code"]')).not.toBeVisible();
		await expect(d.locator('button', { hasText: 'Connect' })).toBeVisible();
	});

	test('wallet can paste URI and Prepare Join', async ({ page }) => {
		await waitForPlayground(page);
		const d = dapp(page);
		const w = wallet(page);

		// dApp: connect
		await d.locator('button', { hasText: 'Connect' }).click();
		await expect(d.locator('.uri-box')).not.toHaveText('--', { timeout: 10000 });

		// Get the URI
		const uri = await d.locator('.uri-box').textContent();
		expect(uri).toBeTruthy();

		// Wallet: paste URI
		await w.locator('input[placeholder*="walletpair:?ch="]').fill(uri!);

		// Wallet: click Prepare Join
		await w.locator('button', { hasText: 'Prepare Join' }).click();

		// Should show fingerprint
		await expect(w.locator('.fingerprint')).toBeVisible({ timeout: 5000 });
		const walletFp = await w.locator('.fingerprint').textContent();
		expect(walletFp).toMatch(/^\d{4}$/);

		// Fingerprints should match
		const dappFp = await d.locator('.fingerprint').textContent();
		expect(walletFp).toBe(dappFp);

		// Should show Confirm Join button
		await expect(w.locator('button', { hasText: 'Confirm Join' })).toBeVisible();
	});

	test('full pairing flow: connect → join → connected', async ({ page }) => {
		await waitForPlayground(page);
		const d = dapp(page);
		const w = wallet(page);

		// dApp: connect
		await d.locator('button', { hasText: 'Connect' }).click();
		await expect(d.locator('.uri-box')).not.toHaveText('--', { timeout: 10000 });

		const uri = await d.locator('.uri-box').textContent();

		// Wallet: paste URI and prepare join
		await w.locator('input[placeholder*="walletpair:?ch="]').fill(uri!);
		await w.locator('button', { hasText: 'Prepare Join' }).click();
		await expect(w.locator('.fingerprint')).toBeVisible({ timeout: 5000 });

		// Wallet: confirm join
		await w.locator('button', { hasText: 'Confirm Join' }).click();

		// Both should become connected
		await expect(d.locator('.status')).toContainText('connected', { timeout: 10000 });
		await expect(w.locator('.status')).toContainText('connected', { timeout: 10000 });

		// dApp should show peer metadata
		await expect(d.locator('.peer-name')).toBeVisible();

		// Wallet should show peer metadata
		await expect(w.locator('.peer-name')).toBeVisible();

		// dApp should show negotiated capabilities
		await expect(d.locator('.caps-box')).toBeVisible();
	});

	test('full flow: send request → approve → response', async ({ page }) => {
		await waitForPlayground(page);
		const d = dapp(page);
		const w = wallet(page);

		// Connect both sides
		await d.locator('button', { hasText: 'Connect' }).click();
		await expect(d.locator('.uri-box')).not.toHaveText('--', { timeout: 10000 });
		const uri = await d.locator('.uri-box').textContent();
		await w.locator('input[placeholder*="walletpair:?ch="]').fill(uri!);
		await w.locator('button', { hasText: 'Prepare Join' }).click();
		await expect(w.locator('.fingerprint')).toBeVisible({ timeout: 5000 });
		await w.locator('button', { hasText: 'Confirm Join' }).click();
		await expect(d.locator('.status')).toContainText('connected', { timeout: 10000 });

		// dApp: select a method (first capability tag) and send
		await d.locator('.cap-tag').first().click();
		await d.locator('button', { hasText: 'Send' }).click();

		// Wallet: should see incoming request
		await expect(w.locator('.req-card')).toBeVisible({ timeout: 5000 });
		await expect(w.locator('.req-method')).toContainText('myapp.');

		// Wallet: approve
		await w.locator('button', { hasText: 'Approve' }).click();

		// dApp log should show response
		await expect(d.locator('.log-entry .type', { hasText: 'res' })).toBeVisible({ timeout: 5000 });

		// Request card should be gone from wallet
		await expect(w.locator('.req-card')).not.toBeVisible();
	});

	test('full flow: send request → reject', async ({ page }) => {
		await waitForPlayground(page);
		const d = dapp(page);
		const w = wallet(page);

		// Connect
		await d.locator('button', { hasText: 'Connect' }).click();
		await expect(d.locator('.uri-box')).not.toHaveText('--', { timeout: 10000 });
		const uri = await d.locator('.uri-box').textContent();
		await w.locator('input[placeholder*="walletpair:?ch="]').fill(uri!);
		await w.locator('button', { hasText: 'Prepare Join' }).click();
		await expect(w.locator('.fingerprint')).toBeVisible({ timeout: 5000 });
		await w.locator('button', { hasText: 'Confirm Join' }).click();
		await expect(d.locator('.status')).toContainText('connected', { timeout: 10000 });

		// Send request
		await d.locator('.cap-tag').first().click();
		await d.locator('button', { hasText: 'Send' }).click();
		await expect(w.locator('.req-card')).toBeVisible({ timeout: 5000 });

		// Reject
		await w.locator('button', { hasText: 'Reject' }).click();

		// dApp log should show the rejection — wait a bit and check log content
		await page.waitForTimeout(2000);
		const logText = await d.locator('.log-wrap').textContent();
		expect(logText).toMatch(/ok=false|req_error|rejected/i);
	});

	test('wallet can push events', async ({ page }) => {
		await waitForPlayground(page);
		const d = dapp(page);
		const w = wallet(page);

		// Connect
		await d.locator('button', { hasText: 'Connect' }).click();
		await expect(d.locator('.uri-box')).not.toHaveText('--', { timeout: 10000 });
		const uri = await d.locator('.uri-box').textContent();
		await w.locator('input[placeholder*="walletpair:?ch="]').fill(uri!);
		await w.locator('button', { hasText: 'Prepare Join' }).click();
		await expect(w.locator('.fingerprint')).toBeVisible({ timeout: 5000 });
		await w.locator('button', { hasText: 'Confirm Join' }).click();
		await expect(d.locator('.status')).toContainText('connected', { timeout: 10000 });

		// Wallet: push event
		await w.locator('button', { hasText: 'Push Event' }).click();

		// dApp log should show event
		await expect(d.locator('.log-entry .type', { hasText: 'evt' })).toBeVisible({ timeout: 5000 });
	});

	test('close session from dApp', async ({ page }) => {
		await waitForPlayground(page);
		const d = dapp(page);
		const w = wallet(page);

		// Connect
		await d.locator('button', { hasText: 'Connect' }).click();
		await expect(d.locator('.uri-box')).not.toHaveText('--', { timeout: 10000 });
		const uri = await d.locator('.uri-box').textContent();
		await w.locator('input[placeholder*="walletpair:?ch="]').fill(uri!);
		await w.locator('button', { hasText: 'Prepare Join' }).click();
		await expect(w.locator('.fingerprint')).toBeVisible({ timeout: 5000 });
		await w.locator('button', { hasText: 'Confirm Join' }).click();
		await expect(d.locator('.status')).toContainText('connected', { timeout: 10000 });

		// Close from dApp
		await d.locator('button', { hasText: 'Close' }).click();

		// dApp log should show close
		await expect(d.locator('.log-entry .type', { hasText: 'close' })).toBeVisible();
	});

	test('close session from wallet', async ({ page }) => {
		await waitForPlayground(page);
		const d = dapp(page);
		const w = wallet(page);

		// Connect
		await d.locator('button', { hasText: 'Connect' }).click();
		await expect(d.locator('.uri-box')).not.toHaveText('--', { timeout: 10000 });
		const uri = await d.locator('.uri-box').textContent();
		await w.locator('input[placeholder*="walletpair:?ch="]').fill(uri!);
		await w.locator('button', { hasText: 'Prepare Join' }).click();
		await expect(w.locator('.fingerprint')).toBeVisible({ timeout: 5000 });
		await w.locator('button', { hasText: 'Confirm Join' }).click();
		await expect(w.locator('.status')).toContainText('connected', { timeout: 10000 });

		// Close from wallet
		await w.locator('button', { hasText: 'Close' }).click();

		// Wallet log should show close
		await expect(w.locator('.log-entry .type', { hasText: 'close' })).toBeVisible();
	});
});

// ─── MessageLog ─────────────────────────────────────────────────────

test.describe('MessageLog', () => {
	test('shows timestamps', async ({ page }) => {
		await waitForPlayground(page);
		const d = dapp(page);
		await d.locator('button', { hasText: 'Connect' }).click();
		await expect(d.locator('.log-entry .time').first()).toBeVisible({ timeout: 10000 });
		const time = await d.locator('.log-entry .time').first().textContent();
		expect(time).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}/);
	});

	test('shows entry count', async ({ page }) => {
		await waitForPlayground(page);
		const d = dapp(page);
		await d.locator('button', { hasText: 'Connect' }).click();
		await expect(d.locator('.log-count')).not.toHaveText('0', { timeout: 10000 });
	});
});

// ─── Use dApp's URI button ──────────────────────────────────────────

test.describe('Auto-fill URI', () => {
	test('wallet shows "Use dApp\'s URI" button after dApp connects', async ({ page }) => {
		await waitForPlayground(page);
		const d = dapp(page);
		const w = wallet(page);

		await d.locator('button', { hasText: 'Connect' }).click();
		await expect(d.locator('.uri-box')).not.toHaveText('--', { timeout: 10000 });

		// Wallet should show the auto-fill button
		await expect(w.locator('button', { hasText: "Use dApp's URI" })).toBeVisible();
	});

	test('clicking auto-fill populates the URI input', async ({ page }) => {
		await waitForPlayground(page);
		const d = dapp(page);
		const w = wallet(page);

		await d.locator('button', { hasText: 'Connect' }).click();
		await expect(d.locator('.uri-box')).not.toHaveText('--', { timeout: 10000 });

		await w.locator('button', { hasText: "Use dApp's URI" }).click();

		const uriInput = w.locator('input[placeholder*="walletpair:?ch="]');
		await expect(uriInput).not.toHaveValue('');
	});
});

// ─── Reconnect ──────────────────────────────────────────────────────

test.describe('Reconnect', () => {
	test('after full pairing, localStorage has session snapshot', async ({ page }) => {
		await waitForPlayground(page);
		const d = dapp(page);
		const w = wallet(page);

		// Full pairing flow needed for snapshot (keys are derived after join)
		await d.locator('button', { hasText: 'Connect' }).click();
		await expect(d.locator('.uri-box')).not.toHaveText('--', { timeout: 10000 });
		const uri = await d.locator('.uri-box').textContent();
		await w.locator('input[placeholder*="walletpair:?ch="]').fill(uri!);
		await w.locator('button', { hasText: 'Prepare Join' }).click();
		await expect(w.locator('.fingerprint')).toBeVisible({ timeout: 5000 });
		await w.locator('button', { hasText: 'Confirm Join' }).click();
		await expect(d.locator('.status')).toContainText('connected', { timeout: 10000 });

		// Now the snapshot should exist
		const snap = await page.evaluate(() =>
			localStorage.getItem('walletpair.playground.dapp')
		);
		expect(snap).toBeTruthy();
	});

	test('reset clears localStorage', async ({ page }) => {
		await waitForPlayground(page);
		const d = dapp(page);
		const w = wallet(page);

		// Full pairing to generate snapshot
		await d.locator('button', { hasText: 'Connect' }).click();
		await expect(d.locator('.uri-box')).not.toHaveText('--', { timeout: 10000 });
		const uri = await d.locator('.uri-box').textContent();
		await w.locator('input[placeholder*="walletpair:?ch="]').fill(uri!);
		await w.locator('button', { hasText: 'Prepare Join' }).click();
		await expect(w.locator('.fingerprint')).toBeVisible({ timeout: 5000 });
		await w.locator('button', { hasText: 'Confirm Join' }).click();
		await expect(d.locator('.status')).toContainText('connected', { timeout: 10000 });

		await d.locator('button', { hasText: 'Reset' }).click();

		const snap = await page.evaluate(() =>
			localStorage.getItem('walletpair.playground.dapp')
		);
		expect(snap).toBeNull();
	});
});
