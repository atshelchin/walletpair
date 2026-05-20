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
  computePairingCode,
  canonicalJson,
  sealPayload,
  unsealPayload,
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
  /** 6-digit pairing code. Available after wallet joins. */
  pairingCode = '';
  /** Remote wallet capabilities. Available after wallet joins. */
  walletCapabilities: Capabilities | undefined = undefined;
  /** Remote wallet metadata. Available after wallet joins. */
  walletMeta: WalletMeta | undefined = undefined;
  private approvedCapabilities: Capabilities | undefined = undefined;
  private approvedWalletMeta: WalletMeta | undefined = undefined;
  private approvedScopeRecorded = false;

  private transport: Transport;
  private name: string | undefined;
  private requestTimeout: number;
  private autoAccept: boolean;
  private autoAcceptNewWallet: boolean;

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
    this.requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
    this.autoAccept = options.autoAccept ?? true;
    this.autoAcceptNewWallet = options.autoAcceptNewWallet ?? false;

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
    this.approvedCapabilities = undefined;
    this.approvedWalletMeta = undefined;
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
      from: this.pubKeyB64, pubkey: this.pubKeyB64,
    });
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
      from: this.pubKeyB64, target: b64urlEncode(this.remotePubKey),
      reason: 'user_rejected',
    } as any);
    this.close();
  }

  /** Send an encrypted request to the wallet. Returns the decrypted response. */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.phase !== 'connected' || !this.sendKey) {
      return Promise.reject(new Error('Not connected'));
    }

    const id = `req-${++this.reqCounter}`;
    const msg: ProtocolMessage = {
      v: 1, t: 'req', ch: this.channelId, id,
      from: this.pubKeyB64, method,
    };

    // Always seal: even parameterless requests must be authenticated via AEAD
    // to prevent method injection by a malicious relay.
    let seq: number;
    try {
      seq = this.nextSendSeq();
    } catch (error) {
      return Promise.reject(error as Error);
    }
    const hdr = { type: 'req' as const, from: this.pubKeyB64, id, method };
    (msg as any).sealed = sealPayload(this.sendKey, this.channelId, seq, params ?? {}, hdr);

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
    this.sendRaw({ v: 1, t: 'ping', ch: this.channelId, from: this.pubKeyB64, ts: Date.now() });
  }

  /** Gracefully close the session. */
  close(): void {
    this.intentionalClose = true;
    this.clearPendingAcceptTimer();
    this.stopReconnect();
    for (const [, req] of this.pendingRequests) {
      if (req.timer) clearTimeout(req.timer);
      req.reject(new Error('Session closed'));
    }
    this.pendingRequests.clear();
    if (this.channelId) {
      this.sendRaw({ v: 1, t: 'close', ch: this.channelId, from: this.pubKeyB64, reason: 'normal' });
    }
    this.transport.disconnect();
    this.setPhase('closed');
  }

  /** Destroy the session and release all resources. */
  destroy(): void {
    this.close();
    this.removeAll();
    // Wipe sensitive key material
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
      sessionKey: this.sessionKey ? bytesToHex(this.sessionKey) : null,
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
      this.sessionKey = d.sessionKey ? hexToBytes(d.sessionKey) : null;
      this.sendKey = d.sendKey ? hexToBytes(d.sendKey) : null;
      this.recvKey = d.recvKey ? hexToBytes(d.recvKey) : null;
      if (this.sessionKey && (!this.sendKey || !this.recvKey)) return false;
      this.sendSeq = d.sendSeq || 0;
      this.recvSeq = d.recvSeq ?? -1;
      this.resumeToken = d.resumeToken;
      this.reqCounter = d.reqCounter || 0;
      this.paired = d.paired || false;
      this.approvedScopeRecorded = d.approvedScopeRecorded === true;
      this.approvedCapabilities = d.approvedCapabilities ?? undefined;
      this.approvedWalletMeta = d.approvedWalletMeta ?? undefined;
      this.walletCapabilities = this.approvedCapabilities;
      this.walletMeta = this.approvedWalletMeta;
      this.name = d.dappName ?? undefined;
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
      case 'ready':
        this.resumeToken = msg.resume ?? null;
        this.stopReconnect();
        if (
          msg.state === 'connected' &&
          msg.remote &&
          this.remotePubKey &&
          msg.remote !== b64urlEncode(this.remotePubKey)
        ) {
          this.emit('error', new Error('Connected remote does not match paired wallet'));
          this.close();
          break;
        }
        if (msg.state === 'waiting') {
          this.setPhase('waiting');
        } else if (msg.state === 'connected') {
          this.setPhase('connected');
        }
        break;

      case 'join': {
        const joinPubKey = msg.from!;
        if (!joinPubKey || msg.pubkey !== joinPubKey) {
          this.sendRaw({
            v: 1, t: 'close', ch: this.channelId,
            from: this.pubKeyB64, target: joinPubKey,
            reason: 'protocol_error',
          } as any);
          this.emit('error', new Error('Malformed wallet join'));
          break;
        }
        let remoteBytes: Uint8Array;
        try {
          remoteBytes = b64urlDecode(joinPubKey);
          if (remoteBytes.length !== 32) throw new Error('Invalid wallet public key length');
        } catch {
          this.sendRaw({
            v: 1, t: 'close', ch: this.channelId,
            from: this.pubKeyB64, target: joinPubKey,
            reason: 'protocol_error',
          } as any);
          this.emit('error', new Error('Malformed wallet public key'));
          break;
        }

        // Validate capabilities shape
        if (msg.capabilities != null && !validateCapabilities(msg.capabilities)) {
          this.sendRaw({
            v: 1, t: 'close', ch: this.channelId,
            from: this.pubKeyB64, target: joinPubKey,
            reason: 'protocol_error',
          } as any);
          this.emit('error', new Error('Malformed wallet capabilities'));
          break;
        }

        const knownWallet = this.isSameApprovedWallet(joinPubKey, msg.capabilities, msg.meta);
        this.remotePubKey = remoteBytes;
        const shared = computeSharedSecret(this.privKey, this.remotePubKey);
        this.sessionKey = deriveSessionKey(shared, this.channelId);

        this.walletCapabilities = msg.capabilities;
        this.walletMeta = msg.meta;
        const context = this.sessionContext(joinPubKey, msg.capabilities, msg.meta);
        const keys = deriveDirectionalSessionKeys(this.sessionKey, this.channelId, context);
        this.sendKey = keys.dappToWalletKey;
        this.recvKey = keys.walletToDappKey;

        if (knownWallet) {
          this.doAccept();
        } else {
          this.pairingCode = computePairingCode(this.sessionKey, this.channelId, context);
          this.emit('pairingCode', this.pairingCode);
          this.emit('walletJoined', {
            pubkey: joinPubKey,
            capabilities: msg.capabilities,
            meta: msg.meta,
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
        if (this.remotePubKey && msg.from !== b64urlEncode(this.remotePubKey)) break;
        const pending = this.pendingRequests.get(msg.id);
        if (!pending) break;
        this.pendingRequests.delete(msg.id);
        if (pending.timer) clearTimeout(pending.timer);

        // All responses MUST be sealed — reject unsealed to prevent forgery.
        if (!msg.sealed || !this.recvKey) {
          pending.reject(new Error('Response must be encrypted'));
          break;
        }

        try {
          const resHdr = { type: 'res' as const, from: msg.from!, id: msg.id, ok: msg.ok };
          const { seq, data } = unsealPayload(this.recvKey, this.channelId, msg.sealed, resHdr);
          if (seq <= this.recvSeq) {
            pending.reject(new Error('Replay detected'));
            break;
          }
          this.recvSeq = seq;
          if (msg.ok) {
            pending.resolve(data);
          } else {
            const err = data as { code?: string; message?: string };
            const error = new Error(err.message ?? 'Request rejected');
            (error as any).code = err.code;
            pending.reject(error);
          }
          this.emit('response', { id: msg.id, ok: msg.ok, data });
        } catch {
          pending.reject(new Error('Decryption failed'));
        }
        break;
      }

      case 'evt': {
        if (this.remotePubKey && msg.from !== b64urlEncode(this.remotePubKey)) break;
        // Events MUST be sealed — drop unsealed events to prevent forgery.
        if (!msg.sealed || !this.recvKey) break;
        try {
          const evtHdr = { type: 'evt' as const, from: msg.from!, event: msg.event, id: (msg as any).id ?? '' };
          const { seq, data } = unsealPayload(this.recvKey, this.channelId, msg.sealed, evtHdr);
          if (seq <= this.recvSeq) break; // replay — silently drop
          this.recvSeq = seq;
          this.emit('event', { event: msg.event, data });
        } catch { /* drop events that fail decryption */ }
        break;
      }

      case 'ping':
        this.sendRaw({ v: 1, t: 'pong', ch: this.channelId, from: this.pubKeyB64, ts: Date.now() });
        break;

      case 'pong':
        break;

      case 'close':
        if (msg.reason === 'invalid_resume') {
          this.resumeToken = null;
          this.transport.disconnect();
          this.doReconnectAttempt(false);
        } else if (msg.reason === 'channel_exists') {
          this.startReconnect();
        } else if (this.phase !== 'disconnected') {
          this.setPhase('closed');
          this.intentionalClose = true;
        }
        break;
    }
  }

  private doAccept(): void {
    this.paired = true;
    this.approvedCapabilities = this.walletCapabilities;
    this.approvedWalletMeta = this.walletMeta;
    this.approvedScopeRecorded = true;
    const walletPubB64 = b64urlEncode(this.remotePubKey!);
    this.sendRaw({
      v: 1, t: 'accept', ch: this.channelId,
      from: this.pubKeyB64, target: walletPubB64,
    });
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
      walletMeta: walletMeta ?? null,
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
      this.remotePubKey !== null &&
      b64urlEncode(this.remotePubKey) === walletPubKeyB64 &&
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
      const msg: ProtocolMessage = {
        v: 1, t: 'create', ch: this.channelId,
        from: this.pubKeyB64, pubkey: this.pubKeyB64,
      };
      if (useResume && this.resumeToken) (msg as any).resume = this.resumeToken;
      this.sendRaw(msg);
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

  private setPhase(phase: DAppPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.emit('phase', phase);
  }
}
