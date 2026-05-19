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
  computePairingCode,
  sealPayload,
  unsealPayload,
  b64urlEncode,
  b64urlDecode,
  bytesToHex,
  hexToBytes,
} from './crypto.js';
import { Emitter } from './emitter.js';

const BACKOFF = [1000, 2000, 5000, 10000, 30000];
const DEFAULT_REQUEST_TIMEOUT = 120_000;

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

  private transport: Transport;
  private name: string | undefined;
  private requestTimeout: number;
  private autoAccept: boolean;

  private privKey!: Uint8Array;
  private pubKeyB64 = '';
  private remotePubKey: Uint8Array | null = null;
  private sessionKey: Uint8Array | null = null;
  private sendSeq = 0;
  private resumeToken: string | null = null;
  private paired = false;
  private intentionalClose = false;
  private reqCounter = 0;
  private pendingRequests = new Map<string, PendingRequest>();

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;

  constructor(options: DAppSessionOptions) {
    super();
    this.transport = options.transport;
    this.name = options.name;
    this.requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
    this.autoAccept = options.autoAccept ?? true;

    this.transport.onMessage((msg) => this.handleMessage(msg));
    this.transport.onClose(() => this.handleTransportClose());
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Create a new pairing channel and return the pairing URI for QR display. */
  async createPairing(): Promise<string> {
    this.intentionalClose = false;
    const kp = generateX25519KeyPair();
    this.privKey = kp.privateKey;
    this.pubKeyB64 = kp.publicKeyB64;
    this.channelId = generateChannelId();
    this.sendSeq = 0;
    this.remotePubKey = null;
    this.sessionKey = null;
    this.reqCounter = 0;
    this.paired = false;
    this.resumeToken = null;

    await this.transport.connect();
    this.setPhase('waiting');
    this.sendRaw({
      v: 1, t: 'create', ch: this.channelId,
      from: this.pubKeyB64, pubkey: this.pubKeyB64,
    });

    // Build pairing URI
    let relayUrl: string | undefined;
    if (this.transport.constructor.name === 'WebSocketTransport') {
      relayUrl = (this.transport as any).url as string | undefined;
    }
    this.pairingUri = buildPairingUri({
      channelId: this.channelId,
      pubkeyB64: this.pubKeyB64,
      relayUrl,
      name: this.name,
    });
    this.emit('pairingUri', this.pairingUri);
    return this.pairingUri;
  }

  /** Accept the wallet after pairing code verification. */
  acceptWallet(): void {
    if (this.phase !== 'pending_accept' || !this.remotePubKey) return;
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
    if (this.phase !== 'connected' || !this.sessionKey) {
      return Promise.reject(new Error('Not connected'));
    }

    const id = `req-${++this.reqCounter}`;
    const msg: ProtocolMessage = {
      v: 1, t: 'req', ch: this.channelId, id,
      from: this.pubKeyB64, method,
    };
    if (params !== undefined && params !== null) {
      (msg as any).sealed = sealPayload(this.sessionKey, this.channelId, this.sendSeq++, params);
    }

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
      sendSeq: this.sendSeq,
      resumeToken: this.resumeToken,
      reqCounter: this.reqCounter,
      paired: this.paired,
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
      this.sendSeq = d.sendSeq || 0;
      this.resumeToken = d.resumeToken;
      this.reqCounter = d.reqCounter || 0;
      this.paired = d.paired || false;
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
        if (msg.state === 'waiting') {
          this.setPhase('waiting');
        } else if (msg.state === 'connected') {
          this.setPhase('connected');
        }
        break;

      case 'join': {
        const joinPubKey = msg.from!;
        const remoteBytes = b64urlDecode(joinPubKey);
        const knownWallet = this.autoAccept && this.paired &&
          this.remotePubKey !== null &&
          b64urlEncode(this.remotePubKey) === joinPubKey;

        this.remotePubKey = remoteBytes;
        const shared = computeSharedSecret(this.privKey, this.remotePubKey);
        this.sessionKey = deriveSessionKey(shared, this.channelId);

        this.walletCapabilities = msg.capabilities;
        this.walletMeta = msg.meta;

        if (knownWallet) {
          this.doAccept();
        } else {
          this.pairingCode = computePairingCode(this.sessionKey, this.channelId);
          this.emit('pairingCode', this.pairingCode);
          this.emit('walletJoined', {
            pubkey: joinPubKey,
            capabilities: msg.capabilities,
            meta: msg.meta,
          });
          this.setPhase('pending_accept');
        }
        break;
      }

      case 'res': {
        const pending = this.pendingRequests.get(msg.id);
        if (!pending) break;
        this.pendingRequests.delete(msg.id);
        if (pending.timer) clearTimeout(pending.timer);

        if (msg.sealed && this.sessionKey) {
          try {
            const { data } = unsealPayload(this.sessionKey, this.channelId, msg.sealed);
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
        } else if (msg.ok) {
          pending.resolve(undefined);
          this.emit('response', { id: msg.id, ok: true, data: undefined });
        } else {
          pending.reject(new Error('Request rejected'));
          this.emit('response', { id: msg.id, ok: false, data: undefined });
        }
        break;
      }

      case 'evt': {
        if (msg.sealed && this.sessionKey) {
          try {
            const { data } = unsealPayload(this.sessionKey, this.channelId, msg.sealed);
            this.emit('event', { event: msg.event, data });
          } catch { /* ignore decryption failure on events */ }
        }
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
    const walletPubB64 = b64urlEncode(this.remotePubKey!);
    this.sendRaw({
      v: 1, t: 'accept', ch: this.channelId,
      from: this.pubKeyB64, target: walletPubB64,
    });
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
    const delay = BACKOFF[Math.min(this.reconnectAttempt, BACKOFF.length - 1)]!;
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

  private setPhase(phase: DAppPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.emit('phase', phase);
  }
}
