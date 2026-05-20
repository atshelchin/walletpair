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
  deriveDirectionalSessionKeys,
  deriveJoinEncryptionKey,
  computePairingCode,
  canonicalJson,
  sealPayload,
  unsealPayload,
  sealJoin,
  sha256Hex,
  b64urlEncode,
  b64urlDecode,
  bytesToHex,
  hexToBytes,
} from './crypto.js';
import type { SessionCryptoContext } from './crypto.js';
import { Emitter } from './emitter.js';

const BACKOFF = [1000, 2000, 5000, 10000, 30000];
const MAX_SEND_SEQ = 2 ** 31;
const DEFAULT_SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours (§16 rule 17)
const IDEMPOTENCY_CACHE_LIMIT = 1024;
const IDEMPOTENCY_RESPONSE_LIMIT_BYTES = 16 * 1024;

interface PendingRequestRecord {
  paramsHash: string;
  method: string;
}

interface CachedRequestResponse extends PendingRequestRecord {
  ok: boolean;
  data: unknown;
  tooLarge: boolean;
}

export class WalletSession extends Emitter<WalletSessionEvents> {
  phase: WalletPhase = 'idle';

  /** Channel ID (hex). Available after join. */
  channelId = '';
  /** 4-digit pairing code. Available after join. */
  pairingCode = '';

  private transport: Transport;
  private capabilities: Capabilities;
  private meta: WalletMeta | undefined;

  private privKey!: Uint8Array;
  private pubKeyB64 = '';
  private remotePubKey: Uint8Array | null = null;
  private sessionKey: Uint8Array | null = null;
  private sendKey: Uint8Array | null = null;
  private recvKey: Uint8Array | null = null;
  private sendSeq = 0;
  private recvSeq = -1;
  private resumeToken: string | null = null;
  private relayUrl = '';
  private dappName: string | undefined;
  private intentionalClose = false;
  private evtCounter = 0;
  /** dApp-declared method scope from pairing URI (§9.1 / §8.1). */
  private dappDeclaredMethods: string[] | undefined;
  /** dApp-declared chain scope from pairing URI (§9.1 / §8.1). */
  private dappDeclaredChains: string[] | undefined;
  /** Effective capabilities after scope intersection (§8.1). */
  private effectiveCapabilities!: Capabilities;
  /** Session TTL in ms (§16 rule 17). */
  private sessionTtl: number;
  private sessionTtlTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionStartTime: number | null = null;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private pendingRequestRecords = new Map<string, PendingRequestRecord>();
  private idempotencyCache = new Map<string, CachedRequestResponse>();
  private broadcastResponseCache = new Map<string, CachedRequestResponse>();

  constructor(options: WalletSessionOptions) {
    super();
    this.transport = options.transport;
    this.capabilities = options.capabilities;
    this.meta = options.meta;
    this.sessionTtl = options.sessionTtl ?? DEFAULT_SESSION_TTL;
    this.effectiveCapabilities = { ...options.capabilities };

    this.transport.onMessage((msg) => this.handleMessage(msg));
    this.transport.onClose(() => this.handleTransportClose());
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Prepare to join a channel by parsing a pairing URI.
   * Computes local keys and the pairing code without connecting.
   * The dApp can only display the same code after it receives this wallet's
   * join public key, so the user must compare both displays after join.
   */
  prepareJoin(uri: string): string {
    const parsed = parsePairingUri(uri);
    this.intentionalClose = false;
    this.channelId = parsed.ch;
    this.remotePubKey = b64urlDecode(parsed.pubkey);
    this.relayUrl = parsed.relay;
    this.dappName = parsed.name;
    this.dappDeclaredMethods = parsed.methods;
    this.dappDeclaredChains = parsed.chains;
    this.sendSeq = 0;
    this.recvSeq = -1;
    this.sendKey = null;
    this.recvKey = null;
    this.pendingRequestRecords.clear();
    this.idempotencyCache.clear();
    this.broadcastResponseCache.clear();

    // Compute effective capabilities via scope intersection (§8.1)
    this.effectiveCapabilities = this.computeScopeIntersection();

    const kp = generateX25519KeyPair();
    this.privKey = kp.privateKey;
    this.pubKeyB64 = kp.publicKeyB64;

    // Derive root and directional traffic keys immediately.
    const shared = computeSharedSecret(this.privKey, this.remotePubKey);
    const rootKey = deriveSessionKey(shared, this.channelId);
    // §20.7: erase shared_secret immediately after root_key derivation
    shared.fill(0);

    const context = this.sessionContext();
    const keys = deriveDirectionalSessionKeys(rootKey, this.channelId, context);
    this.sendKey = keys.walletToDappKey;
    this.recvKey = keys.dappToWalletKey;

    this.pairingCode = computePairingCode(rootKey, this.channelId, context);
    this.emit('pairingCode', this.pairingCode);

    // Always derive join encryption key for sealed_join before erasing rootKey
    this.sessionKey = deriveJoinEncryptionKey(rootKey, this.channelId);

    // §20.7: erase root_key after all derivations complete
    rootKey.fill(0);
    keys.rootKey.fill(0);
    keys.transcriptHash.fill(0);

    return this.pairingCode;
  }

  /**
   * Send the join message. The pairing code comparison happens after the dApp
   * receives this join and displays its locally computed code.
   */
  async confirmJoin(): Promise<void> {
    if (!this.channelId || !this.sendKey || !this.recvKey) {
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
   * Equivalent to prepareJoin() + confirmJoin().
   */
  async joinFromUri(uri: string): Promise<string> {
    const code = this.prepareJoin(uri);
    await this.confirmJoin();
    return code;
  }

  /** Respond to a request with success. */
  approve(requestId: string, result: unknown): void {
    if (this.sendResponse(requestId, true, result)) {
      this.cacheProcessedResponse(requestId, true, result);
    }
  }

  /** Respond to a request with rejection. */
  reject(requestId: string, code = 'user_rejected', message = 'User rejected the request'): void {
    const error = { code, message };
    if (this.sendResponse(requestId, false, error)) {
      this.cacheProcessedResponse(requestId, false, error);
    }
  }

  /** Push an event to the dApp. */
  pushEvent(event: string, data: unknown): void {
    if (this.phase !== 'connected' || !this.sendKey) return;
    const seq = this.nextSendSeq();
    if (seq == null) return;
    const evtId = `evt-${++this.evtCounter}`;
    // Privacy mode (§7.4): encrypt event name inside sealed payload
    const sealedData = { _event: event, ...(data && typeof data === 'object' ? data as Record<string, unknown> : { _data: data }) };
    const hdr = { type: 'evt' as const, from: this.pubKeyB64, id: evtId };
    const sealed = sealPayload(this.sendKey, this.channelId, seq, sealedData, hdr);
    this.sendRaw({
      v: 1, t: 'evt', ch: this.channelId,
      ts: Date.now(), from: this.pubKeyB64,
      body: { id: evtId, sealed },
    } as ProtocolMessage);
  }

  /** Send ping. */
  ping(): void {
    if (this.phase !== 'connected') return;
    this.sendRaw({ v: 1, t: 'ping', ch: this.channelId, ts: Date.now(), from: this.pubKeyB64, body: {} } as ProtocolMessage);
  }

  /** Gracefully close. */
  close(reason: string = 'normal'): void {
    this.intentionalClose = true;
    this.stopReconnect();
    this.clearSessionTtl();
    this.pendingRequestRecords.clear();
    this.idempotencyCache.clear();
    this.broadcastResponseCache.clear();
    if (this.channelId) {
      this.sendRaw({ v: 1, t: 'close', ch: this.channelId, ts: Date.now(), from: this.pubKeyB64, body: { reason } } as ProtocolMessage);
    }
    this.transport.disconnect();
    this.setPhase('closed');
  }

  /** Destroy and release all resources. */
  destroy(): void {
    this.close();
    this.removeAll();
    // Wipe sensitive key material (§20.7)
    if (this.privKey) this.privKey.fill(0);
    if (this.sessionKey) this.sessionKey.fill(0);
    if (this.sendKey) this.sendKey.fill(0);
    if (this.recvKey) this.recvKey.fill(0);
    this.pendingRequestRecords.clear();
    this.idempotencyCache.clear();
    this.broadcastResponseCache.clear();
    this.sessionKey = null;
    this.sendKey = null;
    this.recvKey = null;
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
      sendKey: this.sendKey ? bytesToHex(this.sendKey) : null,
      recvKey: this.recvKey ? bytesToHex(this.recvKey) : null,
      sendSeq: this.sendSeq,
      recvSeq: this.recvSeq,
      resumeToken: this.resumeToken,
      relayUrl: this.relayUrl,
      capabilities: this.capabilities,
      meta: this.meta ?? null,
      dappName: this.dappName ?? null,
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
      if (!this.sendKey || !this.recvKey) return false;
      this.sendSeq = d.sendSeq || 0;
      this.recvSeq = d.recvSeq ?? -1;
      this.resumeToken = d.resumeToken;
      this.relayUrl = d.relayUrl;
      if ('capabilities' in d && canonicalJson(d.capabilities ?? null) !== canonicalJson(this.capabilities ?? null)) {
        return false;
      }
      if ('meta' in d && canonicalJson(d.meta ?? null) !== canonicalJson(this.meta ?? null)) {
        return false;
      }
      this.dappName = d.dappName ?? undefined;
      this.sessionStartTime = d.sessionStartTime ?? null;
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
      case 'ready': {
        const readyBody = msg.body as { state?: string; resume?: string | null; remote?: string | null };
        this.resumeToken = readyBody.resume ?? null;
        this.stopReconnect();
        if (readyBody.state === 'connected') {
          const expectedRemote = this.remotePubKey ? b64urlEncode(this.remotePubKey) : null;
          if (!expectedRemote || readyBody.remote !== expectedRemote) {
            this.emit('error', new Error('Connected remote does not match paired dApp'));
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

      case 'req': {
        const reqBody = msg.body as { id?: string; sealed?: string };
        if (this.remotePubKey && msg.from !== b64urlEncode(this.remotePubKey)) break;
        // All requests MUST be sealed — reject unsealed requests to prevent
        // method injection by a malicious relay.
        if (!reqBody.sealed || !reqBody.id || !this.recvKey) {
          if (reqBody.id) this.reject(reqBody.id, 'decryption_failed', 'Request must be encrypted');
          break;
        }
        try {
          // AAD: no method field — real method is inside sealed payload
          const reqHdr = { type: 'req' as const, from: msg.from, id: reqBody.id };
          const { seq, data, plaintext } = unsealPayload(this.recvKey, this.channelId, reqBody.sealed, reqHdr);
          if (seq <= this.recvSeq) break; // replay — silently drop
          this.recvSeq = seq;

          // Extract _method from decrypted payload
          if (!data || typeof data !== 'object' || typeof (data as any)._method !== 'string' || (data as any)._method.length === 0) {
            this.reject(reqBody.id, 'invalid_params', 'Request payload missing _method');
            break;
          }
          const method = (data as any)._method;
          const { _method: _, ...rest } = data as Record<string, unknown>;
          const params: unknown = rest;
          const paramsHash = sha256Hex(plaintext);

          const cachedBroadcast = this.broadcastResponseCache.get(reqBody.id);
          if (cachedBroadcast) {
            if (cachedBroadcast.paramsHash !== paramsHash) {
              this.reject(reqBody.id, 'invalid_params', 'Duplicate request ID with different params');
              break;
            }
            this.sendResponse(reqBody.id, cachedBroadcast.ok, cachedBroadcast.data);
            break;
          }

          const cached = this.idempotencyCache.get(reqBody.id);
          if (cached) {
            if (cached.paramsHash !== paramsHash) {
              this.reject(reqBody.id, 'invalid_params', 'Duplicate request ID with different params');
              break;
            }
            this.touchIdempotencyEntry(reqBody.id, cached);
            if (!cached.tooLarge) {
              this.sendResponse(reqBody.id, cached.ok, cached.data);
              break;
            }
          }

          const pending = this.pendingRequestRecords.get(reqBody.id);
          if (pending) {
            if (pending.paramsHash !== paramsHash) {
              this.reject(reqBody.id, 'invalid_params', 'Duplicate request ID with different params');
            }
            break;
          }

          this.pendingRequestRecords.set(reqBody.id, { paramsHash, method });

          this.emit('request', { id: reqBody.id, method, params });
        } catch {
          this.reject(reqBody.id, 'decryption_failed', 'Failed to decrypt request');
        }
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
        } else if (closeBody.reason === 'channel_not_found') {
          this.transport.disconnect();
          this.startReconnect();
        } else if (this.phase !== 'disconnected') {
          this.pendingRequestRecords.clear();
          this.idempotencyCache.clear();
          this.broadcastResponseCache.clear();
          this.setPhase('closed');
          this.intentionalClose = true;
        }
        break;
      }

      case 'terminate': {
        // Adapter-sent termination — treat like close
        if (this.phase !== 'disconnected') {
          this.pendingRequestRecords.clear();
          this.idempotencyCache.clear();
          this.broadcastResponseCache.clear();
          this.setPhase('closed');
          this.intentionalClose = true;
        }
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internal: responses and request idempotency
  // -------------------------------------------------------------------------

  private sendResponse(requestId: string, ok: boolean, data: unknown): boolean {
    if (!this.sendKey) return false;
    const seq = this.nextSendSeq();
    if (seq == null) return false;
    const hdr = { type: 'res' as const, from: this.pubKeyB64, id: requestId, ok };
    const sealed = sealPayload(this.sendKey, this.channelId, seq, data, hdr);
    this.sendRaw({
      v: 1, t: 'res', ch: this.channelId,
      ts: Date.now(), from: this.pubKeyB64,
      body: { id: requestId, ok, sealed },
    } as ProtocolMessage);
    return true;
  }

  private cacheProcessedResponse(requestId: string, ok: boolean, data: unknown): void {
    const pending = this.pendingRequestRecords.get(requestId);
    if (!pending) return;
    this.pendingRequestRecords.delete(requestId);

    const serialized = JSON.stringify(data ?? null);
    const tooLarge = new TextEncoder().encode(serialized).length > IDEMPOTENCY_RESPONSE_LIMIT_BYTES;
    const entry: CachedRequestResponse = {
      ...pending,
      ok,
      data: tooLarge ? null : data,
      tooLarge,
    };

    this.idempotencyCache.set(requestId, entry);
    this.evictIdempotencyCache();

    if (pending.method === 'wallet_sendTransaction' && ok) {
      this.broadcastResponseCache.set(requestId, {
        ...pending,
        ok,
        data,
        tooLarge: false,
      });
    }
  }

  private touchIdempotencyEntry(requestId: string, entry: CachedRequestResponse): void {
    this.idempotencyCache.delete(requestId);
    this.idempotencyCache.set(requestId, entry);
  }

  private evictIdempotencyCache(): void {
    while (this.idempotencyCache.size > IDEMPOTENCY_CACHE_LIMIT) {
      const oldest = this.idempotencyCache.keys().next().value as string | undefined;
      if (!oldest) return;
      this.idempotencyCache.delete(oldest);
    }
  }

  // -------------------------------------------------------------------------
  // Internal: transport
  // -------------------------------------------------------------------------

  private sendRaw(msg: ProtocolMessage): void {
    this.transport.send(msg);
  }

  private sendJoin(useResume: boolean): void {
    const body: Record<string, unknown> = {
      sealed_join: null,
      resume: useResume ? this.resumeToken : null,
    };
    if (!useResume && this.sessionKey) {
      body.sealed_join = sealJoin(this.sessionKey, this.channelId, this.effectiveCapabilities, this.meta);
      // §20.7: erase join_encryption_key after one-shot use
      this.sessionKey.fill(0);
      this.sessionKey = null;
    }
    this.sendRaw({
      v: 1, t: 'join', ch: this.channelId,
      ts: Date.now(), from: this.pubKeyB64,
      body,
    } as ProtocolMessage);
  }

  private sessionContext(): SessionCryptoContext {
    return {
      dappPubKeyB64: this.remotePubKey ? b64urlEncode(this.remotePubKey) : '',
      walletPubKeyB64: this.pubKeyB64,
      capabilities: this.effectiveCapabilities,
      walletMeta: this.meta ?? {},
      dappName: this.dappName,
    };
  }

  /**
   * Compute the intersection of wallet capabilities with dApp-declared
   * scope from the pairing URI (§8.1).
   */
  private computeScopeIntersection(): Capabilities {
    const base = this.capabilities;
    let methods = base.methods;
    let chains = base.chains;

    if (this.dappDeclaredMethods?.length) {
      const allowed = new Set(this.dappDeclaredMethods);
      methods = base.methods.filter((m) => allowed.has(m));
    }
    if (this.dappDeclaredChains?.length) {
      const allowed = new Set(this.dappDeclaredChains);
      chains = base.chains.filter((c) => allowed.has(c));
    }

    const result: Capabilities = { methods, events: base.events, chains };
    if (base.version != null) result.version = base.version;
    return result;
  }

  private nextSendSeq(): number | null {
    if (this.sendSeq >= MAX_SEND_SEQ) {
      const error = new Error('Send sequence overflow/limit reached — session invalidated');
      this.emit('error', error);
      this.close();
      return null;
    }
    return this.sendSeq++;
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

  private setPhase(phase: WalletPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.emit('phase', phase);
  }
}
