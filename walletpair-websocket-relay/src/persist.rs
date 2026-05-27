//! State persistence for relay restart.
//!
//! On graceful shutdown the relay serialises all channel metadata to a JSON
//! file. On startup, if the file exists, the state is restored so that the
//! relay can resume where it left off.
//!
//! Only channel metadata is persisted — live WebSocket connections are not.
//! Both peers' `PeerConn` will be `None` after restore; each peer must
//! reconnect.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tokio::time::Instant;

use crate::config::Config;
use crate::metrics::Metrics;
use crate::protocol::{ChannelId, PeerId};
use crate::state::{Channel, ChannelState};
use crate::store::ChannelStore;

// ---------------------------------------------------------------------------
// Serialisable snapshot types
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
struct ChannelSnapshot {
    id: ChannelId,
    state: String,
    /// Seconds since the channel was created (relative, re-anchored on load).
    age_secs: u64,
    /// Seconds since connected (if applicable).
    connected_age_secs: Option<u64>,
    dapp_peer_id: PeerId,
    wallet_peer_id: Option<PeerId>,
    pending_requests: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct Snapshot {
    version: u32,
    channels: Vec<ChannelSnapshot>,
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

pub fn save_state(store: &ChannelStore, path: &Path) -> Result<(), String> {
    let now = Instant::now();

    let channels: Vec<ChannelSnapshot> = store
        .channels
        .values()
        .filter(|ch| ch.state != ChannelState::Closed)
        .map(|ch| {
            let age_secs = now.duration_since(ch.created_at).as_secs();
            let connected_age_secs = ch.connected_at.map(|t| now.duration_since(t).as_secs());
            ChannelSnapshot {
                id: ch.id.clone(),
                state: ch.state.as_str().to_string(),
                age_secs,
                connected_age_secs,
                dapp_peer_id: ch.dapp_peer_id.clone(),
                wallet_peer_id: ch.wallet_peer_id.clone(),
                pending_requests: ch.pending_requests.iter().cloned().collect(),
            }
        })
        .collect();

    let snapshot = Snapshot {
        version: 1,
        channels,
    };

    let json = serde_json::to_string_pretty(&snapshot).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(path, json).map_err(|e| format!("write {}: {e}", path.display()))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

pub fn load_state(
    config: &Config,
    metrics: &Metrics,
    path: &Path,
) -> Result<ChannelStore, String> {
    let json = std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let snapshot: Snapshot =
        serde_json::from_str(&json).map_err(|e| format!("deserialize: {e}"))?;

    if snapshot.version != 1 {
        return Err(format!("unsupported snapshot version: {}", snapshot.version));
    }

    let mut store = ChannelStore::new(config);
    let now = Instant::now();

    for cs in snapshot.channels {
        let state = match cs.state.as_str() {
            "waiting_for_wallet" => ChannelState::WaitingForWallet,
            "pending_accept" => ChannelState::PendingAccept,
            "connected" => ChannelState::Connected,
            _ => continue, // skip closed or unknown
        };

        // Re-anchor timestamps: the channel was created `age_secs` ago.
        let created_at = now - std::time::Duration::from_secs(cs.age_secs);
        let connected_at = cs
            .connected_age_secs
            .map(|s| now - std::time::Duration::from_secs(s));

        let channel = Channel {
            id: cs.id.clone(),
            state,
            created_at,
            connected_at,
            dapp_peer_id: cs.dapp_peer_id,
            dapp_conn: None, // no live connection after restart
            wallet_peer_id: cs.wallet_peer_id,
            wallet_conn: None,
            is_reconnect: false,
            pending_requests: cs.pending_requests.into_iter().collect(),
        };

        store.channels.insert(cs.id, channel);
        metrics.active_channels.inc();
    }

    Ok(store)
}

// ---------------------------------------------------------------------------
// Convenience: try to load, fall back to fresh store
// ---------------------------------------------------------------------------

pub fn load_or_new(config: &Config, metrics: &Metrics, path: &Path) -> ChannelStore {
    if path.exists() {
        match load_state(config, metrics, path) {
            Ok(store) => {
                let ch_count = store.channels.len();
                // Remove the snapshot file so we don't reload stale state on the
                // next restart if this run crashes before a clean shutdown.
                let _ = std::fs::remove_file(path);
                tracing::info!(
                    channels = ch_count,
                    "restored state from {}",
                    path.display()
                );
                store
            }
            Err(e) => {
                tracing::warn!("failed to restore state: {e}, starting fresh");
                ChannelStore::new(config)
            }
        }
    } else {
        ChannelStore::new(config)
    }
}
