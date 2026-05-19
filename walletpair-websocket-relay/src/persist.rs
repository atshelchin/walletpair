//! State persistence for relay restart.
//!
//! On graceful shutdown the relay serialises all channel metadata and resume
//! tokens to a JSON file. On startup, if the file exists, the state is
//! restored so that peers can reconnect with their saved resume tokens without
//! re-pairing.
//!
//! Only channel metadata is persisted — live WebSocket connections are not.
//! Both peers' `PeerConn` will be `None` after restore; each peer must
//! reconnect and present a valid resume token.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tokio::time::Instant;

use crate::config::Config;
use crate::metrics::Metrics;
use crate::protocol::{ChannelId, PeerId, Role};
use crate::state::{Channel, ChannelState};
use crate::store::{ChannelStore, ResumeInfo};

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
    dapp_resume: Option<String>,
    wallet_resume: Option<String>,
    pending_requests: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct ResumeTokenSnapshot {
    token: String,
    channel_id: ChannelId,
    role: String,
    peer_id: PeerId,
}

#[derive(Serialize, Deserialize)]
struct Snapshot {
    version: u32,
    channels: Vec<ChannelSnapshot>,
    resume_tokens: Vec<ResumeTokenSnapshot>,
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
                dapp_resume: ch.dapp_resume.clone(),
                wallet_resume: ch.wallet_resume.clone(),
                pending_requests: ch.pending_requests.iter().cloned().collect(),
            }
        })
        .collect();

    let resume_tokens: Vec<ResumeTokenSnapshot> = store
        .resume_tokens
        .iter()
        .map(|(token, info)| ResumeTokenSnapshot {
            token: token.clone(),
            channel_id: info.channel_id.clone(),
            role: match info.role {
                Role::DApp => "dapp".to_string(),
                Role::Wallet => "wallet".to_string(),
            },
            peer_id: info.peer_id.clone(),
        })
        .collect();

    let snapshot = Snapshot {
        version: 1,
        channels,
        resume_tokens,
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
            dapp_resume: cs.dapp_resume,
            wallet_peer_id: cs.wallet_peer_id,
            wallet_conn: None,
            wallet_resume: cs.wallet_resume,
            pending_requests: cs.pending_requests.into_iter().collect(),
        };

        store.channels.insert(cs.id, channel);
        metrics.active_channels.inc();
    }

    for rt in snapshot.resume_tokens {
        let role = match rt.role.as_str() {
            "dapp" => Role::DApp,
            "wallet" => Role::Wallet,
            _ => continue,
        };
        store.resume_tokens.insert(
            rt.token,
            ResumeInfo {
                channel_id: rt.channel_id,
                role,
                peer_id: rt.peer_id,
            },
        );
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
                let rt_count = store.resume_tokens.len();
                // Remove the snapshot file so we don't reload stale state on the
                // next restart if this run crashes before a clean shutdown.
                let _ = std::fs::remove_file(path);
                tracing::info!(
                    channels = ch_count,
                    resume_tokens = rt_count,
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
