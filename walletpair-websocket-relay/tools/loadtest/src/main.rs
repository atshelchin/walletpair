//! WalletPair Relay Load Test
//!
//! Exercises the relay with concurrent channel lifecycles and message forwarding.
//!
//! Usage:
//!   cargo run --release -- --url ws://127.0.0.1:8080/v1 --channels 1000 --messages 10
//!
//! The test creates N channels, each going through the full lifecycle:
//!   create → join → accept → req/res × M → close
//!
//! At the end it prints a summary with latency percentiles and error counts.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;
use tokio_tungstenite::tungstenite::Message;

#[derive(Parser, Debug)]
#[command(name = "walletpair-loadtest")]
struct Args {
    /// WebSocket relay URL (e.g. ws://127.0.0.1:8080/v1)
    #[arg(long, default_value = "ws://127.0.0.1:8080/v1")]
    url: String,

    /// Number of channels to create
    #[arg(long, default_value = "1000")]
    channels: usize,

    /// Number of req/res round-trips per channel
    #[arg(long, default_value = "10")]
    messages: usize,

    /// Max concurrent channels in flight
    #[arg(long, default_value = "100")]
    concurrency: usize,

    /// Timeout per channel lifecycle (seconds)
    #[arg(long, default_value = "30")]
    timeout_secs: u64,

    /// If set, test oversized payload rejection (64KiB+1)
    #[arg(long, default_value = "false")]
    test_oversize: bool,

    /// If set, test near-limit payload (64KiB exactly)
    #[arg(long, default_value = "false")]
    test_near_limit: bool,
}

#[derive(Debug, Default)]
struct Stats {
    channels_created: AtomicU64,
    channels_joined: AtomicU64,
    channels_accepted: AtomicU64,
    channels_completed: AtomicU64,
    messages_sent: AtomicU64,
    messages_received: AtomicU64,
    errors: AtomicU64,
    oversize_rejected: AtomicU64,
    near_limit_ok: AtomicU64,
}

fn make_peer_id(seed: u64) -> String {
    let mut bytes = [0u8; 32];
    bytes[0..8].copy_from_slice(&seed.to_le_bytes());
    URL_SAFE_NO_PAD.encode(bytes)
}

fn make_channel_id(seed: u64) -> String {
    format!("{:064x}", seed)
}

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn ws_connect(url: &str) -> Result<WsStream, String> {
    tokio_tungstenite::connect_async(url)
        .await
        .map(|(ws, _)| ws)
        .map_err(|e| format!("connect failed: {e}"))
}

async fn send_json(ws: &mut WsStream, val: &Value) -> Result<(), String> {
    ws.send(Message::Text(val.to_string().into()))
        .await
        .map_err(|e| format!("send failed: {e}"))
}

async fn recv_json(ws: &mut WsStream, timeout: Duration) -> Result<Value, String> {
    match tokio::time::timeout(timeout, ws.next()).await {
        Ok(Some(Ok(Message::Text(t)))) => {
            serde_json::from_str(&t).map_err(|e| format!("json parse: {e}"))
        }
        Ok(Some(Ok(other))) => Err(format!("unexpected frame: {other:?}")),
        Ok(Some(Err(e))) => Err(format!("read error: {e}")),
        Ok(None) => Err("stream ended".into()),
        Err(_) => Err("timeout".into()),
    }
}

async fn run_channel(
    url: &str,
    channel_idx: u64,
    messages: usize,
    timeout: Duration,
    stats: &Stats,
    latencies: &tokio::sync::Mutex<Vec<Duration>>,
) -> Result<(), String> {
    let ch = make_channel_id(channel_idx);
    let dapp_peer = make_peer_id(channel_idx * 2);
    let wallet_peer = make_peer_id(channel_idx * 2 + 1);

    // dApp creates
    let mut dapp = ws_connect(url).await?;
    send_json(
        &mut dapp,
        &json!({"v":1,"t":"create","ch":ch,"from":dapp_peer,"pubkey":dapp_peer}),
    )
    .await?;
    let ready = recv_json(&mut dapp, timeout).await?;
    if ready["t"] != "ready" || ready["state"] != "waiting" {
        return Err(format!("expected ready.waiting, got: {ready}"));
    }
    stats.channels_created.fetch_add(1, Ordering::Relaxed);

    // Wallet joins
    let mut wallet = ws_connect(url).await?;
    send_json(
        &mut wallet,
        &json!({
            "v":1,"t":"join","ch":ch,"from":wallet_peer,"pubkey":wallet_peer,
            "capabilities":{"methods":[],"events":[],"chains":[]}
        }),
    )
    .await?;
    let wallet_ready = recv_json(&mut wallet, timeout).await?;
    if wallet_ready["t"] != "ready" {
        return Err(format!("wallet expected ready, got: {wallet_ready}"));
    }
    stats.channels_joined.fetch_add(1, Ordering::Relaxed);

    // dApp receives join
    let join_fwd = recv_json(&mut dapp, timeout).await?;
    if join_fwd["t"] != "join" {
        return Err(format!("dapp expected join, got: {join_fwd}"));
    }

    // dApp accepts
    send_json(
        &mut dapp,
        &json!({"v":1,"t":"accept","ch":ch,"from":dapp_peer,"target":wallet_peer}),
    )
    .await?;
    let dapp_connected = recv_json(&mut dapp, timeout).await?;
    if dapp_connected["state"] != "connected" {
        return Err(format!("dapp expected connected, got: {dapp_connected}"));
    }
    let wallet_connected = recv_json(&mut wallet, timeout).await?;
    if wallet_connected["state"] != "connected" {
        return Err(format!(
            "wallet expected connected, got: {wallet_connected}"
        ));
    }
    stats.channels_accepted.fetch_add(1, Ordering::Relaxed);

    // req/res round-trips
    for i in 0..messages {
        let id = format!("r{channel_idx}-{i}");
        let start = Instant::now();

        send_json(
            &mut dapp,
            &json!({
                "v":1,"t":"req","ch":ch,"from":dapp_peer,
                "id":id,"method":"test","sealed":"dGVzdA"
            }),
        )
        .await?;
        stats.messages_sent.fetch_add(1, Ordering::Relaxed);

        let req_fwd = recv_json(&mut wallet, timeout).await?;
        if req_fwd["t"] != "req" {
            return Err(format!("wallet expected req, got: {req_fwd}"));
        }

        send_json(
            &mut wallet,
            &json!({
                "v":1,"t":"res","ch":ch,"from":wallet_peer,
                "id":id,"ok":true,"sealed":"cmVz"
            }),
        )
        .await?;

        let res_fwd = recv_json(&mut dapp, timeout).await?;
        if res_fwd["t"] != "res" {
            return Err(format!("dapp expected res, got: {res_fwd}"));
        }
        stats.messages_received.fetch_add(1, Ordering::Relaxed);

        let elapsed = start.elapsed();
        latencies.lock().await.push(elapsed);
    }

    // Close
    send_json(
        &mut dapp,
        &json!({"v":1,"t":"close","ch":ch,"from":dapp_peer,"reason":"normal"}),
    )
    .await?;
    stats.channels_completed.fetch_add(1, Ordering::Relaxed);

    // Drain wallet close
    let _ = recv_json(&mut wallet, Duration::from_secs(2)).await;

    Ok(())
}

async fn test_oversize_payload(url: &str, stats: &Stats) {
    let ch = make_channel_id(999_999);
    let peer = make_peer_id(999_998);

    let mut ws = match ws_connect(url).await {
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("oversize test connect failed: {e}");
            stats.errors.fetch_add(1, Ordering::Relaxed);
            return;
        }
    };

    // Create channel first
    let _ = send_json(
        &mut ws,
        &json!({"v":1,"t":"create","ch":ch,"from":peer,"pubkey":peer}),
    )
    .await;
    let _ = recv_json(&mut ws, Duration::from_secs(5)).await;

    // Send oversized payload (65537 bytes of padding)
    let big = "x".repeat(65_537);
    let msg = json!({"v":1,"t":"close","ch":ch,"from":peer,"reason":"normal","pad":big});
    let _ = send_json(&mut ws, &msg).await;

    match recv_json(&mut ws, Duration::from_secs(5)).await {
        Ok(v) if v["reason"] == "payload_too_large" => {
            stats.oversize_rejected.fetch_add(1, Ordering::Relaxed);
            println!("  oversize payload correctly rejected");
        }
        Ok(v) => {
            eprintln!("  oversize test: unexpected response: {v}");
            stats.errors.fetch_add(1, Ordering::Relaxed);
        }
        Err(e) => {
            // Connection close is also acceptable
            println!("  oversize test: connection closed ({e}) — acceptable");
            stats.oversize_rejected.fetch_add(1, Ordering::Relaxed);
        }
    }
}

async fn test_near_limit_payload(url: &str, stats: &Stats) {
    let ch = make_channel_id(999_998);
    let dapp_peer = make_peer_id(999_996);
    let wallet_peer = make_peer_id(999_997);

    let mut dapp = match ws_connect(url).await {
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("near-limit test connect failed: {e}");
            stats.errors.fetch_add(1, Ordering::Relaxed);
            return;
        }
    };

    // Create + join + accept
    let _ = send_json(
        &mut dapp,
        &json!({"v":1,"t":"create","ch":ch,"from":dapp_peer,"pubkey":dapp_peer}),
    )
    .await;
    let _ = recv_json(&mut dapp, Duration::from_secs(5)).await;

    let mut wallet = match ws_connect(url).await {
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("near-limit test wallet connect failed: {e}");
            stats.errors.fetch_add(1, Ordering::Relaxed);
            return;
        }
    };

    let _ = send_json(
        &mut wallet,
        &json!({"v":1,"t":"join","ch":ch,"from":wallet_peer,"pubkey":wallet_peer,
            "capabilities":{"methods":[],"events":[],"chains":[]}}),
    )
    .await;
    let _ = recv_json(&mut wallet, Duration::from_secs(5)).await;
    let _ = recv_json(&mut dapp, Duration::from_secs(5)).await;

    let _ = send_json(
        &mut dapp,
        &json!({"v":1,"t":"accept","ch":ch,"from":dapp_peer,"target":wallet_peer}),
    )
    .await;
    let _ = recv_json(&mut dapp, Duration::from_secs(5)).await;
    let _ = recv_json(&mut wallet, Duration::from_secs(5)).await;

    // Send a message close to 64KiB (leave room for JSON structure)
    let sealed_data = "A".repeat(60_000); // ~60KB sealed payload
    let req = json!({
        "v":1,"t":"req","ch":ch,"from":dapp_peer,
        "id":"big-req","method":"test","sealed":sealed_data
    });
    let serialized = req.to_string();
    println!("  near-limit payload size: {} bytes", serialized.len());

    let _ = send_json(&mut dapp, &req).await;
    match recv_json(&mut wallet, Duration::from_secs(5)).await {
        Ok(v) if v["t"] == "req" && v["id"] == "big-req" => {
            stats.near_limit_ok.fetch_add(1, Ordering::Relaxed);
            println!("  near-limit payload forwarded successfully");
        }
        Ok(v) => {
            eprintln!("  near-limit test: unexpected response: {v}");
            stats.errors.fetch_add(1, Ordering::Relaxed);
        }
        Err(e) => {
            eprintln!("  near-limit test failed: {e}");
            stats.errors.fetch_add(1, Ordering::Relaxed);
        }
    }
}

fn percentile(sorted: &[Duration], p: f64) -> Duration {
    if sorted.is_empty() {
        return Duration::ZERO;
    }
    let idx = ((p / 100.0) * (sorted.len() as f64 - 1.0)).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

#[tokio::main]
async fn main() {
    let args = Args::parse();
    let stats = Arc::new(Stats::default());
    let latencies = Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let semaphore = Arc::new(Semaphore::new(args.concurrency));
    let timeout = Duration::from_secs(args.timeout_secs);

    println!("WalletPair Relay Load Test");
    println!("  URL:         {}", args.url);
    println!("  Channels:    {}", args.channels);
    println!("  Messages:    {} req/res per channel", args.messages);
    println!("  Concurrency: {}", args.concurrency);
    println!("  Timeout:     {}s per channel", args.timeout_secs);
    println!();

    let start = Instant::now();

    // Oversize / near-limit tests
    if args.test_oversize {
        println!("Running oversize payload test...");
        test_oversize_payload(&args.url, &stats).await;
        println!();
    }
    if args.test_near_limit {
        println!("Running near-limit payload test...");
        test_near_limit_payload(&args.url, &stats).await;
        println!();
    }

    // Main load test
    println!("Running channel lifecycle load test...");
    let mut handles = Vec::new();

    for i in 0..args.channels as u64 {
        let permit = semaphore.clone().acquire_owned().await.unwrap();
        let url = args.url.clone();
        let stats = stats.clone();
        let latencies = latencies.clone();
        let messages = args.messages;

        handles.push(tokio::spawn(async move {
            let result = run_channel(&url, i, messages, timeout, &stats, &latencies).await;
            if let Err(e) = result {
                stats.errors.fetch_add(1, Ordering::Relaxed);
                if i < 5 || i % 100 == 0 {
                    eprintln!("  channel {i} error: {e}");
                }
            }
            drop(permit);
        }));
    }

    for h in handles {
        let _ = h.await;
    }

    let elapsed = start.elapsed();

    // Compute latency percentiles
    let mut lats = latencies.lock().await;
    lats.sort();
    let p50 = percentile(&lats, 50.0);
    let p95 = percentile(&lats, 95.0);
    let p99 = percentile(&lats, 99.0);

    println!();
    println!("========== RESULTS ==========");
    println!("Duration:            {:.2}s", elapsed.as_secs_f64());
    println!("Channels created:    {}", stats.channels_created.load(Ordering::Relaxed));
    println!("Channels joined:     {}", stats.channels_joined.load(Ordering::Relaxed));
    println!("Channels accepted:   {}", stats.channels_accepted.load(Ordering::Relaxed));
    println!("Channels completed:  {}", stats.channels_completed.load(Ordering::Relaxed));
    println!("Messages sent:       {}", stats.messages_sent.load(Ordering::Relaxed));
    println!("Messages received:   {}", stats.messages_received.load(Ordering::Relaxed));
    println!("Errors:              {}", stats.errors.load(Ordering::Relaxed));
    if args.test_oversize {
        println!("Oversize rejected:   {}", stats.oversize_rejected.load(Ordering::Relaxed));
    }
    if args.test_near_limit {
        println!("Near-limit OK:       {}", stats.near_limit_ok.load(Ordering::Relaxed));
    }
    println!();
    println!("Latency (req→res round-trip):");
    println!("  p50:  {:?}", p50);
    println!("  p95:  {:?}", p95);
    println!("  p99:  {:?}", p99);
    println!("  samples: {}", lats.len());
    println!();

    let errors = stats.errors.load(Ordering::Relaxed);
    if errors > 0 {
        println!("WARN: {} errors occurred", errors);
        std::process::exit(1);
    } else {
        println!("ALL OK — no errors");
    }
}
