# WalletPair WebSocket Relay

A WebSocket relay server implementing the **WalletPair Protocol v1 WebSocket Relay Binding** (Sections 17-18 of the protocol specification). The relay routes encrypted messages between dApps and wallets without decrypting them.

## What it does

The relay acts as a blind message router for the WalletPair protocol. It manages channel lifecycles, enforces the protocol state machine, and forwards opaque messages between paired peers. Specifically, the relay implements:

- **Section 3 (Roles)**: Distinguishes between `dapp` and `wallet` roles and enforces role-based message direction.
- **Sections 5-6 (Message Format/Types)**: Parses and validates the WalletPair v1 JSON envelope (`v`, `t`, `ch`, `from`, etc.) and recognizes all message types (`create`, `join`, `accept`, `req`, `res`, `evt`, `ping`, `pong`, `close`, `ready`).
- **Section 9 (Pairing Flow)**: Manages the create/join/accept handshake, generates `ready` messages with resume tokens, and transitions channels through `WaitingForWallet` -> `PendingAccept` -> `Connected` states.
- **Sections 10-13 (Request/Response/Events/Heartbeat/Close)**: Forwards `req`, `res`, `evt`, `ping`, `pong`, and `close` messages to the other peer. Tracks pending request IDs and enforces the pending request limit.
- **Section 14 (Reconnect)**: Supports resume tokens for reconnection. Peers can reconnect to an existing channel by including a `resume` token in their `create` or `join` message.
- **Sections 15-16 (State Machine/Rules)**: Enforces which message types are valid in each channel state and from which role. Rejects messages that violate the state machine with appropriate close reasons.
- **Sections 17-18 (Transport Requirements / WebSocket Relay Binding)**: Implements the WebSocket transport layer with subprotocol negotiation (`walletpair.v1`), text-only frames, message size limits, connection limits, and graceful shutdown.

## What the relay does NOT do

The relay is intentionally limited in scope. It does **not**:

- Perform **end-to-end decryption**. The `sealed` field in `req`, `res`, and `evt` messages is never inspected, parsed, or logged.
- Execute **key exchange** (X25519/HKDF). Key material never touches the relay.
- Compute **pairing codes** (SPAKE2 or otherwise). The relay has no knowledge of shared secrets.
- Perform **wallet signing logic**. No transaction construction, no chain interaction.
- **Authenticate** peer identities cryptographically. The `from` field is self-reported by the client (see Known Protocol Issues below).

The relay is a blind message router. It validates message structure and protocol state, then forwards the raw JSON text verbatim.

## Configuration

All configuration is loaded from a TOML file. The relay looks for the file path in the `WALLETPAIR_CONFIG` environment variable, then falls back to `config.toml` in the working directory, then uses built-in defaults.

| Option | Default | Description |
|---|---|---|
| `listen_addr` | `0.0.0.0:8080` | Address and port to bind |
| `websocket_path` | `/v1` | URL path for the WebSocket endpoint |
| `max_connections` | `10000` | Maximum concurrent WebSocket connections |
| `max_channels` | `50000` | Maximum concurrent channels |
| `max_message_bytes` | `65536` | Maximum size of a single WebSocket text frame in bytes |
| `outbound_queue_size` | `64` | Per-connection outbound message buffer size |
| `pending_request_limit` | `32` | Maximum pending (unanswered) requests per channel |
| `unpaired_channel_ttl_secs` | `300` | Seconds before an unpaired channel is cleaned up |
| `connected_channel_ttl_secs` | `86400` | Seconds before a connected channel is cleaned up |
| `cleanup_interval_secs` | `30` | How often the background cleanup task runs |
| `graceful_shutdown_timeout_secs` | `10` | Seconds to wait during graceful shutdown |
| `log_level` | `info` | Log level filter (trace, debug, info, warn, error) |
| `metrics_enabled` | `true` | Whether the /metrics endpoint is active |
| `allowed_origins` | *(none)* | Optional list of allowed CORS origins |

See `config.example.toml` for a fully commented example.

## Running locally

```sh
cargo run
```

The relay starts on `0.0.0.0:8080` by default. Override with a config file:

```sh
WALLETPAIR_CONFIG=my-config.toml cargo run
```

Or set the log level via environment variable:

```sh
RUST_LOG=debug cargo run
```

## Docker

Build and run:

```sh
docker build -t walletpair-relay .
docker run -p 8080:8080 walletpair-relay
```

Pass a custom config file:

```sh
docker run -p 8080:8080 \
  -v $(pwd)/config.toml:/app/config.toml \
  -e WALLETPAIR_CONFIG=/app/config.toml \
  walletpair-relay
```

## WebSocket usage example

Connect to the relay with the `walletpair.v1` subprotocol:

```
ws://localhost:8080/v1
Sec-WebSocket-Protocol: walletpair.v1
```

### 1. dApp creates a channel

```json
{
  "v": 1,
  "t": "create",
  "ch": "a]1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  "from": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
  "pubkey": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"
}
```

Relay responds:

```json
{
  "v": 1,
  "t": "ready",
  "ch": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  "state": "waiting",
  "role": "dapp",
  "self": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
  "resume": "<uuid-resume-token>"
}
```

### 2. Wallet joins the channel

```json
{
  "v": 1,
  "t": "join",
  "ch": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  "from": "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
  "pubkey": "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
  "capabilities": { "methods": ["eth_signTransaction"], "events": ["chainChanged"], "chains": ["eip155:1"] }
}
```

Relay forwards the raw `join` message to the dApp and sends `ready` (state: `waiting`) to the wallet.

### 3. dApp accepts the wallet

```json
{
  "v": 1,
  "t": "accept",
  "ch": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  "from": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
  "target": "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI"
}
```

Relay sends `ready` (state: `connected`) to both peers with new resume tokens.

### 4. dApp sends a request

```json
{
  "v": 1,
  "t": "req",
  "ch": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  "id": "req-001",
  "from": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
  "method": "eth_signTransaction",
  "sealed": "<base64url-encrypted-payload>"
}
```

Relay forwards the raw JSON verbatim to the wallet. The `sealed` field is never read.

### 5. Wallet responds

```json
{
  "v": 1,
  "t": "res",
  "ch": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  "id": "req-001",
  "from": "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
  "sealed": "<base64url-encrypted-payload>"
}
```

Relay forwards the raw JSON verbatim to the dApp. Success/failure status is
encrypted inside `sealed` (`_ok` field) and invisible to the relay.

## Endpoints

| Path | Method | Description |
|---|---|---|
| `/v1` | GET (WebSocket Upgrade) | WebSocket endpoint. Requires `Sec-WebSocket-Protocol: walletpair.v1`. |
| `/healthz` | GET | Liveness probe. Always returns `200 ok`. |
| `/readyz` | GET | Readiness probe. Returns `200 ready` if below channel capacity, `503 at channel capacity` otherwise. |
| `/metrics` | GET | Prometheus metrics in text exposition format. Returns `404` if `metrics_enabled` is `false`. |

## Metrics

All metrics use the `walletpair_` prefix.

| Metric | Type | Labels | Description |
|---|---|---|---|
| `walletpair_active_connections` | Gauge | -- | Current number of WebSocket connections |
| `walletpair_active_channels` | Gauge | -- | Current number of active channels |
| `walletpair_channels_created_total` | Counter | -- | Total channels created by dApps |
| `walletpair_channels_joined_total` | Counter | -- | Total channels joined by wallets |
| `walletpair_channels_connected_total` | Counter | -- | Total channels that reached the connected state |
| `walletpair_channels_closed_total` | Counter | `reason` | Total channels closed, labeled by close reason (`normal`, `user_rejected`, `timeout`, `server_shutdown`, etc.) |
| `walletpair_messages_rejected_total` | Counter | `reason` | Total messages rejected, labeled by rejection reason (`channel_exists`, `channel_not_found`, `invalid_state`, `invalid_role`, `payload_too_large`, `protocol_error`, etc.) |
| `walletpair_messages_forwarded_total` | Counter | `type` | Total messages forwarded, labeled by message type (`join`, `req`, `res`, `evt`, `ping`, `pong`, `close`) |
| `walletpair_reconnect_attempts_total` | Counter | `result` | Total reconnect attempts, labeled by result (`success_connected`, `success_waiting`, `invalid_token`, `token_mismatch`, `channel_gone`) |
| `walletpair_outbound_queue_drops_total` | Counter | -- | Total messages dropped because the outbound queue was full |
| `walletpair_slow_consumer_closes_total` | Counter | -- | Total connections closed because the peer was consuming too slowly |

## Production deployment

- **TLS**: Run the relay behind a reverse proxy (nginx, Caddy, envoy) that terminates TLS. The relay itself serves plain WebSocket (`ws://`). Clients should connect over `wss://` through the proxy.
- **Tuning `max_connections` and `max_channels`**: The default of 10,000 connections and 50,000 channels is suitable for moderate traffic. Each connection uses one tokio task and a small outbound buffer. Increase these for high-traffic deployments; monitor with the Prometheus metrics.
- **Channel TTLs**: Set `connected_channel_ttl_secs` based on expected session duration. The default of 86,400 seconds (24 hours) is generous. For short-lived signing sessions, consider lowering it. `unpaired_channel_ttl_secs` controls how long a channel waits for a wallet to join before being cleaned up.
- **Health checks**: Use `/healthz` for liveness and `/readyz` for readiness in Kubernetes or similar orchestrators. The readiness endpoint returns 503 when the relay is at channel capacity.
- **Graceful shutdown**: The relay handles SIGINT and SIGTERM. On shutdown, it sends `close` (reason: `server_shutdown`) to all connected peers and waits briefly for writes to flush.

## Known protocol issues

**CRITICAL: Nonce reuse vulnerability in the protocol specification.**
Both peers derive AEAD nonces from `HMAC-SHA256(session_key, seq_bytes)`, but both start their sequence counter at 0 using the same `session_key`. Since both the key and nonce are identical for the first message from each direction, AEAD security guarantees are broken (an attacker observing both ciphertexts can XOR them to recover the XOR of the plaintexts). The fix is to include a direction byte in the nonce derivation (e.g., prefix the HMAC input with `0x00` for dApp-to-wallet and `0x01` for wallet-to-dApp). This relay is unaffected because it never decrypts `sealed` payloads, but **client implementations must be aware of this issue**.

**The `from` field is self-reported and not cryptographically authenticated by the relay.**
A malicious client can set any `from` value. The relay validates only that `from` is a syntactically valid base64url-encoded 32-byte value and that `from == pubkey` in `create`/`join` messages. It does not verify that the sender possesses the corresponding private key. Authentication of peer identity is the responsibility of the end-to-end encryption layer.

## Testing

Run the full test suite:

```sh
cargo test
```

This runs 34 unit tests and 22 integration tests. Tests use random ports (binding to `127.0.0.1:0`) and do not depend on `sleep` or timing.

### How to add test fixtures

Add JSON message fixtures to the test helper functions (see `tests/integration.rs` and the `#[cfg(test)]` modules in source files). Use `protocol::parse_message()` to validate that fixtures parse correctly:

```rust
let raw = r#"{"v":1,"t":"create","ch":"aa...(64 hex)","from":"...","pubkey":"..."}"#;
let msg = protocol::parse_message(raw).expect("fixture should parse");
assert!(matches!(msg, protocol::ClientMessage::Create { .. }));
```

## License

See LICENSE file.
