/**
 * Integration tests for ChannelDO — full protocol flows.
 * Runs in Cloudflare Workers vitest pool.
 */
import { env, createExecutionContext, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { PENDING_REQUEST_LIMIT } from "../channel";

const CH = "a".repeat(64);
const DAPP_KEY = "HJ_Yj0VgbZMqgMcYJK4VHRXXPnfeOOjgAIUuYU-ucBk";
const WALLET_KEY = "_2P-V7-_Q_o_VjYosUmvcE09tiU2nEmYNlA0empx4A4";

function msg(t: string, from: string, body: Record<string, unknown> = {}): string {
  return JSON.stringify({ v: 1, t, ch: CH, ts: Date.now(), from, body });
}

// Helper to open a WebSocket to the DO
async function connectWs(): Promise<WebSocket> {
  const resp = await SELF.fetch(`http://localhost/v1?ch=${CH}`, {
    headers: {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": "walletpair.v1",
    },
  });
  expect(resp.status).toBe(101);
  expect(resp.webSocket).not.toBeNull();
  const ws = resp.webSocket!;
  ws.accept();
  return ws;
}

// Collect messages from a WebSocket
function collectMessages(ws: WebSocket): string[] {
  const messages: string[] = [];
  ws.addEventListener("message", (e) => {
    messages.push(typeof e.data === "string" ? e.data : "");
  });
  return messages;
}

// Parse a collected message
function parse(raw: string): Record<string, unknown> {
  return JSON.parse(raw);
}

// ─────────────────────────────────────────────
// Happy path: full pairing flow
// ─────────────────────────────────────────────
describe("ChannelDO — pairing flow", () => {
  it("complete create → join → accept → req/res → close", async () => {
    // dApp connects and creates
    const dappWs = await connectWs();
    const dappMsgs = collectMessages(dappWs);
    dappWs.send(msg("create", DAPP_KEY, { meta: { name: "Test" } }));
    await new Promise((r) => setTimeout(r, 50));

    // Should receive ready.waiting
    expect(dappMsgs.length).toBe(1);
    const readyWaiting = parse(dappMsgs[0]);
    expect(readyWaiting.t).toBe("ready");
    expect(readyWaiting.body).toMatchObject({
      state: "waiting",
      role: "dapp",
      self: DAPP_KEY,
      remote: null,
      reconnect: false,
    });

    // Wallet connects and joins
    const walletWs = await connectWs();
    const walletMsgs = collectMessages(walletWs);
    walletWs.send(msg("join", WALLET_KEY, { sealed_join: "encrypted_data" }));
    await new Promise((r) => setTimeout(r, 50));

    // Wallet gets ready.waiting
    expect(walletMsgs.length).toBe(1);
    const walletReady = parse(walletMsgs[0]);
    expect(walletReady.body).toMatchObject({
      state: "waiting",
      role: "wallet",
      reconnect: false,
    });

    // dApp receives forwarded join
    expect(dappMsgs.length).toBe(2);
    const joinForwarded = parse(dappMsgs[1]);
    expect(joinForwarded.t).toBe("join");
    expect(joinForwarded.from).toBe(WALLET_KEY);

    // dApp accepts
    dappWs.send(msg("accept", DAPP_KEY, { target: WALLET_KEY }));
    await new Promise((r) => setTimeout(r, 50));

    // Both receive ready.connected
    const dappConnected = parse(dappMsgs[2]);
    expect(dappConnected.body).toMatchObject({
      state: "connected",
      role: "dapp",
      self: DAPP_KEY,
      remote: WALLET_KEY,
      reconnect: false,
    });

    const walletConnected = parse(walletMsgs[1]);
    expect(walletConnected.body).toMatchObject({
      state: "connected",
      role: "wallet",
      self: WALLET_KEY,
      remote: DAPP_KEY,
      reconnect: false,
    });

    // dApp sends req
    const reqMsg = msg("req", DAPP_KEY, { id: "r-1", sealed: "enc_req" });
    dappWs.send(reqMsg);
    await new Promise((r) => setTimeout(r, 50));

    // Wallet receives req
    const walletReq = parse(walletMsgs[2]);
    expect(walletReq.t).toBe("req");
    expect(walletReq.body).toMatchObject({ id: "r-1" });

    // Wallet sends res
    const resMsg = msg("res", WALLET_KEY, { id: "r-1", sealed: "enc_res" });
    walletWs.send(resMsg);
    await new Promise((r) => setTimeout(r, 50));

    // dApp receives res
    const dappRes = parse(dappMsgs[3]);
    expect(dappRes.t).toBe("res");
    expect(dappRes.body).toMatchObject({ id: "r-1" });

    // Wallet sends evt
    const evtMsg = msg("evt", WALLET_KEY, { id: "e-1", sealed: "enc_evt" });
    walletWs.send(evtMsg);
    await new Promise((r) => setTimeout(r, 50));

    const dappEvt = parse(dappMsgs[4]);
    expect(dappEvt.t).toBe("evt");

    // Close
    dappWs.send(msg("close", DAPP_KEY, { reason: "normal" }));
    await new Promise((r) => setTimeout(r, 50));

    // Wallet receives close
    const walletClose = parse(walletMsgs[3]);
    expect(walletClose.t).toBe("close");
    expect(walletClose.body).toMatchObject({ reason: "normal" });
  });
});

// ─────────────────────────────────────────────
// Validation and rejection
// ─────────────────────────────────────────────
describe("ChannelDO — validation", () => {
  it("rejects first message that is not create or join", async () => {
    const ws = await connectWs();
    const msgs = collectMessages(ws);
    ws.send(msg("accept", DAPP_KEY, { target: WALLET_KEY }));
    await new Promise((r) => setTimeout(r, 50));

    expect(msgs.length).toBe(1);
    const term = parse(msgs[0]);
    expect(term.t).toBe("terminate");
    expect(term.body).toMatchObject({ reason: "invalid_state" });
  });

  it("rejects binary frames", async () => {
    const ws = await connectWs();
    const msgs = collectMessages(ws);
    ws.send(new ArrayBuffer(10));
    await new Promise((r) => setTimeout(r, 50));

    expect(msgs.length).toBe(1);
    const term = parse(msgs[0]);
    expect(term.t).toBe("terminate");
    expect(term.body).toMatchObject({ reason: "protocol_error" });
  });

  it("rejects oversized messages", async () => {
    const ws = await connectWs();
    const msgs = collectMessages(ws);
    ws.send("x".repeat(65_537));
    await new Promise((r) => setTimeout(r, 50));

    expect(msgs.length).toBe(1);
    const term = parse(msgs[0]);
    expect(term.body).toMatchObject({ reason: "payload_too_large" });
  });

  it("rejects wrong protocol version", async () => {
    const ws = await connectWs();
    const msgs = collectMessages(ws);
    ws.send(JSON.stringify({ v: 2, t: "create", ch: CH, ts: 1, from: DAPP_KEY, body: { meta: {} } }));
    await new Promise((r) => setTimeout(r, 50));

    const term = parse(msgs[0]);
    expect(term.body).toMatchObject({ reason: "unsupported_version" });
  });

  it("rejects ready from client", async () => {
    const ws = await connectWs();
    const msgs = collectMessages(ws);
    ws.send(msg("ready", DAPP_KEY, { state: "waiting" }));
    await new Promise((r) => setTimeout(r, 50));

    const term = parse(msgs[0]);
    expect(term.body).toMatchObject({ reason: "protocol_error" });
  });
});

// ─────────────────────────────────────────────
// State machine enforcement
// ─────────────────────────────────────────────
describe("ChannelDO — state enforcement", () => {
  it("rejects join on non-waiting channel", async () => {
    // Create first
    const dappWs = await connectWs();
    const dappMsgs = collectMessages(dappWs);
    dappWs.send(msg("create", DAPP_KEY, { meta: { name: "T" } }));
    await new Promise((r) => setTimeout(r, 50));

    // Wallet joins
    const walletWs = await connectWs();
    const walletMsgs = collectMessages(walletWs);
    walletWs.send(msg("join", WALLET_KEY, { sealed_join: "data" }));
    await new Promise((r) => setTimeout(r, 50));

    // Second wallet tries to join — should get already_connected
    const wallet2Ws = await connectWs();
    const wallet2Msgs = collectMessages(wallet2Ws);
    wallet2Ws.send(msg("join", WALLET_KEY, { sealed_join: "data2" }));
    await new Promise((r) => setTimeout(r, 50));

    const term = parse(wallet2Msgs[0]);
    expect(term.t).toBe("terminate");
    expect(term.body).toMatchObject({ reason: "already_connected" });
  });

  it("rejects accept from wallet", async () => {
    const dappWs = await connectWs();
    dappWs.send(msg("create", DAPP_KEY, { meta: { name: "T" } }));
    await new Promise((r) => setTimeout(r, 50));

    const walletWs = await connectWs();
    const walletMsgs = collectMessages(walletWs);
    walletWs.send(msg("join", WALLET_KEY, { sealed_join: "data" }));
    await new Promise((r) => setTimeout(r, 50));

    // Wallet tries to accept — invalid_role
    walletWs.send(msg("accept", WALLET_KEY, { target: DAPP_KEY }));
    await new Promise((r) => setTimeout(r, 50));

    // ready.waiting (index 0) + terminate (index 1)
    expect(walletMsgs.length).toBeGreaterThanOrEqual(2);
    const term = parse(walletMsgs[walletMsgs.length - 1]);
    expect(term.t).toBe("terminate");
    expect(term.body).toMatchObject({ reason: "invalid_role" });
  });

  it("rejects accept with wrong target", async () => {
    const dappWs = await connectWs();
    const dappMsgs = collectMessages(dappWs);
    dappWs.send(msg("create", DAPP_KEY, { meta: { name: "T" } }));
    await new Promise((r) => setTimeout(r, 50));

    const walletWs = await connectWs();
    walletWs.send(msg("join", WALLET_KEY, { sealed_join: "data" }));
    await new Promise((r) => setTimeout(r, 50));

    // Accept with wrong target
    dappWs.send(msg("accept", DAPP_KEY, { target: DAPP_KEY })); // wrong: should be WALLET_KEY
    await new Promise((r) => setTimeout(r, 50));

    // Should get terminate with protocol_error and target field
    const lastMsg = parse(dappMsgs[dappMsgs.length - 1]);
    expect(lastMsg.t).toBe("terminate");
    expect(lastMsg.body).toMatchObject({ reason: "protocol_error", target: DAPP_KEY });
  });

  it("rejects req before connected", async () => {
    const dappWs = await connectWs();
    const dappMsgs = collectMessages(dappWs);
    dappWs.send(msg("create", DAPP_KEY, { meta: { name: "T" } }));
    await new Promise((r) => setTimeout(r, 50));

    // Send req in waiting state
    dappWs.send(msg("req", DAPP_KEY, { id: "r-1", sealed: "data" }));
    await new Promise((r) => setTimeout(r, 50));

    const lastMsg = parse(dappMsgs[dappMsgs.length - 1]);
    expect(lastMsg.t).toBe("terminate");
  });

  it("rejects req from wallet", async () => {
    // Full pairing
    const dappWs = await connectWs();
    collectMessages(dappWs);
    dappWs.send(msg("create", DAPP_KEY, { meta: { name: "T" } }));
    await new Promise((r) => setTimeout(r, 50));

    const walletWs = await connectWs();
    const walletMsgs = collectMessages(walletWs);
    walletWs.send(msg("join", WALLET_KEY, { sealed_join: "data" }));
    await new Promise((r) => setTimeout(r, 50));

    dappWs.send(msg("accept", DAPP_KEY, { target: WALLET_KEY }));
    await new Promise((r) => setTimeout(r, 50));

    // Wallet sends req — invalid_role
    walletWs.send(msg("req", WALLET_KEY, { id: "r-1", sealed: "data" }));
    await new Promise((r) => setTimeout(r, 50));

    const lastMsg = parse(walletMsgs[walletMsgs.length - 1]);
    expect(lastMsg.t).toBe("terminate");
    expect(lastMsg.body).toMatchObject({ reason: "invalid_role" });
  });
});

// ─────────────────────────────────────────────
// Pending request limit
// ─────────────────────────────────────────────
describe("ChannelDO — pending request limit", () => {
  it("rejects 33rd pending request", async () => {
    // Full pairing
    const dappWs = await connectWs();
    const dappMsgs = collectMessages(dappWs);
    dappWs.send(msg("create", DAPP_KEY, { meta: { name: "T" } }));
    await new Promise((r) => setTimeout(r, 50));

    const walletWs = await connectWs();
    collectMessages(walletWs);
    walletWs.send(msg("join", WALLET_KEY, { sealed_join: "data" }));
    await new Promise((r) => setTimeout(r, 50));

    dappWs.send(msg("accept", DAPP_KEY, { target: WALLET_KEY }));
    await new Promise((r) => setTimeout(r, 50));

    // Fill the pending-request window (all should succeed)
    for (let i = 0; i < PENDING_REQUEST_LIMIT; i++) {
      dappWs.send(msg("req", DAPP_KEY, { id: `r-${i}`, sealed: "data" }));
    }
    await new Promise((r) => setTimeout(r, 300));

    // One past the limit should be rejected with rate_limited
    dappWs.send(msg("req", DAPP_KEY, { id: `r-${PENDING_REQUEST_LIMIT}`, sealed: "data" }));
    await new Promise((r) => setTimeout(r, 100));

    const lastMsg = parse(dappMsgs[dappMsgs.length - 1]);
    expect(lastMsg.t).toBe("terminate");
    expect(lastMsg.body).toMatchObject({ reason: "rate_limited" });
  });
});

// ─────────────────────────────────────────────
// Reconnect flow
// ─────────────────────────────────────────────
describe("ChannelDO — reconnect", () => {
  it("join with sealed_join=null sets reconnect flag", async () => {
    const dappWs = await connectWs();
    const dappMsgs = collectMessages(dappWs);
    dappWs.send(msg("create", DAPP_KEY, { meta: { name: "T" } }));
    await new Promise((r) => setTimeout(r, 50));

    const walletWs = await connectWs();
    const walletMsgs = collectMessages(walletWs);
    walletWs.send(msg("join", WALLET_KEY, { sealed_join: null }));
    await new Promise((r) => setTimeout(r, 50));

    // Wallet ready.waiting should have reconnect=true
    const walletReady = parse(walletMsgs[0]);
    expect(walletReady.body.reconnect).toBe(true);

    // Accept
    dappWs.send(msg("accept", DAPP_KEY, { target: WALLET_KEY }));
    await new Promise((r) => setTimeout(r, 50));

    // ready.connected should have reconnect=true
    const dappConnected = parse(dappMsgs[2]);
    expect(dappConnected.body.reconnect).toBe(true);
  });
});

// ─────────────────────────────────────────────
// Ping/pong forwarding
// ─────────────────────────────────────────────
describe("ChannelDO — ping/pong", () => {
  it("forwards ping/pong between peers", async () => {
    // Full pairing
    const dappWs = await connectWs();
    const dappMsgs = collectMessages(dappWs);
    dappWs.send(msg("create", DAPP_KEY, { meta: { name: "T" } }));
    await new Promise((r) => setTimeout(r, 50));

    const walletWs = await connectWs();
    const walletMsgs = collectMessages(walletWs);
    walletWs.send(msg("join", WALLET_KEY, { sealed_join: "data" }));
    await new Promise((r) => setTimeout(r, 50));

    dappWs.send(msg("accept", DAPP_KEY, { target: WALLET_KEY }));
    await new Promise((r) => setTimeout(r, 50));

    // dApp sends ping
    dappWs.send(msg("ping", DAPP_KEY));
    await new Promise((r) => setTimeout(r, 50));

    // Wallet should receive it
    const walletPing = parse(walletMsgs[walletMsgs.length - 1]);
    expect(walletPing.t).toBe("ping");

    // Wallet sends pong
    walletWs.send(msg("pong", WALLET_KEY));
    await new Promise((r) => setTimeout(r, 50));

    const dappPong = parse(dappMsgs[dappMsgs.length - 1]);
    expect(dappPong.t).toBe("pong");
  });
});

// ─────────────────────────────────────────────
// Channel replacement (reconnect race)
// ─────────────────────────────────────────────
describe("ChannelDO — channel replacement", () => {
  it("replaces waiting channel on re-create", async () => {
    // First create
    const dappWs1 = await connectWs();
    const dappMsgs1 = collectMessages(dappWs1);
    dappWs1.send(msg("create", DAPP_KEY, { meta: { name: "T" } }));
    await new Promise((r) => setTimeout(r, 50));

    expect(dappMsgs1.length).toBe(1);
    expect(parse(dappMsgs1[0]).body).toMatchObject({ state: "waiting" });

    // Second create — replaces
    const dappWs2 = await connectWs();
    const dappMsgs2 = collectMessages(dappWs2);
    dappWs2.send(msg("create", DAPP_KEY, { meta: { name: "T2" } }));
    await new Promise((r) => setTimeout(r, 50));

    // New dApp gets ready.waiting
    expect(dappMsgs2.length).toBe(1);
    expect(parse(dappMsgs2[0]).body).toMatchObject({ state: "waiting" });

    // Old dApp should have received terminate(normal)
    const oldTerm = dappMsgs1.find((m) => {
      const p = parse(m);
      return p.t === "terminate";
    });
    expect(oldTerm).toBeDefined();
  });
});

// ─────────────────────────────────────────────
// Join on nonexistent channel
// ─────────────────────────────────────────────
describe("ChannelDO — join without create", () => {
  it("rejects join on channel with no prior create", async () => {
    // Use a different channel ID to get a fresh DO
    const otherCh = "b".repeat(64);
    const resp = await SELF.fetch(`http://localhost/v1?ch=${otherCh}`, {
      headers: { Upgrade: "websocket" },
    });
    const ws = resp.webSocket!;
    ws.accept();
    const msgs = collectMessages(ws);

    ws.send(JSON.stringify({ v: 1, t: "join", ch: otherCh, ts: Date.now(), from: WALLET_KEY, body: { sealed_join: "data" } }));
    await new Promise((r) => setTimeout(r, 50));

    const term = parse(msgs[0]);
    expect(term.t).toBe("terminate");
    expect(term.body).toMatchObject({ reason: "channel_not_found" });
  });
});

// ─────────────────────────────────────────────
// Regression: Fix #1 — handleCreate peerId validation
// ─────────────────────────────────────────────
describe("ChannelDO — create peerId validation (Fix #1)", () => {
  const OTHER_DAPP_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

  it("rejects create from different peerId on existing channel", async () => {
    // Original dApp creates the channel
    const dappWs = await connectWs();
    const dappMsgs = collectMessages(dappWs);
    dappWs.send(msg("create", DAPP_KEY, { meta: { name: "T" } }));
    await new Promise((r) => setTimeout(r, 50));

    expect(dappMsgs.length).toBe(1);
    expect(parse(dappMsgs[0]).body).toMatchObject({ state: "waiting" });

    // Different peerId tries to create on same channel via subsequent message
    // (i.e. a WS that already has a role sends create with a different peerId)
    // To trigger handleMessage's create branch, we need an already-attached WS.
    // The simplest way: the original dApp sends create again but with a spoofed from.
    // However, the from is validated against the attachment's peerId.
    // The fix is in handleMessage: if dappPeerId is set and msg.from !== dappPeerId, reject.
    //
    // We test this by having a second WS connect and create with a different key.
    // Since handleFirstMessage -> handleCreate runs for new WS, this goes through
    // the "waiting" branch which replaces. But in handleMessage (subsequent create),
    // a different peerId is rejected.
    //
    // To hit the handleMessage path: first create, then send another create on same WS
    // but the 'from' won't match attachment. Let's test with a new WS that first joins
    // (gets role), then tries to create — but that's complex.
    //
    // Simpler: a new WS sends create with OTHER_DAPP_KEY as first message.
    // This goes through handleFirstMessage -> handleCreate -> "waiting" branch.
    // The fix #1 is specifically in handleMessage (subsequent message, not first).
    // To test it: send two messages on the SAME WS where second is create with different from.
    // But protocol.ts validates peerId format, so we need a valid-format key.

    // The dApp WS already has role "dapp" with DAPP_KEY.
    // Sending create again from the same WS with a different peerId triggers handleMessage.
    dappWs.send(msg("create", OTHER_DAPP_KEY, { meta: { name: "Imposter" } }));
    await new Promise((r) => setTimeout(r, 50));

    // Should get terminated with invalid_role
    const lastMsg = parse(dappMsgs[dappMsgs.length - 1]);
    expect(lastMsg.t).toBe("terminate");
    expect(lastMsg.body).toMatchObject({ reason: "invalid_role" });
  });

  it("same peerId can re-create via new WS (existing behavior preserved)", async () => {
    // dApp creates the channel on first WS
    const dappWs1 = await connectWs();
    const dappMsgs1 = collectMessages(dappWs1);
    dappWs1.send(msg("create", DAPP_KEY, { meta: { name: "T" } }));
    await new Promise((r) => setTimeout(r, 50));

    expect(dappMsgs1.length).toBe(1);
    expect(parse(dappMsgs1[0]).body).toMatchObject({ state: "waiting" });

    // Same peerId re-creates via a new WS (goes through handleFirstMessage)
    const dappWs2 = await connectWs();
    const dappMsgs2 = collectMessages(dappWs2);
    dappWs2.send(msg("create", DAPP_KEY, { meta: { name: "T2" } }));
    await new Promise((r) => setTimeout(r, 50));

    // New WS gets ready.waiting (re-create succeeds)
    expect(dappMsgs2.length).toBe(1);
    const readyMsg = parse(dappMsgs2[0]);
    expect(readyMsg.t).toBe("ready");
    expect(readyMsg.body).toMatchObject({ state: "waiting", role: "dapp" });

    // Old WS gets terminated
    const oldTerm = dappMsgs1.find((m) => parse(m).t === "terminate");
    expect(oldTerm).toBeDefined();
  });

  it("different peerId on new WS also gets rejected via handleFirstMessage", async () => {
    // Original dApp creates
    const dappWs = await connectWs();
    const dappMsgs = collectMessages(dappWs);
    dappWs.send(msg("create", DAPP_KEY, { meta: { name: "T" } }));
    await new Promise((r) => setTimeout(r, 50));

    // Wallet joins to move to pending_accept
    const walletWs = await connectWs();
    collectMessages(walletWs);
    walletWs.send(msg("join", WALLET_KEY, { sealed_join: "data" }));
    await new Promise((r) => setTimeout(r, 50));

    // Different peerId tries to create on a new WS — should be rejected
    // because state is pending_accept (channel_exists)
    const imposterWs = await connectWs();
    const imposterMsgs = collectMessages(imposterWs);
    imposterWs.send(msg("create", OTHER_DAPP_KEY, { meta: { name: "Imposter" } }));
    await new Promise((r) => setTimeout(r, 50));

    expect(imposterMsgs.length).toBe(1);
    const term = parse(imposterMsgs[0]);
    expect(term.t).toBe("terminate");
    expect(term.body).toMatchObject({ reason: "channel_exists" });
  });
});

// ─────────────────────────────────────────────
// Regression: Fix #5 — Alarm reset on wallet disconnect from pending_accept
// ─────────────────────────────────────────────
describe("ChannelDO — wallet disconnect from pending_accept (Fix #5)", () => {
  it("reverts to waiting state when wallet disconnects during pending_accept", async () => {
    // dApp creates
    const dappWs = await connectWs();
    const dappMsgs = collectMessages(dappWs);
    dappWs.send(msg("create", DAPP_KEY, { meta: { name: "T" } }));
    await new Promise((r) => setTimeout(r, 50));

    expect(parse(dappMsgs[0]).body).toMatchObject({ state: "waiting" });

    // Wallet joins (moves to pending_accept)
    const walletWs = await connectWs();
    const walletMsgs = collectMessages(walletWs);
    walletWs.send(msg("join", WALLET_KEY, { sealed_join: "data" }));
    await new Promise((r) => setTimeout(r, 50));

    expect(parse(walletMsgs[0]).body).toMatchObject({ state: "waiting", role: "wallet" });

    // Wallet disconnects
    walletWs.close(1000, "wallet_left");
    await new Promise((r) => setTimeout(r, 50));

    // A new wallet should be able to join (proves state reverted to "waiting")
    const wallet2Ws = await connectWs();
    const wallet2Msgs = collectMessages(wallet2Ws);
    wallet2Ws.send(msg("join", WALLET_KEY, { sealed_join: "data2" }));
    await new Promise((r) => setTimeout(r, 50));

    // New wallet gets ready.waiting — channel is back in waiting state
    expect(wallet2Msgs.length).toBeGreaterThanOrEqual(1);
    const wallet2Ready = parse(wallet2Msgs[0]);
    expect(wallet2Ready.t).toBe("ready");
    expect(wallet2Ready.body).toMatchObject({ state: "waiting", role: "wallet" });
  });

  it("dApp still receives forwarded join from new wallet after first wallet disconnects", async () => {
    // dApp creates
    const dappWs = await connectWs();
    const dappMsgs = collectMessages(dappWs);
    dappWs.send(msg("create", DAPP_KEY, { meta: { name: "T" } }));
    await new Promise((r) => setTimeout(r, 50));

    // First wallet joins
    const walletWs = await connectWs();
    collectMessages(walletWs);
    walletWs.send(msg("join", WALLET_KEY, { sealed_join: "data" }));
    await new Promise((r) => setTimeout(r, 50));

    // dApp should have: ready.waiting + forwarded join = 2 messages
    expect(dappMsgs.length).toBe(2);

    // First wallet disconnects
    walletWs.close(1000, "wallet_left");
    await new Promise((r) => setTimeout(r, 50));

    // Second wallet joins
    const wallet2Ws = await connectWs();
    collectMessages(wallet2Ws);
    wallet2Ws.send(msg("join", WALLET_KEY, { sealed_join: "data_retry" }));
    await new Promise((r) => setTimeout(r, 50));

    // dApp should have received the second join forwarded
    expect(dappMsgs.length).toBe(3);
    const secondJoin = parse(dappMsgs[2]);
    expect(secondJoin.t).toBe("join");
    expect(secondJoin.from).toBe(WALLET_KEY);
  });
});
