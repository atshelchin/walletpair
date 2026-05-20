/**
 * DApp-side WalletPair session.
 *
 * Manages the full lifecycle: create channel → QR → wallet joins → accept →
 * encrypted request/response + events.
 */

import type {
  Transport,
  ProtocolMessage,
  DAppPhase,
  DAppSessionEvents,
  DAppSessionOptions,
  PendingRequest,
  Capabilities,
  WalletMeta,
} from './types.js';
import {
  generateX25519KeyPair,
  generateChannelId,
  buildPairingUri,
  computeSharedSecret,
  deriveSessionKey,
  deriveDirectionalSessionKeys,
  deriveJoinEncryptionKey,
  computePairingCode,
  canonicalJson,
  sealPayload,
  unsealPayload,
  unsealJoin,
  b64urlEncode,
  b64urlDecode,
  bytesToHex,
  hexToBytes,
} from './crypto.js';
import type { SessionCryptoContext } from './crypto.js';
import { Emitter } from './emitter.js';

const BACKOFF = [1000, 2000, 5000, 10000, 30000];
const DEFAULT_REQUEST_TIMEOUT = 120_000;
const PENDING_ACCEPT_TIMEOUT = 60_000;
const MAX_SEND_SEQ = 2 ** 31;
const DEFAULT_SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours (§16 rule 17)

function validateCapabilities(cap: unknown): cap is Capabilities {
  if (cap == null || typeof cap !== 'object') return false;
  const c = cap as Record<string, unknown>;
  return Array.isArray(c.methods) && Array.isArray(c.events) && Array.isArray(c.chains);
}

export class DAppSession extends Emitter<DAppSessionEvents> {
  phase: DAppPhase = 'idle';

  /** Channel ID (hex). Available after createPairing(). */
  channelId = '';
  /** Pairing URI. Available after createPairing(). */
  pairingUri = '';
  /** 4-digit pairing code. Available after wallet joins. */
  pairingCode = '';
  /** Remote wallet capabilities. Available after wallet joins. */
  walletCapabilities: Capabilities | undefined = undefined;
  /** Remote wallet metadata. Available after wallet joins. */
  walletMeta: WalletMeta | undefined = undefined;
  private approvedCapabilities: Capabilities | undefined = undefined;
  private approvedWalletMeta: WalletMeta | undefined = undefined;
  private approvedWalletPubKeyB64: string | undefined = undefined;
  private approvedScopeRecorded = false;

  private transport: Transport;
  private name: string | undefined;
  private declaredMethods: string[] | undefined;
  private declaredChains: string[] | undefined;
  private requestTimeout: number;
  private autoAccept: boolean;
  private autoAcceptNewWallet: boolean;
  /** Session lifetime in ms (§16 rule 17). */
  private sessionTtl: number;
  private sessionTtlTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionStartTime: number | null = null;

  private privKey!: Uint8Array;
  private pubKeyB64 = '';
  private remotePubKey: Uint8Array | null = null;
  private sessionKey: Uint8Array | null = null;
  private sendKey: Uint8Array | null = null;
  private recvKey: Uint8Array | null = null;
  private sendSeq = 0;
  private recvSeq = -1;
  private resumeToken: string | null = null;
  private paired = false;
  private intentionalClose = false;
  private reqCounter = 0;
  private pendingRequests = new Map<string, PendingRequest>();

  private pendingAcceptTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;

  constructor(options: DAppSessionOptions) {
    super();
    this.transport = options.transport;
    this.name = options.name;
    this.declaredMethods = options.methods;
    this.declaredChains = options.chains;
    this.requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
    this.autoAccept = options.autoAccept ?? true;
    this.autoAcceptNewWallet = options.autoAcceptNewWallet ?? false;
    this.sessionTtl = options.sessionTtl ?? DEFAULT_SESSION_TTL;

    this.transport.onMessage((msg) => this.handleMessage(msg));
    this.transport.onClose(() => this.handleTransportClose());
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Create a new pairing channel and return the pairing URI for QR display.
   *
   * @param options.deferTransport - If true, don't connect the transport yet.
   *   Call `connectTransport()` later (e.g. after user scans QR in BLE mode).
   */
  async createPairing(options?: { deferTransport?: boolean | undefined }): Promise<string> {
    this.intentionalClose = false;
    const kp = generateX25519KeyPair();
    this.privKey = kp.privateKey;
    this.pubKeyB64 = kp.publicKeyB64;
    this.channelId = generateChannelId();
    this.sendSeq = 0;
    this.recvSeq = -1;
    this.remotePubKey = null;
    this.sessionKey = null;
    this.sendKey = null;
    this.recvKey = null;
    this.sessionStartTime = null;
    this.clearSessionTtl();
    this.approvedCapabilities = undefined;
    this.approvedWalletMeta = undefined;
    this.approvedWalletPubKeyB64 = undefined;
    this.approvedScopeRecorded = false;
    this.reqCounter = 0;
    this.paired = false;
    this.resumeToken = null;

    // Build pairing URI first (before transport connect, so BLE can show QR first)
    let relayUrl: string | undefined;
    if ('url' in this.transport) {
      relayUrl = (this.transport as any).url as string | undefined;
    }
    this.pairingUri = buildPairingUri({
      channelId: this.channelId,
      pubkeyB64: this.pubKeyB64,
      relayUrl,
      name: this.name,
      methods: this.declaredMethods,
      chains: this.declaredChains,
    });
    this.emit('pairingUri', this.pairingUri);

    if (!options?.deferTransport) {
      await this.connectTransport();
    } else {
      this.setPhase('waiting');
    }

    return this.pairingUri;
  }

  /**
   * Connect the transport and send the `create` message.
   * Call this after `createPairing({ deferTransport: true })` when the user
   * is ready (e.g. after showing QR and before BLE scan).
   */
  async connectTransport(): Promise<void> {
    await this.transport.connect();
    this.setPhase('waiting');
    this.sendRaw({
      v: 1, t: 'create', ch: this.channelId,
      ts: Date.now(), from: this.pubKeyB64,
      body: { meta: this.name ? { name: this.name } : {}, resume: null },
    } as ProtocolMessage);
  }

  /** Accept the wallet after pairing code verification. */
  acceptWallet(): void {
    if (this.phase !== 'pending_accept' || !this.remotePubKey) return;
    this.clearPendingAcceptTimer();
    this.doAccept();
  }

  /** Reject the wallet. */
  rejectWallet(): void {
    if (!this.remotePubKey) return;
    this.sendRaw({
      v: 1, t: 'close', ch: this.channelId,
      ts: Date.now(), from: this.pubKeyB64,
      body: { reason: 'user_rejected' },
    } as ProtocolMessage);
    this.close();
  }

  /** Send an encrypted request to the wallet. Returns the decrypted response. */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.phase !== 'connected' || !this.sendKey) {
      return Promise.reject(new Error('Not connected'));
    }

    const id = `req-${++this.reqCounter}`;

    // Always seal: even parameterless requests must be authenticated via AEAD
    // to prevent method injection by a malicious relay.
    let seq: number;
    try {
      seq = this.nextSendSeq();
    } catch (error) {
      return Promise.reject(error as Error);
    }
    // AAD: no method field — real method goes inside sealed payload
    const hdr = { type: 'req' as const, from: this.pubKeyB64, id };
    const sealedParams = { _method: method, ...(params && typeof params === 'object' ? params as Record<string, unknown> : { _params: params ?? {} }) };
    const sealed = sealPayload(this.sendKey, this.channelId, seq, sealedParams, hdr);

    const msg: ProtocolMessage = {
      v: 1, t: 'req', ch: this.channelId,
      ts: Date.now(), from: this.pubKeyB64,
      body: { id, sealed },
    } as ProtocolMessage;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out`));
      }, this.requestTimeout);

      this.pendingRequests.set(id, { id, method, resolve: resolve as any, reject, timer });
      this.sendRaw(msg);
    });
  }

  /** Send ping. */
  ping(): void {
    if (this.phase !== 'connected') return;
    this.sendRaw({ v: 1, t: 'ping', ch: this.channelId, ts: Date.now(), from: this.pubKeyB64, body: {} } as ProtocolMessage);
  }

  /** Gracefully close the session. */
  close(reason: string = 'normal'): void {
    this.intentionalClose = true;
    this.clearPendingAcceptTimer();
    this.clearSessionTtl();
    this.stopReconnect();
    for (const [, req] of this.pendingRequests) {
      if (req.timer) clearTimeout(req.timer);
      req.reject(new Error('Session closed'));
    }
    this.pendingRequests.clear();
    if (this.channelId) {
      this.sendRaw({ v: 1, t: 'close', ch: this.channelId, ts: Date.now(), from: this.pubKeyB64, body: { reason } } as ProtocolMessage);
    }
    this.transport.disconnect();
    this.setPhase('closed');
  }

  /** Destroy the session and release all resources. */
  destroy(): void {
    this.close();
    this.removeAll();
    // Wipe sensitive key material (§20.7)
    if (this.privKey) this.privKey.fill(0);
    if (this.sessionKey) this.sessionKey.fill(0);
    if (this.sendKey) this.sendKey.fill(0);
    if (this.recvKey) this.recvKey.fill(0);
    this.sessionKey = null;
    this.sendKey = null;
    this.recvKey = null;
  }

  // -------------------------------------------------------------------------
  // State serialization (for persistence across page reloads)
  // -------------------------------------------------------------------------

  serialize(): string {
    return JSON.stringify({
      channelId: this.channelId,
      privKey: bytesToHex(this.privKey),
      pubKeyB64: this.pubKeyB64,
      remotePubKeyB64: this.remotePubKey ? b64urlEncode(this.remotePubKey) : null,
      sendKey: this.sendKey ? bytesToHex(this.sendKey) : null,
      recvKey: this.recvKey ? bytesToHex(this.recvKey) : null,
      sendSeq: this.sendSeq,
      recvSeq: this.recvSeq,
      resumeToken: this.resumeToken,
      reqCounter: this.reqCounter,
      paired: this.paired,
      dappName: this.name ?? null,
      approvedScopeRecorded: this.approvedScopeRecorded,
      approvedCapabilities: this.approvedCapabilities ?? null,
      approvedWalletMeta: this.approvedWalletMeta ?? null,
      approvedWalletPubKeyB64: this.approvedWalletPubKeyB64 ?? null,
      sessionStartTime: this.sessionStartTime,
    });
  }

  restore(json: string): boolean {
    try {
      const d = JSON.parse(json);
      if (!d.channelId || !d.privKey) return false;
      this.channelId = d.channelId;
      this.privKey = hexToBytes(d.privKey);
      this.pubKeyB64 = d.pubKeyB64;
      this.remotePubKey = d.remotePubKeyB64 ? b64urlDecode(d.remotePubKeyB64) : null;
      this.sendKey = d.sendKey ? hexToBytes(d.sendKey) : null;
      this.recvKey = d.recvKey ? hexToBytes(d.recvKey) : null;
      // Backward compat: ignore sessionKey from old serialization format
      if (!this.sendKey || !this.recvKey) return false;
      this.sendSeq = d.sendSeq || 0;
      this.recvSeq = d.recvSeq ?? -1;
      this.resumeToken = d.resumeToken;
      this.reqCounter = d.reqCounter || 0;
      this.paired = d.paired || false;
      this.approvedScopeRecorded = d.approvedScopeRecorded === true;
      this.approvedCapabilities = d.approvedCapabilities ?? undefined;
      this.approvedWalletMeta = d.approvedWalletMeta ?? undefined;
      this.approvedWalletPubKeyB64 = d.approvedWalletPubKeyB64 ?? (d.remotePubKeyB64 ?? undefined);
      this.walletCapabilities = this.approvedCapabilities;
      this.walletMeta = this.approvedWalletMeta;
      this.name = d.dappName ?? undefined;
      this.sessionStartTime = d.sessionStartTime ?? null;
      return true;
    } catch { return false; }
  }

  /** Reconnect after restoring state. */
  async reconnect(): Promise<void> {
    this.intentionalClose = false;
    this.startReconnect();
  }

  // -------------------------------------------------------------------------
  // Internal: message handling
  // -------------------------------------------------------------------------

  private handleMessage(msg: ProtocolMessage): void {
    switch (msg.t) {
      case 'ready': {
        const readyBody = msg.body as { state?: string; resume?: string | null; remote?: string | null };
        this.resumeToken = readyBody.resume ?? null;
        this.stopReconnect();
        if (readyBody.state === 'connected') {
          const expectedRemote = this.remotePubKey ? b64urlEncode(this.remotePubKey) : null;
          if (!expectedRemote || readyBody.remote !== expectedRemote) {
            this.emit('error', new Error('Connected remote does not match paired wallet'));
            this.close();
            break;
          }
        }
        if (readyBody.state === 'waiting') {
          this.setPhase('waiting');
        } else if (readyBody.state === 'connected') {
          this.setPhase('connected');
          this.startSessionTtl();
        }
        break;
      }

      case 'join': {
        const joinBody = msg.body as { sealed_join?: string | null; resume?: string | null };
        const joinPubKey = msg.from;
        if (!joinPubKey) {
          this.emit('error', new Error('Malformed wallet join: missing from'));
          break;
        }
        let remoteBytes: Uint8Array;
        try {
          remoteBytes = b64urlDecode(joinPubKey);
          if (remoteBytes.length !== 32) throw new Error('Invalid wallet public key length');
        } catch {
          this.sendRaw({
            v: 1, t: 'close', ch: this.channelId,
            ts: Date.now(), from: this.pubKeyB64,
            body: { reason: 'protocol_error' },
          } as ProtocolMessage);
          this.emit('error', new Error('Malformed wallet public key'));
          break;
        }

        this.remotePubKey = remoteBytes;
        const shared = computeSharedSecret(this.privKey, this.remotePubKey);
        const rootKey = deriveSessionKey(shared, this.channelId);
        // §20.7: erase shared_secret immediately
        shared.fill(0);

        // For reconnect (resume set), skip sealed_join decryption
        let joinCapabilities: Capabilities | undefined;
        let joinMeta: WalletMeta | undefined;
        if (joinBody.resume) {
          // Reconnect — capabilities/meta come from previously approved scope
          joinCapabilities = this.approvedCapabilities;
          joinMeta = this.approvedWalletMeta;
        } else if (joinBody.sealed_join) {
          // Decrypt sealed_join (private handshake §7.5)
          let joinKey: Uint8Array | null = null;
          try {
            joinKey = deriveJoinEncryptionKey(rootKey, this.channelId);
            const decrypted = unsealJoin(joinKey, this.channelId, joinBody.sealed_join);
            joinCapabilities = decrypted.capabilities as Capabilities | undefined;
            joinMeta = decrypted.meta as WalletMeta | undefined;
          } catch {
            this.sendRaw({
              v: 1, t: 'close', ch: this.channelId,
              ts: Date.now(), from: this.pubKeyB64,
              body: { reason: 'decryption_failed' },
            } as ProtocolMessage);
            this.emit('error', new Error('Failed to decrypt sealed_join'));
            rootKey.fill(0);
            break;
          } finally {
            // §20.7: erase join_encryption_key after one-shot use.
            if (joinKey) joinKey.fill(0);
          }
        } else {
          this.sendRaw({
            v: 1, t: 'close', ch: this.channelId,
            ts: Date.now(), from: this.pubKeyB64,
            body: { reason: 'protocol_error' },
          } as ProtocolMessage);
          this.emit('error', new Error('Initial wallet join missing sealed_join'));
          rootKey.fill(0);
          break;
        }

        // Validate capabilities shape
        if (joinCapabilities != null && !validateCapabilities(joinCapabilities)) {
          this.sendRaw({
            v: 1, t: 'close', ch: this.channelId,
            ts: Date.now(), from: this.pubKeyB64,
            body: { reason: 'protocol_error' },
          } as ProtocolMessage);
          this.emit('error', new Error('Malformed wallet capabilities'));
          rootKey.fill(0);
          break;
        }

        const knownWallet = this.isSameApprovedWallet(joinPubKey, joinCapabilities, joinMeta);
        this.walletCapabilities = joinCapabilities;
        this.walletMeta = joinMeta;
        const context = this.sessionContext(joinPubKey, joinCapabilities, joinMeta);
        const keys = deriveDirectionalSessionKeys(rootKey, this.channelId, context);
        this.sendKey = keys.dappToWalletKey;
        this.recvKey = keys.walletToDappKey;

        this.pairingCode = computePairingCode(rootKey, this.channelId, context);

        // §20.7: erase root_key and transcript_hash after all derivations
        rootKey.fill(0);
        keys.rootKey.fill(0);
        keys.transcriptHash.fill(0);

        if (knownWallet) {
          this.doAccept();
        } else {
          this.emit('pairingCode', this.pairingCode);
          this.emit('walletJoined', {
            capabilities: joinCapabilities,
            meta: joinMeta,
          });

          if (this.autoAcceptNewWallet) {
            this.emit('error', new Error('autoAcceptNewWallet is disabled for first-time wallets; call acceptWallet() after code comparison'));
          }
          this.setPhase('pending_accept');

          // Start pending_accept timeout
          this.clearPendingAcceptTimer();
          this.pendingAcceptTimer = setTimeout(() => {
            if (this.phase === 'pending_accept') {
              this.emit('error', new Error('Pairing acceptance timed out'));
              this.rejectWallet();
            }
          }, PENDING_ACCEPT_TIMEOUT);
        }
        break;
      }

      case 'res': {
        const resBody = msg.body as { id?: string; ok?: boolean; sealed?: string };
        if (this.remotePubKey && msg.from !== b64urlEncode(this.remotePubKey)) break;
        if (!resBody.id) break;
        const pending = this.pendingRequests.get(resBody.id);
        if (!pending) break;
        this.pendingRequests.delete(resBody.id);
        if (pending.timer) clearTimeout(pending.timer);

        // All responses MUST be sealed — reject unsealed to prevent forgery.
        if (!resBody.sealed || !this.recvKey) {
          pending.reject(new Error('Response must be encrypted'));
          break;
        }

        try {
          const resHdr = { type: 'res' as const, from: msg.from, id: resBody.id, ok: !!resBody.ok };
          const { seq, data } = unsealPayload(this.recvKey, this.channelId, resBody.sealed, resHdr);
          if (seq <= this.recvSeq) {
            pending.reject(new Error('Replay detected'));
            break;
          }
          this.recvSeq = seq;
          if (resBody.ok) {
            pending.resolve(data);
          } else {
            const err = data as { code?: string; message?: string };
            const error = new Error(err.message ?? 'Request rejected');
            (error as any).code = err.code;
            pending.reject(error);
          }
          this.emit('response', { id: resBody.id, ok: !!resBody.ok, data });
        } catch {
          pending.reject(new Error('Decryption failed'));
        }
        break;
      }

      case 'evt': {
        const evtBody = msg.body as { id?: string; sealed?: string };
        if (this.remotePubKey && msg.from !== b64urlEncode(this.remotePubKey)) break;
        // Events MUST be sealed — drop unsealed events to prevent forgery.
        if (!evtBody.sealed || !evtBody.id || !this.recvKey) break;
        try {
          const evtHdr = { type: 'evt' as const, from: msg.from, id: evtBody.id };
          const { seq, data } = unsealPayload(this.recvKey, this.channelId, evtBody.sealed, evtHdr);
          if (seq <= this.recvSeq) break; // replay — silently drop
          this.recvSeq = seq;

          // Privacy mode (§7.4): real event name is inside the encrypted payload
          let event: string | undefined;
          let eventData: unknown = data;
          if (data && typeof data === 'object' && '_event' in (data as any)) {
            event = (data as any)._event;
            const { _event: _, ...rest } = data as Record<string, unknown>;
            eventData = Object.keys(rest).length === 1 && '_data' in rest ? rest._data : rest;
          }

          if (event) {
            this.emit('event', { event, data: eventData });
          } else {
            this.emit('error', new Error('Event payload missing _event'));
          }
        } catch { /* drop events that fail decryption */ }
        break;
      }

      case 'ping':
        this.sendRaw({ v: 1, t: 'pong', ch: this.channelId, ts: Date.now(), from: this.pubKeyB64, body: {} } as ProtocolMessage);
        break;

      case 'pong':
        break;

      case 'close': {
        const closeBody = msg.body as { reason?: string };
        if (closeBody.reason === 'invalid_resume') {
          this.resumeToken = null;
          this.transport.disconnect();
          this.doReconnectAttempt(false);
        } else if (closeBody.reason === 'channel_exists') {
          this.startReconnect();
        } else if (this.phase !== 'disconnected') {
          this.setPhase('closed');
          this.intentionalClose = true;
        }
        break;
      }

      case 'terminate': {
        // Adapter-sent termination — treat like close
        if (this.phase !== 'disconnected') {
          this.setPhase('closed');
          this.intentionalClose = true;
        }
        break;
      }
    }
  }

  private doAccept(): void {
    this.paired = true;
    this.approvedCapabilities = this.walletCapabilities;
    this.approvedWalletMeta = this.walletMeta;
    this.approvedWalletPubKeyB64 = b64urlEncode(this.remotePubKey!);
    this.approvedScopeRecorded = true;
    const walletPubB64 = b64urlEncode(this.remotePubKey!);
    this.sendRaw({
      v: 1, t: 'accept', ch: this.channelId,
      ts: Date.now(), from: this.pubKeyB64,
      body: { target: walletPubB64 },
    } as ProtocolMessage);
  }

  private sessionContext(
    walletPubKeyB64: string,
    capabilities?: Capabilities | undefined,
    walletMeta?: WalletMeta | undefined,
  ): SessionCryptoContext {
    return {
      dappPubKeyB64: this.pubKeyB64,
      walletPubKeyB64,
      capabilities: capabilities ?? null,
      walletMeta: walletMeta ?? {},
      dappName: this.name,
    };
  }

  private isSameApprovedWallet(
    walletPubKeyB64: string,
    capabilities?: Capabilities | undefined,
    walletMeta?: WalletMeta | undefined,
  ): boolean {
    return this.autoAccept &&
      this.paired &&
      this.approvedWalletPubKeyB64 === walletPubKeyB64 &&
      this.approvedScopeRecorded &&
      canonicalJson(this.approvedCapabilities) === canonicalJson(capabilities ?? null) &&
      canonicalJson(this.approvedWalletMeta ?? null) === canonicalJson(walletMeta ?? null);
  }

  private nextSendSeq(): number {
    if (this.sendSeq >= MAX_SEND_SEQ) {
      const error = new Error('Send sequence overflow/limit reached — session invalidated');
      this.emit('error', error);
      this.close();
      throw error;
    }
    return this.sendSeq++;
  }

  // -------------------------------------------------------------------------
  // Internal: transport
  // -------------------------------------------------------------------------

  private sendRaw(msg: ProtocolMessage): void {
    this.transport.send(msg);
  }

  private handleTransportClose(): void {
    if (this.intentionalClose || this.phase === 'closed') return;
    this.startReconnect();
  }

  // -------------------------------------------------------------------------
  // Internal: reconnect
  // -------------------------------------------------------------------------

  private startReconnect(): void {
    this.setPhase('disconnected');
    this.reconnectAttempt = 0;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose || this.phase === 'closed') return;
    const base = BACKOFF[Math.min(this.reconnectAttempt, BACKOFF.length - 1)]!;
    const delay = base + Math.floor(Math.random() * base * 0.3); // ±30% jitter
    this.reconnectTimer = setTimeout(() => {
      this.doReconnectAttempt(this.reconnectAttempt === 0 && !!this.resumeToken);
      this.reconnectAttempt++;
    }, delay);
  }

  private async doReconnectAttempt(useResume: boolean): Promise<void> {
    if (this.intentionalClose || this.phase === 'closed') return;
    try {
      await this.transport.connect();
      this.sendRaw({
        v: 1, t: 'create', ch: this.channelId,
        ts: Date.now(), from: this.pubKeyB64,
        body: { meta: this.name ? { name: this.name } : {}, resume: (useResume && this.resumeToken) ? this.resumeToken : null },
      } as ProtocolMessage);
    } catch {
      this.scheduleReconnect();
    }
  }

  private stopReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearPendingAcceptTimer(): void {
    if (this.pendingAcceptTimer) {
      clearTimeout(this.pendingAcceptTimer);
      this.pendingAcceptTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Internal: session TTL (§16 rule 17)
  // -------------------------------------------------------------------------

  private startSessionTtl(): void {
    this.clearSessionTtl();
    if (this.sessionStartTime == null) {
      this.sessionStartTime = Date.now();
    }
    const elapsed = Date.now() - this.sessionStartTime;
    const remaining = Math.max(0, this.sessionTtl - elapsed);
    this.sessionTtlTimer = setTimeout(() => {
      this.emit('error', new Error('Session lifetime expired'));
      this.close('timeout');
    }, remaining);
  }

  private clearSessionTtl(): void {
    if (this.sessionTtlTimer) {
      clearTimeout(this.sessionTtlTimer);
      this.sessionTtlTimer = null;
    }
  }

  private setPhase(phase: DAppPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.emit('phase', phase);
  }
}
