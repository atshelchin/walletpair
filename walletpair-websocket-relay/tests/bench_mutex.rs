//! Mutex lock-hold-time benchmark for ChannelStore.
//!
//! Run with:
//!   cargo test --test bench_mutex -- --ignored --nocapture

use std::sync::{Arc, Mutex};
use std::time::Instant;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use tokio::sync::mpsc;
use walletpair_websocket_relay::config::Config;
use walletpair_websocket_relay::state::{Channel, ChannelState, PeerConn};
use walletpair_websocket_relay::store::ChannelStore;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn make_peer_id(seed: u8) -> String {
    URL_SAFE_NO_PAD.encode([seed; 32])
}

/// Generate a deterministic 64-char lowercase hex channel ID from an index.
fn make_channel_id(index: usize) -> String {
    format!("{:064x}", index)
}

/// Build a ChannelStore pre-populated with `count` fully-connected channels.
/// Each channel has both a dApp sender and a wallet sender (buffered at 64).
fn build_store(count: usize) -> ChannelStore {
    let config = Config {
        max_channels: count + 1000,
        pending_request_limit: 32,
        outbound_queue_size: 64,
        ..Config::default()
    };
    let mut store = ChannelStore::new(&config);

    for i in 0..count {
        let ch_id = make_channel_id(i);
        let dapp_peer = make_peer_id((i % 256) as u8);
        let wallet_peer = make_peer_id(((i + 1) % 256) as u8);

        // Each channel gets its own mpsc pair for dApp and wallet.
        let (dapp_tx, _dapp_rx) = mpsc::channel::<String>(64);
        let (wallet_tx, _wallet_rx) = mpsc::channel::<String>(64);

        let mut ch = Channel::new(
            ch_id,
            dapp_peer,
            PeerConn {
                sender: dapp_tx,
                conn_id: (i * 2) as u64,
            },
        );

        // Wire up wallet side to simulate a Connected channel.
        ch.wallet_peer_id = Some(wallet_peer);
        ch.wallet_conn = Some(PeerConn {
            sender: wallet_tx,
            conn_id: (i * 2 + 1) as u64,
        });
        ch.state = ChannelState::Connected;

        store.insert(ch);
    }

    store
}

// ---------------------------------------------------------------------------
// Percentile helper
// ---------------------------------------------------------------------------

fn percentile(sorted: &[u64], p: f64) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let idx = ((p / 100.0) * (sorted.len() - 1) as f64).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

fn print_stats(label: &str, mut samples: Vec<u64>) {
    samples.sort_unstable();
    let total: u64 = samples.iter().sum();
    let mean = total / samples.len() as u64;
    println!(
        "{label}: n={n}  mean={mean}ns  p50={p50}ns  p95={p95}ns  p99={p99}ns  max={max}ns",
        n = samples.len(),
        mean = mean,
        p50 = percentile(&samples, 50.0),
        p95 = percentile(&samples, 95.0),
        p99 = percentile(&samples, 99.0),
        max = samples.last().copied().unwrap_or(0),
    );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const CHANNEL_COUNT: usize = 50_000;
const ITERATIONS: usize = 100_000;
const CONTENTION_TASKS: usize = 8;

/// Single-threaded: measure how long each lock-acquire + operation + release
/// actually takes for the three representative operations:
///   1. lookup by channel ID (read-only)
///   2. mpsc try_send to the wallet sender (simulated forward)
///   3. insert a pending request ID into a channel's HashSet
#[ignore]
#[tokio::test]
async fn bench_mutex_single_thread() {
    println!(
        "\n=== Single-thread mutex benchmark ({ITERATIONS} iterations, {CHANNEL_COUNT} channels) ==="
    );

    let store = Arc::new(Mutex::new(build_store(CHANNEL_COUNT)));

    // Pick a spread of channels to look up so we're not always hitting the
    // same HashMap bucket.
    let lookup_ids: Vec<String> = (0..ITERATIONS)
        .map(|i| make_channel_id(i % CHANNEL_COUNT))
        .collect();

    // ---- 1. Lookup (read via get) ----------------------------------------
    {
        let mut samples = Vec::with_capacity(ITERATIONS);
        for id in &lookup_ids {
            let t0 = Instant::now();
            let guard = store.lock().unwrap();
            let _found = guard.get(id);
            drop(guard);
            samples.push(t0.elapsed().as_nanos() as u64);
        }
        print_stats("lookup (lock+get+drop)", samples);
    }

    // ---- 2. try_send (simulated message forward) --------------------------
    {
        let mut samples = Vec::with_capacity(ITERATIONS);
        let msg = r#"{"v":1,"t":"req","ch":"ab","id":"r1","from":"peer"}"#.to_string();
        for id in &lookup_ids {
            let t0 = Instant::now();
            {
                let guard = store.lock().unwrap();
                if let Some(ch) = guard.get(id) {
                    if let Some(conn) = &ch.wallet_conn {
                        // try_send is non-blocking; this is the hot path the
                        // relay actually executes while holding the lock.
                        let _ = conn.sender.try_send(msg.clone());
                    }
                }
            }
            samples.push(t0.elapsed().as_nanos() as u64);
        }
        print_stats("forward  (lock+get+try_send+drop)", samples);
    }

    // ---- 3. Insert pending request ----------------------------------------
    {
        let mut samples = Vec::with_capacity(ITERATIONS);
        for (i, id) in lookup_ids.iter().enumerate() {
            let req_id = format!("req-{i}");
            let t0 = Instant::now();
            {
                let mut guard = store.lock().unwrap();
                if let Some(ch) = guard.get_mut(id) {
                    ch.pending_requests.insert(req_id);
                }
            }
            samples.push(t0.elapsed().as_nanos() as u64);
        }
        print_stats("track    (lock+get_mut+insert+drop)", samples);
    }
}

/// Multi-threaded: N tokio tasks all competing for the same Mutex.
/// Each task performs ITERATIONS/N lookups; we report total wall-clock time
/// and per-operation stats aggregated across all tasks.
#[ignore]
#[tokio::test(flavor = "multi_thread")]
async fn bench_mutex_contention() {
    println!(
        "\n=== Contention benchmark ({CONTENTION_TASKS} tasks × {} iterations) ===",
        ITERATIONS / CONTENTION_TASKS
    );

    let store = Arc::new(Mutex::new(build_store(CHANNEL_COUNT)));
    let per_task = ITERATIONS / CONTENTION_TASKS;

    let wall_start = Instant::now();

    let handles: Vec<_> = (0..CONTENTION_TASKS)
        .map(|task_id| {
            let store = Arc::clone(&store);
            tokio::spawn(async move {
                let mut samples = Vec::with_capacity(per_task);
                for i in 0..per_task {
                    let ch_id = make_channel_id((task_id * per_task + i) % CHANNEL_COUNT);
                    let msg = format!("{{\"v\":1,\"t\":\"req\",\"id\":\"{i}\"}}");
                    let t0 = Instant::now();
                    {
                        let guard = store.lock().unwrap();
                        if let Some(ch) = guard.get(&ch_id) {
                            if let Some(conn) = &ch.wallet_conn {
                                let _ = conn.sender.try_send(msg);
                            }
                        }
                    }
                    samples.push(t0.elapsed().as_nanos() as u64);
                }
                samples
            })
        })
        .collect();

    let mut all_samples: Vec<u64> = Vec::with_capacity(ITERATIONS);
    for h in handles {
        let s = h.await.unwrap();
        all_samples.extend(s);
    }

    let wall_elapsed = wall_start.elapsed();

    print_stats("contended forward (all tasks combined)", all_samples);
    println!(
        "wall-clock total: {:.3}s  ({:.0} ops/sec)",
        wall_elapsed.as_secs_f64(),
        ITERATIONS as f64 / wall_elapsed.as_secs_f64(),
    );

    // Report rough lock-wait estimate: total elapsed across all samples vs
    // uncontended baseline.  This gives a sense of queuing overhead.
    println!(
        "note: p99 under contention vs single-thread p99 reveals lock-wait time"
    );
}

/// Comprehensive combined report: run both scenarios back-to-back and
/// summarise the findings in one place.
#[ignore]
#[tokio::test(flavor = "multi_thread")]
async fn bench_mutex_full_report() {
    println!("\n╔══════════════════════════════════════════════════════════════╗");
    println!("║          WalletPair ChannelStore Mutex Benchmark            ║");
    println!("╚══════════════════════════════════════════════════════════════╝");
    println!(
        "Store size: {CHANNEL_COUNT} channels  |  Iterations: {ITERATIONS}"
    );

    // ---- Build store once, reuse for all sub-benchmarks ------------------
    println!("\nBuilding store...");
    let t0 = Instant::now();
    let store = Arc::new(Mutex::new(build_store(CHANNEL_COUNT)));
    println!("Store built in {:.2}ms", t0.elapsed().as_secs_f64() * 1000.0);

    let lookup_ids: Vec<String> = (0..ITERATIONS)
        .map(|i| make_channel_id(i % CHANNEL_COUNT))
        .collect();

    // ---- Uncontended: lookup ----------------------------------------------
    println!("\n-- Uncontended --");
    {
        let mut samples = Vec::with_capacity(ITERATIONS);
        for id in &lookup_ids {
            let t = Instant::now();
            let g = store.lock().unwrap();
            let _ = g.get(id);
            drop(g);
            samples.push(t.elapsed().as_nanos() as u64);
        }
        print_stats("lookup", samples);
    }

    // ---- Uncontended: forward --------------------------------------------
    {
        let msg = "relay-forward-payload".to_string();
        let mut samples = Vec::with_capacity(ITERATIONS);
        for id in &lookup_ids {
            let t = Instant::now();
            {
                let g = store.lock().unwrap();
                if let Some(ch) = g.get(id) {
                    if let Some(c) = &ch.wallet_conn {
                        let _ = c.sender.try_send(msg.clone());
                    }
                }
            }
            samples.push(t.elapsed().as_nanos() as u64);
        }
        print_stats("forward", samples);
    }

    // ---- Uncontended: track pending request ------------------------------
    {
        let mut samples = Vec::with_capacity(ITERATIONS);
        for (i, id) in lookup_ids.iter().enumerate() {
            let req = format!("r{i}");
            let t = Instant::now();
            {
                let mut g = store.lock().unwrap();
                if let Some(ch) = g.get_mut(id) {
                    ch.pending_requests.insert(req);
                }
            }
            samples.push(t.elapsed().as_nanos() as u64);
        }
        print_stats("track  ", samples);
    }

    // ---- Contended: 8 tasks ----------------------------------------------
    println!("\n-- Contended ({CONTENTION_TASKS} concurrent tokio tasks) --");
    let per_task = ITERATIONS / CONTENTION_TASKS;
    let wall = Instant::now();
    let handles: Vec<_> = (0..CONTENTION_TASKS)
        .map(|tid| {
            let s = Arc::clone(&store);
            let msg = "relay-forward-payload".to_string();
            tokio::spawn(async move {
                let mut samples = Vec::with_capacity(per_task);
                for i in 0..per_task {
                    let id = make_channel_id((tid * per_task + i) % CHANNEL_COUNT);
                    let t = Instant::now();
                    {
                        let g = s.lock().unwrap();
                        if let Some(ch) = g.get(&id) {
                            if let Some(c) = &ch.wallet_conn {
                                let _ = c.sender.try_send(msg.clone());
                            }
                        }
                    }
                    samples.push(t.elapsed().as_nanos() as u64);
                }
                samples
            })
        })
        .collect();

    let mut contended: Vec<u64> = Vec::with_capacity(ITERATIONS);
    for h in handles {
        contended.extend(h.await.unwrap());
    }
    let wall_elapsed = wall.elapsed();
    print_stats("forward", contended);
    println!(
        "wall-clock: {:.3}s  throughput: {:.0} ops/sec",
        wall_elapsed.as_secs_f64(),
        ITERATIONS as f64 / wall_elapsed.as_secs_f64(),
    );

    println!("\nDone.");
}
