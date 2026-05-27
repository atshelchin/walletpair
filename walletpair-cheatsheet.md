# WalletPair v1 Cheat Sheet

## Roles

```
DApp    — creates channel, sends req          (create, accept, req, ping/pong, close)
Wallet  — joins channel, handles req          (join, res, evt, ping/pong, close)
Adapter — relay/BLE, routes messages          (ready, terminate)
```

## Message Envelope

```json
{ "v": 1, "t": "<type>", "ch": "<64-hex>", "ts": <ms>, "from": "<pubkey|_adapter>", "body": {} }
```

## Pairing Flow (Happy Path)

```
DApp                      Relay                     Wallet
 │                          │                          │
 │── create ───────────────>│                          │
 │<── ready(waiting) ───────│                          │
 │                          │              scan QR, verify fingerprint
 │                          │<──────────────── join ───│
 │<── join (forwarded) ─────│── ready(waiting) ──────>│
 │                          │                          │
 │   decrypt sealed_join    │                          │
 │   verify capabilities    │                          │
 │── accept ───────────────>│                          │
 │<── ready(connected) ─────│── ready(connected) ────>│
 │                          │                          │
 │══════════ encrypted req/res/evt from here ═════════│
```

## Pairing URI

```
walletpair:?ch=<hex64>&pubkey=<b64url>&relay=<wss://...>&name=<>&url=<>&icon=<https://...>
            &methods=<comma-list>  (optional)
            &chains=<comma-list>   (optional)
```

Primary delivery: **QR code** (mandatory). Deep link = convenience only + security warning.

## Encryption Pipeline

```
           X25519 ECDH
DApp priv + Wallet pub ──> shared_secret
                               │
                          HKDF(salt=ch)
                               │
                           root_key
                            /     \
              HKDF(salt=ch)        HKDF(salt=transcript_hash)
                   │                    /                  \
          join_encryption_key   dapp_to_wallet_key    wallet_to_dapp_key
          (encrypt sealed_join)  (encrypt req)         (encrypt res/evt)
```

**AEAD:** ChaCha20-Poly1305
**Nonce:** HMAC-SHA256(traffic_key, seq_bytes)[0:12]
**AAD:** channel_id_bytes || type_byte || lp(from) || lp(id)

## Session Fingerprint

```
SHA256("walletpair-v1-session-fingerprint" || ch_bytes || dapp_pub_bytes)[0:4]
  -> uint32 big-endian -> mod 10000 -> zero-pad to 4 digits
```

Both sides compute independently. User verifies match.

## Sealed Payload (inside `sealed` field, encrypted)

```
req:  { "_method": "<name>", ...params }
res:  { "_ok": true,  "_result": <value> }   or
      { "_ok": false, "code": "<code>", "message": "<text>" }
evt:  { "_event": "<name>", ...data }
```

## State Machine (Simplified)

```
DApp:    idle ─create─> waiting ─join─> pending ─accept─> connected ─── disconnected
                                                              │              │
                                                            close      create(same ch)
                                                              v              v
                                                           closed         waiting

Wallet:  idle ─join─> waiting_accept ─ready.connected─> connected ─── disconnected
                                                            │              │
                                                          close      join(sealed=null)
                                                            v              v
                                                         closed      waiting_accept
```

## Reconnect

- Same `ch`, same `from`, same traffic keys, same counters
- DApp: re-sends `create` | Wallet: re-sends `join` with `sealed_join: null`
- Relay treats it as fresh channel (stateless)
- Sequence counters **NEVER reset** — gaps are OK
- Backoff: 1s → 2s → 5s → 10s → 30s

## Key Limits

| What                      | Limit          |
|---------------------------|----------------|
| Message size              | 64 KB          |
| Pending requests          | 32             |
| Idempotency cache         | 1024 entries   |
| Cached response max       | 16 KB          |
| Broadcast tx hash cache   | 256 entries    |
| Seq counter max           | 2^31           |
| Session lifetime          | 24 hours (max) |
| Unpaired channel TTL      | 5 min          |

## Close Reasons

| Peer-sent                   | Adapter-sent        |
|-----------------------------|---------------------|
| normal                      | channel_not_found   |
| user_rejected               | channel_exists      |
| unsupported_capability      | already_connected   |
| unsupported_version         | invalid_state       |
| decryption_failed           | invalid_role        |
| invalid_state               | timeout             |
| timeout                     | rate_limited        |
| rate_limited                | payload_too_large   |
| payload_too_large           | protocol_error      |
| protocol_error              |                     |

## Key Erasure Order

```
shared_secret  ── erase after root_key derived
X25519 privkey ── erase after all keys derived
root_key       ── erase after join_key + traffic keys derived
join_enc_key   ── erase after sealed_join encrypt/decrypt
transcript     ── erase after traffic keys derived
traffic keys   ── erase on channel close
seq counters   ── erase on channel close
idem cache     ── zero on channel close
```

## Security At-a-Glance

| Threat              | Defense                                         |
|---------------------|-------------------------------------------------|
| Eavesdropping       | E2E encryption (X25519 + ChaCha20-Poly1305)     |
| MITM                | QR out-of-band key delivery + session fingerprint|
| Replay              | Monotonic sequence counter as nonce input        |
| Relay reads payload | All business data inside `sealed`                |
| Peer impersonation  | AEAD verification with direction-specific keys   |
| Channel hijack      | 256-bit random channel ID                        |
| Relay DoS           | Reconnect logic + session expiry                 |
