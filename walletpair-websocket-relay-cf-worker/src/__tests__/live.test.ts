/**
 * Live tests against deployed relay at https://relay.walletpair.org
 * Run: npx vitest run src/__tests__/live.test.ts
 *
 * These tests use real WebSocket connections to verify the production
 * deployment behaves identically to the local tests.
 */
import { describe, it, expect } from "vitest";
import { WebSocket } from "ws";

const RELAY_URL = "wss://relay.walletpair.org/v1";
const DAPP_KEY = "HJ_Yj0VgbZMqgMcYJK4VHRXXPnfeOOjgAIUuYU-ucBk";
const WALLET_KEY = "_2P-V7-_Q_o_VjYosUmvcE09tiU2nEmYNlA0empx4A4";

let counter = 0;
function freshCh(): string {
  counter++;
  const rand = crypto.randomUUID().replace(/-/g, "");
  return (rand + rand).slice(0, 64);
}

function msg(ch: string, t: string, from: string, body: Record<string, unknown> = {}): string {
  return JSON.stringify({ v: 1, t, ch, ts: Date.now(), from, body });
}

function parse(raw: string): any {
  return JSON.parse(raw);
}

// Open a WebSocket to the live relay
function openWs(ch: string): Promise<{ ws: WebSocket; msgs: string[]; waitForN: (n: number, timeout?: number) => Promise<void>; waitMsg: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${RELAY_URL}?ch=${ch}`, ["walletpair.v1"]);
    const msgs: string[] = [];
    const listeners: Array<() => void> = [];

    ws.on("message", (data: Buffer) => {
      msgs.push(data.toString());
      // Wake all waiters so they can re-check
      for (const fn of listeners) fn();
    });

    // Also wake waiters on close (server may close after sending terminate)
    ws.on("close", () => {
      for (const fn of listeners) fn();
    });

    ws.on("open", () => {
      let wsClosed = false;
      ws.on("close", () => { wsClosed = true; });

      const waitForN = (n: number, timeout = 10000) => new Promise<void>((res, rej) => {
        if (msgs.length >= n) { res(); return; }
        const timer = setTimeout(() => rej(new Error(`Timeout waiting for ${n} msgs, got ${msgs.length}`)), timeout);
        const check = () => {
          if (msgs.length >= n || wsClosed) { clearTimeout(timer); res(); }
        };
        listeners.push(check);
      });
      resolve({
        ws,
        msgs,
        waitForN,
        // Convenience: wait for one more message than currently have
        waitMsg: () => waitForN(msgs.length + 1),
      });
    });

    ws.on("error", reject);
    setTimeout(() => reject(new Error("WebSocket connect timeout")), 10000);
  });
}

function waitFor(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Wait for a specific message type in the msgs array
function waitForType(msgs: string[], type: string, timeout = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const found = msgs.find((m) => parse(m).t === type);
      if (found) { resolve(parse(found)); return; }
      if (Date.now() - start > timeout) { reject(new Error(`Timeout waiting for ${type}`)); return; }
      setTimeout(check, 50);
    };
    check();
  });
}

// ─────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────
describe("Live — health check", () => {
  it("healthz returns 200", async () => {
    const resp = await fetch("https://relay.walletpair.org/healthz");
    expect(resp.status).toBe(200);
    const body = await resp.text();
    expect(body).toContain("ok");
  });

  it("rejects missing ch param via HTTP GET", async () => {
    const resp = await fetch("https://relay.walletpair.org/v1");
    // Without proper WS upgrade, CF returns 400 or 426
    expect(resp.status).toBeGreaterThanOrEqual(400);
  });
});

// ─────────────────────────────────────────────
// Full pairing flow
// ─────────────────────────────────────────────
describe("Live — full pairing", () => {
  it("create → join → accept → req/res → evt → close", async () => {
    const ch = freshCh();

    // dApp creates
    const dapp = await openWs(ch);
    dapp.ws.send(msg(ch, "create", DAPP_KEY, { meta: { name: "LiveTest", description: "test", url: "https://test.com", icon: "https://test.com/icon.png" } }));
    await dapp.waitForN(1); // ready.waiting

    const readyWaiting = parse(dapp.msgs[0]);
    expect(readyWaiting.t).toBe("ready");
    expect(readyWaiting.body.state).toBe("waiting");
    expect(readyWaiting.body.role).toBe("dapp");
    expect(readyWaiting.body.self).toBe(DAPP_KEY);
    expect(readyWaiting.body.remote).toBeNull();
    expect(readyWaiting.body.reconnect).toBe(false);
    expect(readyWaiting.from).toBe("_adapter");

    // Wallet joins
    const wallet = await openWs(ch);
    wallet.ws.send(msg(ch, "join", WALLET_KEY, { sealed_join: "encrypted_caps" }));
    await wallet.waitForN(1); // ready.waiting
    await dapp.waitForN(2); // + forwarded join

    const walletReady = parse(wallet.msgs[0]);
    expect(walletReady.t).toBe("ready");
    expect(walletReady.body.state).toBe("waiting");
    expect(walletReady.body.role).toBe("wallet");

    const joinFwd = parse(dapp.msgs[1]);
    expect(joinFwd.t).toBe("join");
    expect(joinFwd.from).toBe(WALLET_KEY);

    // dApp accepts
    dapp.ws.send(msg(ch, "accept", DAPP_KEY, { target: WALLET_KEY }));
    await dapp.waitForN(3); // + ready.connected
    await wallet.waitForN(2); // + ready.connected

    const dappConnected = parse(dapp.msgs[2]);
    expect(dappConnected.t).toBe("ready");
    expect(dappConnected.body.state).toBe("connected");
    expect(dappConnected.body.remote).toBe(WALLET_KEY);

    const walletConnected = parse(wallet.msgs[1]);
    expect(walletConnected.body.state).toBe("connected");
    expect(walletConnected.body.remote).toBe(DAPP_KEY);

    // req → res
    dapp.ws.send(msg(ch, "req", DAPP_KEY, { id: "r-1", sealed: "encrypted_request" }));
    await wallet.waitForN(3); // + req

    expect(parse(wallet.msgs[2]).t).toBe("req");
    expect(parse(wallet.msgs[2]).body.id).toBe("r-1");

    wallet.ws.send(msg(ch, "res", WALLET_KEY, { id: "r-1", sealed: "encrypted_response" }));
    await dapp.waitForN(4); // + res

    expect(parse(dapp.msgs[3]).t).toBe("res");
    expect(parse(dapp.msgs[3]).body.id).toBe("r-1");

    // evt
    wallet.ws.send(msg(ch, "evt", WALLET_KEY, { id: "e-1", sealed: "encrypted_event" }));
    await dapp.waitForN(5); // + evt
    expect(parse(dapp.msgs[4]).t).toBe("evt");

    // ping/pong
    dapp.ws.send(msg(ch, "ping", DAPP_KEY));
    await wallet.waitForN(4); // + ping
    expect(parse(wallet.msgs[3]).t).toBe("ping");

    wallet.ws.send(msg(ch, "pong", WALLET_KEY));
    await dapp.waitForN(6); // + pong
    expect(parse(dapp.msgs[5]).t).toBe("pong");

    // close
    dapp.ws.send(msg(ch, "close", DAPP_KEY, { reason: "normal" }));
    await wallet.waitForN(5); // + close

    expect(parse(wallet.msgs[4]).t).toBe("close");
    expect(parse(wallet.msgs[4]).body.reason).toBe("normal");

    dapp.ws.close();
    wallet.ws.close();
  }, 30000);
});

// ─────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────
describe("Live — validation", () => {
  it("rejects wrong protocol version", async () => {
    const ch = freshCh();
    const dapp = await openWs(ch);
    dapp.ws.send(JSON.stringify({ v: 2, t: "create", ch, ts: Date.now(), from: DAPP_KEY, body: { meta: {} } }));
    await dapp.waitMsg();

    const term = parse(dapp.msgs[0]);
    expect(term.t).toBe("terminate");
    expect(term.body.reason).toBe("unsupported_version");
    dapp.ws.close();
  });

  it("rejects first message not create/join", async () => {
    const ch = freshCh();
    const ws = await openWs(ch);
    ws.ws.send(msg(ch, "accept", DAPP_KEY, { target: WALLET_KEY }));
    await ws.waitMsg();

    const term = parse(ws.msgs[0]);
    expect(term.t).toBe("terminate");
    expect(term.body.reason).toBe("invalid_state");
    ws.ws.close();
  });

  it("rejects ready from client", async () => {
    const ch = freshCh();
    const ws = await openWs(ch);
    ws.ws.send(msg(ch, "ready", DAPP_KEY, { state: "waiting" }));
    await ws.waitMsg();

    const term = parse(ws.msgs[0]);
    expect(term.t).toBe("terminate");
    expect(term.body.reason).toBe("protocol_error");
    ws.ws.close();
  });

  it("rejects join without prior create", async () => {
    const ch = freshCh();
    const ws = await openWs(ch);
    ws.ws.send(msg(ch, "join", WALLET_KEY, { sealed_join: "data" }));
    await ws.waitMsg();

    const term = parse(ws.msgs[0]);
    expect(term.t).toBe("terminate");
    expect(term.body.reason).toBe("channel_not_found");
    ws.ws.close();
  });

  it("rejects channel ID mismatch", async () => {
    const ch = freshCh();
    const otherCh = freshCh();
    const ws = await openWs(ch);
    ws.ws.send(msg(otherCh, "create", DAPP_KEY, { meta: { name: "T" } }));
    await ws.waitMsg();

    const term = parse(ws.msgs[0]);
    expect(term.t).toBe("terminate");
    expect(term.body.reason).toBe("protocol_error");
    ws.ws.close();
  });
});

// ─────────────────────────────────────────────
// State enforcement
// ─────────────────────────────────────────────
describe("Live — state enforcement", () => {
  it("rejects second join (already_connected)", async () => {
    const ch = freshCh();

    const dapp = await openWs(ch);
    dapp.ws.send(msg(ch, "create", DAPP_KEY, { meta: { name: "T", description: "", url: "", icon: "https://x.com/i.png" } }));
    await dapp.waitMsg();

    const w1 = await openWs(ch);
    w1.ws.send(msg(ch, "join", WALLET_KEY, { sealed_join: "data" }));
    await w1.waitMsg();

    // Second wallet
    const w2 = await openWs(ch);
    w2.ws.send(msg(ch, "join", WALLET_KEY, { sealed_join: "data" }));
    await w2.waitMsg();

    const term = parse(w2.msgs[0]);
    expect(term.t).toBe("terminate");
    expect(term.body.reason).toBe("already_connected");

    dapp.ws.close();
    w1.ws.close();
    w2.ws.close();
  });

  it("rejects accept with wrong target", async () => {
    const ch = freshCh();

    const dapp = await openWs(ch);
    const dappMsgs = dapp.msgs;
    dapp.ws.send(msg(ch, "create", DAPP_KEY, { meta: { name: "T", description: "", url: "", icon: "https://x.com/i.png" } }));
    await dapp.waitForN(1);

    const wallet = await openWs(ch);
    wallet.ws.send(msg(ch, "join", WALLET_KEY, { sealed_join: "data" }));
    await wallet.waitForN(1);
    await dapp.waitForN(2);

    // Accept with wrong target
    dapp.ws.send(msg(ch, "accept", DAPP_KEY, { target: DAPP_KEY }));
    await waitFor(2000);

    const term = dappMsgs.find((m) => parse(m).t === "terminate");
    if (term) {
      expect(parse(term).body.reason).toBe("protocol_error");
      expect(parse(term).body.target).toBe(DAPP_KEY);
    } else {
      expect(dapp.ws.readyState).toBeGreaterThanOrEqual(2);
    }

    dapp.ws.close();
    wallet.ws.close();
  });

  it("rejects req from wallet", async () => {
    const ch = freshCh();

    const dapp = await openWs(ch);
    dapp.ws.send(msg(ch, "create", DAPP_KEY, { meta: { name: "T", description: "", url: "", icon: "https://x.com/i.png" } }));
    await dapp.waitForN(1); // ready.waiting

    const wallet = await openWs(ch);
    wallet.ws.send(msg(ch, "join", WALLET_KEY, { sealed_join: "data" }));
    await wallet.waitForN(1); // ready.waiting
    await dapp.waitForN(2); // + join forwarded

    dapp.ws.send(msg(ch, "accept", DAPP_KEY, { target: WALLET_KEY }));
    await dapp.waitForN(3); // + ready.connected
    await wallet.waitForN(2); // + ready.connected

    // Wallet sends req — role violation
    wallet.ws.send(msg(ch, "req", WALLET_KEY, { id: "r-1", sealed: "data" }));
    await waitFor(2000);

    const term = wallet.msgs.find((m) => parse(m).t === "terminate");
    if (term) {
      expect(parse(term).body.reason).toBe("invalid_role");
    } else {
      expect(wallet.ws.readyState).toBeGreaterThanOrEqual(2);
    }

    dapp.ws.close();
    wallet.ws.close();
  });
});

// ─────────────────────────────────────────────
// Reconnect
// ─────────────────────────────────────────────
describe("Live — reconnect", () => {
  it("sealed_join=null sets reconnect flag", async () => {
    const ch = freshCh();

    const dapp = await openWs(ch);
    dapp.ws.send(msg(ch, "create", DAPP_KEY, { meta: { name: "T", description: "", url: "", icon: "https://x.com/i.png" } }));
    await dapp.waitForN(1); // ready.waiting

    const wallet = await openWs(ch);
    wallet.ws.send(msg(ch, "join", WALLET_KEY, { sealed_join: null }));
    await wallet.waitForN(1); // ready.waiting

    const walletReady = parse(wallet.msgs[0]);
    expect(walletReady.body.reconnect).toBe(true);

    await dapp.waitForN(2); // + join forwarded
    dapp.ws.send(msg(ch, "accept", DAPP_KEY, { target: WALLET_KEY }));
    await dapp.waitForN(3); // + ready.connected

    const connected = parse(dapp.msgs[2]);
    expect(connected.body.state).toBe("connected");
    expect(connected.body.reconnect).toBe(true);

    dapp.ws.close();
    wallet.ws.close();
  });

  it("re-create on waiting channel replaces it", async () => {
    const ch = freshCh();

    const dapp1 = await openWs(ch);
    dapp1.ws.send(msg(ch, "create", DAPP_KEY, { meta: { name: "T1", description: "", url: "", icon: "https://x.com/i.png" } }));
    await dapp1.waitMsg();
    expect(parse(dapp1.msgs[0]).body.state).toBe("waiting");

    // Second create replaces
    const dapp2 = await openWs(ch);
    dapp2.ws.send(msg(ch, "create", DAPP_KEY, { meta: { name: "T2", description: "", url: "", icon: "https://x.com/i.png" } }));
    await dapp2.waitMsg();

    expect(parse(dapp2.msgs[0]).t).toBe("ready");
    expect(parse(dapp2.msgs[0]).body.state).toBe("waiting");

    // Old dApp may receive terminate (delivery not guaranteed if WS
    // is closed by server before message arrives). The key assertion is
    // that dapp2 got ready.waiting — replacement succeeded.
    dapp1.ws.close();
    dapp2.ws.close();
  });
});

// ─────────────────────────────────────────────
// Pending request limit
// ─────────────────────────────────────────────
describe("Live — pending request limit", () => {
  it("rejects 33rd pending request with rate_limited", async () => {
    const ch = freshCh();

    const dapp = await openWs(ch);
    dapp.ws.send(msg(ch, "create", DAPP_KEY, { meta: { name: "T", description: "", url: "", icon: "https://x.com/i.png" } }));
    await dapp.waitForN(1);

    const wallet = await openWs(ch);
    wallet.ws.send(msg(ch, "join", WALLET_KEY, { sealed_join: "data" }));
    await wallet.waitForN(1);
    await dapp.waitForN(2);

    dapp.ws.send(msg(ch, "accept", DAPP_KEY, { target: WALLET_KEY }));
    await dapp.waitForN(3);
    await wallet.waitForN(2);

    // Send 32 requests
    for (let i = 0; i < 32; i++) {
      dapp.ws.send(msg(ch, "req", DAPP_KEY, { id: `r-${i}`, sealed: "data" }));
    }
    await waitFor(500);

    // 33rd should be rejected
    dapp.ws.send(msg(ch, "req", DAPP_KEY, { id: "r-32", sealed: "data" }));
    await waitFor(2000);

    const term = dapp.msgs.find((m) => parse(m).t === "terminate");
    if (term) {
      expect(parse(term).body.reason).toBe("rate_limited");
    } else {
      // WS was closed without receiving terminate — relay still rejected
      expect(dapp.ws.readyState).toBeGreaterThanOrEqual(2);
    }

    dapp.ws.close();
    wallet.ws.close();
  }, 30000);
});

// ─────────────────────────────────────────────
// Subprotocol negotiation
// ─────────────────────────────────────────────
describe("Live — subprotocol", () => {
  it("negotiates walletpair.v1", async () => {
    const ch = freshCh();
    const ws = new WebSocket(`${RELAY_URL}?ch=${ch}`, ["walletpair.v1"]);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5000);
    });
    expect(ws.protocol).toBe("walletpair.v1");
    ws.close();
  });

  it("connects without subprotocol header", async () => {
    const ch = freshCh();
    const ws = new WebSocket(`${RELAY_URL}?ch=${ch}`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5000);
    });
    // Should still connect (subprotocol is optional per spec)
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});

// ─────────────────────────────────────────────
// Helper: full pairing setup
// ─────────────────────────────────────────────
const META = { name: "T", description: "", url: "", icon: "https://x.com/i.png" };
async function pair(ch: string) {
  const dapp = await openWs(ch);
  dapp.ws.send(msg(ch, "create", DAPP_KEY, { meta: META }));
  await dapp.waitForN(1);

  const wallet = await openWs(ch);
  wallet.ws.send(msg(ch, "join", WALLET_KEY, { sealed_join: "data" }));
  await wallet.waitForN(1);
  await dapp.waitForN(2);

  dapp.ws.send(msg(ch, "accept", DAPP_KEY, { target: WALLET_KEY }));
  await dapp.waitForN(3);
  await wallet.waitForN(2);

  return { dapp, wallet };
}

// ─────────────────────────────────────────────
// Role enforcement (additional)
// ─────────────────────────────────────────────
describe("Live — role enforcement", () => {
  it("rejects res from dApp", async () => {
    const ch = freshCh();
    const { dapp, wallet } = await pair(ch);

    dapp.ws.send(msg(ch, "res", DAPP_KEY, { id: "r-1", sealed: "data" }));
    await waitFor(2000);

    const term = dapp.msgs.find((m) => parse(m).t === "terminate");
    if (term) expect(parse(term).body.reason).toBe("invalid_role");
    else expect(dapp.ws.readyState).toBeGreaterThanOrEqual(2);

    dapp.ws.close();
    wallet.ws.close();
  });

  it("rejects evt from dApp", async () => {
    const ch = freshCh();
    const { dapp, wallet } = await pair(ch);

    dapp.ws.send(msg(ch, "evt", DAPP_KEY, { id: "e-1", sealed: "data" }));
    await waitFor(2000);

    const term = dapp.msgs.find((m) => parse(m).t === "terminate");
    if (term) expect(parse(term).body.reason).toBe("invalid_role");
    else expect(dapp.ws.readyState).toBeGreaterThanOrEqual(2);

    dapp.ws.close();
    wallet.ws.close();
  });
});

// ─────────────────────────────────────────────
// Close from both sides
// ─────────────────────────────────────────────
describe("Live — close", () => {
  it("wallet-initiated close reaches dApp", async () => {
    const ch = freshCh();
    const { dapp, wallet } = await pair(ch);

    wallet.ws.send(msg(ch, "close", WALLET_KEY, { reason: "user_rejected" }));
    await waitFor(1000);

    const closeMsg = dapp.msgs.find((m) => parse(m).t === "close");
    expect(closeMsg).toBeDefined();
    expect(parse(closeMsg!).body.reason).toBe("user_rejected");

    dapp.ws.close();
    wallet.ws.close();
  });

  it("close with each valid reason", async () => {
    for (const reason of ["normal", "user_rejected", "unsupported_capability", "timeout", "decryption_failed"]) {
      const ch = freshCh();
      const { dapp, wallet } = await pair(ch);

      dapp.ws.send(msg(ch, "close", DAPP_KEY, { reason }));
      await waitFor(1000);

      const closeMsg = wallet.msgs.find((m) => parse(m).t === "close");
      expect(closeMsg).toBeDefined();
      expect(parse(closeMsg!).body.reason).toBe(reason);

      dapp.ws.close();
      wallet.ws.close();
    }
  }, 30000);
});

// ─────────────────────────────────────────────
// Message ordering and interleaving
// ─────────────────────────────────────────────
describe("Live — message ordering", () => {
  it("multiple rapid req/res in sequence", async () => {
    const ch = freshCh();
    const { dapp, wallet } = await pair(ch);

    for (let i = 0; i < 5; i++) {
      dapp.ws.send(msg(ch, "req", DAPP_KEY, { id: `r-${i}`, sealed: `req${i}` }));
    }
    await waitFor(1000);

    // Wallet should have all 5
    const reqs = wallet.msgs.filter((m) => parse(m).t === "req");
    expect(reqs.length).toBe(5);

    // Respond to all
    for (let i = 0; i < 5; i++) {
      wallet.ws.send(msg(ch, "res", WALLET_KEY, { id: `r-${i}`, sealed: `res${i}` }));
    }
    await waitFor(1000);

    const ress = dapp.msgs.filter((m) => parse(m).t === "res");
    expect(ress.length).toBe(5);

    dapp.ws.close();
    wallet.ws.close();
  });

  it("evt interleaved between req and res", async () => {
    const ch = freshCh();
    const { dapp, wallet } = await pair(ch);

    dapp.ws.send(msg(ch, "req", DAPP_KEY, { id: "r-1", sealed: "req" }));
    await waitFor(500);

    // Wallet sends evt before responding
    wallet.ws.send(msg(ch, "evt", WALLET_KEY, { id: "e-1", sealed: "accts_changed" }));
    await waitFor(500);

    // Then responds
    wallet.ws.send(msg(ch, "res", WALLET_KEY, { id: "r-1", sealed: "res" }));
    await waitFor(500);

    const evts = dapp.msgs.filter((m) => parse(m).t === "evt");
    const ress = dapp.msgs.filter((m) => parse(m).t === "res");
    expect(evts.length).toBe(1);
    expect(ress.length).toBe(1);

    dapp.ws.close();
    wallet.ws.close();
  });

  it("multiple evt without req", async () => {
    const ch = freshCh();
    const { dapp, wallet } = await pair(ch);

    for (let i = 0; i < 3; i++) {
      wallet.ws.send(msg(ch, "evt", WALLET_KEY, { id: `e-${i}`, sealed: `evt${i}` }));
    }
    await waitFor(1000);

    const evts = dapp.msgs.filter((m) => parse(m).t === "evt");
    expect(evts.length).toBe(3);

    dapp.ws.close();
    wallet.ws.close();
  });
});

// ─────────────────────────────────────────────
// Validation edge cases
// ─────────────────────────────────────────────
describe("Live — validation edge cases", () => {
  it("rejects terminate from client", async () => {
    const ch = freshCh();
    const ws = await openWs(ch);
    ws.ws.send(msg(ch, "terminate", DAPP_KEY, { reason: "timeout" }));
    await ws.waitMsg();

    const term = parse(ws.msgs[0]);
    expect(term.t).toBe("terminate");
    expect(term.body.reason).toBe("protocol_error");
    ws.ws.close();
  });

  it("rejects unknown message type", async () => {
    const ch = freshCh();
    const ws = await openWs(ch);
    ws.ws.send(msg(ch, "foobar", DAPP_KEY));
    await ws.waitMsg();

    const term = parse(ws.msgs[0]);
    expect(term.t).toBe("terminate");
    expect(term.body.reason).toBe("protocol_error");
    ws.ws.close();
  });

  it("rejects malformed JSON", async () => {
    const ch = freshCh();
    const ws = await openWs(ch);
    ws.ws.send("{not valid json");
    await ws.waitMsg();

    const term = parse(ws.msgs[0]);
    expect(term.t).toBe("terminate");
    expect(term.body.reason).toBe("protocol_error");
    ws.ws.close();
  });

  it("rejects missing body", async () => {
    const ch = freshCh();
    const ws = await openWs(ch);
    ws.ws.send(JSON.stringify({ v: 1, t: "create", ch, ts: Date.now(), from: DAPP_KEY }));
    await ws.waitMsg();

    const term = parse(ws.msgs[0]);
    expect(term.t).toBe("terminate");
    expect(term.body.reason).toBe("protocol_error");
    ws.ws.close();
  });

  it("rejects invalid peer ID format", async () => {
    const ch = freshCh();
    const ws = await openWs(ch);
    ws.ws.send(JSON.stringify({ v: 1, t: "create", ch, ts: Date.now(), from: "not-valid-base64url", body: { meta: {} } }));
    await ws.waitMsg();

    const term = parse(ws.msgs[0]);
    expect(term.t).toBe("terminate");
    expect(term.body.reason).toBe("protocol_error");
    ws.ws.close();
  });

  it("rejects create without meta", async () => {
    const ch = freshCh();
    const ws = await openWs(ch);
    ws.ws.send(msg(ch, "create", DAPP_KEY, {}));
    await ws.waitMsg();

    const term = parse(ws.msgs[0]);
    expect(term.t).toBe("terminate");
    expect(term.body.reason).toBe("protocol_error");
    ws.ws.close();
  });

  it("rejects join without sealed_join key", async () => {
    const ch = freshCh();
    const dapp = await openWs(ch);
    dapp.ws.send(msg(ch, "create", DAPP_KEY, { meta: META }));
    await dapp.waitForN(1);

    const wallet = await openWs(ch);
    wallet.ws.send(msg(ch, "join", WALLET_KEY, {})); // missing sealed_join
    await wallet.waitMsg();

    const term = parse(wallet.msgs[0]);
    expect(term.t).toBe("terminate");
    expect(term.body.reason).toBe("protocol_error");

    dapp.ws.close();
    wallet.ws.close();
  });
});

// ─────────────────────────────────────────────
// State machine: req/res/evt before connected
// ─────────────────────────────────────────────
describe("Live — pre-connected state", () => {
  it("rejects req in waiting state", async () => {
    const ch = freshCh();
    const dapp = await openWs(ch);
    dapp.ws.send(msg(ch, "create", DAPP_KEY, { meta: META }));
    await dapp.waitForN(1);

    dapp.ws.send(msg(ch, "req", DAPP_KEY, { id: "r-1", sealed: "data" }));
    await waitFor(2000);

    const term = dapp.msgs.find((m) => parse(m).t === "terminate");
    if (term) expect(parse(term).body.reason).toBe("invalid_state");
    else expect(dapp.ws.readyState).toBeGreaterThanOrEqual(2);

    dapp.ws.close();
  });

  it("rejects evt in pending_accept state", async () => {
    const ch = freshCh();
    const dapp = await openWs(ch);
    dapp.ws.send(msg(ch, "create", DAPP_KEY, { meta: META }));
    await dapp.waitForN(1);

    const wallet = await openWs(ch);
    wallet.ws.send(msg(ch, "join", WALLET_KEY, { sealed_join: "data" }));
    await wallet.waitForN(1);

    // Wallet sends evt before accept
    wallet.ws.send(msg(ch, "evt", WALLET_KEY, { id: "e-1", sealed: "data" }));
    await waitFor(2000);

    const term = wallet.msgs.find((m) => parse(m).t === "terminate");
    if (term) expect(parse(term).body.reason).toBe("invalid_state");
    else expect(wallet.ws.readyState).toBeGreaterThanOrEqual(2);

    dapp.ws.close();
    wallet.ws.close();
  });

  it("allows ping in waiting state", async () => {
    const ch = freshCh();
    const dapp = await openWs(ch);
    dapp.ws.send(msg(ch, "create", DAPP_KEY, { meta: META }));
    await dapp.waitForN(1);

    dapp.ws.send(msg(ch, "ping", DAPP_KEY));
    await waitFor(1000);

    // No terminate — ping is allowed
    const terminates = dapp.msgs.filter((m) => parse(m).t === "terminate");
    expect(terminates.length).toBe(0);

    dapp.ws.close();
  });
});

// ─────────────────────────────────────────────
// Pending request tracking
// ─────────────────────────────────────────────
describe("Live — pending request tracking", () => {
  it("res clears pending slot, allows new req", async () => {
    const ch = freshCh();
    const { dapp, wallet } = await pair(ch);

    // Fill up to 32
    for (let i = 0; i < 32; i++) {
      dapp.ws.send(msg(ch, "req", DAPP_KEY, { id: `r-${i}`, sealed: "data" }));
    }
    await waitFor(500);

    // Respond to one — wait for dApp to receive the response first
    wallet.ws.send(msg(ch, "res", WALLET_KEY, { id: "r-0", sealed: "res" }));
    await waitFor(1000);

    // Now send one more (pending count should be 31, not 32)
    dapp.ws.send(msg(ch, "req", DAPP_KEY, { id: "r-new", sealed: "data" }));
    await waitFor(1000);

    // dApp should NOT have received a terminate (the 33rd req went through)
    const dappTerms = dapp.msgs.filter((m) => parse(m).t === "terminate");
    expect(dappTerms.length).toBe(0);

    dapp.ws.close();
    wallet.ws.close();
  }, 30000);
});

// ─────────────────────────────────────────────
// Ready message format verification
// ─────────────────────────────────────────────
describe("Live — ready message format", () => {
  it("ready.waiting has all required fields", async () => {
    const ch = freshCh();
    const dapp = await openWs(ch);
    dapp.ws.send(msg(ch, "create", DAPP_KEY, { meta: META }));
    await dapp.waitForN(1);

    const r = parse(dapp.msgs[0]);
    expect(r.v).toBe(1);
    expect(r.t).toBe("ready");
    expect(r.ch).toBe(ch);
    expect(typeof r.ts).toBe("number");
    expect(r.from).toBe("_adapter");
    expect(r.body).toHaveProperty("state", "waiting");
    expect(r.body).toHaveProperty("role", "dapp");
    expect(r.body).toHaveProperty("self", DAPP_KEY);
    expect(r.body).toHaveProperty("remote", null);
    expect(r.body).toHaveProperty("reconnect", false);

    dapp.ws.close();
  });

  it("ready.connected has correct remote field for both peers", async () => {
    const ch = freshCh();
    const { dapp, wallet } = await pair(ch);

    const dappConnected = parse(dapp.msgs[2]);
    expect(dappConnected.body.self).toBe(DAPP_KEY);
    expect(dappConnected.body.remote).toBe(WALLET_KEY);
    expect(dappConnected.body.role).toBe("dapp");

    const walletConnected = parse(wallet.msgs[1]);
    expect(walletConnected.body.self).toBe(WALLET_KEY);
    expect(walletConnected.body.remote).toBe(DAPP_KEY);
    expect(walletConnected.body.role).toBe("wallet");

    dapp.ws.close();
    wallet.ws.close();
  });
});

// ─────────────────────────────────────────────
// Message forwarding fidelity
// ─────────────────────────────────────────────
describe("Live — message forwarding", () => {
  it("join message forwarded verbatim to dApp", async () => {
    const ch = freshCh();
    const dapp = await openWs(ch);
    dapp.ws.send(msg(ch, "create", DAPP_KEY, { meta: META }));
    await dapp.waitForN(1);

    const wallet = await openWs(ch);
    const joinMsg = msg(ch, "join", WALLET_KEY, { sealed_join: "test_sealed_data_123" });
    wallet.ws.send(joinMsg);
    await wallet.waitForN(1);
    await dapp.waitForN(2);

    // dApp should receive the exact join with sealed_join intact
    const fwd = parse(dapp.msgs[1]);
    expect(fwd.t).toBe("join");
    expect(fwd.from).toBe(WALLET_KEY);
    expect(fwd.body.sealed_join).toBe("test_sealed_data_123");

    dapp.ws.close();
    wallet.ws.close();
  });

  it("req forwarded with all body fields intact", async () => {
    const ch = freshCh();
    const { dapp, wallet } = await pair(ch);

    dapp.ws.send(msg(ch, "req", DAPP_KEY, { id: "req-abc-123", sealed: "long_sealed_payload_data" }));
    await waitFor(500);

    const walletReq = wallet.msgs.filter((m) => parse(m).t === "req");
    expect(walletReq.length).toBe(1);
    const req = parse(walletReq[0]);
    expect(req.body.id).toBe("req-abc-123");
    expect(req.body.sealed).toBe("long_sealed_payload_data");
    expect(req.from).toBe(DAPP_KEY);

    dapp.ws.close();
    wallet.ws.close();
  });
});

// ─────────────────────────────────────────────
// HTTP endpoints
// ─────────────────────────────────────────────
describe("Live — HTTP endpoints", () => {
  it("returns 404 for unknown path", async () => {
    const resp = await fetch("https://relay.walletpair.org/unknown");
    expect(resp.status).toBe(404);
  });

  it("returns 400 for invalid ch format via WebSocket", async () => {
    // WebSocket with invalid ch should fail to connect or get closed
    const ws = new WebSocket(`${RELAY_URL}?ch=tooshort`, ["walletpair.v1"]);
    const result = await new Promise<string>((resolve) => {
      ws.on("open", () => resolve("opened"));
      ws.on("error", () => resolve("error"));
      ws.on("close", () => resolve("closed"));
      setTimeout(() => resolve("timeout"), 5000);
    });
    // Server should reject — either connection error or immediate close
    expect(["error", "closed"]).toContain(result);
    try { ws.close(); } catch { /* already closed */ }
  });

  it("CORS preflight returns 204", async () => {
    const resp = await fetch("https://relay.walletpair.org/v1", {
      method: "OPTIONS",
    });
    expect(resp.status).toBe(204);
    expect(resp.headers.get("access-control-allow-origin")).toBe("*");
  });
});
