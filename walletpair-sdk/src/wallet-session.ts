/**
 * Wallet-side WalletPair session.
 *
 * Manages: parse URI → join → pairing code → connected → handle requests → push events.
 */

import type {
  Transport,
  ProtocolMessage,
  WalletPhase,
  WalletSessionEvents,
  WalletSessionOptions,
  Capabilities,
  WalletMeta,
} from './types.js';
import {
  generateX25519KeyPair,
  parsePairingUri,
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

export class WalletSession extends Emitter<WalletSessionEvents> {
  phase: WalletPhase = 'idle';

  /** Channel ID (hex). Available after join. */
  channelId = '';
  /** 6-digit pairing code. Available after join. */
  pairingCode = '';

  private transport: Transport;
  private capabilities: Capabilities;
  private meta: WalletMeta | undefined;

  private privKey!: Uint8Array;
  private pubKeyB64 = '';
  private remotePubKey: Uint8Array | null = null;
  private sessionKey: Uint8Array | null = null;
  private sendSeq = 0;
  private recvSeq = -1;
  private resumeToken: string | null = null;
  private relayUrl = '';
  private intentionalClose = false;
  private evtCounter = 0;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;

  constructor(options: WalletSessionOptions) {
    super();
    this.transport = options.transport;
    this.capabilities = options.capabilities;
    this.meta = options.meta;

    this.transport.onMessage((msg) => this.handleMessage(msg));
    this.transport.onClose(() => this.handleTransportClose());
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Prepare to join a channel by parsing a pairing URI.
   * Computes session key and pairing code WITHOUT connecting or sending join.
   * The wallet UI should display the pairing code and ask the user to confirm
   * it matches the dApp's display. After user confirms, call `confirmJoin()`.
   */
  prepareJoin(uri: string): string {
    const parsed = parsePairingUri(uri);
    this.intentionalClose = false;
    this.channelId = parsed.ch;
    this.remotePubKey = b64urlDecode(parsed.pubkey);
    this.relayUrl = parsed.relay;
    this.sendSeq = 0;
    this.recvSeq = -1;

    const kp = generateX25519KeyPair();
    this.privKey = kp.privateKey;
    this.pubKeyB64 = kp.publicKeyB64;

    // Derive session key immediately (we have dApp pubkey from URI)
    const shared = computeSharedSecret(this.privKey, this.remotePubKey);
    this.sessionKey = deriveSessionKey(shared, this.channelId);

    this.pairingCode = computePairingCode(this.sessionKey, this.channelId);
    this.emit('pairingCode', this.pairingCode);

    return this.pairingCode;
  }

  /**
   * Confirm the pairing code and send the join message.
   * Call this after `prepareJoin()` when the user has confirmed the code.
   */
  async confirmJoin(): Promise<void> {
    if (!this.channelId || !this.sessionKey) {
      throw new Error('Must call prepareJoin() first');
    }

    // Update transport URL if WebSocket
    if ('setUrl' in this.transport && typeof (this.transport as any).setUrl === 'function') {
      (this.transport as any).setUrl(this.relayUrl);
    }

    await this.transport.connect();
    this.setPhase('waiting');
    this.sendJoin(false);
  }

  /**
   * Join a channel in one step (convenience method).
   * Equivalent to prepareJoin() + confirmJoin() without waiting for user
   * confirmation. Prefer prepareJoin() + confirmJoin() for better UX.
   */
  async joinFromUri(uri: string): Promise<string> {
    const code = this.prepareJoin(uri);
    await this.confirmJoin();
    return code;
  }

  /** Respond to a request with success. */
  approve(requestId: string, result: unknown): void {
    if (!this.sessionKey) return;
    const seq = this.sendSeq;
    this.sendSeq = (this.sendSeq + 1) >>> 0;
    if (this.sendSeq === 0) {
      this.emit('error', new Error('Send sequence overflow — session invalidated'));
      this.close();
      return;
    }
    const msg: ProtocolMessage = {
      v: 1, t: 'res', ch: this.channelId, id: requestId,
      from: this.pubKeyB64, ok: true,
    };
    const hdr = { type: 'res' as const, from: this.pubKeyB64, id: requestId, ok: true };
    (msg as any).sealed = sealPayload(this.sessionKey, this.channelId, seq, result, hdr);
    this.sendRaw(msg);
  }

  /** Respond to a request with rejection. */
  reject(requestId: string, code = 'user_rejected', message = 'User rejected the request'): void {
    if (!this.sessionKey) return;
    const seq = this.sendSeq;
    this.sendSeq = (this.sendSeq + 1) >>> 0;
    if (this.sendSeq === 0) {
      this.emit('error', new Error('Send sequence overflow — session invalidated'));
      this.close();
      return;
    }
    const error = { code, message };
    const msg: ProtocolMessage = {
      v: 1, t: 'res', ch: this.channelId, id: requestId,
      from: this.pubKeyB64, ok: false,
    };
    const hdr = { type: 'res' as const, from: this.pubKeyB64, id: requestId, ok: false };
    (msg as any).sealed = sealPayload(this.sessionKey, this.channelId, seq, error, hdr);
    this.sendRaw(msg);
  }

  /** Push an event to the dApp. */
  pushEvent(event: string, data: unknown): void {
    if (this.phase !== 'connected' || !this.sessionKey) return;
    const seq = this.sendSeq;
    this.sendSeq = (this.sendSeq + 1) >>> 0;
    if (this.sendSeq === 0) {
      this.emit('error', new Error('Send sequence overflow — session invalidated'));
      this.close();
      return;
    }
    const evtId = `evt-${++this.evtCounter}`;
    const msg: ProtocolMessage = {
      v: 1, t: 'evt', ch: this.channelId,
      id: evtId,
      from: this.pubKeyB64, event,
    };
    const hdr = { type: 'evt' as const, from: this.pubKeyB64, event, id: evtId };
    (msg as any).sealed = sealPayload(this.sessionKey, this.channelId, seq, data, hdr);
    this.sendRaw(msg);
  }

  /** Send ping. */
  ping(): void {
    if (this.phase !== 'connected') return;
    this.sendRaw({ v: 1, t: 'ping', ch: this.channelId, from: this.pubKeyB64, ts: Date.now() });
  }

  /** Gracefully close. */
  close(): void {
    this.intentionalClose = true;
    this.stopReconnect();
    if (this.channelId) {
      this.sendRaw({ v: 1, t: 'close', ch: this.channelId, from: this.pubKeyB64, reason: 'normal' });
    }
    this.transport.disconnect();
    this.setPhase('closed');
  }

  /** Destroy and release all resources. */
  destroy(): void {
    this.close();
    this.removeAll();
  }

  // -------------------------------------------------------------------------
  // State serialization
  // -------------------------------------------------------------------------

  serialize(): string {
    return JSON.stringify({
      channelId: this.channelId,
      privKey: bytesToHex(this.privKey),
      pubKeyB64: this.pubKeyB64,
      remotePubKeyB64: this.remotePubKey ? b64urlEncode(this.remotePubKey) : null,
      sessionKey: this.sessionKey ? bytesToHex(this.sessionKey) : null,
      sendSeq: this.sendSeq,
      recvSeq: this.recvSeq,
      resumeToken: this.resumeToken,
      relayUrl: this.relayUrl,
    });
  }

  restore(json: string): boolean {
    try {
      const d = JSON.parse(json);
      if (!d.channelId || !d.privKey || !d.sessionKey) return false;
      this.channelId = d.channelId;
      this.privKey = hexToBytes(d.privKey);
      this.pubKeyB64 = d.pubKeyB64;
      this.remotePubKey = d.remotePubKeyB64 ? b64urlDecode(d.remotePubKeyB64) : null;
      this.sessionKey = hexToBytes(d.sessionKey);
      this.sendSeq = d.sendSeq || 0;
      this.recvSeq = d.recvSeq ?? -1;
      this.resumeToken = d.resumeToken;
      this.relayUrl = d.relayUrl;
      return true;
    } catch { return false; }
  }

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

      case 'req': {
        let params: unknown = {};
        if (msg.sealed && this.sessionKey) {
          try {
            const reqHdr = { type: 'req' as const, from: msg.from!, id: msg.id, method: msg.method };
            const { seq, data } = unsealPayload(this.sessionKey, this.channelId, msg.sealed, reqHdr);
            if (seq <= this.recvSeq) break; // replay — silently drop
            this.recvSeq = seq;
            params = data;
          } catch { /* ignore decryption failure */ break; }
        }
        this.emit('request', { id: msg.id, method: msg.method, params });
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
        } else if (msg.reason === 'channel_not_found') {
          this.transport.disconnect();
          this.startReconnect();
        } else if (this.phase !== 'disconnected') {
          this.setPhase('closed');
          this.intentionalClose = true;
        }
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Internal: transport
  // -------------------------------------------------------------------------

  private sendRaw(msg: ProtocolMessage): void {
    this.transport.send(msg);
  }

  private sendJoin(useResume: boolean): void {
    const msg: ProtocolMessage = {
      v: 1, t: 'join', ch: this.channelId,
      from: this.pubKeyB64, pubkey: this.pubKeyB64,
      capabilities: this.capabilities,
      meta: this.meta,
    };
    if (useResume && this.resumeToken) (msg as any).resume = this.resumeToken;
    this.sendRaw(msg);
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
      this.setPhase('waiting');
      this.sendJoin(useResume);
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

  private setPhase(phase: WalletPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.emit('phase', phase);
  }
}
