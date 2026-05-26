//! HTTP routes and WebSocket upgrade handler.

use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::ConnectInfo;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use prometheus::Encoder;
use tokio::sync::broadcast;
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::config::Config;
use crate::metrics::Metrics;
use crate::ratelimit::IpRateLimiter;
use crate::session;
use crate::store::ShardedStore;

/// Shared application state.
#[derive(Clone)]
pub struct AppState {
    pub store: Arc<ShardedStore>,
    pub config: Arc<Config>,
    pub metrics: Metrics,
    pub shutdown_tx: broadcast::Sender<()>,
    pub conn_counter: Arc<AtomicU64>,
    pub rate_limiter: Arc<IpRateLimiter>,
}

pub fn router(state: AppState) -> Router {
    let ws_path = state.config.websocket_path.clone();

    // Build CORS layer from config
    let cors = match &state.config.allowed_origins {
        Some(origins) if !origins.is_empty() => {
            let parsed: Vec<axum::http::HeaderValue> = origins
                .iter()
                .filter_map(|o| o.parse().ok())
                .collect();
            CorsLayer::new().allow_origin(AllowOrigin::list(parsed))
        }
        _ => CorsLayer::permissive(),
    };

    Router::new()
        .route(&ws_path, get(ws_upgrade))
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/metrics", get(metrics_handler))
        .layer(cors)
        .with_state(state)
}

async fn ws_upgrade(
    ws: WebSocketUpgrade,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    State(state): State<AppState>,
) -> Response {
    // Connection limit (global)
    let current = state.metrics.active_connections.get();
    if current >= state.config.max_connections as i64 {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }

    let client_ip = addr.ip();

    // Per-IP connection limit (§17.3)
    if state.config.max_connections_per_ip > 0 && !state.rate_limiter.track_connection(client_ip) {
        tracing::debug!(ip = %client_ip, "per-IP connection limit exceeded");
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }

    // Negotiate subprotocol — require walletpair.v1
    let ws = ws.protocols(["walletpair.v1"]);

    let conn_id = state.conn_counter.fetch_add(1, Ordering::Relaxed);

    ws.on_upgrade(move |socket| {
        state.metrics.active_connections.inc();
        tracing::debug!(conn_id = conn_id, ip = %client_ip, "new websocket connection");

        let shutdown_rx = state.shutdown_tx.subscribe();
        session::handle_ws(
            socket,
            conn_id,
            client_ip,
            state.store.clone(),
            state.config.clone(),
            state.metrics.clone(),
            state.rate_limiter.clone(),
            shutdown_rx,
        )
    })
}

async fn healthz() -> &'static str {
    "ok"
}

async fn readyz(State(state): State<AppState>) -> Response {
    let channels = state.store.total_channels();

    if channels < state.config.max_channels {
        (StatusCode::OK, "ready").into_response()
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, "at channel capacity").into_response()
    }
}

async fn metrics_handler(State(state): State<AppState>) -> Response {
    if !state.config.metrics_enabled {
        return StatusCode::NOT_FOUND.into_response();
    }

    let encoder = prometheus::TextEncoder::new();
    let metric_families = state.metrics.registry.gather();
    let mut buffer = Vec::new();

    if encoder.encode(&metric_families, &mut buffer).is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    (
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, prometheus::TEXT_FORMAT)],
        buffer,
    )
        .into_response()
}
