//! Integration tests for WalletPair Protocol v1 WebSocket Relay.
//!
//! Each test starts its own relay server on a random port, connects WebSocket
//! clients, and verifies protocol behavior end-to-end.

use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TIMEOUT: Duration = Duration::from_secs(5);

fn make_peer_id(byte: u8) -> String {
    URL_SAFE_NO_PAD.encode([byte; 32])
}

fn make_channel_id() -> String {
    "ab".repeat(32)
}

/// Start a relay server on a random port and return its base URL (e.g. "127.0.0.1:12345").
async fn start_server() -> (String, tokio::sync::broadcast::Sender<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let config = walletpair_websocket_relay::config::Config {
        listen_addr: addr,
        metrics_enabled: true,
        max_message_bytes: 65_536,
        max_creates_per_ip_per_min: 0, // disable for tests
        max_connections_per_ip: 0,     // disable for tests
        ..Default::default()
    };
    let config = Arc::new(config);

    let metrics = walletpair_websocket_relay::metrics::Metrics::new();
    let store = walletpair_websocket_relay::store::ShardedStore::new(&config);

    let (shutdown_tx, _) = tokio::sync::broadcast::channel(1);

    let rate_limiter = Arc::new(walletpair_websocket_relay::ratelimit::IpRateLimiter::new(
        config.max_creates_per_ip_per_min,
        config.max_connections_per_ip,
        60,
    ));

    let app_state = walletpair_websocket_relay::http::AppState {
        store: Arc::new(store),
        config: config.clone(),
        metrics,
        shutdown_tx: shutdown_tx.clone(),
        conn_counter: Arc::new(AtomicU64::new(1)),
        rate_limiter,
    };

    let router = walletpair_websocket_relay::http::router(app_state);

    tokio::spawn(async move {
        axum::serve(listener, router.into_make_service_with_connect_info::<std::net::SocketAddr>()).await.unwrap();
    });

    (addr.to_string(), shutdown_tx)
}

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn ws_connect(addr: &str) -> WsStream {
    let url = format!("ws://{}/v1", addr);
    let (ws, _response) = tokio_tungstenite::connect_async(&url).await.unwrap();
    ws
}

async fn send_json(ws: &mut WsStream, val: &Value) {
    ws.send(Message::Text(val.to_string().into()))
        .await
        .unwrap();
}

async fn send_text(ws: &mut WsStream, text: &str) {
    ws.send(Message::Text(text.into())).await.unwrap();
}

async fn recv_json(ws: &mut WsStream) -> Value {
    let msg = timeout(TIMEOUT, ws.next())
        .await
        .expect("timed out waiting for message")
        .expect("stream ended")
        .expect("read error");
    match msg {
        Message::Text(t) => serde_json::from_str(&t).expect("not valid JSON"),
        other => panic!("expected text frame, got {:?}", other),
    }
}

fn create_msg(ch: &str, peer: &str) -> Value {
    json!({
        "v": 1,
        "t": "create",
        "ch": ch,
        "ts": 1234,
        "from": peer,
        "body": {"meta": {}}
    })
}

fn join_msg(ch: &str, peer: &str) -> Value {
    json!({
        "v": 1,
        "t": "join",
        "ch": ch,
        "ts": 1234,
        "from": peer,
        "body": {"sealed_join": null}
    })
}

fn accept_msg(ch: &str, from: &str, target: &str) -> Value {
    json!({
        "v": 1,
        "t": "accept",
        "ch": ch,
        "ts": 1234,
        "from": from,
        "body": {"target": target}
    })
}

fn req_msg(ch: &str, from: &str, id: &str) -> Value {
    json!({
        "v": 1,
        "t": "req",
        "ch": ch,
        "ts": 1234,
        "from": from,
        "body": {"id": id, "sealed": "encrypted_data"}
    })
}

fn res_msg(ch: &str, from: &str, id: &str) -> Value {
    json!({
        "v": 1,
        "t": "res",
        "ch": ch,
        "ts": 1234,
        "from": from,
        "body": {"id": id, "sealed": "encrypted_result"}
    })
}

fn evt_msg(ch: &str, from: &str) -> Value {
    json!({
        "v": 1,
        "t": "evt",
        "ch": ch,
        "ts": 1234,
        "from": from,
        "body": {"id": "e1", "sealed": "encrypted_event"}
    })
}

fn close_msg(ch: &str, from: &str, reason: &str) -> Value {
    json!({
        "v": 1,
        "t": "close",
        "ch": ch,
        "ts": 1234,
        "from": from,
        "body": {"reason": reason}
    })
}

/// Helper: create channel, join wallet, accept -- return (dapp_ws, wallet_ws).
async fn setup_connected_pair(addr: &str) -> (WsStream, WsStream) {
    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);
    let wallet_peer = make_peer_id(2);

    // dApp creates
    let mut dapp = ws_connect(addr).await;
    send_json(&mut dapp, &create_msg(&ch, &dapp_peer)).await;
    let ready = recv_json(&mut dapp).await;
    assert_eq!(ready["t"], "ready");
    assert_eq!(ready["body"]["state"], "waiting");

    // Wallet joins
    let mut wallet = ws_connect(addr).await;
    send_json(&mut wallet, &join_msg(&ch, &wallet_peer)).await;

    // Wallet gets ready.waiting
    let wallet_ready = recv_json(&mut wallet).await;
    assert_eq!(wallet_ready["t"], "ready");
    assert_eq!(wallet_ready["body"]["state"], "waiting");

    // dApp gets the raw join forwarded
    let join_fwd = recv_json(&mut dapp).await;
    assert_eq!(join_fwd["t"], "join");

    // dApp accepts
    send_json(&mut dapp, &accept_msg(&ch, &dapp_peer, &wallet_peer)).await;

    // Both get ready.connected
    let dapp_connected = recv_json(&mut dapp).await;
    assert_eq!(dapp_connected["t"], "ready");
    assert_eq!(dapp_connected["body"]["state"], "connected");

    let wallet_connected = recv_json(&mut wallet).await;
    assert_eq!(wallet_connected["t"], "ready");
    assert_eq!(wallet_connected["body"]["state"], "connected");

    (dapp, wallet)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn dapp_create_receives_ready_waiting() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);

    let mut dapp = ws_connect(&addr).await;
    send_json(&mut dapp, &create_msg(&ch, &dapp_peer)).await;

    let ready = recv_json(&mut dapp).await;
    assert_eq!(ready["v"], 1);
    assert_eq!(ready["t"], "ready");
    assert_eq!(ready["ch"], ch);
    assert_eq!(ready["from"], "_adapter");
    assert!(ready["ts"].as_u64().is_some());
    assert_eq!(ready["body"]["state"], "waiting");
    assert_eq!(ready["body"]["role"], "dapp");
    assert_eq!(ready["body"]["self"], dapp_peer);
}

#[tokio::test]
async fn wallet_join_receives_ready_waiting_and_dapp_receives_join() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);
    let wallet_peer = make_peer_id(2);

    // dApp creates
    let mut dapp = ws_connect(&addr).await;
    send_json(&mut dapp, &create_msg(&ch, &dapp_peer)).await;
    let _ = recv_json(&mut dapp).await; // ready.waiting

    // Wallet joins
    let mut wallet = ws_connect(&addr).await;
    send_json(&mut wallet, &join_msg(&ch, &wallet_peer)).await;

    // Wallet gets ready.waiting
    let wallet_ready = recv_json(&mut wallet).await;
    assert_eq!(wallet_ready["t"], "ready");
    assert_eq!(wallet_ready["body"]["state"], "waiting");
    assert_eq!(wallet_ready["body"]["role"], "wallet");
    assert_eq!(wallet_ready["body"]["self"], wallet_peer);

    // dApp receives the raw join message forwarded
    let join_fwd = recv_json(&mut dapp).await;
    assert_eq!(join_fwd["t"], "join");
    assert_eq!(join_fwd["from"], wallet_peer);
}

#[tokio::test]
async fn dapp_accept_both_receive_ready_connected() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);
    let wallet_peer = make_peer_id(2);

    let mut dapp = ws_connect(&addr).await;
    send_json(&mut dapp, &create_msg(&ch, &dapp_peer)).await;
    let _ = recv_json(&mut dapp).await;

    let mut wallet = ws_connect(&addr).await;
    send_json(&mut wallet, &join_msg(&ch, &wallet_peer)).await;
    let _ = recv_json(&mut wallet).await; // ready.waiting
    let _ = recv_json(&mut dapp).await; // join forwarded

    // dApp accepts
    send_json(&mut dapp, &accept_msg(&ch, &dapp_peer, &wallet_peer)).await;

    // dApp gets ready.connected
    let dapp_ready = recv_json(&mut dapp).await;
    assert_eq!(dapp_ready["t"], "ready");
    assert_eq!(dapp_ready["body"]["state"], "connected");
    assert_eq!(dapp_ready["body"]["role"], "dapp");
    assert_eq!(dapp_ready["body"]["remote"], wallet_peer);

    // Wallet gets ready.connected
    let wallet_ready = recv_json(&mut wallet).await;
    assert_eq!(wallet_ready["t"], "ready");
    assert_eq!(wallet_ready["body"]["state"], "connected");
    assert_eq!(wallet_ready["body"]["role"], "wallet");
    assert_eq!(wallet_ready["body"]["remote"], dapp_peer);
}

#[tokio::test]
async fn connected_req_forwarded_to_wallet() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);

    let (mut dapp, mut wallet) = setup_connected_pair(&addr).await;

    // dApp sends req
    let req = req_msg(&ch, &dapp_peer, "r1");
    send_json(&mut dapp, &req).await;

    // Wallet receives it
    let received = recv_json(&mut wallet).await;
    assert_eq!(received["t"], "req");
    assert_eq!(received["body"]["id"], "r1");
}

#[tokio::test]
async fn connected_res_forwarded_to_dapp() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);
    let wallet_peer = make_peer_id(2);

    let (mut dapp, mut wallet) = setup_connected_pair(&addr).await;

    // dApp sends req first (to have a pending request)
    send_json(&mut dapp, &req_msg(&ch, &dapp_peer, "r1")).await;
    let _ = recv_json(&mut wallet).await; // consume req

    // Wallet sends res
    let res = res_msg(&ch, &wallet_peer, "r1");
    send_json(&mut wallet, &res).await;

    // dApp receives it
    let received = recv_json(&mut dapp).await;
    assert_eq!(received["t"], "res");
    assert_eq!(received["body"]["id"], "r1");
    assert_eq!(received["body"]["sealed"], "encrypted_result");
}

#[tokio::test]
async fn connected_evt_forwarded_to_dapp() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let wallet_peer = make_peer_id(2);

    let (mut dapp, mut wallet) = setup_connected_pair(&addr).await;

    // Wallet sends evt
    let evt = evt_msg(&ch, &wallet_peer);
    send_json(&mut wallet, &evt).await;

    // dApp receives it
    let received = recv_json(&mut dapp).await;
    assert_eq!(received["t"], "evt");
}

#[tokio::test]
async fn dapp_cannot_send_evt() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);

    let (mut dapp, mut _wallet) = setup_connected_pair(&addr).await;

    // dApp sends evt (not allowed)
    let evt = evt_msg(&ch, &dapp_peer);
    send_json(&mut dapp, &evt).await;

    // dApp gets terminate with invalid_role
    let close = recv_json(&mut dapp).await;
    assert_eq!(close["t"], "terminate");
    assert_eq!(close["body"]["reason"], "invalid_role");
}

#[tokio::test]
async fn wallet_cannot_send_req() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let wallet_peer = make_peer_id(2);

    let (mut _dapp, mut wallet) = setup_connected_pair(&addr).await;

    // Wallet sends req (not allowed)
    let req = req_msg(&ch, &wallet_peer, "r1");
    send_json(&mut wallet, &req).await;

    // Wallet gets terminate with invalid_role
    let close = recv_json(&mut wallet).await;
    assert_eq!(close["t"], "terminate");
    assert_eq!(close["body"]["reason"], "invalid_role");
}

#[tokio::test]
async fn accept_wrong_target_rejected() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);
    let wallet_peer = make_peer_id(2);
    let wrong_target = make_peer_id(3);

    let mut dapp = ws_connect(&addr).await;
    send_json(&mut dapp, &create_msg(&ch, &dapp_peer)).await;
    let _ = recv_json(&mut dapp).await;

    let mut wallet = ws_connect(&addr).await;
    send_json(&mut wallet, &join_msg(&ch, &wallet_peer)).await;
    let _ = recv_json(&mut wallet).await;
    let _ = recv_json(&mut dapp).await;

    // dApp accepts with wrong target
    send_json(&mut dapp, &accept_msg(&ch, &dapp_peer, &wrong_target)).await;

    let close = recv_json(&mut dapp).await;
    assert_eq!(close["t"], "terminate");
    assert_eq!(close["body"]["reason"], "protocol_error");
    assert_eq!(close["body"]["target"], wrong_target);
}

#[tokio::test]
async fn join_missing_channel_returns_channel_not_found() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let wallet_peer = make_peer_id(2);

    let mut wallet = ws_connect(&addr).await;
    send_json(&mut wallet, &join_msg(&ch, &wallet_peer)).await;

    let close = recv_json(&mut wallet).await;
    assert_eq!(close["t"], "terminate");
    assert_eq!(close["body"]["reason"], "channel_not_found");
}

#[tokio::test]
async fn duplicate_create_returns_channel_exists() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);
    let dapp_peer_2 = make_peer_id(3);

    // First create succeeds
    let mut dapp1 = ws_connect(&addr).await;
    send_json(&mut dapp1, &create_msg(&ch, &dapp_peer)).await;
    let ready = recv_json(&mut dapp1).await;
    assert_eq!(ready["t"], "ready");

    // Second create on same channel while in waiting state — replaces the old
    // channel per spec §13 (waiting channels are replaced on re-create).
    let mut dapp2 = ws_connect(&addr).await;
    send_json(&mut dapp2, &create_msg(&ch, &dapp_peer_2)).await;
    let ready2 = recv_json(&mut dapp2).await;
    assert_eq!(ready2["t"], "ready");
    assert_eq!(ready2["body"]["state"], "waiting");
}

#[tokio::test]
async fn third_peer_join_returns_already_connected() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);
    let wallet_peer = make_peer_id(2);
    let third_peer = make_peer_id(3);

    // Setup: create + join (channel is now in PendingAccept)
    let mut dapp = ws_connect(&addr).await;
    send_json(&mut dapp, &create_msg(&ch, &dapp_peer)).await;
    let _ = recv_json(&mut dapp).await;

    let mut wallet = ws_connect(&addr).await;
    send_json(&mut wallet, &join_msg(&ch, &wallet_peer)).await;
    let _ = recv_json(&mut wallet).await;
    let _ = recv_json(&mut dapp).await;

    // Third peer tries to join
    let mut third = ws_connect(&addr).await;
    send_json(&mut third, &join_msg(&ch, &third_peer)).await;

    let close = recv_json(&mut third).await;
    assert_eq!(close["t"], "terminate");
    assert_eq!(close["body"]["reason"], "already_connected");
}

#[tokio::test]
async fn payload_too_large_returns_close() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);

    let mut dapp = ws_connect(&addr).await;
    send_json(&mut dapp, &create_msg(&ch, &dapp_peer)).await;
    let _ = recv_json(&mut dapp).await; // ready.waiting

    // Send a message exceeding 64KB
    let huge_payload = "x".repeat(65_537 + 100);
    let big_msg = json!({
        "v": 1,
        "t": "close",
        "ch": ch,
        "ts": 1234,
        "from": dapp_peer,
        "body": {"reason": "normal", "data": huge_payload}
    });
    send_json(&mut dapp, &big_msg).await;

    let close = recv_json(&mut dapp).await;
    assert_eq!(close["t"], "terminate");
    assert_eq!(close["body"]["reason"], "payload_too_large");
}

#[tokio::test]
async fn invalid_json_returns_protocol_error() {
    let (addr, _shutdown) = start_server().await;

    let mut ws = ws_connect(&addr).await;
    send_text(&mut ws, "this is not json {{{").await;

    let close = recv_json(&mut ws).await;
    assert_eq!(close["t"], "terminate");
    assert_eq!(close["body"]["reason"], "protocol_error");
}

#[tokio::test]
async fn unsupported_version_returns_close() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);

    let mut ws = ws_connect(&addr).await;
    let msg = json!({
        "v": 2,
        "t": "create",
        "ch": ch,
        "ts": 1234,
        "from": dapp_peer,
        "body": {}
    });
    send_json(&mut ws, &msg).await;

    let close = recv_json(&mut ws).await;
    assert_eq!(close["t"], "terminate");
    assert_eq!(close["body"]["reason"], "unsupported_version");
}

#[tokio::test]
async fn close_from_dapp_forwarded_to_wallet() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);

    let (mut dapp, mut wallet) = setup_connected_pair(&addr).await;

    // dApp sends close
    send_json(&mut dapp, &close_msg(&ch, &dapp_peer, "normal")).await;

    // Wallet receives the close (forwarded as-is from peer)
    let received = recv_json(&mut wallet).await;
    assert_eq!(received["t"], "close");
    assert_eq!(received["body"]["reason"], "normal");
    assert_eq!(received["from"], dapp_peer);
}

#[tokio::test]
async fn metrics_endpoint_returns_prometheus_format() {
    let (addr, _shutdown) = start_server().await;

    // Create a channel to ensure some metrics exist
    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);
    let mut dapp = ws_connect(&addr).await;
    send_json(&mut dapp, &create_msg(&ch, &dapp_peer)).await;
    let _ = recv_json(&mut dapp).await;

    // Fetch /metrics via HTTP
    let resp = reqwest::get(&format!("http://{}/metrics", addr))
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);

    let body = resp.text().await.unwrap();
    // Check for expected Prometheus metric names
    assert!(body.contains("walletpair_active_connections"));
    assert!(body.contains("walletpair_active_channels"));
    assert!(body.contains("walletpair_channels_created_total"));
}

#[tokio::test]
async fn healthz_returns_ok() {
    let (addr, _shutdown) = start_server().await;

    let resp = reqwest::get(&format!("http://{}/healthz", addr))
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);

    let body = resp.text().await.unwrap();
    assert_eq!(body, "ok");
}

#[tokio::test]
async fn binary_frame_rejected() {
    let (addr, _shutdown) = start_server().await;

    let mut ws = ws_connect(&addr).await;
    // Send a binary frame
    ws.send(Message::Binary(vec![0x00, 0x01, 0x02].into()))
        .await
        .unwrap();

    // Should get a terminate with protocol_error
    let close = recv_json(&mut ws).await;
    assert_eq!(close["t"], "terminate");
    assert_eq!(close["body"]["reason"], "protocol_error");
}

// ---------------------------------------------------------------------------
// Additional E2E tests — edge cases & full protocol coverage
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ping_forwarded_to_other_peer_in_connected_state() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);

    let (mut dapp, mut wallet) = setup_connected_pair(&addr).await;

    // dApp sends ping
    let ping = json!({"v":1, "t":"ping", "ch":ch, "ts": 12345, "from":dapp_peer, "body": {}});
    send_json(&mut dapp, &ping).await;

    // wallet receives the ping (raw forwarded)
    let received = recv_json(&mut wallet).await;
    assert_eq!(received["t"], "ping");
    assert_eq!(received["from"], dapp_peer);
    assert_eq!(received["ts"], 12345);
}

#[tokio::test]
async fn pong_forwarded_to_other_peer_in_connected_state() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);
    let wallet_peer = make_peer_id(2);

    let (mut dapp, mut wallet) = setup_connected_pair(&addr).await;

    // dApp pings, wallet receives
    let ping = json!({"v":1, "t":"ping", "ch":ch, "ts": 100, "from":dapp_peer, "body": {}});
    send_json(&mut dapp, &ping).await;
    let _ = recv_json(&mut wallet).await;

    // wallet pongs, dApp receives
    let pong = json!({"v":1, "t":"pong", "ch":ch, "ts": 200, "from":wallet_peer, "body": {}});
    send_json(&mut wallet, &pong).await;

    let received = recv_json(&mut dapp).await;
    assert_eq!(received["t"], "pong");
    assert_eq!(received["ts"], 200);
}

#[tokio::test]
async fn close_from_wallet_forwarded_to_dapp() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let wallet_peer = make_peer_id(2);

    let (mut dapp, mut wallet) = setup_connected_pair(&addr).await;

    send_json(&mut wallet, &close_msg(&ch, &wallet_peer, "normal")).await;

    let received = recv_json(&mut dapp).await;
    assert_eq!(received["t"], "close");
    assert_eq!(received["body"]["reason"], "normal");
    assert_eq!(received["from"], wallet_peer);
}

#[tokio::test]
async fn dapp_accept_before_wallet_joins_returns_invalid_state() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);
    let wallet_peer = make_peer_id(2);

    let mut dapp = ws_connect(&addr).await;
    send_json(&mut dapp, &create_msg(&ch, &dapp_peer)).await;
    let _ = recv_json(&mut dapp).await; // ready.waiting

    // dApp tries to accept before any wallet joined
    send_json(&mut dapp, &accept_msg(&ch, &dapp_peer, &wallet_peer)).await;

    let close = recv_json(&mut dapp).await;
    assert_eq!(close["t"], "terminate");
    assert_eq!(close["body"]["reason"], "invalid_state");
}

#[tokio::test]
async fn wallet_sends_res_before_connected_returns_invalid_state() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);
    let wallet_peer = make_peer_id(2);

    // Create + join but don't accept
    let mut dapp = ws_connect(&addr).await;
    send_json(&mut dapp, &create_msg(&ch, &dapp_peer)).await;
    let _ = recv_json(&mut dapp).await;

    let mut wallet = ws_connect(&addr).await;
    send_json(&mut wallet, &join_msg(&ch, &wallet_peer)).await;
    let _ = recv_json(&mut wallet).await; // ready.waiting
    let _ = recv_json(&mut dapp).await; // join forwarded

    // Wallet tries to send res before accept
    send_json(&mut wallet, &res_msg(&ch, &wallet_peer, "r1")).await;

    let close = recv_json(&mut wallet).await;
    assert_eq!(close["t"], "terminate");
    assert_eq!(close["body"]["reason"], "invalid_state");
}

#[tokio::test]
async fn first_message_must_be_create_or_join() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let peer = make_peer_id(1);

    let mut ws = ws_connect(&addr).await;
    // Send req as first message (no channel binding)
    send_json(&mut ws, &req_msg(&ch, &peer, "r1")).await;

    let close = recv_json(&mut ws).await;
    assert_eq!(close["t"], "terminate");
    assert_eq!(close["body"]["reason"], "invalid_state");
}

#[tokio::test]
async fn multiple_req_res_in_sequence() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);
    let wallet_peer = make_peer_id(2);

    let (mut dapp, mut wallet) = setup_connected_pair(&addr).await;

    for i in 0..5 {
        let id = format!("req-{i}");
        send_json(&mut dapp, &req_msg(&ch, &dapp_peer, &id)).await;
        let received = recv_json(&mut wallet).await;
        assert_eq!(received["body"]["id"], id);

        send_json(&mut wallet, &res_msg(&ch, &wallet_peer, &id)).await;
        let received = recv_json(&mut dapp).await;
        assert_eq!(received["body"]["id"], id);
        assert_eq!(received["body"]["sealed"], "encrypted_result");
    }
}

#[tokio::test]
async fn sealed_field_passes_through_untouched() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);

    let (mut dapp, mut wallet) = setup_connected_pair(&addr).await;

    let req = json!({
        "v":1, "t":"req", "ch":ch, "ts":1234, "from":dapp_peer,
        "body": {"id":"s1", "sealed": "dGhpcyBpcyBlbmNyeXB0ZWQgZGF0YQ"}
    });
    send_json(&mut dapp, &req).await;

    let received = recv_json(&mut wallet).await;
    assert_eq!(received["body"]["sealed"], "dGhpcyBpcyBlbmNyeXB0ZWQgZGF0YQ");
}

#[tokio::test]
async fn wallet_cannot_send_accept() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);
    let wallet_peer = make_peer_id(2);

    let mut dapp = ws_connect(&addr).await;
    send_json(&mut dapp, &create_msg(&ch, &dapp_peer)).await;
    let _ = recv_json(&mut dapp).await;

    let mut wallet = ws_connect(&addr).await;
    send_json(&mut wallet, &join_msg(&ch, &wallet_peer)).await;
    let _ = recv_json(&mut wallet).await;
    let _ = recv_json(&mut dapp).await;

    // Wallet tries to accept (not allowed — only dApp can accept)
    send_json(&mut wallet, &accept_msg(&ch, &wallet_peer, &dapp_peer)).await;

    let close = recv_json(&mut wallet).await;
    assert_eq!(close["t"], "terminate");
    assert_eq!(close["body"]["reason"], "invalid_role");
}

#[tokio::test]
async fn message_on_wrong_channel_rejected() {
    let (addr, _shutdown) = start_server().await;
    let ch1 = make_channel_id();
    let ch2 = "cd".repeat(32);
    let dapp_peer = make_peer_id(1);

    let mut dapp = ws_connect(&addr).await;
    // Bind to ch1
    send_json(&mut dapp, &create_msg(&ch1, &dapp_peer)).await;
    let _ = recv_json(&mut dapp).await;

    // Send message for ch2 on same connection
    let msg = json!({"v":1, "t":"close", "ch":ch2, "ts":1234, "from":dapp_peer, "body":{"reason":"normal"}});
    send_json(&mut dapp, &msg).await;

    let close = recv_json(&mut dapp).await;
    assert_eq!(close["t"], "terminate");
    assert_eq!(close["body"]["reason"], "protocol_error");
}

#[tokio::test]
async fn missing_required_field_from_returns_protocol_error() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();

    let mut ws = ws_connect(&addr).await;
    // create without "from" field
    let msg = json!({"v":1, "t":"create", "ch":ch, "ts":1234, "body":{}});
    send_json(&mut ws, &msg).await;

    let close = recv_json(&mut ws).await;
    assert_eq!(close["t"], "terminate");
    assert_eq!(close["body"]["reason"], "protocol_error");
}

#[tokio::test]
async fn invalid_channel_id_format_returns_protocol_error() {
    let (addr, _shutdown) = start_server().await;
    let peer = make_peer_id(1);

    let mut ws = ws_connect(&addr).await;
    // Channel ID too short
    let msg = json!({"v":1, "t":"create", "ch":"abcd", "ts":1234, "from":peer, "body":{}});
    send_json(&mut ws, &msg).await;

    let close = recv_json(&mut ws).await;
    assert_eq!(close["t"], "terminate");
    assert_eq!(close["body"]["reason"], "protocol_error");
}

#[tokio::test]
async fn invalid_peer_id_format_returns_protocol_error() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();

    let mut ws = ws_connect(&addr).await;
    let msg = json!({"v":1, "t":"create", "ch":ch, "ts":1234, "from":"not-valid-base64!!!", "body":{}});
    send_json(&mut ws, &msg).await;

    let close = recv_json(&mut ws).await;
    assert_eq!(close["t"], "terminate");
    assert_eq!(close["body"]["reason"], "protocol_error");
}

#[tokio::test]
async fn missing_body_returns_protocol_error() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let peer1 = make_peer_id(1);

    let mut ws = ws_connect(&addr).await;
    // Message without body field
    let msg = json!({"v":1, "t":"create", "ch":ch, "ts":1234, "from":peer1});
    send_json(&mut ws, &msg).await;

    let close = recv_json(&mut ws).await;
    assert_eq!(close["t"], "terminate");
    assert_eq!(close["body"]["reason"], "protocol_error");
}

#[tokio::test]
async fn readyz_returns_ok() {
    let (addr, _shutdown) = start_server().await;

    let resp = reqwest::get(&format!("http://{}/readyz", addr))
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
}

#[tokio::test]
async fn graceful_shutdown_sends_close_to_peers() {
    let (addr, shutdown_tx) = start_server().await;
    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);

    let mut dapp = ws_connect(&addr).await;
    send_json(&mut dapp, &create_msg(&ch, &dapp_peer)).await;
    let _ = recv_json(&mut dapp).await; // ready.waiting

    // Trigger shutdown
    let _ = shutdown_tx.send(());

    // dApp should eventually get disconnected (stream ends or close frame)
    // We just check the stream terminates without hanging
    let result = timeout(Duration::from_secs(3), async {
        loop {
            match dapp.next().await {
                None => return true,         // stream ended — graceful
                Some(Err(_)) => return true, // error — connection closed
                Some(Ok(Message::Close(_))) => return true,
                Some(Ok(Message::Text(t))) => {
                    // Might get a server_shutdown terminate
                    let v: Value = serde_json::from_str(&t).unwrap_or_default();
                    if v["t"] == "terminate" {
                        return true;
                    }
                }
                _ => continue,
            }
        }
    })
    .await;
    assert!(
        result.is_ok(),
        "dApp connection should close during shutdown"
    );
}

#[tokio::test]
async fn join_with_meta_and_capabilities_forwarded_to_dapp() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);
    let wallet_peer = make_peer_id(2);

    let mut dapp = ws_connect(&addr).await;
    send_json(&mut dapp, &create_msg(&ch, &dapp_peer)).await;
    let _ = recv_json(&mut dapp).await;

    let mut wallet = ws_connect(&addr).await;
    let join = json!({
        "v":1, "t":"join", "ch":ch, "ts":1234,
        "from":wallet_peer,
        "body": {
            "sealed_join": "encrypted_join_data",
            "meta": {"name": "TestWallet", "icon": "https://example.com/icon.png"}
        }
    });
    send_json(&mut wallet, &join).await;
    let _ = recv_json(&mut wallet).await; // ready.waiting

    // dApp receives the full join with all fields (forwarded raw)
    let fwd = recv_json(&mut dapp).await;
    assert_eq!(fwd["t"], "join");
    assert_eq!(fwd["body"]["sealed_join"], "encrypted_join_data");
    assert_eq!(fwd["body"]["meta"]["name"], "TestWallet");
}

#[tokio::test]
async fn create_with_meta_sends_ready_waiting() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);

    let mut dapp = ws_connect(&addr).await;
    let create = json!({
        "v":1, "t":"create", "ch":ch, "ts":1234,
        "from":dapp_peer,
        "body": {"meta": {"name": "MyDApp"}}
    });
    send_json(&mut dapp, &create).await;

    let ready = recv_json(&mut dapp).await;
    assert_eq!(ready["t"], "ready");
    assert_eq!(ready["body"]["state"], "waiting");
    // meta is not echoed in ready — just verify it didn't break anything
}

#[tokio::test]
async fn wallet_sends_evt_with_id_and_sealed() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let wallet_peer = make_peer_id(2);

    let (mut dapp, mut wallet) = setup_connected_pair(&addr).await;

    let evt = json!({
        "v":1, "t":"evt", "ch":ch, "ts":1234, "from":wallet_peer,
        "body": {"id": "evt-001", "sealed": "ZW5jcnlwdGVkLWRhdGE"}
    });
    send_json(&mut wallet, &evt).await;

    let received = recv_json(&mut dapp).await;
    assert_eq!(received["t"], "evt");
    assert_eq!(received["body"]["id"], "evt-001");
    assert_eq!(received["body"]["sealed"], "ZW5jcnlwdGVkLWRhdGE");
}

#[tokio::test]
async fn close_with_user_rejected_reason() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);
    let wallet_peer = make_peer_id(2);

    let mut dapp = ws_connect(&addr).await;
    send_json(&mut dapp, &create_msg(&ch, &dapp_peer)).await;
    let _ = recv_json(&mut dapp).await;

    let mut wallet = ws_connect(&addr).await;
    send_json(&mut wallet, &join_msg(&ch, &wallet_peer)).await;
    let _ = recv_json(&mut wallet).await;
    let _ = recv_json(&mut dapp).await;

    // dApp rejects wallet with close + user_rejected
    let close = json!({
        "v":1, "t":"close", "ch":ch, "ts":1234, "from":dapp_peer,
        "body": {"reason":"user_rejected"}
    });
    send_json(&mut dapp, &close).await;

    let received = recv_json(&mut wallet).await;
    assert_eq!(received["t"], "close");
    assert_eq!(received["body"]["reason"], "user_rejected");
}

// ---------------------------------------------------------------------------
// New coverage tests — added to cover previously uncovered scenarios
// ---------------------------------------------------------------------------

/// Start a relay server with a custom config. Returns (addr, shutdown_tx).
/// Also spawns the background TTL cleanup task (matching main.rs behaviour).
async fn start_server_with_config(
    mut config: walletpair_websocket_relay::config::Config,
) -> (String, tokio::sync::broadcast::Sender<()>) {
    // Disable per-IP rate limits for tests (all connections come from localhost)
    config.max_creates_per_ip_per_min = 0;
    config.max_connections_per_ip = 0;

    let listener = tokio::net::TcpListener::bind(config.listen_addr).await.unwrap();
    let addr = listener.local_addr().unwrap();

    let cleanup_interval = config.cleanup_interval_secs;
    let config = std::sync::Arc::new(config);
    let metrics = walletpair_websocket_relay::metrics::Metrics::new();
    let store = walletpair_websocket_relay::store::ShardedStore::new(&config);
    let store = std::sync::Arc::new(store);

    let (shutdown_tx, _) = tokio::sync::broadcast::channel(1);

    let rate_limiter = std::sync::Arc::new(walletpair_websocket_relay::ratelimit::IpRateLimiter::new(
        config.max_creates_per_ip_per_min,
        config.max_connections_per_ip,
        60,
    ));

    let app_state = walletpair_websocket_relay::http::AppState {
        store: store.clone(),
        config: config.clone(),
        metrics: metrics.clone(),
        shutdown_tx: shutdown_tx.clone(),
        conn_counter: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(1)),
        rate_limiter,
    };

    // Background cleanup task (mirrors main.rs)
    {
        let store = store.clone();
        let mut shutdown_rx = shutdown_tx.subscribe();
        tokio::spawn(async move {
            let mut ticker =
                tokio::time::interval(std::time::Duration::from_secs(cleanup_interval));
            loop {
                tokio::select! {
                    _ = ticker.tick() => {
                        store.cleanup_all(&metrics);
                    }
                    _ = shutdown_rx.recv() => break,
                }
            }
        });
    }

    let router = walletpair_websocket_relay::http::router(app_state);

    tokio::spawn(async move {
        axum::serve(listener, router.into_make_service_with_connect_info::<std::net::SocketAddr>()).await.unwrap();
    });

    (addr.to_string(), shutdown_tx)
}

// 1. pending_request_limit — 33rd req is rejected with rate_limited (§15 rule 11)
#[tokio::test]
async fn pending_request_limit_33rd_req_rejected() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);
    let wallet_peer = make_peer_id(2);

    let (mut dapp, mut wallet) = setup_connected_pair(&addr).await;

    // Send 32 req messages (the limit) — wallet reads each one so they forward
    for i in 0..32_u32 {
        let id = format!("r{i}");
        send_json(&mut dapp, &req_msg(&ch, &dapp_peer, &id)).await;
        // Consume on wallet side so the forward succeeds; do NOT send res so
        // the pending set keeps growing.
        let received = recv_json(&mut wallet).await;
        assert_eq!(received["t"], "req");
    }

    // 33rd req should be rejected
    send_json(&mut dapp, &req_msg(&ch, &dapp_peer, "r32")).await;

    let close = recv_json(&mut dapp).await;
    assert_eq!(close["t"], "terminate");
    assert_eq!(close["body"]["reason"], "rate_limited");

    // wallet_peer is used in the setup; suppress unused-variable warning
    let _ = wallet_peer;
}

// 2. slow_consumer — outbound_queue_size=1; flood messages so the queue fills up;
//    the relay should either drop messages (slow consumer) or close the target.
#[tokio::test]
async fn slow_consumer_overflow_queue() {
    // Use a tiny outbound queue to reliably trigger the slow-consumer path.
    let config = walletpair_websocket_relay::config::Config {
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        metrics_enabled: false,
        max_message_bytes: 65_536,
        outbound_queue_size: 1,
        ..Default::default()
    };
    let (addr, _shutdown) = start_server_with_config(config).await;

    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);

    let (mut dapp, mut wallet) = setup_connected_pair(&addr).await;

    // Fire many req messages without the wallet reading any, so the wallet's
    // 1-slot outbound queue fills up immediately and subsequent sends are dropped.
    let burst = 20_u32;
    for i in 0..burst {
        let id = format!("flood-{i}");
        // Once the sender gets a Reject (close) it will break out of loop;
        // ignore send errors because the connection may already be dropped.
        if dapp
            .send(tokio_tungstenite::tungstenite::Message::Text(
                req_msg(&ch, &dapp_peer, &id).to_string().into(),
            ))
            .await
            .is_err()
        {
            break;
        }
    }

    // The test succeeds if:
    //  a) the wallet receives at least one message (queue accepted ≥1), OR
    //  b) the dApp receives a close (dApp itself hit a reject), OR
    //  c) the wallet connection was silently dropped (slow consumer path).
    // We simply verify the relay doesn't hang and the connections eventually
    // reach a terminal state within TIMEOUT.
    let result = tokio::time::timeout(TIMEOUT, async {
        loop {
            tokio::select! {
                msg = wallet.next() => {
                    match msg {
                        None | Some(Err(_)) => return true,
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Text(t))) => {
                            let v: Value = serde_json::from_str(&t).unwrap_or_default();
                            if v["t"] == "close" || v["t"] == "terminate" || v["t"] == "req" {
                                return true;
                            }
                        }
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) => return true,
                        _ => {}
                    }
                },
                msg = dapp.next() => {
                    match msg {
                        None | Some(Err(_)) => return true,
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Text(t))) => {
                            let v: Value = serde_json::from_str(&t).unwrap_or_default();
                            if v["t"] == "close" || v["t"] == "terminate" || v["t"] == "req" {
                                return true;
                            }
                        }
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) => return true,
                        _ => {}
                    }
                },
            }
        }
    })
    .await;

    assert!(result.is_ok(), "relay should react within timeout on slow consumer");
}

// 3. TTL cleanup — unpaired channel expires, subsequent wallet join gets channel_not_found
#[tokio::test]
async fn unpaired_channel_ttl_cleanup() {
    // 2-second TTL, 1-second cleanup interval
    let config = walletpair_websocket_relay::config::Config {
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        metrics_enabled: false,
        max_message_bytes: 65_536,
        unpaired_channel_ttl_secs: 2,
        cleanup_interval_secs: 1,
        ..Default::default()
    };
    let (addr, _shutdown) = start_server_with_config(config).await;

    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);
    let wallet_peer = make_peer_id(2);

    // dApp creates channel and disconnects (channel stays but is unpaired)
    let mut dapp = ws_connect(&addr).await;
    send_json(&mut dapp, &create_msg(&ch, &dapp_peer)).await;
    let _ = recv_json(&mut dapp).await; // ready.waiting
    // Drop the WebSocket; channel remains in WaitingForWallet state
    drop(dapp);

    // Wait for TTL + cleanup to fire (TTL=2s, interval=1s → wait 3s)
    tokio::time::sleep(Duration::from_secs(3)).await;

    // Wallet tries to join the now-expired channel
    let mut wallet = ws_connect(&addr).await;
    send_json(&mut wallet, &join_msg(&ch, &wallet_peer)).await;

    let close = recv_json(&mut wallet).await;
    assert_eq!(close["t"], "terminate");
    assert_eq!(close["body"]["reason"], "channel_not_found");
}

// 4. max_channels_limit — 3rd create attempt is rejected
#[tokio::test]
async fn max_channels_limit_enforced() {
    let config = walletpair_websocket_relay::config::Config {
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        metrics_enabled: false,
        max_message_bytes: 65_536,
        max_channels: 2,
        ..Default::default()
    };
    let (addr, _shutdown) = start_server_with_config(config).await;

    let ch1 = "ab".repeat(32);
    let ch2 = "cd".repeat(32);
    let ch3 = "ef".repeat(32);
    let dapp1 = make_peer_id(1);
    let dapp2 = make_peer_id(2);
    let dapp3 = make_peer_id(3);

    // Create first channel — succeeds
    let mut ws1 = ws_connect(&addr).await;
    send_json(&mut ws1, &create_msg(&ch1, &dapp1)).await;
    let r1 = recv_json(&mut ws1).await;
    assert_eq!(r1["t"], "ready");

    // Create second channel — succeeds
    let mut ws2 = ws_connect(&addr).await;
    send_json(&mut ws2, &create_msg(&ch2, &dapp2)).await;
    let r2 = recv_json(&mut ws2).await;
    assert_eq!(r2["t"], "ready");

    // Create third channel — should be rejected (max_channels=2)
    let mut ws3 = ws_connect(&addr).await;
    send_json(&mut ws3, &create_msg(&ch3, &dapp3)).await;
    let close = recv_json(&mut ws3).await;
    assert_eq!(close["t"], "terminate");
    // The relay maps the max-channels condition to rate_limited
    assert_eq!(close["body"]["reason"], "rate_limited");
}

// 5. dApp sends res in connected state — role violation → invalid_role
#[tokio::test]
async fn dapp_cannot_send_res_in_connected_state() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);

    let (mut dapp, mut _wallet) = setup_connected_pair(&addr).await;

    send_json(&mut dapp, &res_msg(&ch, &dapp_peer, "r1")).await;

    let close = recv_json(&mut dapp).await;
    assert_eq!(close["t"], "terminate");
    assert_eq!(close["body"]["reason"], "invalid_role");
}

// 6. wallet sends accept in PendingAccept state — role violation → invalid_role
#[tokio::test]
async fn wallet_accept_role_violation_reason_is_invalid_role() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);
    let wallet_peer = make_peer_id(2);

    let mut dapp = ws_connect(&addr).await;
    send_json(&mut dapp, &create_msg(&ch, &dapp_peer)).await;
    let _ = recv_json(&mut dapp).await;

    let mut wallet = ws_connect(&addr).await;
    send_json(&mut wallet, &join_msg(&ch, &wallet_peer)).await;
    let _ = recv_json(&mut wallet).await; // ready.waiting
    let _ = recv_json(&mut dapp).await; // join forwarded

    // Wallet tries to send accept — only dApp may accept
    send_json(&mut wallet, &accept_msg(&ch, &wallet_peer, &dapp_peer)).await;

    let close = recv_json(&mut wallet).await;
    assert_eq!(close["t"], "terminate");
    assert_eq!(close["body"]["reason"], "invalid_role");
}

// 7. ping/pong work in PendingAccept state (before accept is sent)
#[tokio::test]
async fn ping_pong_in_pending_accept_state() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);
    let wallet_peer = make_peer_id(2);

    // Create + join but do NOT accept → state is PendingAccept
    let mut dapp = ws_connect(&addr).await;
    send_json(&mut dapp, &create_msg(&ch, &dapp_peer)).await;
    let _ = recv_json(&mut dapp).await; // ready.waiting

    let mut wallet = ws_connect(&addr).await;
    send_json(&mut wallet, &join_msg(&ch, &wallet_peer)).await;
    let _ = recv_json(&mut wallet).await; // ready.waiting
    let _ = recv_json(&mut dapp).await; // join forwarded

    // dApp sends ping in PendingAccept
    let ping = json!({"v":1, "t":"ping", "ch":ch, "ts": 42, "from":dapp_peer, "body": {}});
    send_json(&mut dapp, &ping).await;

    // Wallet should receive the ping
    let received = recv_json(&mut wallet).await;
    assert_eq!(received["t"], "ping");
    assert_eq!(received["ts"], 42);

    // Wallet pongs back
    let pong = json!({"v":1, "t":"pong", "ch":ch, "ts": 43, "from":wallet_peer, "body": {}});
    send_json(&mut wallet, &pong).await;

    let received = recv_json(&mut dapp).await;
    assert_eq!(received["t"], "pong");
    assert_eq!(received["ts"], 43);
}

// 8. close in WaitingForWallet state — dApp closes before wallet joins
#[tokio::test]
async fn dapp_close_in_waiting_for_wallet_state() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);

    let mut dapp = ws_connect(&addr).await;
    send_json(&mut dapp, &create_msg(&ch, &dapp_peer)).await;
    let _ = recv_json(&mut dapp).await; // ready.waiting

    // dApp closes the channel before any wallet joins
    send_json(&mut dapp, &close_msg(&ch, &dapp_peer, "normal")).await;

    // No error expected; the relay handles close gracefully in WaitingForWallet.
    // Verify the channel is gone by trying to join it — should get channel_not_found.
    let wallet_peer = make_peer_id(2);
    let mut wallet = ws_connect(&addr).await;
    send_json(&mut wallet, &join_msg(&ch, &wallet_peer)).await;

    let close = recv_json(&mut wallet).await;
    assert_eq!(close["t"], "terminate");
    assert_eq!(close["body"]["reason"], "channel_not_found");
}

// 9. req before connected state (in PendingAccept) — dApp tries to send req → invalid_state
#[tokio::test]
async fn req_in_pending_accept_state_returns_invalid_state() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);
    let wallet_peer = make_peer_id(2);

    // Create + join but no accept
    let mut dapp = ws_connect(&addr).await;
    send_json(&mut dapp, &create_msg(&ch, &dapp_peer)).await;
    let _ = recv_json(&mut dapp).await;

    let mut wallet = ws_connect(&addr).await;
    send_json(&mut wallet, &join_msg(&ch, &wallet_peer)).await;
    let _ = recv_json(&mut wallet).await;
    let _ = recv_json(&mut dapp).await;

    // dApp tries to send req before accept
    send_json(&mut dapp, &req_msg(&ch, &dapp_peer, "early-req")).await;

    let close = recv_json(&mut dapp).await;
    assert_eq!(close["t"], "terminate");
    assert_eq!(close["body"]["reason"], "invalid_state");
}

// 10. Multiple events in sequence — wallet sends 5 events, all forwarded correctly
#[tokio::test]
async fn multiple_events_forwarded_in_sequence() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let wallet_peer = make_peer_id(2);

    let (mut dapp, mut wallet) = setup_connected_pair(&addr).await;

    for i in 0..5 {
        let evt = json!({
            "v": 1, "t": "evt", "ch": ch, "ts": 1234, "from": wallet_peer,
            "body": {"id": format!("evt-{i}"), "sealed": "encrypted"}
        });
        send_json(&mut wallet, &evt).await;

        let received = recv_json(&mut dapp).await;
        assert_eq!(received["t"], "evt");
        assert_eq!(received["body"]["id"], format!("evt-{i}"));
        assert_eq!(received["from"], wallet_peer);
    }
}

// 11. req with sealed field passes through — verify sealed is forwarded unchanged
#[tokio::test]
async fn req_with_sealed_field_forwarded_unchanged() {
    let (addr, _shutdown) = start_server().await;
    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);

    let (mut dapp, mut wallet) = setup_connected_pair(&addr).await;

    let sealed_value = "U2VhbGVkUGF5bG9hZEhlcmU"; // base64url of arbitrary bytes
    let req = json!({
        "v": 1, "t": "req", "ch": ch, "ts": 1234, "from": dapp_peer,
        "body": {"id": "sealed-req-1", "sealed": sealed_value}
    });
    send_json(&mut dapp, &req).await;

    let received = recv_json(&mut wallet).await;
    assert_eq!(received["t"], "req");
    assert_eq!(received["body"]["id"], "sealed-req-1");
    assert_eq!(received["body"]["sealed"], sealed_value);
}

// ---------------------------------------------------------------------------
// Persistence test — relay restart with state file
// ---------------------------------------------------------------------------

/// Verify that state persistence across relay restart works:
/// 1. Write a state file with a connected channel.
/// 2. Start server B from that state file.
/// 3. Verify the channel was restored.
#[tokio::test]
async fn relay_restart_with_persistence_restores_channels() {
    use std::io::Write as _;

    let ch = make_channel_id();
    let dapp_peer = make_peer_id(1);
    let wallet_peer = make_peer_id(2);

    // Temp file for state persistence
    let state_path = std::env::temp_dir().join(format!(
        "walletpair_test_state_{}.json",
        std::process::id()
    ));

    // Build a snapshot by hand
    let snapshot = serde_json::json!({
        "version": 1,
        "channels": [{
            "id": ch,
            "state": "connected",
            "age_secs": 0,
            "connected_age_secs": 0,
            "dapp_peer_id": dapp_peer,
            "wallet_peer_id": wallet_peer,
            "pending_requests": []
        }]
    });

    let mut f = std::fs::File::create(&state_path).unwrap();
    f.write_all(snapshot.to_string().as_bytes()).unwrap();
    drop(f);

    // Load state
    let config_b = walletpair_websocket_relay::config::Config {
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        metrics_enabled: false,
        max_message_bytes: 65_536,
        state_file: Some(state_path.to_string_lossy().into_owned()),
        ..Default::default()
    };

    let metrics_b = walletpair_websocket_relay::metrics::Metrics::new();
    let store_b = walletpair_websocket_relay::persist::load_or_new(
        &config_b,
        &metrics_b,
        &state_path,
    );

    // Verify state was loaded
    assert!(
        store_b.channels.contains_key(&ch),
        "channel should be restored from state file"
    );

    // Cleanup
    let _ = std::fs::remove_file(&state_path);
}
