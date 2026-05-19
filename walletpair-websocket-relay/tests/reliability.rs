//! Reliability tests for WalletPair WebSocket Relay.
//!
//! These tests exercise edge cases related to resource lifecycle, concurrent
//! access, and failure modes. They run as part of the normal test suite but
//! are deterministic (no long sleeps or external dependencies).

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

const TIMEOUT: Duration = Duration::from_secs(5);

fn make_peer_id(byte: u8) -> String {
    URL_SAFE_NO_PAD.encode([byte; 32])
}

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn start_server_custom(
    config: walletpair_websocket_relay::config::Config,
) -> (String, tokio::sync::broadcast::Sender<()>) {
    let listener = TcpListener::bind(config.listen_addr).await.unwrap();
    let addr = listener.local_addr().unwrap();

    let cleanup_interval = config.cleanup_interval_secs;
    let config = Arc::new(config);
    let metrics = walletpair_websocket_relay::metrics::Metrics::new();
    let store = Arc::new(walletpair_websocket_relay::store::ShardedStore::new(&config));

    let (shutdown_tx, _) = tokio::sync::broadcast::channel(1);

    let app_state = walletpair_websocket_relay::http::AppState {
        store: store.clone(),
        config: config.clone(),
        metrics: metrics.clone(),
        shutdown_tx: shutdown_tx.clone(),
        conn_counter: Arc::new(AtomicU64::new(1)),
    };

    // Background cleanup
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
        axum::serve(listener, router).await.unwrap();
    });

    (addr.to_string(), shutdown_tx)
}

async fn start_default_server() -> (String, tokio::sync::broadcast::Sender<()>) {
    start_server_custom(walletpair_websocket_relay::config::Config {
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        metrics_enabled: true,
        ..Default::default()
    })
    .await
}

async fn ws_connect(addr: &str) -> WsStream {
    let url = format!("ws://{}/v1", addr);
    let (ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    ws
}

async fn send_json(ws: &mut WsStream, val: &Value) {
    ws.send(Message::Text(val.to_string().into()))
        .await
        .unwrap();
}

async fn recv_json(ws: &mut WsStream) -> Value {
    let msg = timeout(TIMEOUT, ws.next())
        .await
        .expect("timeout")
        .expect("stream ended")
        .expect("read error");
    match msg {
        Message::Text(t) => serde_json::from_str(&t).expect("not json"),
        other => panic!("expected text, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// Rapidly create and close many channels to verify no channel leak.
#[tokio::test]
async fn rapid_create_close_no_channel_leak() {
    let (addr, _shutdown) = start_default_server().await;

    for i in 0u32..100 {
        let ch = format!("{:064x}", i);
        let peer = make_peer_id((i % 255) as u8 + 1);

        let mut ws = ws_connect(&addr).await;
        send_json(
            &mut ws,
            &json!({"v":1,"t":"create","ch":ch,"from":peer,"pubkey":peer}),
        )
        .await;
        let r = recv_json(&mut ws).await;
        assert_eq!(r["t"], "ready");

        // Close immediately
        send_json(
            &mut ws,
            &json!({"v":1,"t":"close","ch":ch,"from":peer,"reason":"normal"}),
        )
        .await;
        // Allow connection to flush
        let _ = ws.close(None).await;
    }

    // Check metrics: active_channels should be 0 (or very close)
    tokio::time::sleep(Duration::from_millis(100)).await;
    let resp = reqwest::get(&format!("http://{}/metrics", addr))
        .await
        .unwrap();
    let body = resp.text().await.unwrap();
    let active = body
        .lines()
        .find(|l| l.starts_with("walletpair_active_channels "))
        .and_then(|l| l.split_whitespace().last())
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(-1);

    assert_eq!(active, 0, "all channels should be cleaned up, got {active}");
}

/// Create channels, let them expire via TTL, verify cleanup removes them.
#[tokio::test]
async fn ttl_cleanup_removes_expired_channels() {
    let config = walletpair_websocket_relay::config::Config {
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        metrics_enabled: true,
        unpaired_channel_ttl_secs: 1,
        cleanup_interval_secs: 1,
        ..Default::default()
    };
    let (addr, _shutdown) = start_server_custom(config).await;

    // Create 10 channels, don't join them
    for i in 0u32..10 {
        let ch = format!("{:064x}", i);
        let peer = make_peer_id((i % 255) as u8 + 1);
        let mut ws = ws_connect(&addr).await;
        send_json(
            &mut ws,
            &json!({"v":1,"t":"create","ch":ch,"from":peer,"pubkey":peer}),
        )
        .await;
        let _ = recv_json(&mut ws).await;
        // Drop ws without closing — channel remains in WaitingForWallet
    }

    // Wait for TTL + cleanup
    tokio::time::sleep(Duration::from_secs(3)).await;

    // All channels should be cleaned up
    let resp = reqwest::get(&format!("http://{}/metrics", addr))
        .await
        .unwrap();
    let body = resp.text().await.unwrap();
    let active = body
        .lines()
        .find(|l| l.starts_with("walletpair_active_channels "))
        .and_then(|l| l.split_whitespace().last())
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(-1);

    assert_eq!(active, 0, "expired channels should be cleaned up, got {active}");
}

/// WebSocket connection drops abruptly (no close frame). Relay should handle gracefully.
#[tokio::test]
async fn abrupt_disconnect_handled_gracefully() {
    let (addr, _shutdown) = start_default_server().await;
    let ch = "ab".repeat(32);
    let dapp = make_peer_id(1);
    let wallet = make_peer_id(2);

    // dApp creates channel
    let mut dapp_ws = ws_connect(&addr).await;
    send_json(
        &mut dapp_ws,
        &json!({"v":1,"t":"create","ch":ch,"from":dapp,"pubkey":dapp}),
    )
    .await;
    let _ = recv_json(&mut dapp_ws).await;

    // Wallet joins
    let mut wallet_ws = ws_connect(&addr).await;
    send_json(
        &mut wallet_ws,
        &json!({"v":1,"t":"join","ch":ch,"from":wallet,"pubkey":wallet,
            "capabilities":{"methods":[],"events":[],"chains":[]}}),
    )
    .await;
    let _ = recv_json(&mut wallet_ws).await;
    let _ = recv_json(&mut dapp_ws).await;

    // Accept
    send_json(
        &mut dapp_ws,
        &json!({"v":1,"t":"accept","ch":ch,"from":dapp,"target":wallet}),
    )
    .await;
    let _ = recv_json(&mut dapp_ws).await;
    let dapp_resume = recv_json(&mut wallet_ws).await["resume"]
        .as_str()
        .unwrap()
        .to_string();

    // Drop wallet abruptly (no close frame)
    drop(wallet_ws);
    tokio::task::yield_now().await;

    // dApp should still be able to reconnect and the channel should survive
    // Try sending req — other peer not connected, message will be dropped silently
    send_json(
        &mut dapp_ws,
        &json!({"v":1,"t":"req","ch":ch,"from":dapp,"id":"test","method":"m","sealed":"x"}),
    )
    .await;

    // No panic, no hang — the relay handles the missing peer gracefully.
    // Give it a moment and verify the connection is still alive
    tokio::time::sleep(Duration::from_millis(100)).await;

    // dApp can still send close
    send_json(
        &mut dapp_ws,
        &json!({"v":1,"t":"close","ch":ch,"from":dapp,"reason":"normal"}),
    )
    .await;

    let _ = dapp_resume; // suppress unused warning
}

/// Multiple invalid JSON messages don't crash the server.
#[tokio::test]
async fn flood_invalid_json_no_crash() {
    let (addr, _shutdown) = start_default_server().await;

    for _ in 0..50 {
        let mut ws = ws_connect(&addr).await;
        ws.send(Message::Text("{{{{invalid".into())).await.unwrap();
        // Expect close with protocol_error
        let msg = timeout(TIMEOUT, ws.next()).await;
        if let Ok(Some(Ok(Message::Text(t)))) = msg {
            let v: Value = serde_json::from_str(&t).unwrap();
            assert_eq!(v["reason"], "protocol_error");
        }
    }

    // Server should still be healthy
    let resp = reqwest::get(&format!("http://{}/healthz", addr))
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
}

/// Concurrent create + join on different channels should all succeed.
#[tokio::test]
async fn concurrent_channel_creation() {
    let (addr, _shutdown) = start_default_server().await;
    let addr = Arc::new(addr);

    let mut handles = Vec::new();
    for i in 0u32..50 {
        let addr = addr.clone();
        handles.push(tokio::spawn(async move {
            let ch = format!("{:064x}", i);
            let dapp = URL_SAFE_NO_PAD.encode([(i * 2) as u8 + 1; 32]);
            let wallet = URL_SAFE_NO_PAD.encode([(i * 2 + 1) as u8 + 1; 32]);

            let mut dapp_ws = ws_connect(&addr).await;
            send_json(
                &mut dapp_ws,
                &json!({"v":1,"t":"create","ch":ch,"from":dapp,"pubkey":dapp}),
            )
            .await;
            let r = recv_json(&mut dapp_ws).await;
            assert_eq!(r["t"], "ready", "channel {i}: expected ready, got {r}");

            let mut wallet_ws = ws_connect(&addr).await;
            send_json(
                &mut wallet_ws,
                &json!({"v":1,"t":"join","ch":ch,"from":wallet,"pubkey":wallet,
                    "capabilities":{"methods":[],"events":[],"chains":[]}}),
            )
            .await;
            let r = recv_json(&mut wallet_ws).await;
            assert_eq!(r["t"], "ready", "channel {i}: wallet expected ready");

            // Close
            send_json(
                &mut dapp_ws,
                &json!({"v":1,"t":"close","ch":ch,"from":dapp,"reason":"normal"}),
            )
            .await;
        }));
    }

    for h in handles {
        h.await.unwrap();
    }

    // Verify server health
    let resp = reqwest::get(&format!("http://{}/healthz", addr))
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
}

/// Graceful shutdown sends close to all connected peers.
#[tokio::test]
async fn graceful_shutdown_closes_all_channels() {
    let (addr, shutdown_tx) = start_default_server().await;

    // Create 5 channels, all in Connected state
    let mut connections = Vec::new();
    for i in 0u8..5 {
        let ch = format!("{:064x}", i as u32);
        let dapp = URL_SAFE_NO_PAD.encode([i * 2 + 1; 32]);
        let wallet = URL_SAFE_NO_PAD.encode([i * 2 + 2; 32]);

        let mut dapp_ws = ws_connect(&addr).await;
        send_json(
            &mut dapp_ws,
            &json!({"v":1,"t":"create","ch":ch,"from":dapp,"pubkey":dapp}),
        )
        .await;
        let _ = recv_json(&mut dapp_ws).await;

        let mut wallet_ws = ws_connect(&addr).await;
        send_json(
            &mut wallet_ws,
            &json!({"v":1,"t":"join","ch":ch,"from":wallet,"pubkey":wallet,
                "capabilities":{"methods":[],"events":[],"chains":[]}}),
        )
        .await;
        let _ = recv_json(&mut wallet_ws).await;
        let _ = recv_json(&mut dapp_ws).await;

        send_json(
            &mut dapp_ws,
            &json!({"v":1,"t":"accept","ch":ch,"from":dapp,"target":wallet}),
        )
        .await;
        let _ = recv_json(&mut dapp_ws).await;
        let _ = recv_json(&mut wallet_ws).await;

        connections.push((dapp_ws, wallet_ws));
    }

    // Signal shutdown
    let _ = shutdown_tx.send(());

    // All connections should terminate within timeout
    for (mut dapp_ws, mut wallet_ws) in connections {
        let r = timeout(Duration::from_secs(3), async {
            loop {
                match dapp_ws.next().await {
                    None | Some(Err(_)) => return true,
                    Some(Ok(Message::Close(_))) => return true,
                    Some(Ok(Message::Text(t))) => {
                        let v: Value = serde_json::from_str(&t).unwrap_or_default();
                        if v["t"] == "close" {
                            return true;
                        }
                    }
                    _ => continue,
                }
            }
        })
        .await;
        assert!(r.is_ok(), "dApp should receive close or stream end");

        let r = timeout(Duration::from_secs(3), async {
            loop {
                match wallet_ws.next().await {
                    None | Some(Err(_)) => return true,
                    Some(Ok(Message::Close(_))) => return true,
                    Some(Ok(Message::Text(t))) => {
                        let v: Value = serde_json::from_str(&t).unwrap_or_default();
                        if v["t"] == "close" {
                            return true;
                        }
                    }
                    _ => continue,
                }
            }
        })
        .await;
        assert!(r.is_ok(), "wallet should receive close or stream end");
    }
}

/// Metrics endpoint works under concurrent load.
#[tokio::test]
async fn metrics_accessible_during_activity() {
    let (addr, _shutdown) = start_default_server().await;
    let addr = Arc::new(addr);

    // Start some WebSocket activity
    let addr_clone = addr.clone();
    let activity = tokio::spawn(async move {
        for i in 0u32..20 {
            let ch = format!("{:064x}", i);
            let peer = URL_SAFE_NO_PAD.encode([(i % 255) as u8 + 1; 32]);
            let mut ws = ws_connect(&addr_clone).await;
            send_json(
                &mut ws,
                &json!({"v":1,"t":"create","ch":ch,"from":peer,"pubkey":peer}),
            )
            .await;
            let _ = recv_json(&mut ws).await;
        }
    });

    // Concurrently hit the metrics endpoint
    for _ in 0..10 {
        let resp = reqwest::get(&format!("http://{}/metrics", addr))
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let body = resp.text().await.unwrap();
        assert!(body.contains("walletpair_active_channels"));
    }

    let _ = activity.await;
}
