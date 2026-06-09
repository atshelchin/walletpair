import { DurableObject } from "cloudflare:workers";
import type {
  ChannelState,
  CloseReasonString,
  Env,
  PersistedChannelState,
  Role,
  WsAttachment,
} from "./types";
import {
  buildReadyConnected,
  buildReadyWaiting,
  buildTerminate,
  buildTerminateWithTarget,
  parseErrorToCloseReason,
  parseMessage,
  stateAllowsMessage,
  validateChannelId,
  type ClientMessage,
} from "./protocol";

// --- Constants (parity with Rust relay) ---
const MAX_MESSAGE_BYTES = 65_536; // 64 KB
const PENDING_REQUEST_LIMIT = 32;
const UNPAIRED_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CONNECTED_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * ChannelDO: One Durable Object per channel. Both peers (dApp and wallet)
 * connect their WebSockets to this DO. Uses the Hibernation API for
 * cost-effective idle connections.
 */
export class ChannelDO extends DurableObject<Env> {
  // --- In-memory state (reconstructed from storage on hibernation wake) ---
  private channelState: ChannelState = "none";
  private channelId: string | null = null;
  private dappPeerId: string | null = null;
  private walletPeerId: string | null = null;
  private isReconnect = false;
  private pendingRequests = new Set<string>();
  private initialized = false;

  // --- WebSocket Upgrade Handler ---

  async fetch(request: Request): Promise<Response> {
    // Only accept WebSocket upgrades
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    // Extract channel ID from query parameter
    const url = new URL(request.url);
    const ch = url.searchParams.get("ch");
    if (!ch || !validateChannelId(ch)) {
      return new Response("Invalid channel ID", { status: 400 });
    }

    // Negotiate subprotocol
    const protocols = request.headers.get("Sec-WebSocket-Protocol");
    const hasWalletPairProtocol =
      protocols?.split(",").some((p) => p.trim() === "walletpair.v1") ?? false;

    // Create WebSocket pair
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Accept with hibernation API (no tags yet -- assigned on first message)
    this.ctx.acceptWebSocket(server);

    // Restore state from storage if waking from hibernation
    await this.ensureInitialized();

    // Store channel ID if this is the first connection to this DO
    if (this.channelId === null) {
      this.channelId = ch;
    }

    const responseHeaders: Record<string, string> = {};
    if (hasWalletPairProtocol) {
      responseHeaders["Sec-WebSocket-Protocol"] = "walletpair.v1";
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: responseHeaders,
    });
  }

  // --- Hibernation Callbacks ---

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.ensureInitialized();

    // Binary frames not allowed
    if (typeof message !== "string") {
      const ch = this.channelId ?? "unknown";
      this.sendAndClose(ws, buildTerminate(ch, "protocol_error"));
      return;
    }

    // Size limit (pre-parse)
    if (message.length > MAX_MESSAGE_BYTES) {
      const ch = this.channelId ?? "unknown";
      this.sendAndClose(ws, buildTerminate(ch, "payload_too_large"));
      return;
    }

    // Parse
    const result = parseMessage(message);
    if ("kind" in result) {
      const ch = this.channelId ?? "unknown";
      const reason = parseErrorToCloseReason(result);
      this.sendAndClose(ws, buildTerminate(ch, reason));
      return;
    }

    const msg = result;

    // Validate channel binding: message ch must match this DO's channel
    if (msg.ch !== this.channelId) {
      this.sendAndClose(ws, buildTerminate(msg.ch, "protocol_error"));
      return;
    }

    // Determine if this WS already has a role assignment
    const attachment = this.getAttachment(ws);

    if (attachment === null) {
      // First message on this WebSocket -- must be create or join
      await this.handleFirstMessage(ws, msg, message);
    } else {
      // Subsequent message -- process with known role
      await this.handleMessage(ws, attachment, msg, message);
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    await this.ensureInitialized();
    await this.handleDisconnect(ws);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    await this.ensureInitialized();
    await this.handleDisconnect(ws);
  }

  async alarm(): Promise<void> {
    await this.ensureInitialized();

    // Timeout: send terminate to all connected peers and close
    const ch = this.channelId;
    if (!ch) return;

    const terminateMsg = buildTerminate(ch, "timeout");

    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(terminateMsg);
        ws.close(1000, "timeout");
      } catch {
        // Already closed
      }
    }

    this.channelState = "closed";
    await this.persistState();
  }

  // --- First message handling ---

  private async handleFirstMessage(
    ws: WebSocket,
    msg: ClientMessage,
    rawText: string,
  ): Promise<void> {
    const ch = msg.ch;

    switch (msg.t) {
      case "create":
        await this.handleCreate(ws, ch, msg.from);
        break;

      case "join":
        await this.handleJoin(ws, ch, msg.from, msg.sealedJoinNull, rawText);
        break;

      default:
        // First message must be create or join
        this.sendAndClose(ws, buildTerminate(ch, "invalid_state"));
        break;
    }
  }

  // --- Create ---

  private async handleCreate(ws: WebSocket, ch: string, from: string): Promise<void> {
    switch (this.channelState) {
      case "waiting": {
        // Replace: close old dApp WebSocket if still open
        const oldDapp = this.findPeerWs("dapp");
        if (oldDapp) {
          try {
            oldDapp.send(buildTerminate(ch, "normal"));
            oldDapp.close(1000, "replaced");
          } catch {
            // Already closed
          }
        }
        break;
      }

      case "connected": {
        // Only allow if dApp connection is dead
        const dappWs = this.findPeerWs("dapp");
        if (dappWs) {
          // dApp is still alive -- reject
          this.sendAndClose(ws, buildTerminate(ch, "channel_exists"));
          return;
        }
        // dApp is dead: clean up wallet too
        const walletWs = this.findPeerWs("wallet");
        if (walletWs) {
          try {
            walletWs.send(buildTerminate(ch, "normal"));
            walletWs.close(1000, "replaced");
          } catch {
            // Already closed
          }
        }
        break;
      }

      case "pending_accept": {
        this.sendAndClose(ws, buildTerminate(ch, "channel_exists"));
        return;
      }

      case "closed":
      case "none": {
        // No prior channel or closed -- allow create
        break;
      }
    }

    // Create channel
    this.channelState = "waiting";
    this.dappPeerId = from;
    this.walletPeerId = null;
    this.isReconnect = false;
    this.pendingRequests.clear();

    // Assign role to WebSocket
    this.setAttachment(ws, { role: "dapp", peerId: from, channelId: ch });

    // Send ready.waiting
    ws.send(buildReadyWaiting(ch, "dapp", from, false));

    // Set unpaired TTL alarm
    await this.ctx.storage.setAlarm(Date.now() + UNPAIRED_TTL_MS);

    await this.persistState();
  }

  // --- Join ---

  private async handleJoin(
    ws: WebSocket,
    ch: string,
    from: string,
    sealedJoinNull: boolean,
    rawText: string,
  ): Promise<void> {
    // Channel must be in waiting state
    if (this.channelState !== "waiting") {
      const reason: CloseReasonString =
        this.channelState === "closed" || this.channelState === "none"
          ? "channel_not_found"
          : "already_connected";
      this.sendAndClose(ws, buildTerminate(ch, reason));
      return;
    }

    // Register wallet
    this.walletPeerId = from;
    this.isReconnect = sealedJoinNull;
    this.channelState = "pending_accept";

    // Assign role to WebSocket
    this.setAttachment(ws, { role: "wallet", peerId: from, channelId: ch });

    // Forward join to dApp (raw message)
    const dappWs = this.findPeerWs("dapp");
    if (dappWs) {
      try {
        dappWs.send(rawText);
      } catch {
        // dApp WebSocket send failed — revert to waiting so wallet can retry
        this.walletPeerId = null;
        this.isReconnect = false;
        this.channelState = "waiting";
        this.sendAndClose(ws, buildTerminate(ch, "channel_not_found"));
        await this.persistState();
        return;
      }
    } else {
      // dApp WebSocket not found (e.g. closed during hibernation) — reject wallet
      this.walletPeerId = null;
      this.isReconnect = false;
      this.channelState = "waiting";
      this.sendAndClose(ws, buildTerminate(ch, "channel_not_found"));
      await this.persistState();
      return;
    }

    // Send ready.waiting to wallet
    ws.send(buildReadyWaiting(ch, "wallet", from, sealedJoinNull));

    await this.persistState();
  }

  // --- Subsequent message handling ---

  private async handleMessage(
    ws: WebSocket,
    attachment: WsAttachment,
    msg: ClientMessage,
    rawText: string,
  ): Promise<void> {
    const ch = msg.ch;
    const { role } = attachment;

    switch (msg.t) {
      case "create": {
        // Re-create from dApp: only valid if from same peer (Fix #1)
        if (this.dappPeerId && msg.from !== this.dappPeerId) {
          this.sendAndClose(ws, buildTerminate(ch, "invalid_role"));
          return;
        }
        await this.handleCreate(ws, ch, msg.from);
        return;
      }

      case "join": {
        // Join is only valid as a first message
        this.sendAndClose(ws, buildTerminate(ch, "invalid_state"));
        return;
      }

      case "accept":
        await this.handleAccept(ws, ch, msg.from, msg.target, role);
        return;

      case "req":
        await this.handleData(ws, rawText, ch, msg.from, "req", msg.id, role);
        return;

      case "res":
        await this.handleData(ws, rawText, ch, msg.from, "res", msg.id, role);
        return;

      case "evt":
        await this.handleData(ws, rawText, ch, msg.from, "evt", msg.id, role);
        return;

      case "ping":
        await this.handleData(ws, rawText, ch, msg.from, "ping", undefined, role);
        return;

      case "pong":
        await this.handleData(ws, rawText, ch, msg.from, "pong", undefined, role);
        return;

      case "close":
        await this.handleClose(ws, rawText, ch, msg.from, role);
        return;
    }
  }

  // --- Accept ---

  private async handleAccept(
    _ws: WebSocket,
    ch: string,
    from: string,
    target: string,
    senderRole: Role,
  ): Promise<void> {
    // Must be from dApp
    if (senderRole !== "dapp" || from !== this.dappPeerId) {
      this.sendAndClose(_ws, buildTerminate(ch, "invalid_role"));
      return;
    }

    // Must be in pending_accept
    if (this.channelState !== "pending_accept") {
      this.sendAndClose(_ws, buildTerminate(ch, "invalid_state"));
      return;
    }

    // Target must match wallet
    if (target !== this.walletPeerId) {
      this.sendAndClose(_ws, buildTerminateWithTarget(ch, "protocol_error", target));
      return;
    }

    const walletId = this.walletPeerId!;
    const reconnect = this.isReconnect;

    // Fix #2: Send ready.connected to both peers BEFORE transitioning state,
    // so if a send fails we can revert instead of being stuck in "connected"
    // with a missing peer.
    const dappWs = this.findPeerWs("dapp");
    const walletWs = this.findPeerWs("wallet");

    let dappOk = false;
    let walletOk = false;

    if (dappWs) {
      try {
        dappWs.send(buildReadyConnected(ch, "dapp", from, walletId, reconnect));
        dappOk = true;
      } catch {
        // disconnected
      }
    }

    if (walletWs) {
      try {
        walletWs.send(buildReadyConnected(ch, "wallet", walletId, from, reconnect));
        walletOk = true;
      } catch {
        // disconnected
      }
    }

    // Only transition if at least one peer received the message
    if (!dappOk && !walletOk) {
      // Both peers gone — close channel
      this.channelState = "closed";
      await this.persistState();
      await this.ctx.storage.deleteAlarm();
      return;
    }

    // Transition to connected
    this.channelState = "connected";

    // Update alarm to connected TTL
    await this.ctx.storage.setAlarm(Date.now() + CONNECTED_TTL_MS);

    await this.persistState();
  }

  // --- Data messages (req, res, evt, ping, pong) ---

  private async handleData(
    ws: WebSocket,
    rawText: string,
    ch: string,
    from: string,
    msgType: string,
    reqId: string | undefined,
    senderRole: Role,
  ): Promise<void> {
    // Verify sender identity matches stored peer
    const expectedPeerId =
      senderRole === "dapp" ? this.dappPeerId : this.walletPeerId;
    if (from !== expectedPeerId) {
      this.sendAndClose(ws, buildTerminate(ch, "invalid_role"));
      return;
    }

    // Check state allows this message
    if (!stateAllowsMessage(this.channelState, msgType, senderRole)) {
      const reason: CloseReasonString =
        (msgType === "req" || msgType === "res" || msgType === "evt") &&
        this.channelState !== "connected"
          ? "invalid_state"
          : "invalid_role";
      this.sendAndClose(ws, buildTerminate(ch, reason));
      return;
    }

    // Pending request tracking
    if (msgType === "req" && reqId !== undefined) {
      if (this.pendingRequests.size >= PENDING_REQUEST_LIMIT) {
        this.sendAndClose(ws, buildTerminate(ch, "rate_limited"));
        return;
      }
      this.pendingRequests.add(reqId);
    }

    if (msgType === "res" && reqId !== undefined) {
      this.pendingRequests.delete(reqId);
    }

    // Forward to other peer
    const otherRole: Role = senderRole === "dapp" ? "wallet" : "dapp";
    const otherWs = this.findPeerWs(otherRole);
    if (otherWs) {
      try {
        otherWs.send(rawText);
      } catch {
        // Fix #3: Notify sender that peer is unreachable instead of silent drop
        try {
          ws.send(buildTerminate(ch, "channel_not_found"));
        } catch { /* sender also gone */ }
      }
    } else if (msgType === "req") {
      // Fix #3: Peer not connected — notify sender so request doesn't hang
      try {
        ws.send(buildTerminate(ch, "channel_not_found"));
      } catch { /* sender also gone */ }
    }

    // Persist only if pending requests changed
    if (msgType === "req" || msgType === "res") {
      await this.persistState();
    }
  }

  // --- Close ---

  private async handleClose(
    _ws: WebSocket,
    rawText: string,
    ch: string,
    from: string,
    senderRole: Role,
  ): Promise<void> {
    // Verify sender
    const expectedPeerId =
      senderRole === "dapp" ? this.dappPeerId : this.walletPeerId;
    if (from !== expectedPeerId) {
      this.sendAndClose(_ws, buildTerminate(ch, "invalid_role"));
      return;
    }

    // Forward close to other peer
    const otherRole: Role = senderRole === "dapp" ? "wallet" : "dapp";
    const otherWs = this.findPeerWs(otherRole);
    if (otherWs) {
      try {
        otherWs.send(rawText);
        otherWs.close(1000, "peer_closed");
      } catch {
        // Already closed
      }
    }

    // Close the sender too
    try {
      _ws.close(1000, "closed");
    } catch {
      // Already closed
    }

    this.channelState = "closed";
    await this.persistState();

    // Cancel alarm
    await this.ctx.storage.deleteAlarm();
  }

  // --- Disconnect handling ---

  private async handleDisconnect(ws: WebSocket): Promise<void> {
    const attachment = this.getAttachment(ws);
    if (!attachment) return;

    const { role } = attachment;
    const ch = this.channelId;
    if (!ch) return;

    // In waiting/pending_accept: if the dApp disconnects, the channel
    // is unusable (wallet can't pair without dApp). Clean up immediately.
    if (this.channelState === "waiting" || this.channelState === "pending_accept") {
      if (role === "dapp") {
        // Notify wallet if present and close it
        const walletWs = this.findPeerWs("wallet");
        if (walletWs) {
          try {
            walletWs.send(buildTerminate(ch, "channel_not_found"));
            walletWs.close(1000, "dapp_disconnected");
          } catch { /* already closed */ }
        }
        this.channelState = "closed";
        await this.persistState();
        await this.ctx.storage.deleteAlarm();
      }
      // Wallet disconnect during pending_accept: dApp can still wait for
      // another wallet. Revert to waiting state.
      if (role === "wallet" && this.channelState === "pending_accept") {
        this.walletPeerId = null;
        this.isReconnect = false;
        this.channelState = "waiting";
        // Fix #5: Reset alarm to unpaired TTL since we're back to waiting
        await this.ctx.storage.setAlarm(Date.now() + UNPAIRED_TTL_MS);
        await this.persistState();
      }
      return;
    }

    // In connected: peer dropped without sending close.
    // Keep channel alive for reconnection. The alarm handles expiry.
    // Don't notify or close the other peer — they will detect the
    // disconnection via heartbeat timeout and begin reconnect.
    // Don't set to closed — allow reconnect via new create/join.
    if (this.channelState === "connected") {
      return;
    }
  }

  // --- Helpers ---

  private findPeerWs(role: Role): WebSocket | null {
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      const att = this.getAttachment(ws);
      if (att?.role === role) {
        // Fix #6: Only return OPEN sockets (readyState 1), not CONNECTING (0)
        if (ws.readyState === 1) return ws;
        console.log(`[relay] findPeerWs(${role}): found but readyState=${ws.readyState}`);
      }
    }
    console.log(`[relay] findPeerWs(${role}): not found among ${sockets.length} sockets`);
    return null;
  }

  private getAttachment(ws: WebSocket): WsAttachment | null {
    try {
      const att = ws.deserializeAttachment() as WsAttachment | null;
      return att;
    } catch {
      return null;
    }
  }

  private setAttachment(ws: WebSocket, attachment: WsAttachment): void {
    ws.serializeAttachment(attachment);
  }

  private sendAndClose(ws: WebSocket, message: string): void {
    try {
      ws.send(message);
      ws.close(1000, "rejected");
    } catch {
      // Already closed
    }
  }

  private async persistState(): Promise<void> {
    if (!this.channelId) return;
    const state: PersistedChannelState = {
      state: this.channelState,
      dappPeerId: this.dappPeerId ?? "",
      walletPeerId: this.walletPeerId,
      isReconnect: this.isReconnect,
      pendingRequests: Array.from(this.pendingRequests),
    };
    await this.ctx.storage.put("channelState", state);
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const stored = await this.ctx.storage.get<PersistedChannelState>("channelState");
    if (stored) {
      this.channelState = stored.state;
      this.dappPeerId = stored.dappPeerId || null;
      this.walletPeerId = stored.walletPeerId;
      this.isReconnect = stored.isReconnect;
      this.pendingRequests = new Set(stored.pendingRequests);
    }

    // Reconstruct channelId from any connected WebSocket's attachment
    if (!this.channelId) {
      for (const ws of this.ctx.getWebSockets()) {
        const att = this.getAttachment(ws);
        if (att?.channelId) {
          this.channelId = att.channelId;
          break;
        }
      }
    }
  }
}
