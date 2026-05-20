use walletpair_websocket_relay::config;
use walletpair_websocket_relay::http;
use walletpair_websocket_relay::metrics;
use walletpair_websocket_relay::persist;
use walletpair_websocket_relay::protocol;
use walletpair_websocket_relay::shutdown;
use walletpair_websocket_relay::store;

use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use tokio::net::TcpListener;

#[tokio::main]
async fn main() {
    let config = config::Config::load();

    // Initialize tracing
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(&config.log_level));
    tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .with_target(false)
        .init();

    let config = Arc::new(config);
    let m = metrics::Metrics::new();

    // Load persisted state or start fresh
    let sharded_store = match &config.state_file {
        Some(path) => {
            let single = persist::load_or_new(&config, &m, std::path::Path::new(path));
            store::ShardedStore::from_single(single, &config)
        }
        None => store::ShardedStore::new(&config),
    };
    let sharded_store = Arc::new(sharded_store);

    let (shutdown_tx, _) = shutdown::signal_channel();

    let app_state = http::AppState {
        store: sharded_store.clone(),
        config: config.clone(),
        metrics: m.clone(),
        shutdown_tx: shutdown_tx.clone(),
        conn_counter: Arc::new(AtomicU64::new(1)),
    };

    // Background: TTL cleanup
    {
        let store = sharded_store.clone();
        let metrics = m.clone();
        let interval = config.cleanup_interval_secs;
        let mut shutdown_rx = shutdown_tx.subscribe();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_secs(interval));
            loop {
                tokio::select! {
                    _ = ticker.tick() => {
                        let removed = store.cleanup_all(&metrics);
                        if removed > 0 {
                            tracing::info!(removed = removed, "expired channels cleaned up");
                        }
                    }
                    _ = shutdown_rx.recv() => break,
                }
            }
        });
    }

    let router = http::router(app_state.clone());
    let listener = TcpListener::bind(&config.listen_addr)
        .await
        .unwrap_or_else(|e| {
            eprintln!("failed to bind {}: {e}", config.listen_addr);
            std::process::exit(1);
        });

    tracing::info!(addr = %config.listen_addr, path = %config.websocket_path, "relay started");

    // Serve with graceful shutdown
    let shutdown_tx_clone = shutdown_tx.clone();
    tokio::spawn(async move {
        shutdown::wait_for_signal(shutdown_tx_clone).await;
    });

    let mut shutdown_rx = shutdown_tx.subscribe();
    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx.recv().await;
            tracing::info!("shutting down gracefully");
        })
        .await
        .unwrap_or_else(|e| {
            tracing::error!(error = %e, "server error");
        });

    // Send close to all active channels and persist state
    {
        // Collect state for persistence before sending closes
        if let Some(ref path) = config.state_file {
            // Build a single ChannelStore snapshot from all shards
            let mut snapshot_store = store::ChannelStore::new(&config);
            sharded_store.for_each_shard(|shard| {
                for (id, ch) in &shard.channels {
                    // We can't move channels out, so we need to clone the essentials
                    // for persistence. The persist module reads from ChannelStore fields.
                    // Actually we pass shard references directly to persist.
                    let _ = (id, ch); // handled below
                }
            });
            // Use a direct approach: iterate shards and collect into snapshot_store
            sharded_store.for_each_shard(|shard| {
                for (id, channel) in shard.channels.drain() {
                    snapshot_store.channels.insert(id, channel);
                }
                for (token, info) in shard.resume_tokens.drain() {
                    snapshot_store.resume_tokens.insert(token, info);
                }
            });

            match persist::save_state(&snapshot_store, std::path::Path::new(path)) {
                Ok(()) => {
                    tracing::info!(
                        channels = snapshot_store.channels.len(),
                        path = %path,
                        "state persisted for restart"
                    );
                }
                Err(e) => {
                    tracing::error!(error = %e, "failed to persist state");
                }
            }
        } else {
            // No persistence — just send closes
            sharded_store.for_each_shard(|shard| {
                let channel_ids: Vec<String> = shard.channels.keys().cloned().collect();
                for ch_id in &channel_ids {
                    let close_msg =
                        protocol::build_terminate(ch_id, protocol::CloseReason::ServerShutdown);
                    if let Some(ch) = shard.channels.get(ch_id) {
                        if let Some(ref conn) = ch.dapp_conn {
                            let _ = conn.sender.try_send(close_msg.clone());
                        }
                        if let Some(ref conn) = ch.wallet_conn {
                            let _ = conn.sender.try_send(close_msg);
                        }
                    }
                }
                for ch_id in channel_ids {
                    shard.remove_channel(&ch_id, &m, protocol::CloseReason::ServerShutdown);
                }
            });
        }
    }

    // Wait a bit for writes to flush
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    tracing::info!("relay stopped");
}
