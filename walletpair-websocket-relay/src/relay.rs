//! Core relay message processing logic.
//!
//! All channel state transitions happen here. The relay validates incoming
//! messages against the protocol state machine, routes data to the appropriate
//! peer, and generates adapter messages (ready, close).

use tokio::sync::mpsc;

use crate::metrics::Metrics;
use crate::protocol::{
    self, build_ready_connected, build_ready_waiting, build_terminate, build_terminate_with_target,
    ClientMessage, CloseReason, PeerId, Role,
};
use crate::state::{Channel, ChannelState, PeerConn};
use crate::store::ChannelStore;

/// Result of processing a single message.
#[must_use]
pub enum ProcessResult {
    /// Message processed normally.
    Ok,
    /// A new channel was created — caller should increment the global counter.
    OkCreated,
    /// A channel was removed — caller should decrement the global counter.
    OkRemoved,
    /// Reject the sender: send this close JSON, then disconnect.
    Reject(String),
}

/// Try to send a message to a peer's outbound queue.
/// Returns false if the queue is full (slow consumer).
fn try_send(sender: &mpsc::Sender<String>, msg: String, metrics: &Metrics) -> bool {
    match sender.try_send(msg) {
        Ok(()) => true,
        Err(mpsc::error::TrySendError::Full(_)) => {
            metrics.outbound_queue_drops_total.inc();
            false
        }
        Err(mpsc::error::TrySendError::Closed(_)) => false,
    }
}

/// Process an incoming message from a peer.
///
/// `raw_text` is the original JSON text for forwarding.
/// `sender` is the outbound channel for the connection that sent this message.
/// `at_capacity` indicates whether the global channel limit has been reached
/// (checked by the caller against the sharded total, not per-shard count).
pub fn process_message(
    store: &mut ChannelStore,
    conn_id: u64,
    sender: &mpsc::Sender<String>,
    raw_text: &str,
    msg: ClientMessage,
    metrics: &Metrics,
    at_capacity: bool,
) -> ProcessResult {
    match msg {
        ClientMessage::Create { ch, from, .. } => {
            handle_create(store, conn_id, sender, &ch, &from, metrics, at_capacity)
        }

        ClientMessage::Join { ch, from, .. } => {
            handle_join(store, conn_id, sender, raw_text, &ch, &from, metrics)
        }

        ClientMessage::Accept {
            ch, from, target, ..
        } => handle_accept(store, &ch, &from, &target, metrics),

        ClientMessage::Req { ch, id, from } => {
            handle_data(store, raw_text, &ch, &from, "req", Some(&id), metrics)
        }

        ClientMessage::Res { ch, id, from } => {
            handle_data(store, raw_text, &ch, &from, "res", Some(&id), metrics)
        }

        ClientMessage::Evt { ch, from } => {
            handle_data(store, raw_text, &ch, &from, "evt", None, metrics)
        }

        ClientMessage::Ping { ch, from } => {
            handle_data(store, raw_text, &ch, &from, "ping", None, metrics)
        }

        ClientMessage::Pong { ch, from } => {
            handle_data(store, raw_text, &ch, &from, "pong", None, metrics)
        }

        ClientMessage::Close {
            ch, from, reason,
        } => handle_close(store, raw_text, &ch, &from, &reason, metrics),
    }
}

fn handle_create(
    store: &mut ChannelStore,
    conn_id: u64,
    sender: &mpsc::Sender<String>,
    ch: &str,
    from: &PeerId,
    metrics: &Metrics,
    at_capacity: bool,
) -> ProcessResult {
    // Channel already exists?
    if store.contains(ch) {
        metrics
            .messages_rejected_total
            .with_label_values(&["channel_exists"])
            .inc();
        return ProcessResult::Reject(build_terminate(ch, CloseReason::ChannelExists));
    }

    // Global channel limit (checked by caller across all shards)
    if at_capacity {
        metrics
            .messages_rejected_total
            .with_label_values(&["max_channels"])
            .inc();
        return ProcessResult::Reject(build_terminate(ch, CloseReason::ProtocolError));
    }

    // Create channel
    let channel = Channel::new(
        ch.to_string(),
        from.to_string(),
        PeerConn {
            sender: sender.clone(),
            conn_id,
        },
    );
    store.insert(channel);
    metrics.active_channels.inc();
    metrics.channels_created_total.inc();

    // Send ready.waiting
    let ready = build_ready_waiting(ch, Role::DApp, from);
    let _ = try_send(sender, ready, metrics);

    tracing::info!(ch = %ch, peer = %from, "channel created");
    ProcessResult::OkCreated
}

fn handle_join(
    store: &mut ChannelStore,
    conn_id: u64,
    sender: &mpsc::Sender<String>,
    raw_text: &str,
    ch: &str,
    from: &PeerId,
    metrics: &Metrics,
) -> ProcessResult {
    // Channel must exist
    let channel = match store.get(ch) {
        Some(c) => c,
        None => {
            metrics
                .messages_rejected_total
                .with_label_values(&["channel_not_found"])
                .inc();
            return ProcessResult::Reject(build_terminate(ch, CloseReason::ChannelNotFound));
        }
    };

    // Must be in WaitingForWallet state
    if channel.state != ChannelState::WaitingForWallet {
        let reason = if channel.state == ChannelState::Closed {
            CloseReason::ChannelNotFound
        } else {
            CloseReason::AlreadyConnected
        };
        metrics
            .messages_rejected_total
            .with_label_values(&[reason.as_str()])
            .inc();
        return ProcessResult::Reject(build_terminate(ch, reason));
    }

    // Get dApp sender for forwarding (may be disconnected)
    let dapp_sender = channel.dapp_conn.as_ref().map(|c| c.sender.clone());

    // Register wallet
    let channel = store.get_mut(ch).unwrap();
    channel.wallet_peer_id = Some(from.to_string());
    channel.wallet_conn = Some(PeerConn {
        sender: sender.clone(),
        conn_id,
    });
    channel.state = ChannelState::PendingAccept;
    metrics.channels_joined_total.inc();

    // Forward join to dApp (raw message) — skip if dApp is disconnected
    if let Some(ref dapp_tx) = dapp_sender {
        if !try_send(dapp_tx, raw_text.to_string(), metrics) {
            tracing::warn!(ch = %ch, "failed to forward join to dApp (slow consumer)");
        }
    } else {
        tracing::debug!(ch = %ch, "dApp disconnected, join will be delivered on reconnect");
    }
    metrics
        .messages_forwarded_total
        .with_label_values(&["join"])
        .inc();

    // Send ready.waiting to wallet
    let ready = build_ready_waiting(ch, Role::Wallet, from);
    let _ = try_send(sender, ready, metrics);

    tracing::info!(ch = %ch, peer = %from, "wallet joined");
    ProcessResult::Ok
}

fn handle_accept(
    store: &mut ChannelStore,
    ch: &str,
    from: &PeerId,
    target: &PeerId,
    metrics: &Metrics,
) -> ProcessResult {
    let channel = match store.get(ch) {
        Some(c) => c,
        None => {
            return ProcessResult::Reject(build_terminate(ch, CloseReason::ChannelNotFound));
        }
    };

    // Must be from dApp
    if !channel.is_dapp(from) {
        metrics
            .messages_rejected_total
            .with_label_values(&["invalid_role"])
            .inc();
        return ProcessResult::Reject(build_terminate(ch, CloseReason::InvalidRole));
    }

    // Must be in PendingAccept
    if channel.state != ChannelState::PendingAccept {
        metrics
            .messages_rejected_total
            .with_label_values(&["invalid_state"])
            .inc();
        return ProcessResult::Reject(build_terminate(ch, CloseReason::InvalidState));
    }

    // Target must match wallet
    if channel.wallet_peer_id.as_deref() != Some(target.as_str()) {
        metrics
            .messages_rejected_total
            .with_label_values(&["invalid_target"])
            .inc();
        return ProcessResult::Reject(build_terminate_with_target(
            ch,
            CloseReason::ProtocolError,
            target,
        ));
    }

    // Transition to connected
    let channel = store.get_mut(ch).unwrap();
    channel.state = ChannelState::Connected;
    channel.connected_at = Some(tokio::time::Instant::now());
    metrics.channels_connected_total.inc();

    let wallet_id = channel.wallet_peer_id.clone().unwrap();

    // Send ready.connected to dApp
    let dapp_ready = build_ready_connected(ch, Role::DApp, from, &wallet_id);
    if let Some(ref conn) = channel.dapp_conn {
        let _ = try_send(&conn.sender, dapp_ready, metrics);
    }

    // Send ready.connected to wallet
    let wallet_ready = build_ready_connected(ch, Role::Wallet, &wallet_id, from);
    if let Some(ref conn) = channel.wallet_conn {
        let _ = try_send(&conn.sender, wallet_ready, metrics);
    }

    tracing::info!(ch = %ch, "channel connected");
    ProcessResult::Ok
}

fn handle_data(
    store: &mut ChannelStore,
    raw_text: &str,
    ch: &str,
    from: &PeerId,
    msg_type: &str,
    req_id: Option<&str>,
    metrics: &Metrics,
) -> ProcessResult {
    let channel = match store.get(ch) {
        Some(c) => c,
        None => {
            return ProcessResult::Reject(build_terminate(ch, CloseReason::ChannelNotFound));
        }
    };

    // Determine sender's role
    let role = match channel.role_of(from) {
        Some(r) => r,
        None => {
            metrics
                .messages_rejected_total
                .with_label_values(&["invalid_role"])
                .inc();
            return ProcessResult::Reject(build_terminate(ch, CloseReason::InvalidRole));
        }
    };

    // Check state allows this message
    if !channel.state.allows_message(msg_type, role) {
        let reason = match msg_type {
            "req" | "res" | "evt" if channel.state != ChannelState::Connected => {
                CloseReason::InvalidState
            }
            _ => CloseReason::InvalidRole,
        };
        metrics
            .messages_rejected_total
            .with_label_values(&[reason.as_str()])
            .inc();
        return ProcessResult::Reject(build_terminate(ch, reason));
    }

    // Pending request tracking
    if msg_type == "req" {
        if let Some(id) = req_id {
            if channel.pending_requests.len() >= store.pending_request_limit {
                metrics
                    .messages_rejected_total
                    .with_label_values(&["pending_request_limit"])
                    .inc();
                return ProcessResult::Reject(build_terminate(ch, CloseReason::RateLimited));
            }
            let channel = store.get_mut(ch).unwrap();
            channel.pending_requests.insert(id.to_string());
        }
    }

    // Remove pending request on response
    if msg_type == "res" {
        if let Some(id) = req_id {
            let channel = store.get_mut(ch).unwrap();
            channel.pending_requests.remove(id);
        }
    }

    // Forward to other peer
    let channel = store.get(ch).unwrap();
    if let Some(other_sender) = channel.other_sender(role) {
        if !try_send(other_sender, raw_text.to_string(), metrics) {
            tracing::warn!(
                ch = %ch,
                msg_type = %msg_type,
                "slow consumer, message dropped"
            );
            metrics.slow_consumer_closes_total.inc();
            // Notify the slow consumer with a close reason before dropping.
            // The queue is full, so we spawn a direct send on the cloned sender.
            let close_msg = build_terminate(ch, CloseReason::SlowConsumer);
            let slow_sender = other_sender.clone();
            tokio::spawn(async move {
                // Use send() (not try_send) so it waits for one slot.
                // If still stuck after a short while, give up.
                let _ = tokio::time::timeout(
                    std::time::Duration::from_secs(2),
                    slow_sender.send(close_msg),
                )
                .await;
            });
            // Drop the slow consumer's connection
            let channel = store.get_mut(ch).unwrap();
            match role {
                Role::DApp => channel.wallet_conn = None,
                Role::Wallet => channel.dapp_conn = None,
            }
        }
    } else {
        // Other peer not connected. Message is lost (expected during reconnect gap).
        tracing::debug!(
            ch = %ch,
            msg_type = %msg_type,
            "other peer not connected, message dropped"
        );
    }

    metrics
        .messages_forwarded_total
        .with_label_values(&[msg_type])
        .inc();
    ProcessResult::Ok
}

fn handle_close(
    store: &mut ChannelStore,
    raw_text: &str,
    ch: &str,
    from: &PeerId,
    reason: &str,
    metrics: &Metrics,
) -> ProcessResult {
    let channel = match store.get(ch) {
        Some(c) => c,
        None => {
            // Channel doesn't exist, nothing to close
            return ProcessResult::Ok;
        }
    };

    let role = channel.role_of(from);
    if role.is_none() {
        return ProcessResult::Reject(build_terminate(ch, CloseReason::InvalidRole));
    }
    let role = role.unwrap();

    // Forward close to other peer
    if let Some(other_sender) = channel.other_sender(role) {
        let _ = try_send(other_sender, raw_text.to_string(), metrics);
    }
    metrics
        .messages_forwarded_total
        .with_label_values(&["close"])
        .inc();

    // Close the channel — map peer-provided reason string to enum for metrics
    let close_reason = match reason {
        "normal" => CloseReason::Normal,
        "user_rejected" => CloseReason::UserRejected,
        "unsupported_capability" => CloseReason::UnsupportedCapability,
        "timeout" => CloseReason::Timeout,
        "protocol_error" => CloseReason::ProtocolError,
        "decryption_failed" => CloseReason::DecryptionFailed,
        _ => CloseReason::Normal, // unknown peer reasons treated as normal close
    };
    store.remove_channel(ch, metrics, close_reason);

    tracing::info!(ch = %ch, reason = %reason, "channel closed by peer");
    ProcessResult::OkRemoved
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;

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

    fn make_peer_id(seed: u8) -> String {
        URL_SAFE_NO_PAD.encode([seed; 32])
    }

    fn make_channel_id() -> String {
        "ab".repeat(32)
    }

    fn make_create_msg(ch: &str, from: &str) -> (String, ClientMessage) {
        let raw = serde_json::json!({
            "v": 1, "t": "create", "ch": ch, "ts": 1234, "from": from,
            "body": {}
        })
        .to_string();
        let msg = protocol::parse_message(&raw).unwrap();
        (raw, msg)
    }

    fn make_join_msg(ch: &str, from: &str) -> (String, ClientMessage) {
        let raw = serde_json::json!({
            "v": 1, "t": "join", "ch": ch, "ts": 1234, "from": from,
            "body": {"sealed_join": null}
        })
        .to_string();
        let msg = protocol::parse_message(&raw).unwrap();
        (raw, msg)
    }

    fn make_accept_msg(ch: &str, from: &str, target: &str) -> (String, ClientMessage) {
        let raw = serde_json::json!({
            "v": 1, "t": "accept", "ch": ch, "ts": 1234, "from": from,
            "body": {"target": target}
        })
        .to_string();
        let msg = protocol::parse_message(&raw).unwrap();
        (raw, msg)
    }

    fn make_req_msg(ch: &str, from: &str, id: &str) -> (String, ClientMessage) {
        let raw = serde_json::json!({
            "v": 1, "t": "req", "ch": ch, "ts": 1234, "from": from,
            "body": {"id": id, "sealed": "encrypted_data"}
        })
        .to_string();
        let msg = protocol::parse_message(&raw).unwrap();
        (raw, msg)
    }

    fn make_close_msg(ch: &str, from: &str, reason: &str) -> (String, ClientMessage) {
        let raw = serde_json::json!({
            "v": 1, "t": "close", "ch": ch, "ts": 1234, "from": from,
            "body": {"reason": reason}
        })
        .to_string();
        let msg = protocol::parse_message(&raw).unwrap();
        (raw, msg)
    }

    fn make_evt_msg(ch: &str, from: &str) -> (String, ClientMessage) {
        let raw = serde_json::json!({
            "v": 1, "t": "evt", "ch": ch, "ts": 1234, "from": from,
            "body": {"id": "e1", "sealed": "encrypted_data"}
        })
        .to_string();
        let msg = protocol::parse_message(&raw).unwrap();
        (raw, msg)
    }

    fn make_ping_msg(ch: &str, from: &str) -> (String, ClientMessage) {
        let raw = serde_json::json!({
            "v": 1, "t": "ping", "ch": ch, "ts": 1234, "from": from, "body": {}
        })
        .to_string();
        let msg = protocol::parse_message(&raw).unwrap();
        (raw, msg)
    }

    /// Helper: create channel, return the dapp sender rx so we can check messages sent to dapp
    fn setup_channel(
        store: &mut ChannelStore,
        metrics: &Metrics,
        ch: &str,
        dapp_id: &str,
    ) -> mpsc::Receiver<String> {
        let (tx, rx) = mpsc::channel(64);
        let (raw, msg) = make_create_msg(ch, dapp_id);
        let result = process_message(store, 1, &tx, &raw, msg, metrics, false);
        assert!(matches!(result, ProcessResult::OkCreated));
        rx
    }

    /// Helper: create + join, return (dapp_rx, wallet_rx)
    fn setup_joined_channel(
        store: &mut ChannelStore,
        metrics: &Metrics,
        ch: &str,
        dapp_id: &str,
        wallet_id: &str,
    ) -> (mpsc::Receiver<String>, mpsc::Receiver<String>) {
        let dapp_rx = setup_channel(store, metrics, ch, dapp_id);

        let (wallet_tx, wallet_rx) = mpsc::channel(64);
        let (raw, msg) = make_join_msg(ch, wallet_id);
        let result = process_message(store, 2, &wallet_tx, &raw, msg, metrics, false);
        assert!(matches!(result, ProcessResult::Ok));
        (dapp_rx, wallet_rx)
    }

    /// Helper: create + join + accept, return (dapp_rx, wallet_rx)
    fn setup_connected_channel(
        store: &mut ChannelStore,
        metrics: &Metrics,
        ch: &str,
        dapp_id: &str,
        wallet_id: &str,
    ) -> (mpsc::Receiver<String>, mpsc::Receiver<String>) {
        let (dapp_rx, wallet_rx) = setup_joined_channel(store, metrics, ch, dapp_id, wallet_id);

        let (dapp_tx_clone, _) = mpsc::channel(64);
        let (raw, msg) = make_accept_msg(ch, dapp_id, wallet_id);
        // Use the existing dapp sender from the store (it's already stored)
        let result = process_message(store, 1, &dapp_tx_clone, &raw, msg, metrics, false);
        assert!(matches!(result, ProcessResult::Ok));
        (dapp_rx, wallet_rx)
    }

    // --- handle_create tests ---

    #[test]
    fn create_channel_returns_ok_created() {
        let config = test_config();
        let metrics = test_metrics();
        let mut store = ChannelStore::new(&config);
        let ch = make_channel_id();
        let dapp = make_peer_id(1);

        let (tx, mut rx) = mpsc::channel(64);
        let (raw, msg) = make_create_msg(&ch, &dapp);
        let result = process_message(&mut store, 1, &tx, &raw, msg, &metrics, false);

        assert!(matches!(result, ProcessResult::OkCreated));
        assert!(store.contains(&ch));
        assert_eq!(store.channel_count(), 1);

        // Should have received a ready.waiting message
        let ready = rx.try_recv().unwrap();
        let v: serde_json::Value = serde_json::from_str(&ready).unwrap();
        assert_eq!(v["t"], "ready");
        assert_eq!(v["body"]["state"], "waiting");
        assert_eq!(v["body"]["role"], "dapp");
    }

    #[test]
    fn create_duplicate_channel_rejected() {
        let config = test_config();
        let metrics = test_metrics();
        let mut store = ChannelStore::new(&config);
        let ch = make_channel_id();
        let dapp = make_peer_id(1);

        let _rx = setup_channel(&mut store, &metrics, &ch, &dapp);

        // Try to create again
        let (tx2, _rx2) = mpsc::channel(64);
        let (raw, msg) = make_create_msg(&ch, &dapp);
        let result = process_message(&mut store, 2, &tx2, &raw, msg, &metrics, false);

        match result {
            ProcessResult::Reject(terminate_json) => {
                let v: serde_json::Value = serde_json::from_str(&terminate_json).unwrap();
                assert_eq!(v["body"]["reason"], "channel_exists");
            }
            _ => panic!("expected Reject"),
        }
    }

    #[test]
    fn create_at_capacity_rejected() {
        let config = test_config();
        let metrics = test_metrics();
        let mut store = ChannelStore::new(&config);
        let ch = make_channel_id();
        let dapp = make_peer_id(1);

        let (tx, _rx) = mpsc::channel(64);
        let (raw, msg) = make_create_msg(&ch, &dapp);
        let result = process_message(&mut store, 1, &tx, &raw, msg, &metrics, true); // at_capacity = true

        match result {
            ProcessResult::Reject(terminate_json) => {
                let v: serde_json::Value = serde_json::from_str(&terminate_json).unwrap();
                assert_eq!(v["body"]["reason"], "protocol_error");
            }
            _ => panic!("expected Reject"),
        }
    }

    // --- handle_join tests ---

    #[test]
    fn join_valid_channel() {
        let config = test_config();
        let metrics = test_metrics();
        let mut store = ChannelStore::new(&config);
        let ch = make_channel_id();
        let dapp = make_peer_id(1);
        let wallet = make_peer_id(2);

        let mut dapp_rx = setup_channel(&mut store, &metrics, &ch, &dapp);

        let (wallet_tx, mut wallet_rx) = mpsc::channel(64);
        let (raw, msg) = make_join_msg(&ch, &wallet);
        let result = process_message(&mut store, 2, &wallet_tx, &raw, msg, &metrics, false);

        assert!(matches!(result, ProcessResult::Ok));
        assert_eq!(store.get(&ch).unwrap().state, ChannelState::PendingAccept);

        // Wallet should receive ready.waiting
        let wallet_ready = wallet_rx.try_recv().unwrap();
        let v: serde_json::Value = serde_json::from_str(&wallet_ready).unwrap();
        assert_eq!(v["t"], "ready");
        assert_eq!(v["body"]["state"], "waiting");
        assert_eq!(v["body"]["role"], "wallet");

        // DApp should receive the join message (forwarded)
        // First message is ready.waiting from create, second is the join
        let _ready = dapp_rx.try_recv().unwrap(); // ready.waiting from create
        let join_fwd = dapp_rx.try_recv().unwrap();
        let v: serde_json::Value = serde_json::from_str(&join_fwd).unwrap();
        assert_eq!(v["t"], "join");
    }

    #[test]
    fn join_nonexistent_channel_rejected() {
        let config = test_config();
        let metrics = test_metrics();
        let mut store = ChannelStore::new(&config);
        let ch = make_channel_id();
        let wallet = make_peer_id(2);

        let (tx, _rx) = mpsc::channel(64);
        let (raw, msg) = make_join_msg(&ch, &wallet);
        let result = process_message(&mut store, 1, &tx, &raw, msg, &metrics, false);

        match result {
            ProcessResult::Reject(close_json) => {
                let v: serde_json::Value = serde_json::from_str(&close_json).unwrap();
                assert_eq!(v["body"]["reason"], "channel_not_found");
            }
            _ => panic!("expected Reject"),
        }
    }

    #[test]
    fn join_already_joined_channel_rejected() {
        let config = test_config();
        let metrics = test_metrics();
        let mut store = ChannelStore::new(&config);
        let ch = make_channel_id();
        let dapp = make_peer_id(1);
        let wallet1 = make_peer_id(2);
        let wallet2 = make_peer_id(3);

        let _dapp_rx = setup_channel(&mut store, &metrics, &ch, &dapp);

        // First join
        let (tx1, _rx1) = mpsc::channel(64);
        let (raw, msg) = make_join_msg(&ch, &wallet1);
        let _ = process_message(&mut store, 2, &tx1, &raw, msg, &metrics, false);

        // Second join should fail
        let (tx2, _rx2) = mpsc::channel(64);
        let (raw, msg) = make_join_msg(&ch, &wallet2);
        let result = process_message(&mut store, 3, &tx2, &raw, msg, &metrics, false);

        match result {
            ProcessResult::Reject(close_json) => {
                let v: serde_json::Value = serde_json::from_str(&close_json).unwrap();
                assert_eq!(v["body"]["reason"], "already_connected");
            }
            _ => panic!("expected Reject"),
        }
    }

    // --- handle_accept tests ---

    #[test]
    fn accept_transitions_to_connected() {
        let config = test_config();
        let metrics = test_metrics();
        let mut store = ChannelStore::new(&config);
        let ch = make_channel_id();
        let dapp = make_peer_id(1);
        let wallet = make_peer_id(2);

        let (mut dapp_rx, mut wallet_rx) =
            setup_joined_channel(&mut store, &metrics, &ch, &dapp, &wallet);

        let (dapp_tx2, _) = mpsc::channel(64);
        let (raw, msg) = make_accept_msg(&ch, &dapp, &wallet);
        let result = process_message(&mut store, 1, &dapp_tx2, &raw, msg, &metrics, false);

        assert!(matches!(result, ProcessResult::Ok));
        assert_eq!(store.get(&ch).unwrap().state, ChannelState::Connected);

        // Both peers should receive ready.connected
        // Drain the ready.waiting messages first
        let _ = dapp_rx.try_recv(); // ready.waiting from create
        let _ = dapp_rx.try_recv(); // join forwarded
        let dapp_ready = dapp_rx.try_recv().unwrap();
        let v: serde_json::Value = serde_json::from_str(&dapp_ready).unwrap();
        assert_eq!(v["body"]["state"], "connected");

        let _ = wallet_rx.try_recv(); // ready.waiting from join
        let wallet_ready = wallet_rx.try_recv().unwrap();
        let v: serde_json::Value = serde_json::from_str(&wallet_ready).unwrap();
        assert_eq!(v["body"]["state"], "connected");
    }

    #[test]
    fn accept_wrong_target_rejected() {
        let config = test_config();
        let metrics = test_metrics();
        let mut store = ChannelStore::new(&config);
        let ch = make_channel_id();
        let dapp = make_peer_id(1);
        let wallet = make_peer_id(2);
        let wrong_target = make_peer_id(3);

        let _ = setup_joined_channel(&mut store, &metrics, &ch, &dapp, &wallet);

        let (tx, _rx) = mpsc::channel(64);
        let (raw, msg) = make_accept_msg(&ch, &dapp, &wrong_target);
        let result = process_message(&mut store, 1, &tx, &raw, msg, &metrics, false);

        assert!(matches!(result, ProcessResult::Reject(_)));
    }

    #[test]
    fn accept_from_wallet_rejected() {
        let config = test_config();
        let metrics = test_metrics();
        let mut store = ChannelStore::new(&config);
        let ch = make_channel_id();
        let dapp = make_peer_id(1);
        let wallet = make_peer_id(2);

        let _ = setup_joined_channel(&mut store, &metrics, &ch, &dapp, &wallet);

        let (tx, _rx) = mpsc::channel(64);
        let (raw, msg) = make_accept_msg(&ch, &wallet, &dapp);
        let result = process_message(&mut store, 2, &tx, &raw, msg, &metrics, false);

        match result {
            ProcessResult::Reject(close_json) => {
                let v: serde_json::Value = serde_json::from_str(&close_json).unwrap();
                assert_eq!(v["body"]["reason"], "invalid_role");
            }
            _ => panic!("expected Reject"),
        }
    }

    #[test]
    fn accept_nonexistent_channel_rejected() {
        let config = test_config();
        let metrics = test_metrics();
        let mut store = ChannelStore::new(&config);
        let ch = make_channel_id();
        let dapp = make_peer_id(1);
        let wallet = make_peer_id(2);

        let (tx, _rx) = mpsc::channel(64);
        let (raw, msg) = make_accept_msg(&ch, &dapp, &wallet);
        let result = process_message(&mut store, 1, &tx, &raw, msg, &metrics, false);

        match result {
            ProcessResult::Reject(close_json) => {
                let v: serde_json::Value = serde_json::from_str(&close_json).unwrap();
                assert_eq!(v["body"]["reason"], "channel_not_found");
            }
            _ => panic!("expected Reject"),
        }
    }

    #[test]
    fn accept_in_wrong_state_rejected() {
        let config = test_config();
        let metrics = test_metrics();
        let mut store = ChannelStore::new(&config);
        let ch = make_channel_id();
        let dapp = make_peer_id(1);
        let wallet = make_peer_id(2);

        // Only create, don't join — state is WaitingForWallet
        let _ = setup_channel(&mut store, &metrics, &ch, &dapp);

        let (tx, _rx) = mpsc::channel(64);
        let (raw, msg) = make_accept_msg(&ch, &dapp, &wallet);
        let result = process_message(&mut store, 1, &tx, &raw, msg, &metrics, false);

        match result {
            ProcessResult::Reject(close_json) => {
                let v: serde_json::Value = serde_json::from_str(&close_json).unwrap();
                assert_eq!(v["body"]["reason"], "invalid_state");
            }
            _ => panic!("expected Reject"),
        }
    }

    // --- handle_data tests ---

    #[test]
    fn data_forwards_req_to_wallet() {
        let config = test_config();
        let metrics = test_metrics();
        let mut store = ChannelStore::new(&config);
        let ch = make_channel_id();
        let dapp = make_peer_id(1);
        let wallet = make_peer_id(2);

        let (_dapp_rx, mut wallet_rx) =
            setup_connected_channel(&mut store, &metrics, &ch, &dapp, &wallet);

        // Drain wallet_rx of setup messages
        while wallet_rx.try_recv().is_ok() {}

        let (dapp_tx, _) = mpsc::channel(64);
        let (raw, msg) = make_req_msg(&ch, &dapp, "r1");
        let result = process_message(&mut store, 1, &dapp_tx, &raw, msg, &metrics, false);

        assert!(matches!(result, ProcessResult::Ok));

        // Wallet should receive the req
        let forwarded = wallet_rx.try_recv().unwrap();
        let v: serde_json::Value = serde_json::from_str(&forwarded).unwrap();
        assert_eq!(v["t"], "req");
        assert_eq!(v["body"]["id"], "r1");
    }

    #[test]
    fn data_rejects_req_from_wallet() {
        let config = test_config();
        let metrics = test_metrics();
        let mut store = ChannelStore::new(&config);
        let ch = make_channel_id();
        let dapp = make_peer_id(1);
        let wallet = make_peer_id(2);

        let _ = setup_connected_channel(&mut store, &metrics, &ch, &dapp, &wallet);

        let (wallet_tx, _) = mpsc::channel(64);
        let (raw, msg) = make_req_msg(&ch, &wallet, "r1");
        let result = process_message(&mut store, 2, &wallet_tx, &raw, msg, &metrics, false);

        assert!(matches!(result, ProcessResult::Reject(_)));
    }

    #[test]
    fn data_rejects_unknown_peer() {
        let config = test_config();
        let metrics = test_metrics();
        let mut store = ChannelStore::new(&config);
        let ch = make_channel_id();
        let dapp = make_peer_id(1);
        let wallet = make_peer_id(2);
        let stranger = make_peer_id(3);

        let _ = setup_connected_channel(&mut store, &metrics, &ch, &dapp, &wallet);

        let (tx, _) = mpsc::channel(64);
        let (raw, msg) = make_req_msg(&ch, &stranger, "r1");
        let result = process_message(&mut store, 99, &tx, &raw, msg, &metrics, false);

        match result {
            ProcessResult::Reject(close_json) => {
                let v: serde_json::Value = serde_json::from_str(&close_json).unwrap();
                assert_eq!(v["body"]["reason"], "invalid_role");
            }
            _ => panic!("expected Reject"),
        }
    }

    #[test]
    fn data_rejects_req_in_pending_accept_state() {
        let config = test_config();
        let metrics = test_metrics();
        let mut store = ChannelStore::new(&config);
        let ch = make_channel_id();
        let dapp = make_peer_id(1);
        let wallet = make_peer_id(2);

        let _ = setup_joined_channel(&mut store, &metrics, &ch, &dapp, &wallet);
        // State is PendingAccept

        let (tx, _) = mpsc::channel(64);
        let (raw, msg) = make_req_msg(&ch, &dapp, "r1");
        let result = process_message(&mut store, 1, &tx, &raw, msg, &metrics, false);

        assert!(matches!(result, ProcessResult::Reject(_)));
    }

    #[test]
    fn data_evt_forwarded_from_wallet() {
        let config = test_config();
        let metrics = test_metrics();
        let mut store = ChannelStore::new(&config);
        let ch = make_channel_id();
        let dapp = make_peer_id(1);
        let wallet = make_peer_id(2);

        let (mut dapp_rx, _wallet_rx) =
            setup_connected_channel(&mut store, &metrics, &ch, &dapp, &wallet);

        // Drain dapp_rx of setup messages
        while dapp_rx.try_recv().is_ok() {}

        let (wallet_tx, _) = mpsc::channel(64);
        let (raw, msg) = make_evt_msg(&ch, &wallet);
        let result = process_message(&mut store, 2, &wallet_tx, &raw, msg, &metrics, false);

        assert!(matches!(result, ProcessResult::Ok));

        let forwarded = dapp_rx.try_recv().unwrap();
        let v: serde_json::Value = serde_json::from_str(&forwarded).unwrap();
        assert_eq!(v["t"], "evt");
    }

    #[test]
    fn data_ping_forwarded_from_either() {
        let config = test_config();
        let metrics = test_metrics();
        let mut store = ChannelStore::new(&config);
        let ch = make_channel_id();
        let dapp = make_peer_id(1);
        let wallet = make_peer_id(2);

        let (mut dapp_rx, mut wallet_rx) =
            setup_connected_channel(&mut store, &metrics, &ch, &dapp, &wallet);

        while dapp_rx.try_recv().is_ok() {}
        while wallet_rx.try_recv().is_ok() {}

        // DApp sends ping -> wallet receives it
        let (tx, _) = mpsc::channel(64);
        let (raw, msg) = make_ping_msg(&ch, &dapp);
        let result = process_message(&mut store, 1, &tx, &raw, msg, &metrics, false);
        assert!(matches!(result, ProcessResult::Ok));

        let forwarded = wallet_rx.try_recv().unwrap();
        let v: serde_json::Value = serde_json::from_str(&forwarded).unwrap();
        assert_eq!(v["t"], "ping");
    }

    #[test]
    fn data_nonexistent_channel_rejected() {
        let config = test_config();
        let metrics = test_metrics();
        let mut store = ChannelStore::new(&config);
        let ch = make_channel_id();
        let dapp = make_peer_id(1);

        let (tx, _) = mpsc::channel(64);
        let (raw, msg) = make_req_msg(&ch, &dapp, "r1");
        let result = process_message(&mut store, 1, &tx, &raw, msg, &metrics, false);

        match result {
            ProcessResult::Reject(close_json) => {
                let v: serde_json::Value = serde_json::from_str(&close_json).unwrap();
                assert_eq!(v["body"]["reason"], "channel_not_found");
            }
            _ => panic!("expected Reject"),
        }
    }

    #[tokio::test]
    async fn pending_request_tracking() {
        let config = test_config();
        let metrics = test_metrics();
        let mut store = ChannelStore::new(&config);
        let ch = make_channel_id();
        let dapp = make_peer_id(1);
        let wallet = make_peer_id(2);

        let _ = setup_connected_channel(&mut store, &metrics, &ch, &dapp, &wallet);

        // Send a req
        let (tx, _) = mpsc::channel(64);
        let (raw, msg) = make_req_msg(&ch, &dapp, "r1");
        let _ = process_message(&mut store, 1, &tx, &raw, msg, &metrics, false);

        assert!(store.get(&ch).unwrap().pending_requests.contains("r1"));

        // Send a res clears it
        let res_raw = serde_json::json!({
            "v": 1, "t": "res", "ch": ch, "ts": 1234, "from": wallet,
            "body": {"id": "r1", "sealed": "xyz"}
        })
        .to_string();
        let res_msg = protocol::parse_message(&res_raw).unwrap();
        let _ = process_message(&mut store, 2, &tx, &res_raw, res_msg, &metrics, false);

        assert!(!store.get(&ch).unwrap().pending_requests.contains("r1"));
    }

    // --- handle_close tests ---

    #[test]
    fn close_removes_channel() {
        let config = test_config();
        let metrics = test_metrics();
        let mut store = ChannelStore::new(&config);
        let ch = make_channel_id();
        let dapp = make_peer_id(1);
        let wallet = make_peer_id(2);

        let _ = setup_connected_channel(&mut store, &metrics, &ch, &dapp, &wallet);
        assert!(store.contains(&ch));

        let (tx, _) = mpsc::channel(64);
        let (raw, msg) = make_close_msg(&ch, &dapp, "normal");
        let result = process_message(&mut store, 1, &tx, &raw, msg, &metrics, false);

        assert!(matches!(result, ProcessResult::OkRemoved));
        assert!(!store.contains(&ch));
    }

    #[test]
    fn close_forwards_to_other_peer() {
        let config = test_config();
        let metrics = test_metrics();
        let mut store = ChannelStore::new(&config);
        let ch = make_channel_id();
        let dapp = make_peer_id(1);
        let wallet = make_peer_id(2);

        let (_dapp_rx, mut wallet_rx) =
            setup_connected_channel(&mut store, &metrics, &ch, &dapp, &wallet);

        while wallet_rx.try_recv().is_ok() {}

        let (tx, _) = mpsc::channel(64);
        let (raw, msg) = make_close_msg(&ch, &dapp, "normal");
        let _ = process_message(&mut store, 1, &tx, &raw, msg, &metrics, false);

        let forwarded = wallet_rx.try_recv().unwrap();
        let v: serde_json::Value = serde_json::from_str(&forwarded).unwrap();
        assert_eq!(v["t"], "close");
        assert_eq!(v["body"]["reason"], "normal");
    }

    #[test]
    fn close_nonexistent_channel_ok() {
        let config = test_config();
        let metrics = test_metrics();
        let mut store = ChannelStore::new(&config);
        let ch = make_channel_id();
        let dapp = make_peer_id(1);

        let (tx, _) = mpsc::channel(64);
        let (raw, msg) = make_close_msg(&ch, &dapp, "normal");
        let result = process_message(&mut store, 1, &tx, &raw, msg, &metrics, false);

        assert!(matches!(result, ProcessResult::Ok));
    }

    #[test]
    fn close_from_unknown_peer_rejected() {
        let config = test_config();
        let metrics = test_metrics();
        let mut store = ChannelStore::new(&config);
        let ch = make_channel_id();
        let dapp = make_peer_id(1);
        let stranger = make_peer_id(3);

        let _ = setup_channel(&mut store, &metrics, &ch, &dapp);

        let (tx, _) = mpsc::channel(64);
        let (raw, msg) = make_close_msg(&ch, &stranger, "normal");
        let result = process_message(&mut store, 99, &tx, &raw, msg, &metrics, false);

        match result {
            ProcessResult::Reject(close_json) => {
                let v: serde_json::Value = serde_json::from_str(&close_json).unwrap();
                assert_eq!(v["body"]["reason"], "invalid_role");
            }
            _ => panic!("expected Reject"),
        }
    }

    #[tokio::test]
    async fn pending_request_limit_enforced() {
        let config = Config {
            pending_request_limit: 2,
            ..test_config()
        };
        let metrics = test_metrics();
        let mut store = ChannelStore::new(&config);
        let ch = make_channel_id();
        let dapp = make_peer_id(1);
        let wallet = make_peer_id(2);

        let _ = setup_connected_channel(&mut store, &metrics, &ch, &dapp, &wallet);

        let (tx, _) = mpsc::channel(64);

        // Send 2 reqs (at the limit)
        for i in 0..2 {
            let (raw, msg) = make_req_msg(&ch, &dapp, &format!("r{i}"));
            let result = process_message(&mut store, 1, &tx, &raw, msg, &metrics, false);
            assert!(matches!(result, ProcessResult::Ok));
        }

        // Third should be rejected
        let (raw, msg) = make_req_msg(&ch, &dapp, "r2");
        let result = process_message(&mut store, 1, &tx, &raw, msg, &metrics, false);
        assert!(matches!(result, ProcessResult::Reject(_)));
    }
}
