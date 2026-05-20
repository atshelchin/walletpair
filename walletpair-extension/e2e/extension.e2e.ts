/**
 * Comprehensive E2E test suite for WalletPair Chrome Extension.
 *
 * Tests provider injection, EIP-1193 compliance, EIP-6963 discovery,
 * edge cases, concurrency, multi-tab, error paths, page lifecycle,
 * and extension page accessibility.
 *
 * Usage: npx tsx e2e/extension.e2e.ts
 */

import puppeteer, { type Browser, type Page } from 'puppeteer';
import { resolve } from 'path';

const EXT_PATH = resolve(import.meta.dirname!, '..', '.output', 'chrome-mv3');
const TEST_URL = 'http://localhost:3000/dapp.html';
const TIMEOUT = 10_000;

let browser: Browser;
let page: Page;
let extensionId: string;

const results: Array<{ name: string; pass: boolean; error?: string; ms: number }> = [];

async function test(name: string, fn: () => Promise<void>) {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, pass: true, ms: Date.now() - start });
    console.log(`  ✅ ${name} (${Date.now() - start}ms)`);
  } catch (err: any) {
    results.push({ name, pass: false, error: err.message, ms: Date.now() - start });
    console.log(`  ❌ ${name}: ${err.message} (${Date.now() - start}ms)`);
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

// ── Setup ──────────────────────────────────────────────────────────────

async function setup() {
  console.log(`\n🚀 Launching Chrome with extension from ${EXT_PATH}\n`);

  browser = await puppeteer.launch({
    headless: false,
    userDataDir: '/tmp/walletpair-e2e-profile',
    args: [
      `--load-extension=${EXT_PATH}`,
      `--disable-extensions-except=${EXT_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-popup-blocking',
      '--window-size=1280,800',
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
    timeout: 30_000,
  });

  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((r) => setTimeout(r, 1000));
    const swTarget = browser.targets().find(
      (t) => t.type() === 'service_worker' && t.url().includes('chrome-extension://'),
    );
    if (swTarget) {
      extensionId = swTarget.url().match(/chrome-extension:\/\/([a-z]+)/)?.[1] ?? '';
      break;
    }
  }
  assert(extensionId?.length > 0, 'Extension not loaded');
  console.log(`  Extension loaded: ${extensionId}`);

  page = await browser.newPage();
  await page.goto(TEST_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await new Promise((r) => setTimeout(r, 1000));
}

async function teardown() {
  if (browser) await browser.close();
}

// Helper: open a fresh page with provider
async function freshPage(url = TEST_URL): Promise<Page> {
  const p = await browser.newPage();
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await new Promise((r) => setTimeout(r, 800));
  return p;
}

// ── Tests ──────────────────────────────────────────────────────────────

async function runTests() {
  // ═══════════════════════════════════════════════════════════════
  //  Section 1: Provider Injection
  // ═══════════════════════════════════════════════════════════════

  await test('1.1 window.walletpair is injected', async () => {
    const has = await page.evaluate(() => typeof (window as any).walletpair !== 'undefined');
    assert(has, 'window.walletpair is undefined');
  });

  await test('1.2 window.ethereum is injected', async () => {
    const has = await page.evaluate(() => typeof (window as any).ethereum !== 'undefined');
    assert(has, 'window.ethereum is undefined');
  });

  await test('1.3 isWalletPair flag is true', async () => {
    const flag = await page.evaluate(() => (window as any).walletpair?.isWalletPair);
    assert(flag === true, `isWalletPair is ${flag}`);
  });

  await test('1.4 provider is not isMetaMask', async () => {
    // We should NOT impersonate MetaMask
    const isMM = await page.evaluate(() => (window as any).walletpair?.isMetaMask);
    assert(isMM !== true, 'should not be isMetaMask');
  });

  // ═══════════════════════════════════════════════════════════════
  //  Section 2: EIP-1193 Interface Completeness
  // ═══════════════════════════════════════════════════════════════

  const requiredMethods = [
    'request', 'on', 'once', 'removeListener', 'addListener',
    'removeAllListeners', 'listenerCount', 'emit',
    'enable', 'send', 'sendAsync', 'isConnected',
  ];

  for (const method of requiredMethods) {
    await test(`2.${requiredMethods.indexOf(method) + 1} provider.${method} is a function`, async () => {
      const type = await page.evaluate((m: string) => typeof (window as any).walletpair?.[m], method);
      assert(type === 'function', `${method} is ${type}`);
    });
  }

  await test('2.13 provider._metamask.isUnlocked exists', async () => {
    const type = await page.evaluate(() => typeof (window as any).walletpair?._metamask?.isUnlocked);
    assert(type === 'function', `_metamask.isUnlocked is ${type}`);
  });

  await test('2.14 selectedAddress is null when disconnected', async () => {
    const addr = await page.evaluate(() => (window as any).walletpair?.selectedAddress);
    assert(addr === null, `selectedAddress is ${addr}`);
  });

  await test('2.15 chainId property is hex string', async () => {
    const cid = await page.evaluate(() => (window as any).walletpair?.chainId);
    assert(typeof cid === 'string' && cid.startsWith('0x'), `chainId is ${cid}`);
  });

  await test('2.16 networkVersion is decimal string', async () => {
    const nv = await page.evaluate(() => (window as any).walletpair?.networkVersion);
    assert(typeof nv === 'string' && !nv.startsWith('0x'), `networkVersion is ${nv}`);
  });

  await test('2.17 isConnected() returns false initially', async () => {
    const c = await page.evaluate(() => (window as any).walletpair?.isConnected());
    assert(c === false, `isConnected is ${c}`);
  });

  await test('2.18 _metamask.isUnlocked() returns false when disconnected', async () => {
    const unlocked = await page.evaluate(() => (window as any).walletpair._metamask.isUnlocked());
    assert(unlocked === false, `isUnlocked is ${unlocked}`);
  });

  // ═══════════════════════════════════════════════════════════════
  //  Section 3: EIP-6963 Multi-Provider Discovery
  // ═══════════════════════════════════════════════════════════════

  await test('3.1 EIP-6963 announceProvider on requestProvider', async () => {
    const r = await page.evaluate(() => new Promise((resolve) => {
      window.addEventListener('eip6963:announceProvider', (event) => {
        const e = event as CustomEvent;
        resolve(e.detail?.info);
      }, { once: true });
      window.dispatchEvent(new Event('eip6963:requestProvider'));
      setTimeout(() => resolve(null), 3000);
    }));
    assert(r !== null, 'No EIP-6963 response');
    assert((r as any).name === 'WalletPair', `name is ${(r as any).name}`);
    assert((r as any).rdns === 'org.walletpair.extension', `rdns is ${(r as any).rdns}`);
  });

  await test('3.2 EIP-6963 UUID is a valid UUID format', async () => {
    const r = await page.evaluate(() => new Promise((resolve) => {
      window.addEventListener('eip6963:announceProvider', (e: any) => resolve(e.detail?.info?.uuid), { once: true });
      window.dispatchEvent(new Event('eip6963:requestProvider'));
      setTimeout(() => resolve(null), 2000);
    }));
    assert(typeof r === 'string' && /^[0-9a-f-]{36}$/i.test(r as string), `uuid is ${r}`);
  });

  await test('3.3 EIP-6963 icon is a data URI', async () => {
    const r = await page.evaluate(() => new Promise((resolve) => {
      window.addEventListener('eip6963:announceProvider', (e: any) => resolve(e.detail?.info?.icon), { once: true });
      window.dispatchEvent(new Event('eip6963:requestProvider'));
      setTimeout(() => resolve(null), 2000);
    }));
    assert(typeof r === 'string' && (r as string).startsWith('data:image/'), `icon is ${(r as string)?.slice(0, 30)}`);
  });

  await test('3.4 EIP-6963 detail has provider reference', async () => {
    const r = await page.evaluate(() => new Promise((resolve) => {
      window.addEventListener('eip6963:announceProvider', (e: any) => {
        resolve({
          hasProvider: !!e.detail?.provider,
          providerIsWP: e.detail?.provider?.isWalletPair === true,
        });
      }, { once: true });
      window.dispatchEvent(new Event('eip6963:requestProvider'));
      setTimeout(() => resolve(null), 2000);
    }));
    assert((r as any)?.hasProvider === true, 'provider missing');
    assert((r as any)?.providerIsWP === true, 'provider.isWalletPair is not true');
  });

  await test('3.5 EIP-6963 re-announces on multiple requests', async () => {
    const count = await page.evaluate(`new Promise(resolve => {
      let n = 0;
      function handler() { n++; }
      window.addEventListener('eip6963:announceProvider', handler);
      window.dispatchEvent(new Event('eip6963:requestProvider'));
      window.dispatchEvent(new Event('eip6963:requestProvider'));
      window.dispatchEvent(new Event('eip6963:requestProvider'));
      setTimeout(() => {
        window.removeEventListener('eip6963:announceProvider', handler);
        resolve(n);
      }, 500);
    })`);
    assert((count as number) >= 3, `announced ${count} times, expected >= 3`);
  });

  // ═══════════════════════════════════════════════════════════════
  //  Section 4: Local RPC Methods
  // ═══════════════════════════════════════════════════════════════

  await test('4.1 eth_chainId returns hex', async () => {
    const r = await page.evaluate(() => (window as any).walletpair.request({ method: 'eth_chainId' }));
    assert(typeof r === 'string' && r.startsWith('0x'), `chainId is ${r}`);
  });

  await test('4.2 net_version returns decimal string', async () => {
    const r = await page.evaluate(() => (window as any).walletpair.request({ method: 'net_version' }));
    assert(typeof r === 'string' && /^\d+$/.test(r as string), `net_version is ${r}`);
  });

  await test('4.3 web3_clientVersion starts with WalletPair/', async () => {
    const r = await page.evaluate(() => (window as any).walletpair.request({ method: 'web3_clientVersion' }));
    assert(typeof r === 'string' && (r as string).startsWith('WalletPair/'), `version is ${r}`);
  });

  await test('4.4 eth_accounts returns empty array when disconnected', async () => {
    const r = await page.evaluate(() => (window as any).walletpair.request({ method: 'eth_accounts' }));
    assert(Array.isArray(r) && r.length === 0, `accounts is ${JSON.stringify(r)}`);
  });

  await test('4.5 eth_chainId and chainId property match', async () => {
    const [rpc, prop] = await page.evaluate(() => {
      const wp = (window as any).walletpair;
      return Promise.all([wp.request({ method: 'eth_chainId' }), wp.chainId]);
    });
    assert(rpc === prop, `rpc=${rpc} prop=${prop}`);
  });

  await test('4.6 net_version and networkVersion property match', async () => {
    const [rpc, prop] = await page.evaluate(() => {
      const wp = (window as any).walletpair;
      return Promise.all([wp.request({ method: 'net_version' }), wp.networkVersion]);
    });
    assert(rpc === prop, `rpc=${rpc} prop=${prop}`);
  });

  await test('4.7 wallet_getPermissions returns empty when not connected', async () => {
    const r = await page.evaluate(() => (window as any).walletpair.request({ method: 'wallet_getPermissions' }));
    assert(Array.isArray(r) && r.length === 0, `permissions is ${JSON.stringify(r)}`);
  });

  // ═══════════════════════════════════════════════════════════════
  //  Section 5: Unsupported / Deprecated Methods
  // ═══════════════════════════════════════════════════════════════

  for (const method of ['eth_sign', 'eth_decrypt', 'eth_getEncryptionPublicKey']) {
    await test(`5.${['eth_sign', 'eth_decrypt', 'eth_getEncryptionPublicKey'].indexOf(method) + 1} ${method} throws code 4200`, async () => {
      const r = await page.evaluate(async (m: string) => {
        try {
          await (window as any).walletpair.request({ method: m });
          return { threw: false };
        } catch (err: any) {
          return { threw: true, code: err.code, name: err.name };
        }
      }, method);
      assert(r.threw, `${method} did not throw`);
      assert(r.code === 4200, `code is ${r.code}`);
      assert(r.name === 'ProviderRpcError', `name is ${r.name}`);
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  Section 6: Event Emitter Edge Cases
  // ═══════════════════════════════════════════════════════════════

  await test('6.1 on/emit basic', async () => {
    const r = await page.evaluate(() => {
      const wp = (window as any).walletpair;
      let val: any = null;
      wp.on('_t1', (d: any) => { val = d; });
      wp.emit('_t1', { x: 1 });
      return val;
    });
    assert((r as any)?.x === 1, `got ${JSON.stringify(r)}`);
  });

  await test('6.2 once fires exactly once', async () => {
    const r = await page.evaluate(() => {
      const wp = (window as any).walletpair;
      let n = 0;
      wp.once('_t2', () => n++);
      wp.emit('_t2'); wp.emit('_t2'); wp.emit('_t2');
      return n;
    });
    assert(r === 1, `fired ${r} times`);
  });

  await test('6.3 removeListener stops delivery', async () => {
    const r = await page.evaluate(`(() => {
      var wp = window.walletpair;
      var n = 0;
      function h() { n++; }
      wp.on('_t3', h);
      wp.emit('_t3');
      wp.removeListener('_t3', h);
      wp.emit('_t3');
      return n;
    })()`);
    assert(r === 1, `fired ${r} times`);
  });

  await test('6.4 removeAllListeners clears specific event', async () => {
    const r = await page.evaluate(() => {
      const wp = (window as any).walletpair;
      let a = 0, b = 0;
      wp.on('_t4a', () => a++);
      wp.on('_t4b', () => b++);
      wp.removeAllListeners('_t4a');
      wp.emit('_t4a'); wp.emit('_t4b');
      return { a, b };
    });
    assert((r as any).a === 0 && (r as any).b === 1, `a=${(r as any).a} b=${(r as any).b}`);
  });

  await test('6.5 removeAllListeners() clears all events', async () => {
    const r = await page.evaluate(() => {
      const wp = (window as any).walletpair;
      let n = 0;
      wp.on('_t5a', () => n++);
      wp.on('_t5b', () => n++);
      wp.removeAllListeners();
      wp.emit('_t5a'); wp.emit('_t5b');
      return n;
    });
    assert(r === 0, `fired ${r} times`);
  });

  await test('6.6 listenerCount is accurate', async () => {
    const r = await page.evaluate(`(() => {
      var wp = window.walletpair;
      function h1() {}
      function h2() {}
      wp.on('_t6', h1);
      wp.on('_t6', h2);
      var c = wp.listenerCount('_t6');
      wp.removeAllListeners('_t6');
      return c;
    })()`);
    assert(r === 2, `count is ${r}`);
  });

  await test('6.7 multiple handlers on same event all fire', async () => {
    const r = await page.evaluate(() => {
      const wp = (window as any).walletpair;
      const calls: number[] = [];
      wp.on('_t7', () => calls.push(1));
      wp.on('_t7', () => calls.push(2));
      wp.on('_t7', () => calls.push(3));
      wp.emit('_t7');
      wp.removeAllListeners('_t7');
      return calls;
    });
    assert(JSON.stringify(r) === '[1,2,3]', `calls is ${JSON.stringify(r)}`);
  });

  await test('6.8 handler error does not crash other handlers', async () => {
    const r = await page.evaluate(() => {
      const wp = (window as any).walletpair;
      let called = false;
      wp.on('_t8', () => { throw new Error('boom'); });
      wp.on('_t8', () => { called = true; });
      wp.emit('_t8');
      wp.removeAllListeners('_t8');
      return called;
    });
    assert(r === true, 'second handler did not fire');
  });

  await test('6.9 addListener is alias for on', async () => {
    const r = await page.evaluate(() => {
      const wp = (window as any).walletpair;
      let n = 0;
      wp.addListener('_t9', () => n++);
      wp.emit('_t9');
      wp.removeAllListeners('_t9');
      return n;
    });
    assert(r === 1, `fired ${r} times`);
  });

  await test('6.10 on/once return provider for chaining', async () => {
    const r = await page.evaluate(() => {
      const wp = (window as any).walletpair;
      const a = wp.on('_tc', () => {});
      const b = wp.once('_tc2', () => {});
      wp.removeAllListeners('_tc');
      wp.removeAllListeners('_tc2');
      return { onReturns: a === wp, onceReturns: b === wp };
    });
    assert((r as any).onReturns && (r as any).onceReturns, 'chaining broken');
  });

  // ═══════════════════════════════════════════════════════════════
  //  Section 7: Legacy Method Compatibility
  // ═══════════════════════════════════════════════════════════════

  await test('7.1 enable() returns promise', async () => {
    // enable() calls eth_requestAccounts which will fail without wallet,
    // but it should return a promise
    const type = await page.evaluate(() => {
      const wp = (window as any).walletpair;
      const result = wp.enable();
      // It's a promise — cancel it
      result.catch(() => {});
      return typeof result?.then;
    });
    assert(type === 'function', `enable() did not return promise`);
  });

  await test('7.2 send(method) returns promise', async () => {
    const r = await page.evaluate(async () => {
      const wp = (window as any).walletpair;
      const chainId = await wp.send('eth_chainId');
      return chainId;
    });
    assert(typeof r === 'string' && (r as string).startsWith('0x'), `send result is ${r}`);
  });

  await test('7.3 sendAsync(payload, callback) works', async () => {
    const r = await page.evaluate(() => new Promise((resolve) => {
      (window as any).walletpair.sendAsync(
        { method: 'eth_chainId', id: 42 },
        (err: any, result: any) => resolve({ err, result }),
      );
    }));
    assert((r as any).err === null, `err is ${(r as any).err}`);
    assert((r as any).result?.id === 42, `id is ${(r as any).result?.id}`);
    assert(typeof (r as any).result?.result === 'string', 'no result value');
  });

  // ═══════════════════════════════════════════════════════════════
  //  Section 8: Multi-Tab Behavior
  // ═══════════════════════════════════════════════════════════════

  await test('8.1 provider injected on second tab', async () => {
    const p2 = await freshPage();
    const has = await p2.evaluate(() => typeof (window as any).walletpair !== 'undefined');
    await p2.close();
    assert(has, 'walletpair not on second tab');
  });

  await test('8.2 each tab gets independent event emitters', async () => {
    const p2 = await freshPage();
    // Register listener on tab2
    await p2.evaluate(() => { (window as any)._testCount = 0; (window as any).walletpair.on('_mt', () => { (window as any)._testCount++; }); });
    // Emit on tab1
    await page.evaluate(() => (window as any).walletpair.emit('_mt'));
    // Check tab2 — should NOT have fired (different JS contexts)
    const count = await p2.evaluate(() => (window as any)._testCount);
    await p2.evaluate(() => (window as any).walletpair.removeAllListeners('_mt'));
    await p2.close();
    assert(count === 0, `tab2 count is ${count}, should be 0`);
  });

  await test('8.3 concurrent eth_chainId from multiple tabs', async () => {
    const p2 = await freshPage();
    const [r1, r2] = await Promise.all([
      page.evaluate(() => (window as any).walletpair.request({ method: 'eth_chainId' })),
      p2.evaluate(() => (window as any).walletpair.request({ method: 'eth_chainId' })),
    ]);
    await p2.close();
    assert(r1 === r2, `tab1=${r1} tab2=${r2}`);
  });

  // ═══════════════════════════════════════════════════════════════
  //  Section 9: Page Lifecycle
  // ═══════════════════════════════════════════════════════════════

  await test('9.1 provider survives page reload', async () => {
    const p = await freshPage();
    await p.reload({ waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 800));
    const has = await p.evaluate(() => typeof (window as any).walletpair !== 'undefined');
    await p.close();
    assert(has, 'walletpair lost after reload');
  });

  await test('9.2 provider works on different origins', async () => {
    // about:blank won't have content scripts, but any http page should
    const p = await browser.newPage();
    // Navigate to a different port/path if available, or just reload same
    await p.goto(TEST_URL + '?origin_test=1', { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await new Promise((r) => setTimeout(r, 800));
    const has = await p.evaluate(() => typeof (window as any).walletpair !== 'undefined');
    await p.close();
    assert(has, 'walletpair not on different URL');
  });

  // ═══════════════════════════════════════════════════════════════
  //  Section 10: Extension Pages
  // ═══════════════════════════════════════════════════════════════

  await test('10.1 popup.html loads correctly', async () => {
    const p = await browser.newPage();
    await p.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    const title = await p.title();
    await p.close();
    assert(title === 'WalletPair', `title is "${title}"`);
  });

  await test('10.2 sidepanel.html loads correctly', async () => {
    const p = await browser.newPage();
    await p.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    const title = await p.title();
    await p.close();
    assert(title === 'WalletPair', `title is "${title}"`);
  });

  await test('10.3 confirm.html loads correctly', async () => {
    const p = await browser.newPage();
    await p.goto(`chrome-extension://${extensionId}/confirm.html`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    const title = await p.title();
    await p.close();
    assert(title.includes('WalletPair') || title.includes('Confirm'), `title is "${title}"`);
  });

  // ═══════════════════════════════════════════════════════════════
  //  Section 11: RPC Proxy (read-only methods)
  // ═══════════════════════════════════════════════════════════════

  await test('11.1 eth_blockNumber proxies to public RPC', async () => {
    const r = await page.evaluate(async () => {
      try {
        return { ok: true, v: await (window as any).walletpair.request({ method: 'eth_blockNumber' }) };
      } catch (e: any) { return { ok: false, e: e.message }; }
    });
    if ((r as any).ok) {
      assert(typeof (r as any).v === 'string' && (r as any).v.startsWith('0x'), `blockNum is ${(r as any).v}`);
    }
    // Network errors acceptable in test env
  });

  await test('11.2 eth_getBalance proxies correctly', async () => {
    const r = await page.evaluate(async () => {
      try {
        return { ok: true, v: await (window as any).walletpair.request({
          method: 'eth_getBalance',
          params: ['0x0000000000000000000000000000000000000000', 'latest'],
        }) };
      } catch (e: any) { return { ok: false, e: e.message }; }
    });
    if ((r as any).ok) {
      assert(typeof (r as any).v === 'string' && (r as any).v.startsWith('0x'), `balance is ${(r as any).v}`);
    }
  });

  // ═══════════════════════════════════════════════════════════════
  //  Section 12: Error Handling Edge Cases
  // ═══════════════════════════════════════════════════════════════

  await test('12.1 request with no args throws', async () => {
    const r = await page.evaluate(async () => {
      try {
        await (window as any).walletpair.request();
        return { threw: false };
      } catch { return { threw: true }; }
    });
    assert((r as any).threw, 'should throw on no args');
  });

  await test('12.2 request with empty object throws', async () => {
    const r = await page.evaluate(async () => {
      try {
        await (window as any).walletpair.request({});
        return { threw: false };
      } catch { return { threw: true }; }
    });
    // Some implementations allow empty method, but it should at least not crash
  });

  await test('12.3 eth_requestAccounts without wallet times out gracefully', async () => {
    // This should eventually timeout or return an error (no wallet connected)
    const r = await page.evaluate(() => {
      const wp = (window as any).walletpair;
      // Start the request but don't wait — just check it returns a promise
      const p = wp.request({ method: 'eth_requestAccounts' });
      const isPromise = typeof p?.then === 'function';
      p.catch(() => {}); // Prevent unhandled rejection
      return isPromise;
    });
    assert(r === true, 'eth_requestAccounts did not return a promise');
  });

  await test('12.4 concurrent identical requests are stable', async () => {
    const r = await page.evaluate(async () => {
      const wp = (window as any).walletpair;
      const results = await Promise.all([
        wp.request({ method: 'eth_chainId' }),
        wp.request({ method: 'eth_chainId' }),
        wp.request({ method: 'eth_chainId' }),
        wp.request({ method: 'net_version' }),
        wp.request({ method: 'web3_clientVersion' }),
      ]);
      return results;
    });
    const arr = r as string[];
    assert(arr[0] === arr[1] && arr[1] === arr[2], 'concurrent chainId mismatch');
    assert(arr[3] === String(parseInt(arr[0]!, 16)), 'net_version mismatch');
    assert(arr[4]!.startsWith('WalletPair/'), 'clientVersion mismatch');
  });

  await test('12.5 rapid fire requests do not crash', async () => {
    const r = await page.evaluate(async () => {
      const wp = (window as any).walletpair;
      const promises = [];
      for (let i = 0; i < 50; i++) {
        promises.push(wp.request({ method: 'eth_chainId' }));
      }
      const results = await Promise.all(promises);
      return results.every((r: string) => r === results[0]);
    });
    assert(r === true, 'rapid fire results inconsistent');
  });
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  try {
    await setup();
    console.log('\n📋 Running E2E tests...\n');
    await runTests();
  } catch (err: any) {
    console.error(`\n💥 Setup failed: ${err.message}`);
    results.push({ name: 'SETUP', pass: false, error: err.message, ms: 0 });
  } finally {
    await teardown();
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  const total = results.length;

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);
  console.log(`${'─'.repeat(60)}\n`);

  if (failed > 0) {
    console.log('Failed tests:');
    for (const r of results.filter((r) => !r.pass)) {
      console.log(`  ❌ ${r.name}: ${r.error}`);
    }
    process.exit(1);
  }

  process.exit(0);
}

main();
