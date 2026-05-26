//! WebSocket connection lifecycle.
//!
//! Each WebSocket connection is handled by a single task. The connection is
//! bound to at most one channel (established by the first create/join message).

use std::net::IpAddr;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;

use crate::config::Config;
use crate::metrics::Metrics;
use crate::protocol::{self, ClientMessage};
use crate::ratelimit::IpRateLimiter;
use crate::relay::{self, ProcessResult};
use crate::store::ShardedStore;

/// Binding established by the first message on this connection.
struct SessionBinding {
    channel_id: String,
}

/// Handle a single WebSocket connection.
pub async fn handle_ws(
    ws: WebSocket,
    conn_id: u64,
    client_ip: IpAddr,
    store: Arc<ShardedStore>,
    config: Arc<Config>,
    metrics: Metrics,
    rate_limiter: Arc<IpRateLimiter>,
    mut shutdown_rx: tokio::sync::broadcast::Receiver<()>,
) {
    let (mut ws_sink, mut ws_stream) = ws.split();
    let (tx, mut rx) = mpsc::channel::<String>(config.outbound_queue_size);

    // Spawn write task: reads from mpsc and writes to WebSocket
    let write_metrics = metrics.clone();
    let write_handle = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_sink.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
        let _ = ws_sink.close().await;
        drop(write_metrics);
    });

    let mut binding: Option<SessionBinding> = None;

    // Read loop
    loop {
        let frame = tokio::select! {
            frame = ws_stream.next() => frame,
            _ = shutdown_rx.recv() => {
                // Graceful shutdown: send close and break
                if let Some(ref b) = binding {
                    let close = protocol::build_terminate(
                        &b.channel_id,
                        protocol::CloseReason::ServerShutdown,
                    );
                    let _ = tx.try_send(close);
                }
                break;
            }
        };

        let frame = match frame {
            Some(Ok(f)) => f,
            Some(Err(e)) => {
                tracing::debug!(conn_id = conn_id, error = %e, "ws read error");
                break;
            }
            None => break, // stream ended
        };

        let raw_text = match frame {
            Message::Text(t) => t,
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) => continue, // handled by axum/tungstenite
            Message::Binary(_) => {
                // Protocol requires text frames only
                let ch = binding
                    .as_ref()
                    .map(|b| b.channel_id.as_str())
                    .unwrap_or("unknown");
                let close = protocol::build_terminate(ch, protocol::CloseReason::ProtocolError);
                let _ = tx.try_send(close);
                metrics
                    .messages_rejected_total
                    .with_label_values(&["binary_frame"])
                    .inc();
                break;
            }
        };

        // Size limit (pre-parse)
        if raw_text.len() > config.max_message_bytes {
            let ch = binding
                .as_ref()
                .map(|b| b.channel_id.as_str())
                .unwrap_or("unknown");
            let close = protocol::build_terminate(ch, protocol::CloseReason::PayloadTooLarge);
            let _ = tx.try_send(close);
            metrics
                .messages_rejected_total
                .with_label_values(&["payload_too_large"])
                .inc();
            break;
        }

        // Parse
        let msg = match protocol::parse_message(&raw_text) {
            Ok(m) => m,
            Err(e) => {
                let reason = e.to_close_reason();
                let ch = binding
                    .as_ref()
                    .map(|b| b.channel_id.as_str())
                    .unwrap_or("unknown");
                let close = protocol::build_terminate(ch, reason);
                let _ = tx.try_send(close);
                metrics
                    .messages_rejected_total
                    .with_label_values(&[reason.as_str()])
                    .inc();
                tracing::debug!(conn_id = conn_id, error = %e, "parse error");
                break;
            }
        };

        // Log (never log sealed)
        tracing::debug!(
            conn_id = conn_id,
            ch = %msg.channel_id(),
            msg_type = %msg.message_type(),
            peer = %msg.from_peer(),
            "received message"
        );

        // Enforce single-channel binding
        if let Some(ref b) = binding {
            if msg.channel_id() != b.channel_id {
                let close =
                    protocol::build_terminate(msg.channel_id(), protocol::CloseReason::ProtocolError);
                let _ = tx.try_send(close);
                metrics
                    .messages_rejected_total
                    .with_label_values(&["channel_mismatch"])
                    .inc();
                break;
            }
        }

        // First message must be create or join
        if binding.is_none() {
            match &msg {
                ClientMessage::Create { ch, .. } => {
                    // Per-IP channel creation rate limit (§17.3)
                    if config.max_creates_per_ip_per_min > 0
                        && !rate_limiter.check_create(client_ip)
                    {
                        let close =
                            protocol::build_terminate(ch, protocol::CloseReason::RateLimited);
                        let _ = tx.try_send(close);
                        metrics
                            .messages_rejected_total
                            .with_label_values(&["ip_create_rate"])
                            .inc();
                        break;
                    }
                    binding = Some(SessionBinding {
                        channel_id: ch.clone(),
                    });
                }
                ClientMessage::Join { ch, .. } => {
                    binding = Some(SessionBinding {
                        channel_id: ch.clone(),
                    });
                }
                _ => {
                    let close = protocol::build_terminate(
                        msg.channel_id(),
                        protocol::CloseReason::InvalidState,
                    );
                    let _ = tx.try_send(close);
                    metrics
                        .messages_rejected_total
                        .with_label_values(&["no_binding"])
                        .inc();
                    break;
                }
            }
        }

        // Process message through relay — lock only the relevant shard
        let at_capacity = store.at_capacity();
        let result = {
            let mut shard = store.lock_shard(msg.channel_id());
            relay::process_message(&mut shard, conn_id, &tx, &raw_text, msg, &metrics, at_capacity)
        };

        match result {
            ProcessResult::Ok => {}
            ProcessResult::OkCreated => store.inc_total(),
            ProcessResult::OkRemoved => store.dec_total(),
            ProcessResult::Reject(close_json) => {
                let _ = tx.try_send(close_json);
                break;
            }
        }
    }

    // Cleanup: disconnect this peer from its channel
    if let Some(ref b) = binding {
        let mut shard = store.lock_shard(&b.channel_id);
        shard.disconnect_peer(&b.channel_id, conn_id);
    }

    // Wait for write task to finish (with timeout)
    drop(tx);
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), write_handle).await;

    // Release per-IP connection tracking
    if config.max_connections_per_ip > 0 {
        rate_limiter.release_connection(client_ip);
    }

    metrics.active_connections.dec();
    tracing::debug!(conn_id = conn_id, "connection closed");
}
