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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metrics::Metrics;
    use crate::state::{Channel, ChannelState, PeerConn};
    use std::collections::HashSet;
    use std::path::PathBuf;
    use tokio::sync::mpsc;

    fn test_config() -> Config {
        Config {
            max_channels: 100,
            pending_request_limit: 32,
            unpaired_channel_ttl_secs: 300,
            connected_channel_ttl_secs: 86400,
            ..Config::default()
        }
    }

    fn test_metrics() -> Metrics {
        Metrics::new()
    }

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("walletpair_test_{name}_{}", std::process::id()))
    }

    fn make_store_with_channels(config: &Config) -> ChannelStore {
        let mut store = ChannelStore::new(config);
        let (tx, _rx) = mpsc::channel(1);

        // Channel 1: WaitingForWallet
        let ch1 = Channel::new(
            "aa".repeat(32),
            "dapp1".to_string(),
            PeerConn { sender: tx, conn_id: 1 },
        );
        store.channels.insert(ch1.id.clone(), ch1);

        // Channel 2: Connected with pending requests
        let (tx2, _rx2) = mpsc::channel(1);
        let mut ch2 = Channel::new(
            "bb".repeat(32),
            "dapp2".to_string(),
            PeerConn { sender: tx2, conn_id: 2 },
        );
        ch2.state = ChannelState::Connected;
        ch2.connected_at = Some(Instant::now());
        ch2.wallet_peer_id = Some("wallet2".to_string());
        ch2.pending_requests = HashSet::from(["req-1".to_string(), "req-2".to_string()]);
        store.channels.insert(ch2.id.clone(), ch2);

        // Channel 3: Closed (should be filtered out)
        let (tx3, _rx3) = mpsc::channel(1);
        let mut ch3 = Channel::new(
            "cc".repeat(32),
            "dapp3".to_string(),
            PeerConn { sender: tx3, conn_id: 3 },
        );
        ch3.state = ChannelState::Closed;
        store.channels.insert(ch3.id.clone(), ch3);

        store
    }

    #[test]
    fn save_and_load_round_trip() {
        let config = test_config();
        let metrics = test_metrics();
        let store = make_store_with_channels(&config);
        let path = temp_path("round_trip");

        // Save
        save_state(&store, &path).unwrap();
        assert!(path.exists());

        // Load
        let loaded = load_state(&config, &metrics, &path).unwrap();

        // Closed channel should be filtered out
        assert_eq!(loaded.channels.len(), 2);
        assert!(loaded.channels.contains_key(&"aa".repeat(32)));
        assert!(loaded.channels.contains_key(&"bb".repeat(32)));
        assert!(!loaded.channels.contains_key(&"cc".repeat(32)));

        // Cleanup
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn save_preserves_channel_state() {
        let config = test_config();
        let metrics = test_metrics();
        let store = make_store_with_channels(&config);
        let path = temp_path("state");

        save_state(&store, &path).unwrap();
        let loaded = load_state(&config, &metrics, &path).unwrap();

        let ch1 = loaded.channels.get(&"aa".repeat(32)).unwrap();
        assert_eq!(ch1.state, ChannelState::WaitingForWallet);
        assert_eq!(ch1.dapp_peer_id, "dapp1");
        assert!(ch1.wallet_peer_id.is_none());
        assert!(ch1.dapp_conn.is_none()); // connections are not persisted

        let ch2 = loaded.channels.get(&"bb".repeat(32)).unwrap();
        assert_eq!(ch2.state, ChannelState::Connected);
        assert_eq!(ch2.dapp_peer_id, "dapp2");
        assert_eq!(ch2.wallet_peer_id.as_deref(), Some("wallet2"));
        assert!(ch2.connected_at.is_some());
        assert_eq!(ch2.pending_requests.len(), 2);
        assert!(ch2.pending_requests.contains("req-1"));
        assert!(ch2.pending_requests.contains("req-2"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn load_rejects_unsupported_version() {
        let config = test_config();
        let metrics = test_metrics();
        let path = temp_path("bad_version");

        let json = r#"{"version": 99, "channels": []}"#;
        std::fs::write(&path, json).unwrap();

        let result = load_state(&config, &metrics, &path);
        match result {
            Err(e) => assert!(e.contains("unsupported snapshot version"), "got: {e}"),
            Ok(_) => panic!("expected error for unsupported version"),
        }

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn load_handles_invalid_json() {
        let config = test_config();
        let metrics = test_metrics();
        let path = temp_path("bad_json");

        std::fs::write(&path, "not valid json {{{").unwrap();

        let result = load_state(&config, &metrics, &path);
        match result {
            Err(e) => assert!(e.contains("deserialize"), "got: {e}"),
            Ok(_) => panic!("expected error for invalid json"),
        }

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn load_handles_missing_file() {
        let config = test_config();
        let metrics = test_metrics();
        let path = temp_path("nonexistent_file_12345");

        let result = load_state(&config, &metrics, &path);
        match result {
            Err(e) => assert!(e.contains("read"), "got: {e}"),
            Ok(_) => panic!("expected error for missing file"),
        }
    }

    #[test]
    fn load_skips_unknown_states() {
        let config = test_config();
        let metrics = test_metrics();
        let path = temp_path("unknown_state");

        let json = r#"{
            "version": 1,
            "channels": [
                {
                    "id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "state": "some_future_state",
                    "age_secs": 10,
                    "connected_age_secs": null,
                    "dapp_peer_id": "p1",
                    "wallet_peer_id": null,
                    "pending_requests": []
                }
            ]
        }"#;
        std::fs::write(&path, json).unwrap();

        let loaded = load_state(&config, &metrics, &path).unwrap();
        assert_eq!(loaded.channels.len(), 0); // unknown state is skipped

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn load_or_new_returns_fresh_store_when_no_file() {
        let config = test_config();
        let metrics = test_metrics();
        let path = temp_path("no_file_here");

        let store = load_or_new(&config, &metrics, &path);
        assert_eq!(store.channels.len(), 0);
    }

    #[test]
    fn load_or_new_restores_and_removes_file() {
        let config = test_config();
        let metrics = test_metrics();
        let store = make_store_with_channels(&config);
        let path = temp_path("load_or_new");

        save_state(&store, &path).unwrap();
        assert!(path.exists());

        let restored = load_or_new(&config, &metrics, &path);
        assert_eq!(restored.channels.len(), 2); // closed channel filtered
        assert!(!path.exists()); // file should be removed after load
    }

    #[test]
    fn load_or_new_falls_back_on_corrupt_file() {
        let config = test_config();
        let metrics = test_metrics();
        let path = temp_path("corrupt");

        std::fs::write(&path, "garbage data").unwrap();

        let store = load_or_new(&config, &metrics, &path);
        assert_eq!(store.channels.len(), 0); // fresh store
    }

    #[test]
    fn save_empty_store() {
        let config = test_config();
        let metrics = test_metrics();
        let store = ChannelStore::new(&config);
        let path = temp_path("empty");

        save_state(&store, &path).unwrap();

        let loaded = load_state(&config, &metrics, &path).unwrap();
        assert_eq!(loaded.channels.len(), 0);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn save_snapshot_is_valid_json() {
        let config = test_config();
        let store = make_store_with_channels(&config);
        let path = temp_path("json_check");

        save_state(&store, &path).unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed["version"], 1);
        assert!(parsed["channels"].is_array());

        let _ = std::fs::remove_file(&path);
    }
}
