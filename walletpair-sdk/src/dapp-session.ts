/**
 * DApp-side WalletPair session.
 *
 * Manages the full lifecycle: create channel → QR → wallet joins → accept →
 * encrypted request/response + events.
 */

import type { SessionCryptoContext } from './crypto.js'
import {
  b64urlDecode,
  b64urlEncode,
  buildPairingUri,
  bytesToHex,
  canonicalJson,
  computeSessionFingerprint,
  computeSharedSecret,
  deriveDirectionalSessionKeys,
  deriveJoinEncryptionKey,
  deriveSessionKey,
  generateChannelId,
  generateX25519KeyPair,
  hexToBytes,
  sealPayload,
  signSnapshot,
  unsealJoin,
  unsealPayload,
  verifySnapshot,
} from './crypto.js'
import { Emitter } from './emitter.js'
import type {
  Capabilities,
  DAppMeta,
  DAppPhase,
  DAppSessionEvents,
  DAppSessionOptions,
  PendingRequest,
  ProtocolMessage,
  SessionPersistence,
  Transport,
  WalletMeta,
} from './types.js'

const BACKOFF = [1000, 2000, 5000, 10000, 30000]
const DEFAULT_REQUEST_TIMEOUT = 120_000
const PENDING_ACCEPT_TIMEOUT = 60_000
const MAX_SEND_SEQ = 2 ** 31
const MAX_PENDING_REQUESTS = 32 // §15 rule 11
const MAX_MESSAGE_BYTES = 65536 // §15 rule 10: 64 KB
const DEFAULT_SESSION_TTL = 24 * 60 * 60 * 1000 // 24 hours (§16 rule 16)

function isPromiseLike<T = unknown>(value: unknown): value is Promise<T> {
  return !!value && typeof (value as Promise<T>).then === 'function'
}

function validateCapabilities(cap: unknown): cap is Capabilities {
  if (cap == null || typeof cap !== 'object') return false
  const c = cap as Record<string, unknown>
  return Array.isArray(c.methods) && Array.isArray(c.events) && Array.isArray(c.chains)
}

export class DAppSession extends Emitter<DAppSessionEvents> {
  phase: DAppPhase = 'idle'

  /** Channel ID (hex). Available after createPairing(). */
  channelId = ''
  /** Pairing URI. Available after createPairing(). */
  pairingUri = ''
  /** 4-digit session fingerprint. Available after createPairing(). */
  sessionFingerprint = ''
  /** Remote wallet capabilities. Available after wallet joins. */
  walletCapabilities: Capabilities | undefined = undefined
  /** Remote wallet metadata. Available after wallet joins. */
  walletMeta: WalletMeta | undefined = undefined
  private approvedCapabilities: Capabilities | undefined = undefined
  private approvedWalletMeta: WalletMeta | undefined = undefined
  private approvedWalletPubKeyB64: string | undefined = undefined
  private approvedScopeRecorded = false

  private transport: Transport
  private meta: DAppMeta
  private declaredMethods: string[] | undefined
  private declaredChains: string[] | undefined
  private requestTimeout: number
  private autoAccept: boolean
  /** Session lifetime in ms (§16 rule 16). */
  private sessionTtl: number
  private sessionTtlTimer: ReturnType<typeof setTimeout> | null = null
  private sessionStartTime: number | null = null

  private privKey!: Uint8Array
  private pubKeyB64 = ''
  private remotePubKey: Uint8Array | null = null
  private sessionKey: Uint8Array | null = null
  private sendKey: Uint8Array | null = null
  private recvKey: Uint8Array | null = null
  private sendSeq = 0
  private recvSeq = -1
  private paired = false
  private intentionalClose = false
  private reqCounter = 0
  private pendingRequests = new Map<string, PendingRequest>()
  private persistence: SessionPersistence | undefined

  private pendingAcceptTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0

  constructor(options: DAppSessionOptions) {
    super()
    this.transport = options.transport
    this.meta = options.meta
    this.declaredMethods = options.methods
    this.declaredChains = options.chains
    this.requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT
    this.autoAccept = options.autoAccept ?? true
    this.sessionTtl = options.sessionTtl ?? DEFAULT_SESSION_TTL
    this.persistence = options.persistence

    this.transport.onMessage((msg) => this.handleMessage(msg))
    this.transport.onClose(() => this.handleTransportClose())
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
    this.intentionalClose = false
    const kp = generateX25519KeyPair()
    this.privKey = kp.privateKey
    this.pubKeyB64 = kp.publicKeyB64
    this.channelId = generateChannelId()
    this.sendSeq = 0
    this.recvSeq = -1
    this.remotePubKey = null
    this.sessionKey = null
    this.sendKey = null
    this.recvKey = null
    this.sessionStartTime = null
    this.clearSessionTtl()
    this.approvedCapabilities = undefined
    this.approvedWalletMeta = undefined
    this.approvedWalletPubKeyB64 = undefined
    this.approvedScopeRecorded = false
    this.reqCounter = 0
    this.paired = false
    // Build pairing URI first (before transport connect, so BLE can show QR first)
    let relayUrl: string | undefined
    const transportWithUrl = this.transport as Transport & { url?: unknown }
    if (typeof transportWithUrl.url === 'string') {
      relayUrl = transportWithUrl.url
    }
    this.pairingUri = buildPairingUri({
      channelId: this.channelId,
      pubkeyB64: this.pubKeyB64,
      relayUrl,
      name: this.meta.name,
      url: this.meta.url,
      icon: this.meta.icon,
      methods: this.declaredMethods,
      chains: this.declaredChains,
    })
    this.sessionFingerprint = computeSessionFingerprint(this.channelId, this.pubKeyB64)
    this.emit('pairingUri', this.pairingUri)
    this.emit('sessionFingerprint', this.sessionFingerprint)

    if (!options?.deferTransport) {
      await this.connectTransport()
    } else {
      this.setPhase('waiting')
    }

    return this.pairingUri
  }

  /**
   * Connect the transport and send the `create` message.
   * Call this after `createPairing({ deferTransport: true })` when the user
   * is ready (e.g. after showing QR and before BLE scan).
   */
  async connectTransport(): Promise<void> {
    this.setTransportChannelHint()
    await this.transport.connect()
    this.setPhase('waiting')
    this.sendRaw({
      v: 1,
      t: 'create',
      ch: this.channelId,
      ts: Date.now(),
      from: this.pubKeyB64,
      body: { meta: this.meta },
    } as ProtocolMessage)
  }

  /** Accept the wallet after sealed_join verification. */
  acceptWallet(): void {
    if (this.phase !== 'pending_accept' || !this.remotePubKey) return
    this.clearPendingAcceptTimer()
    this.doAccept()
  }

  /** Reject the wallet. */
  rejectWallet(): void {
    if (!this.remotePubKey) return
    this.sendRaw({
      v: 1,
      t: 'close',
      ch: this.channelId,
      ts: Date.now(),
      from: this.pubKeyB64,
      body: { reason: 'user_rejected' },
    } as ProtocolMessage)
    this.close()
  }

  /** Send an encrypted request to the wallet. Returns the decrypted response. */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.phase !== 'connected' || !this.sendKey) {
      return Promise.reject(new Error('Not connected'))
    }

    // §15 rule 11: max 32 pending requests
    if (this.pendingRequests.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error('Too many pending requests'))
    }

    const id = `req-${++this.reqCounter}`
    const sendKey = this.sendKey

    // Always seal: even parameterless requests must be authenticated via AEAD
    // to prevent method injection by a malicious relay.
    const send = (seq: number): Promise<T> => {
      // AAD: no method field — real method goes inside sealed payload
      const hdr = { type: 'req' as const, from: this.pubKeyB64, id }
      const sealedParams = {
        _method: method,
        ...(params && typeof params === 'object' && !Array.isArray(params)
          ? (params as Record<string, unknown>)
          : { _params: params ?? {} }),
      }
      const sealed = sealPayload(sendKey, this.channelId, seq, sealedParams, hdr)

      const msg: ProtocolMessage = {
        v: 1,
        t: 'req',
        ch: this.channelId,
        ts: Date.now(),
        from: this.pubKeyB64,
        body: { id, sealed },
      } as ProtocolMessage

      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingRequests.delete(id)
          reject(new Error(`Request ${method} timed out`))
        }, this.requestTimeout)

        this.pendingRequests.set(id, {
          id,
          method,
          resolve: resolve as (v: unknown) => void,
          reject,
          timer,
        })
        this.sendRaw(msg)
      })
    }

    try {
      const seqOrPromise = this.nextSendSeq()
      return isPromiseLike<number>(seqOrPromise) ? seqOrPromise.then(send) : send(seqOrPromise)
    } catch (error) {
      return Promise.reject(error as Error)
    }
  }

  /** Send ping. */
  ping(): void {
    if (this.phase !== 'connected') return
    this.sendRaw({
      v: 1,
      t: 'ping',
      ch: this.channelId,
      ts: Date.now(),
      from: this.pubKeyB64,
      body: {},
    } as ProtocolMessage)
  }

  /** Gracefully close the session. */
  close(reason: string = 'normal'): void {
    this.intentionalClose = true
    this.clearPendingAcceptTimer()
    this.clearSessionTtl()
    this.stopReconnect()
    for (const [, req] of this.pendingRequests) {
      if (req.timer) clearTimeout(req.timer)
      req.reject(new Error('Session closed'))
    }
    this.pendingRequests.clear()
    if (this.channelId) {
      this.sendRaw({
        v: 1,
        t: 'close',
        ch: this.channelId,
        ts: Date.now(),
        from: this.pubKeyB64,
        body: { reason },
      } as ProtocolMessage)
    }
    this.clearPersistence()
    this.transport.disconnect()
    this.setPhase('closed')
  }

  /** Destroy the session and release all resources. */
  destroy(): void {
    this.close()
    this.removeAll()
    // Wipe sensitive key material (§20.7)
    if (this.privKey) this.privKey.fill(0)
    if (this.sessionKey) this.sessionKey.fill(0)
    if (this.sendKey) this.sendKey.fill(0)
    if (this.recvKey) this.recvKey.fill(0)
    this.sessionKey = null
    this.sendKey = null
    this.recvKey = null
  }

  // -------------------------------------------------------------------------
  // State serialization (for persistence across page reloads)
  // -------------------------------------------------------------------------

  serialize(): string {
    const json = JSON.stringify({
      channelId: this.channelId,
      privKey: bytesToHex(this.privKey),
      pubKeyB64: this.pubKeyB64,
      remotePubKeyB64: this.remotePubKey ? b64urlEncode(this.remotePubKey) : null,
      sendKey: this.sendKey ? bytesToHex(this.sendKey) : null,
      recvKey: this.recvKey ? bytesToHex(this.recvKey) : null,
      sendSeq: this.sendSeq,
      recvSeq: this.recvSeq,
      reqCounter: this.reqCounter,
      paired: this.paired,
      dappMeta: this.meta,
      approvedScopeRecorded: this.approvedScopeRecorded,
      approvedCapabilities: this.approvedCapabilities ?? null,
      approvedWalletMeta: this.approvedWalletMeta ?? null,
      approvedWalletPubKeyB64: this.approvedWalletPubKeyB64 ?? null,
      sessionStartTime: this.sessionStartTime,
    })
    // HMAC-sign the snapshot so tampered storage (e.g. via XSS) is detected on restore
    return this.sendKey ? signSnapshot(this.sendKey, json) : json
  }

  async restoreFromPersistence(): Promise<boolean> {
    if (!this.persistence?.load) return false
    const json = await this.persistence.load()
    return json ? this.restore(json) : false
  }

  restore(signed: string): boolean {
    try {
      // Try HMAC-verified format first: "<hex-mac>.<json>"
      // Fall back to plain JSON for backward compatibility with unsigned snapshots
      let json: string
      if (signed.length > 65 && signed[64] === '.') {
        // Extract sendKey from the JSON to verify HMAC
        const candidateJson = signed.slice(65)
        const d0 = JSON.parse(candidateJson)
        if (!d0.sendKey) return false
        const sendKey = hexToBytes(d0.sendKey)
        const verified = verifySnapshot(sendKey, signed)
        if (!verified) return false // tampered
        json = verified
      } else {
        json = signed
      }

      const d = JSON.parse(json)
      if (!d.channelId || !d.privKey) return false
      this.channelId = d.channelId
      this.privKey = hexToBytes(d.privKey)
      this.pubKeyB64 = d.pubKeyB64
      this.remotePubKey = d.remotePubKeyB64 ? b64urlDecode(d.remotePubKeyB64) : null
      this.sendKey = d.sendKey ? hexToBytes(d.sendKey) : null
      this.recvKey = d.recvKey ? hexToBytes(d.recvKey) : null
      if (!this.sendKey || !this.recvKey) return false
      this.sendSeq = d.sendSeq ?? 0
      this.recvSeq = d.recvSeq ?? -1
      this.reqCounter = d.reqCounter || 0
      this.paired = d.paired || false
      this.approvedScopeRecorded = d.approvedScopeRecorded === true
      this.approvedCapabilities = d.approvedCapabilities ?? undefined
      this.approvedWalletMeta = d.approvedWalletMeta ?? undefined
      this.approvedWalletPubKeyB64 = d.approvedWalletPubKeyB64 ?? d.remotePubKeyB64 ?? undefined
      this.walletCapabilities = this.approvedCapabilities
      this.walletMeta = this.approvedWalletMeta
      this.meta =
        d.dappMeta ??
        (d.dappName ? { name: d.dappName, description: '', url: '', icon: '' } : this.meta)
      this.sessionStartTime = d.sessionStartTime ?? null
      this.setPhase('connected')
      return true
    } catch {
      return false
    }
  }

  /** Reconnect after restoring state. */
  async reconnect(): Promise<void> {
    this.intentionalClose = false
    this.stopReconnect()
    this.setPhase('disconnected')
    this.reconnectAttempt = 0
    await this.doReconnectAttempt()
  }

  // -------------------------------------------------------------------------
  // Internal: message handling
  // -------------------------------------------------------------------------

  private handleMessage(msg: ProtocolMessage): void {
    // §2: Peers MUST reject any peer-sent message where from equals "_adapter"
    if (msg.t !== 'ready' && msg.t !== 'terminate' && msg.from === '_adapter') {
      this.emit('error', new Error('Rejected message with spoofed _adapter from'))
      return
    }

    // §15 rule 12: reject unsupported protocol version
    if (msg.v !== 1) {
      this.close('unsupported_version')
      return
    }

    switch (msg.t) {
      case 'ready': {
        const readyBody = msg.body as {
          state?: string
          reconnect?: boolean
          remote?: string | null
        }
        this.stopReconnect()
        if (readyBody.state === 'connected') {
          const expectedRemote = this.remotePubKey ? b64urlEncode(this.remotePubKey) : null
          if (!expectedRemote || readyBody.remote !== expectedRemote) {
            this.emit('error', new Error('Connected remote does not match paired wallet'))
            this.close()
            break
          }
        }
        if (readyBody.state === 'waiting') {
          this.setPhase('waiting')
        } else if (readyBody.state === 'connected') {
          this.setPhase('connected')
          this.startSessionTtl()
          this.persistSnapshotAsync()
        }
        break
      }

      case 'join': {
        const joinBody = msg.body as { sealed_join?: string | null }
        const joinPubKey = msg.from
        if (!joinPubKey) {
          this.emit('error', new Error('Malformed wallet join: missing from'))
          break
        }
        let remoteBytes: Uint8Array
        try {
          remoteBytes = b64urlDecode(joinPubKey)
          if (remoteBytes.length !== 32) throw new Error('Invalid wallet public key length')
        } catch {
          this.sendRaw({
            v: 1,
            t: 'close',
            ch: this.channelId,
            ts: Date.now(),
            from: this.pubKeyB64,
            body: { reason: 'protocol_error' },
          } as ProtocolMessage)
          this.emit('error', new Error('Malformed wallet public key'))
          break
        }

        this.remotePubKey = remoteBytes
        const shared = computeSharedSecret(this.privKey, this.remotePubKey)
        const rootKey = deriveSessionKey(shared, this.channelId)
        // §20.7: erase shared_secret immediately
        shared.fill(0)

        // For reconnect (sealed_join is null), skip sealed_join decryption
        let joinCapabilities: Capabilities | undefined
        let joinMeta: WalletMeta | undefined
        if (joinBody.sealed_join === null && this.paired) {
          // Reconnect — capabilities/meta come from previously approved scope
          joinCapabilities = this.approvedCapabilities
          joinMeta = this.approvedWalletMeta
        } else if (joinBody.sealed_join && typeof joinBody.sealed_join === 'string') {
          // Decrypt sealed_join (private handshake §7.5)
          let joinKey: Uint8Array | null = null
          try {
            joinKey = deriveJoinEncryptionKey(rootKey, this.channelId)
            const decrypted = unsealJoin(joinKey, this.channelId, joinBody.sealed_join)
            joinCapabilities = decrypted.capabilities as Capabilities | undefined
            joinMeta = decrypted.meta as WalletMeta | undefined
          } catch {
            this.sendRaw({
              v: 1,
              t: 'close',
              ch: this.channelId,
              ts: Date.now(),
              from: this.pubKeyB64,
              body: { reason: 'decryption_failed' },
            } as ProtocolMessage)
            this.emit('error', new Error('Failed to decrypt sealed_join'))
            rootKey.fill(0)
            break
          } finally {
            // §20.7: erase join_encryption_key after one-shot use.
            if (joinKey) joinKey.fill(0)
          }
        } else {
          this.sendRaw({
            v: 1,
            t: 'close',
            ch: this.channelId,
            ts: Date.now(),
            from: this.pubKeyB64,
            body: { reason: 'protocol_error' },
          } as ProtocolMessage)
          this.emit('error', new Error('Initial wallet join missing sealed_join'))
          rootKey.fill(0)
          break
        }

        // Validate capabilities shape
        if (joinCapabilities != null && !validateCapabilities(joinCapabilities)) {
          this.sendRaw({
            v: 1,
            t: 'close',
            ch: this.channelId,
            ts: Date.now(),
            from: this.pubKeyB64,
            body: { reason: 'protocol_error' },
          } as ProtocolMessage)
          this.emit('error', new Error('Malformed wallet capabilities'))
          rootKey.fill(0)
          break
        }

        // Warn if wallet omits any of the 5 MUST-support methods (backwards-compatible)
        if (joinCapabilities) {
          const requiredMethods = [
            'wallet_getAccounts',
            'wallet_signTransaction',
            'wallet_signMessage',
            'wallet_signTypedData',
            'wallet_switchChain',
          ]
          const declared = new Set(joinCapabilities.methods)
          const absent = requiredMethods.filter((m) => !declared.has(m))
          if (absent.length > 0) {
            console.warn(`[WalletPair] Wallet missing MUST-support methods: ${absent.join(', ')}`)
          }
        }

        const knownWallet = this.isSameApprovedWallet(joinPubKey, joinCapabilities, joinMeta)
        this.walletCapabilities = joinCapabilities
        this.walletMeta = joinMeta
        const context = this.sessionContext(joinPubKey, joinCapabilities, joinMeta)
        const keys = deriveDirectionalSessionKeys(rootKey, this.channelId, context)
        this.sendKey = keys.dappToWalletKey
        this.recvKey = keys.walletToDappKey

        // §20.7: erase root_key and transcript_hash after all derivations
        rootKey.fill(0)
        keys.rootKey.fill(0)
        keys.transcriptHash.fill(0)

        // §7.1 DApp-side scope enforcement: check granted capabilities
        if (joinCapabilities && this.declaredMethods?.length) {
          const granted = new Set(joinCapabilities.methods)
          const missing = this.declaredMethods.filter((m) => !granted.has(m))
          if (missing.length > 0) {
            this.sendRaw({
              v: 1,
              t: 'close',
              ch: this.channelId,
              ts: Date.now(),
              from: this.pubKeyB64,
              body: { reason: 'unsupported_capability' },
            } as ProtocolMessage)
            this.emit('error', new Error(`Wallet missing required methods: ${missing.join(', ')}`))
            break
          }
        }
        if (joinCapabilities && this.declaredChains?.length) {
          const granted = new Set(joinCapabilities.chains)
          const missing = this.declaredChains.filter((c) => !granted.has(c))
          if (missing.length > 0) {
            this.sendRaw({
              v: 1,
              t: 'close',
              ch: this.channelId,
              ts: Date.now(),
              from: this.pubKeyB64,
              body: { reason: 'unsupported_capability' },
            } as ProtocolMessage)
            this.emit('error', new Error(`Wallet missing required chains: ${missing.join(', ')}`))
            break
          }
        }

        this.emit('walletJoined', {
          capabilities: joinCapabilities,
          meta: joinMeta,
        })

        this.setPhase('pending_accept')

        // Auto-accept for known wallets on reconnect, or when autoAccept is enabled
        if (this.autoAccept || knownWallet) {
          this.doAccept()
        } else {
          // Application must call acceptWallet() or rejectWallet()
          this.pendingAcceptTimer = setTimeout(() => {
            this.emit('error', new Error('Pending accept timed out'))
            this.close('timeout')
          }, PENDING_ACCEPT_TIMEOUT)
        }
        break
      }

      case 'res': {
        if (this.phase !== 'connected') break
        const resBody = msg.body as { id?: string; sealed?: string }
        if (this.remotePubKey && msg.from !== b64urlEncode(this.remotePubKey)) break
        if (!resBody.id) break
        const responseId = resBody.id
        const pending = this.pendingRequests.get(responseId)
        if (!pending) break
        this.pendingRequests.delete(responseId)
        if (pending.timer) clearTimeout(pending.timer)

        // All responses MUST be sealed — reject unsealed to prevent forgery.
        if (!resBody.sealed || !this.recvKey) {
          pending.reject(new Error('Response must be encrypted'))
          break
        }

        try {
          const resHdr = { type: 'res' as const, from: msg.from, id: responseId }
          const { seq, data } = unsealPayload(this.recvKey, this.channelId, resBody.sealed, resHdr)
          if (seq <= this.recvSeq) {
            pending.reject(new Error('Replay detected'))
            break
          }
          const prevRecvSeq = this.recvSeq
          this.recvSeq = seq
          const afterPersist = () => {
            // Per protocol §5.3: _ok is inside the decrypted sealed payload
            const envelope = data as {
              _ok?: boolean
              _result?: unknown
              code?: string
              message?: string
            }
            if (typeof envelope._ok !== 'boolean') {
              pending.reject(new Error('Response missing _ok field'))
              return
            }
            if (envelope._ok) {
              pending.resolve(envelope._result)
              this.emit('response', { id: responseId, ok: true, result: envelope._result })
            } else {
              const error = new Error(envelope.message ?? 'Request rejected')
              ;(error as any).code = envelope.code
              pending.reject(error)
              this.emit('response', {
                id: responseId,
                ok: false,
                result: { code: envelope.code, message: envelope.message },
              })
            }
          }
          const persisted = this.persistSnapshot()
          if (isPromiseLike(persisted)) {
            void persisted.then(afterPersist).catch((e) => {
              this.recvSeq = prevRecvSeq // rollback on persist failure
              pending.reject(this.persistenceError(e))
            })
          } else {
            afterPersist()
          }
        } catch {
          pending.reject(new Error('Decryption failed'))
        }
        break
      }

      case 'evt': {
        if (this.phase !== 'connected') break
        const evtBody = msg.body as { id?: string; sealed?: string }
        if (this.remotePubKey && msg.from !== b64urlEncode(this.remotePubKey)) break
        // Events MUST be sealed — drop unsealed events to prevent forgery.
        if (!evtBody.sealed || !evtBody.id || !this.recvKey) break
        try {
          const evtHdr = { type: 'evt' as const, from: msg.from, id: evtBody.id }
          const { seq, data } = unsealPayload(this.recvKey, this.channelId, evtBody.sealed, evtHdr)
          if (seq <= this.recvSeq) break // replay — silently drop
          const prevRecvSeqEvt = this.recvSeq
          this.recvSeq = seq

          const afterPersist = () => {
            // Privacy mode (§7.4): real event name is inside the encrypted payload
            let event: string | undefined
            let eventData: unknown = data
            if (data && typeof data === 'object' && '_event' in (data as any)) {
              event = (data as any)._event
              const { _event: _, ...rest } = data as Record<string, unknown>
              eventData = Object.keys(rest).length === 1 && '_data' in rest ? rest._data : rest
            }

            if (event) {
              this.emit('event', { event, data: eventData })
            } else {
              this.emit('error', new Error('Event payload missing _event'))
            }
          }
          const persisted = this.persistSnapshot()
          if (isPromiseLike(persisted)) {
            void persisted.then(afterPersist).catch((e) => {
              this.recvSeq = prevRecvSeqEvt // rollback on persist failure
              this.emit('error', this.persistenceError(e))
            })
          } else {
            afterPersist()
          }
        } catch {
          /* drop events that fail decryption */
        }
        break
      }

      case 'ping':
        this.sendRaw({
          v: 1,
          t: 'pong',
          ch: this.channelId,
          ts: Date.now(),
          from: this.pubKeyB64,
          body: {},
        } as ProtocolMessage)
        break

      case 'pong':
        break

      case 'close': {
        if (this.phase !== 'disconnected') {
          this.clearPersistence()
          this.setPhase('closed')
          this.intentionalClose = true
        }
        break
      }

      case 'terminate': {
        const termBody = msg.body as { reason?: string }
        // Race condition: relay sends channel_exists when we re-create during reconnect
        if (termBody.reason === 'channel_exists' && this.phase === 'disconnected') {
          this.startReconnect()
          break
        }
        // Adapter-sent termination — treat like close
        if (this.phase !== 'disconnected') {
          this.clearPersistence()
          this.setPhase('closed')
          this.intentionalClose = true
        }
        break
      }
    }
  }

  private doAccept(): void {
    this.paired = true
    this.approvedCapabilities = this.walletCapabilities
    this.approvedWalletMeta = this.walletMeta
    this.approvedWalletPubKeyB64 = b64urlEncode(this.remotePubKey!)
    this.approvedScopeRecorded = true
    const walletPubB64 = b64urlEncode(this.remotePubKey!)
    const sendAccept = () => {
      this.sendRaw({
        v: 1,
        t: 'accept',
        ch: this.channelId,
        ts: Date.now(),
        from: this.pubKeyB64,
        body: { target: walletPubB64 },
      } as ProtocolMessage)
    }
    const persisted = this.persistSnapshot()
    if (isPromiseLike(persisted)) {
      void persisted.then(sendAccept).catch((e) => this.persistenceError(e))
    } else {
      sendAccept()
    }
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
      dappName: this.meta.name,
    }
  }

  private isSameApprovedWallet(
    walletPubKeyB64: string,
    capabilities?: Capabilities | undefined,
    walletMeta?: WalletMeta | undefined,
  ): boolean {
    return (
      this.paired &&
      this.approvedWalletPubKeyB64 === walletPubKeyB64 &&
      this.approvedScopeRecorded &&
      canonicalJson(this.approvedCapabilities) === canonicalJson(capabilities ?? null) &&
      canonicalJson(this.approvedWalletMeta ?? null) === canonicalJson(walletMeta ?? null)
    )
  }

  private nextSendSeq(): number | Promise<number> {
    if (this.sendSeq >= MAX_SEND_SEQ) {
      const error = new Error('Send sequence overflow/limit reached — session invalidated')
      this.emit('error', error)
      this.close()
      throw error
    }
    const seq = this.sendSeq
    this.sendSeq += 1
    const persisted = this.persistSnapshot()
    if (isPromiseLike(persisted)) {
      return persisted
        .then(() => seq)
        .catch((e) => {
          throw this.persistenceError(e)
        })
    }
    return seq
  }

  private persistSnapshot(): void | Promise<void> {
    if (!this.persistence) return
    return this.persistence.save(this.serialize())
  }

  private persistSnapshotAsync(): void {
    const persisted = this.persistSnapshot()
    if (isPromiseLike(persisted)) {
      void persisted.catch((e) => this.persistenceError(e))
    }
  }

  private clearPersistence(): void {
    if (!this.persistence?.clear) return
    const cleared = this.persistence.clear()
    if (isPromiseLike(cleared)) {
      void cleared.catch((e) => {
        const err = e instanceof Error ? e : new Error(String(e))
        this.emit('error', err)
      })
    }
  }

  private persistenceError(error: unknown): Error {
    const err = error instanceof Error ? error : new Error(String(error))
    const wrapped = new Error(`Session persistence failed: ${err.message}`)
    this.emit('error', wrapped)
    this.close('protocol_error')
    return wrapped
  }

  // -------------------------------------------------------------------------
  // Internal: transport
  // -------------------------------------------------------------------------

  /** Append ?ch= to transport URL for CF Worker relay routing. Rust relay ignores it. */
  private setTransportChannelHint(): void {
    const t = this.transport as { setUrl?: (url: string) => void; url?: string }
    if (typeof t.setUrl === 'function') {
      const base = (t as any).url ?? ''
      if (base && !base.includes('?ch=')) {
        const sep = base.includes('?') ? '&' : '?'
        t.setUrl(`${base}${sep}ch=${this.channelId}`)
      }
    }
  }

  private sendRaw(msg: ProtocolMessage): void {
    // §15 rule 10: max 64 KB on the wire
    const json = JSON.stringify(msg)
    if (new TextEncoder().encode(json).length > MAX_MESSAGE_BYTES) {
      this.emit('error', new Error('Message exceeds 64 KB limit'))
      return
    }
    this.transport.send(msg)
  }

  private handleTransportClose(): void {
    if (this.intentionalClose || this.phase === 'closed') return
    this.startReconnect()
  }

  // -------------------------------------------------------------------------
  // Internal: reconnect
  // -------------------------------------------------------------------------

  private startReconnect(): void {
    this.setPhase('disconnected')
    this.reconnectAttempt = 0
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose || this.phase === 'closed') return
    const base = BACKOFF[Math.min(this.reconnectAttempt, BACKOFF.length - 1)] ?? 1000
    const delay = base + Math.floor(Math.random() * base * 0.3) // ±30% jitter
    this.reconnectTimer = setTimeout(() => {
      this.doReconnectAttempt()
      this.reconnectAttempt++
    }, delay)
  }

  private async doReconnectAttempt(): Promise<void> {
    if (this.intentionalClose || this.phase === 'closed') return
    try {
      this.setTransportChannelHint()
      await this.transport.connect()
      this.sendRaw({
        v: 1,
        t: 'create',
        ch: this.channelId,
        ts: Date.now(),
        from: this.pubKeyB64,
        body: { meta: this.meta },
      } as ProtocolMessage)
    } catch {
      this.scheduleReconnect()
    }
  }

  private stopReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private clearPendingAcceptTimer(): void {
    if (this.pendingAcceptTimer) {
      clearTimeout(this.pendingAcceptTimer)
      this.pendingAcceptTimer = null
    }
  }

  // -------------------------------------------------------------------------
  // Internal: session TTL (§16 rule 16)
  // -------------------------------------------------------------------------

  private startSessionTtl(): void {
    this.clearSessionTtl()
    if (this.sessionStartTime == null) {
      this.sessionStartTime = Date.now()
    }
    const elapsed = Date.now() - this.sessionStartTime
    const remaining = Math.max(0, this.sessionTtl - elapsed)
    this.sessionTtlTimer = setTimeout(() => {
      this.emit('error', new Error('Session lifetime expired'))
      this.close('timeout')
    }, remaining)
  }

  private clearSessionTtl(): void {
    if (this.sessionTtlTimer) {
      clearTimeout(this.sessionTtlTimer)
      this.sessionTtlTimer = null
    }
  }

  private setPhase(phase: DAppPhase): void {
    if (this.phase === phase) return
    this.phase = phase
    this.emit('phase', phase)
  }
}
