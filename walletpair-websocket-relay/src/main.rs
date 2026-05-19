use walletpair_websocket_relay::config;
use walletpair_websocket_relay::http;
use walletpair_websocket_relay::metrics;
use walletpair_websocket_relay::persist;
use walletpair_websocket_relay::protocol;
use walletpair_websocket_relay::shutdown;
use walletpair_websocket_relay::store;

use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};

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
    let channel_store = match &config.state_file {
        Some(path) => persist::load_or_new(&config, &m, std::path::Path::new(path)),
        None => store::ChannelStore::new(&config),
    };

    let (shutdown_tx, _) = shutdown::signal_channel();

    let app_state = http::AppState {
        store: Arc::new(Mutex::new(channel_store)),
        config: config.clone(),
        metrics: m.clone(),
        shutdown_tx: shutdown_tx.clone(),
        conn_counter: Arc::new(AtomicU64::new(1)),
    };

    // Background: TTL cleanup
    {
        let store = app_state.store.clone();
        let metrics = m.clone();
        let interval = config.cleanup_interval_secs;
        let mut shutdown_rx = shutdown_tx.subscribe();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_secs(interval));
            loop {
                tokio::select! {
                    _ = ticker.tick() => {
                        let removed = {
                            let mut store = store.lock().unwrap();
                            store.cleanup_expired(&metrics)
                        };
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

    // Send close to all active channels
    {
        let mut store = app_state.store.lock().unwrap();
        let channel_ids: Vec<String> = store.channels.keys().cloned().collect();
        for ch_id in &channel_ids {
            let close_msg = protocol::build_close(ch_id, protocol::CloseReason::ServerShutdown);
            if let Some(ch) = store.channels.get(ch_id) {
                if let Some(ref conn) = ch.dapp_conn {
                    let _ = conn.sender.try_send(close_msg.clone());
                }
                if let Some(ref conn) = ch.wallet_conn {
                    let _ = conn.sender.try_send(close_msg);
                }
            }
        }

        // Persist state before removing channels (if configured)
        if let Some(ref path) = config.state_file {
            match persist::save_state(&store, std::path::Path::new(path)) {
                Ok(()) => {
                    tracing::info!(
                        channels = store.channels.len(),
                        path = %path,
                        "state persisted for restart"
                    );
                }
                Err(e) => {
                    tracing::error!(error = %e, "failed to persist state");
                }
            }
        }

        for ch_id in channel_ids {
            store.remove_channel(&ch_id, &m, protocol::CloseReason::ServerShutdown);
        }
    }

    // Wait a bit for writes to flush
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    tracing::info!("relay stopped");
}
