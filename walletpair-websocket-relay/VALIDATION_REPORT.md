# WalletPair WebSocket Relay — Validation Report

**Date:** 2026-05-19
**Validator:** Independent protocol/reliability/performance review
**Relay version:** 0.1.0 (commit 9394ebd)
**Protocol:** WalletPair Protocol v1

---

## 1. Verification Environment

| Item | Value |
|------|-------|
| OS | macOS Darwin 25.0.0 (arm64) |
| Rust | stable (edition 2021) |
| Build profile | release (for perf), debug (for tests) |
| Test runner | cargo test |
| Load test | custom tool (`tools/loadtest/`) |

## 2. Commands Executed

```
cargo fmt --check                                    # PASS
cargo clippy --all-targets --all-features -D warnings # PASS (after 1 unused-var fix)
cargo test --all-targets --all-features               # 101 tests PASS
```

Load tests:
```
walletpair-loadtest --channels 1000 --messages 10 --concurrency 100  # 0 errors
walletpair-loadtest --channels 10000 --messages 5 --concurrency 200  # 7022 OK, 2978 OS port exhaustion
```

## 3. Protocol Coverage Matrix

| # | Protocol Requirement | Spec Section | Implementation | Covered | Test Covered | Risk | Notes |
|---|---------------------|-------------|----------------|---------|-------------|------|-------|
| 1 | WebSocket endpoint `/v1` | 18.2 | `config.rs:9`, `http.rs:32` | YES | YES | Low | Configurable path, default `/v1` |
| 2 | Subprotocol `walletpair.v1` | 18.2 | `http.rs:48` | PARTIAL | NO | **P2** | Server offers it but doesn't reject clients that don't request it |
| 3 | Text frame JSON messages | 18.3 | `session.rs:76-93` | YES | YES | Low | |
| 4 | Binary frame rejection | 18.3 | `session.rs:79-93` | YES | YES | Low | Returns `protocol_error` close |
| 5 | Message size 64 KiB limit | 16.11 | `session.rs:96-108` | YES | YES | Low | Pre-parse check |
| 6 | `v == 1` | 5 | `protocol.rs:274-279` | YES | YES | Low | Returns `unsupported_version` |
| 7 | `ch` 64 hex / 32 bytes | 4 | `protocol.rs:233-242` | YES | YES | Low | Lowercase enforced |
| 8 | `from`/`pubkey` base64url 32 bytes | 4 | `protocol.rs:244-252` | YES | YES | Low | |
| 9 | `from == pubkey` in create/join | 4 | `protocol.rs:293-295, 311-313` | YES | YES | Low | |
| 10 | dApp creates channel | 9.2, 18.3.3 | `relay.rs:91-152` | YES | YES | Low | |
| 11 | Wallet joins channel | 9.3, 18.3.4 | `relay.rs:154-244` | YES | YES | Low | |
| 12 | Relay generates `ready.waiting` | 9.2, 9.3, 18.3 | `relay.rs:147-148, 238-240` | YES | YES | Low | Both dApp and wallet receive it |
| 13 | Relay forwards `join` to dApp | 9.3, 18.3.4 | `relay.rs:228-231` | YES | YES | Low | Raw message forwarded |
| 14 | dApp accepts wallet | 9.4, 18.3.5 | `relay.rs:246-320` | YES | YES | Low | Target validation included |
| 15 | Relay generates `ready.connected` | 9.4, 18.3.5 | `relay.rs:306-316` | YES | YES | Low | Both peers get it with resume tokens |
| 16 | Role enforcement | 3, 16.5-6 | `state.rs:32-51` | YES | YES | Low | req=dApp, res/evt=wallet |
| 17 | State enforcement | 15, 16.7 | `state.rs:32-51`, `relay.rs:350-361` | YES | YES | Low | |
| 18 | `req` only from dApp | 3, 16.5 | `state.rs:38` | YES | YES | Low | |
| 19 | `res`/`evt` only from wallet | 3, 16.6 | `state.rs:39-40` | YES | YES | Low | |
| 20 | `ping`/`pong` forwarded | 12 | `relay.rs:77-83` | YES | YES | Low | Works in Connected and PendingAccept |
| 21 | `close` forwarded + relay close | 13, 18.3.8 | `relay.rs:421-462` | YES | YES | Low | |
| 22 | Resume token generation/binding | 14, 18.3.9 | `store.rs:59-77` | YES | YES | Low | UUID v4, bound to ch+role+peer |
| 23 | Reconnect behavior | 14, 18.3.10 | `relay.rs:464-553` | YES | YES | **P1** | See Issue #1 |
| 24 | Unpaired TTL | 18.3.11 | `store.rs:104-137` | YES | YES | Low | Configurable, default 300s |
| 25 | Connected TTL | 18.3.11 | `store.rs:113-114` | YES | YES | Low | Configurable, default 86400s |
| 26 | Max connections | 18.4 | `http.rs:42-44` | YES | NO | **P2** | Not tested (needs connection-count test) |
| 27 | Max channels | 18.4 | `relay.rs:124-130` | YES | YES | Low | |
| 28 | Outbound queue limit | 18.3 | `session.rs:33`, `relay.rs:27-36` | YES | YES | Low | Configurable, default 64 |
| 29 | Pending request limit 32 | 16.12 | `relay.rs:366-377` | YES | YES | Low | |
| 30 | Slow consumer handling | — | `relay.rs:390-404` | PARTIAL | YES | **P1** | See Issue #2 |
| 31 | Graceful shutdown | 18.4 | `main.rs:76-113`, `session.rs:53-64` | YES | YES | Low | |
| 32 | Metrics | — | `metrics.rs` full | YES | YES | Low | Prometheus format |
| 33 | Never log `sealed` | 20.3.7 | `session.rs:130-137` | YES | NO | Low | Verified by code review: only t/ch/from logged |
| 34 | Relay doesn't decrypt | 18.1, 20 | N/A | YES | YES | Low | No crypto deps; `sealed` forwarded as-is |

## 4. Test Results Summary

| Suite | Count | Pass | Fail |
|-------|-------|------|------|
| Unit tests (`src/`) | 34 | 34 | 0 |
| Integration tests (`tests/integration.rs`) | 60 | 60 | 0 |
| Reliability tests (`tests/reliability.rs`) | 7 | 7 | 0 |
| **Total** | **101** | **101** | **0** |

### Tests Added During Validation

12 new integration tests and 7 reliability tests covering:
- Pending request limit (33rd req rejected)
- Slow consumer queue overflow
- TTL cleanup expiration
- Max channels limit enforcement
- Role violations (dApp res, wallet accept)
- Ping/pong in PendingAccept state
- Close in WaitingForWallet state
- Req before connected state
- Multiple events in sequence
- Sealed field pass-through
- Full reconnect cycle with data flow
- Rapid create/close no channel leak
- TTL cleanup removes expired channels
- Abrupt disconnect handling
- Invalid JSON flood (50 connections)
- Concurrent channel creation (50 channels)
- Graceful shutdown (5 connected channels)
- Metrics accessible during activity

## 5. Performance Results

### Test 1: 1,000 Channels, 10 req/res each

| Metric | Value |
|--------|-------|
| Duration | 0.52s |
| Channels created | 1,000 |
| Channels completed | 1,000 |
| Messages forwarded | 20,000 (10K req + 10K res) |
| Errors | 0 |
| p50 latency | 2.95ms |
| p95 latency | 6.63ms |
| p99 latency | 9.17ms |
| Throughput | ~38,500 messages/sec |

### Test 2: 10,000 Channels, 5 req/res each

| Metric | Value |
|--------|-------|
| Duration | 3.95s |
| Channels created | 7,022 (2,978 hit OS port exhaustion) |
| Channels completed | 6,993 |
| Messages forwarded | 69,930 |
| Relay errors | 0 (all errors were OS-level `EADDRNOTAVAIL`) |
| p50 latency | 9.53ms |
| p95 latency | 17.73ms |
| p99 latency | 30.55ms |

### Test 3: Oversize/Near-Limit Payload

| Test | Result |
|------|--------|
| 65,537+ byte payload | Correctly rejected with `payload_too_large` |
| ~60,185 byte payload | Correctly forwarded |

### Memory

| State | RSS |
|-------|-----|
| After processing ~8K channels + ~90K messages | 94 MB |
| Note: Includes Prometheus registry, connection state, Tokio runtime |

### Capacity Estimate

Based on observed performance on a single-core test machine:

| Scenario | Estimated Capacity | Hardware |
|----------|-------------------|----------|
| Light use (< 100 concurrent channels) | Single $5/mo VPS (1 vCPU, 512MB RAM) | |
| Medium use (1,000 concurrent channels) | 1 vCPU, 1GB RAM | ~40K msg/s throughput |
| Heavy use (10,000 concurrent channels) | 2-4 vCPU, 2-4GB RAM | Tune OS fd/port limits |
| Very heavy (50,000 channels) | 4-8 vCPU, 8GB RAM | Requires sharded store (see P2) |

The global `Mutex<ChannelStore>` will become the bottleneck before CPU or memory. For >10K concurrent channels under active message forwarding, consider switching to a `DashMap` or sharded approach.

## 6. Reliability Results

| Scenario | Result |
|----------|--------|
| 100 rapid create/close cycles | 0 channel leak (verified via metrics) |
| TTL cleanup of 10 expired channels | All removed within 3s |
| Abrupt disconnect (no close frame) | Handled gracefully, no panic |
| 50 invalid JSON flood | Server healthy after all |
| 50 concurrent channel creations | All succeed |
| Graceful shutdown with 5 connected channels | All peers notified |
| Metrics during activity | Always accessible |

## 7. Issues Found

### P0 — Critical

**No P0 issues found.**

The relay has no panics in production paths, no data cross-contamination between channels, no channel takeover vulnerabilities, and no unbounded resource growth.

### P1 — Important

#### Issue #1: Reconnect in PendingAccept State May Send Wrong Ready

**File:** [relay.rs:509-510](src/relay.rs#L509-L510)

**Code:**
```rust
let was_connected =
    channel.state == ChannelState::Connected || channel.state == ChannelState::PendingAccept;
```

**Problem:** If a dApp disconnects during `PendingAccept` (wallet joined, accept not sent) and reconnects while the wallet is still connected, the relay sends `ready.connected` to the dApp. But the accept step hasn't happened — the user never confirmed pairing codes. This could cause the dApp client to enter Connected state without MITM verification.

**Impact:** Depends on client implementation. If the dApp client trusts `ready.connected` from the relay without checking whether it sent `accept`, the pairing code verification step is bypassed.

**Recommendation:** On reconnect, if channel state is `PendingAccept`, always send `ready.waiting` and re-forward the cached `join` message. Alternatively, treat PendingAccept reconnect as `ready.waiting` only.

**Fix:**
```rust
let was_connected = channel.state == ChannelState::Connected;
```

#### Issue #2: Slow Consumer Not Notified With Close

**File:** [relay.rs:396-404](src/relay.rs#L396-L404)

**Code:**
```rust
if !try_send(other_sender, raw_text.to_string(), metrics) {
    // Drop the slow consumer's connection
    let channel = store.get_mut(ch).unwrap();
    match role {
        Role::DApp => channel.wallet_conn = None,
        Role::Wallet => channel.dapp_conn = None,
    }
}
```

**Problem:** When the outbound queue overflows, the relay silently drops the slow consumer's connection reference without sending a `close` message with reason. The slow consumer's write task sees the mpsc channel close but has no protocol-level notification.

**Impact:** The slow peer doesn't know why it was disconnected. It may attempt to reconnect but won't understand the cause.

**Recommendation:** Before nulling the connection, attempt to send a `close` with reason `slow_consumer` (or a protocol-defined equivalent). Since the queue is full, use a separate one-shot or direct write.

#### Issue #3: `allowed_origins` Config Has No Effect

**File:** [config.rs:21](src/config.rs#L21), [http.rs:30-37](src/http.rs#L30-L37)

**Problem:** The `allowed_origins` field is in the config and documented in `config.example.toml`, but no CORS middleware is applied to the router. The `tower-http` cors dependency is included but never used. An operator who configures `allowed_origins` expects browser origin checking, but it silently does nothing.

**Impact:** No origin-based access control. Browser-based dApps from any origin can connect.

**Recommendation:** Either wire up `tower_http::cors::CorsLayer` using the config, or remove the field and dependency to avoid false confidence.

### P2 — Moderate

#### Issue #4: Global Mutex Bottleneck

**File:** [http.rs:23](src/http.rs#L23) — `Arc<Mutex<ChannelStore>>`

Every incoming message from every connection acquires the same mutex. At moderate load (1K channels, ~40K msg/s) this works fine. At higher scale (10K+ channels with active traffic), lock contention will become the primary bottleneck.

**Recommendation:** For production at scale, consider `DashMap` or per-channel `Mutex` wrapping. For the current target (dApp-wallet pairing, typically hundreds of concurrent channels), this is acceptable.

#### Issue #5: WebSocket Subprotocol Not Strictly Required

**File:** [http.rs:48](src/http.rs#L48)

The server offers `walletpair.v1` subprotocol but doesn't reject clients that don't request it. Per the protocol spec (Section 18.2), the subprotocol should be `walletpair.v1`.

**Recommendation:** Check the `Sec-WebSocket-Protocol` header and reject connections that don't include `walletpair.v1`.

#### Issue #6: Dummy Sender Created When dApp Disconnected During Join

**File:** [relay.rs:213-215](src/relay.rs#L213-L215)

```rust
mpsc::channel(1).0 // dummy — won't actually send
```

When the wallet joins but the dApp is already disconnected, a dummy mpsc sender is created. The `try_send` on it will fail (receiver immediately dropped). This is wasteful but not harmful.

**Recommendation:** Check `channel.dapp_conn.is_some()` before cloning and skip the forward if dApp is disconnected.

#### Issue #7: `capabilities` Stored as `serde_json::Value`

**File:** [protocol.rs:105](src/protocol.rs#L105)

The `capabilities` field in `Join` is parsed as raw `serde_json::Value` instead of a typed struct. The relay doesn't validate the required structure (`methods`, `events`, `chains` arrays).

**Impact:** Low for relay (it just forwards the raw JSON). But a malformed `capabilities` object passes through without validation.

**Recommendation:** For relay, this is acceptable (relay is a "dumb pipe"). If stricter validation is desired, add a typed `Capabilities` struct.

### P3 — Minor/Quality

#### Issue #8: `unwrap()` After Infallible Lookups in `relay.rs`

Multiple `store.get(ch).unwrap()` / `store.get_mut(ch).unwrap()` calls after confirming the channel exists. These are logically safe (the channel was just checked) but could confuse future maintainers.

**Recommendation:** Consider extracting into helper methods that return `&mut Channel` directly, or add inline comments explaining why the unwrap is safe.

#### Issue #9: Close Reason Mapping is Lossy

**File:** [relay.rs:453-457](src/relay.rs#L453-L457)

```rust
let close_reason = match reason {
    "normal" => CloseReason::Normal,
    "user_rejected" => CloseReason::UserRejected,
    _ => CloseReason::Normal,
};
```

Unknown close reasons from peers are mapped to `Normal` for metrics. This loses information. Consider adding a catch-all variant or using the original string.

#### Issue #10: No `#[must_use]` on `ProcessResult`

The `ProcessResult` enum should be `#[must_use]` to prevent accidentally ignoring rejection results.

## 8. Security and Privacy Checklist

| Check | Result | Evidence |
|-------|--------|----------|
| `sealed` never logged | PASS | `session.rs:130-137` logs only `t`, `ch`, `from` |
| Resume token unpredictable | PASS | UUID v4 via `uuid::Uuid::new_v4()` |
| Resume bound to ch+role+peer | PASS | `store.rs:61-67`, `relay.rs:487-488` validates all three |
| Invalid resume can't take channel | PASS | Tests: `resume_token_rejected_when_wrong_peer_id`, `wrong_role` |
| Third peer can't join | PASS | Test: `third_peer_join_returns_already_connected` |
| Close doesn't leak internals | PASS | Close messages contain only `reason` string |
| Size limit before parse | PASS | `session.rs:96-108` checks `raw_text.len()` before `parse_message` |
| No unbounded channels | PASS | `max_channels` enforced at `relay.rs:124` |
| No unbounded queue | PASS | `mpsc::channel(config.outbound_queue_size)` is bounded |
| No unbounded pending requests | PASS | `pending_request_limit` at `relay.rs:368` |
| No deep JSON nesting DoS | LOW RISK | serde_json has no depth limit, but message parsing extracts only top-level fields |
| Origin checking | FAIL | See Issue #3 — `allowed_origins` has no effect |
| Relay doesn't decrypt | PASS | No crypto dependencies; `sealed` forwarded as opaque string |
| No `unsafe` code | PASS | Verified: zero `unsafe` blocks |

## 9. Test Assets Produced

| File | Description | Long-term Value |
|------|-------------|----------------|
| `tests/integration.rs` | 60 protocol conformance tests | High — regression safety net |
| `tests/reliability.rs` | 7 reliability/lifecycle tests | High — leak/crash detection |
| `tools/loadtest/` | Standalone load test binary | High — repeatable perf measurement |
| `scripts/loadtest.sh` | One-command load test runner | Medium — CI/CD integration |
| `scripts/soak.sh` | Multi-round soak test runner | Medium — pre-release validation |

## 10. Remaining Risks Requiring Human Decision

1. **Issue #1 (reconnect in PendingAccept)** — Severity depends on whether the dApp client independently tracks the accept step. If the client always checks its own state machine before proceeding, the relay sending `ready.connected` prematurely is benign. If the client trusts the relay, it's a security issue. **Needs dApp client team input.**

2. **Global Mutex scalability** — Acceptable for the stated use case (pairing service, hundreds of concurrent channels). If the target grows to 10K+ concurrent channels with heavy message traffic, this needs redesign.

3. **CORS (Issue #3)** — If the relay is meant to be accessed from browser dApps, origin checking matters. If it's always behind a reverse proxy that handles CORS, the config field should be removed to avoid confusion.

4. **Subprotocol strictness** — Some WebSocket libraries don't send subprotocol headers. Enforcing `walletpair.v1` would break those clients. Decide based on ecosystem needs.

## 11. Production Readiness Assessment

### Strengths
- Clean, well-structured Rust code (~850 lines excluding tests)
- Comprehensive protocol coverage with 101 passing tests
- No `unsafe`, no panics in production paths
- Good metrics instrumentation (Prometheus)
- Configurable limits (channels, connections, queue, TTL)
- Graceful shutdown with peer notification
- No persistent storage needed — ephemeral by design
- Performance: 38K+ msg/s on a single core, sub-10ms p95

### Recommendation

**Conditional YES for production trial**, with the following prerequisites:

1. **Must fix before production:**
   - Issue #1: Change reconnect logic to not send `ready.connected` for PendingAccept state
   - Issue #3: Either implement CORS or remove the `allowed_origins` config field

2. **Should fix soon after launch:**
   - Issue #2: Send close reason to slow consumers
   - Issue #5: Consider subprotocol validation

3. **Monitor in production:**
   - Mutex contention (via p99 latency trending)
   - Channel leak (via `walletpair_active_channels` metric)
   - Memory growth over days (via RSS monitoring)

### Hardware Sizing

| Users | Concurrent Channels | Recommended | Monthly Cost |
|-------|-------------------|-------------|-------------|
| < 500 | < 100 | 1 vCPU, 512MB | ~$5 |
| 500-5,000 | 100-1,000 | 1 vCPU, 1GB | ~$10 |
| 5,000-50,000 | 1,000-10,000 | 2 vCPU, 2GB | ~$20-40 |
| 50,000+ | 10,000+ | Needs sharded redesign | — |

---

*Report generated after independent code review, 101 automated tests, and load testing of 8,000+ channels with 90,000+ messages.*
