//! Core relay message processing logic.
//!
//! All channel state transitions happen here. The relay validates incoming
//! messages against the protocol state machine, routes data to the appropriate
//! peer, and generates adapter messages (ready, close).

use tokio::sync::mpsc;

use crate::metrics::Metrics;
use crate::protocol::{
    self, build_close, build_close_with_target, build_ready_connected, build_ready_waiting,
    ClientMessage, CloseReason, PeerId, Role,
};
use crate::state::{Channel, ChannelState, PeerConn};
use crate::store::ChannelStore;

/// Result of processing a single message.
#[must_use]
pub enum ProcessResult {
    /// Message processed. Any responses were sent via channels.
    Ok,
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
pub fn process_message(
    store: &mut ChannelStore,
    conn_id: u64,
    sender: &mpsc::Sender<String>,
    raw_text: &str,
    msg: ClientMessage,
    metrics: &Metrics,
) -> ProcessResult {
    match msg {
        ClientMessage::Create {
            ch, from, resume, ..
        } => handle_create(store, conn_id, sender, &ch, &from, resume, metrics),

        ClientMessage::Join {
            ch, from, resume, ..
        } => handle_join(
            store, conn_id, sender, raw_text, &ch, &from, resume, metrics,
        ),

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
            ch, from, reason, ..
        } => handle_close(store, raw_text, &ch, &from, &reason, metrics),
    }
}

fn handle_create(
    store: &mut ChannelStore,
    conn_id: u64,
    sender: &mpsc::Sender<String>,
    ch: &str,
    from: &PeerId,
    resume: Option<String>,
    metrics: &Metrics,
) -> ProcessResult {
    // Reconnect path
    if let Some(token) = resume {
        return handle_reconnect(
            store,
            conn_id,
            sender,
            ch,
            from,
            &token,
            Role::DApp,
            metrics,
        );
    }

    // Channel already exists?
    if store.contains(ch) {
        metrics
            .messages_rejected_total
            .with_label_values(&["channel_exists"])
            .inc();
        return ProcessResult::Reject(build_close(ch, CloseReason::ChannelExists));
    }

    // Channel limit
    if store.channel_count() >= store.max_channels {
        metrics
            .messages_rejected_total
            .with_label_values(&["max_channels"])
            .inc();
        return ProcessResult::Reject(build_close(ch, CloseReason::ProtocolError));
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

    // Generate resume token and send ready.waiting
    let token = store.generate_resume_token(ch, Role::DApp, from);
    let ready = build_ready_waiting(ch, Role::DApp, from, &token);
    let _ = try_send(sender, ready, metrics);

    tracing::info!(ch = %ch, peer = %from, "channel created");
    ProcessResult::Ok
}

#[allow(clippy::too_many_arguments)]
fn handle_join(
    store: &mut ChannelStore,
    conn_id: u64,
    sender: &mpsc::Sender<String>,
    raw_text: &str,
    ch: &str,
    from: &PeerId,
    resume: Option<String>,
    metrics: &Metrics,
) -> ProcessResult {
    // Reconnect path
    if let Some(token) = resume {
        return handle_reconnect(
            store,
            conn_id,
            sender,
            ch,
            from,
            &token,
            Role::Wallet,
            metrics,
        );
    }

    // Channel must exist
    let channel = match store.get(ch) {
        Some(c) => c,
        None => {
            metrics
                .messages_rejected_total
                .with_label_values(&["channel_not_found"])
                .inc();
            return ProcessResult::Reject(build_close(ch, CloseReason::ChannelNotFound));
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
        return ProcessResult::Reject(build_close(ch, reason));
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
    let token = store.generate_resume_token(ch, Role::Wallet, from);
    let ready = build_ready_waiting(ch, Role::Wallet, from, &token);
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
            return ProcessResult::Reject(build_close(ch, CloseReason::ChannelNotFound));
        }
    };

    // Must be from dApp
    if !channel.is_dapp(from) {
        metrics
            .messages_rejected_total
            .with_label_values(&["invalid_role"])
            .inc();
        return ProcessResult::Reject(build_close(ch, CloseReason::InvalidRole));
    }

    // Must be in PendingAccept
    if channel.state != ChannelState::PendingAccept {
        metrics
            .messages_rejected_total
            .with_label_values(&["invalid_state"])
            .inc();
        return ProcessResult::Reject(build_close(ch, CloseReason::InvalidState));
    }

    // Target must match wallet
    if channel.wallet_peer_id.as_deref() != Some(target.as_str()) {
        metrics
            .messages_rejected_total
            .with_label_values(&["invalid_target"])
            .inc();
        return ProcessResult::Reject(build_close_with_target(
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

    // Revoke old resume tokens and generate new ones
    store.revoke_resume_tokens(ch, Role::DApp);
    store.revoke_resume_tokens(ch, Role::Wallet);
    let dapp_token = store.generate_resume_token(ch, Role::DApp, from);
    let wallet_id = store.get(ch).unwrap().wallet_peer_id.clone().unwrap();
    let wallet_token = store.generate_resume_token(ch, Role::Wallet, &wallet_id);

    let channel = store.get(ch).unwrap();

    // Send ready.connected to dApp
    let dapp_ready = build_ready_connected(ch, Role::DApp, from, &wallet_id, &dapp_token);
    if let Some(ref conn) = channel.dapp_conn {
        let _ = try_send(&conn.sender, dapp_ready, metrics);
    }

    // Send ready.connected to wallet
    let wallet_ready = build_ready_connected(ch, Role::Wallet, &wallet_id, from, &wallet_token);
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
            return ProcessResult::Reject(build_close(ch, CloseReason::ChannelNotFound));
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
            return ProcessResult::Reject(build_close(ch, CloseReason::InvalidRole));
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
        return ProcessResult::Reject(build_close(ch, reason));
    }

    // Pending request tracking
    if msg_type == "req" {
        if let Some(id) = req_id {
            if channel.pending_requests.len() >= store.pending_request_limit {
                metrics
                    .messages_rejected_total
                    .with_label_values(&["pending_request_limit"])
                    .inc();
                return ProcessResult::Reject(build_close(ch, CloseReason::InvalidState));
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
            let close_msg = build_close(ch, CloseReason::SlowConsumer);
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
        return ProcessResult::Reject(build_close(ch, CloseReason::InvalidRole));
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
    ProcessResult::Ok
}

#[allow(clippy::too_many_arguments)]
fn handle_reconnect(
    store: &mut ChannelStore,
    conn_id: u64,
    sender: &mpsc::Sender<String>,
    ch: &str,
    from: &PeerId,
    token: &str,
    expected_role: Role,
    metrics: &Metrics,
) -> ProcessResult {
    // Validate token
    let info = match store.validate_resume_token(token) {
        Some(info) => info,
        None => {
            metrics
                .reconnect_attempts_total
                .with_label_values(&["invalid_token"])
                .inc();
            return ProcessResult::Reject(protocol::build_close(ch, CloseReason::InvalidResume));
        }
    };

    // Token must match channel, role, and peer ID
    if info.channel_id != ch || info.role != expected_role || info.peer_id != from.as_str() {
        metrics
            .reconnect_attempts_total
            .with_label_values(&["token_mismatch"])
            .inc();
        return ProcessResult::Reject(protocol::build_close(ch, CloseReason::InvalidResume));
    }

    // Channel must still exist and not be closed
    let channel = match store.get(ch) {
        Some(c) if c.state != ChannelState::Closed => c,
        _ => {
            metrics
                .reconnect_attempts_total
                .with_label_values(&["channel_gone"])
                .inc();
            return ProcessResult::Reject(protocol::build_close(ch, CloseReason::ChannelNotFound));
        }
    };

    let other_connected = channel.is_other_connected(expected_role);
    // Only send ready.connected if the channel was fully accepted.
    // PendingAccept means the accept step hasn't happened yet — sending
    // ready.connected would bypass pairing code verification (MITM risk).
    let was_connected = channel.state == ChannelState::Connected;

    // Reconnect: restore connection
    let channel = store.get_mut(ch).unwrap();
    let new_conn = PeerConn {
        sender: sender.clone(),
        conn_id,
    };
    match expected_role {
        Role::DApp => channel.dapp_conn = Some(new_conn),
        Role::Wallet => channel.wallet_conn = Some(new_conn),
    }

    // Revoke old token, generate new one
    store.revoke_resume_tokens(ch, expected_role);
    let new_token = store.generate_resume_token(ch, expected_role, from);

    let result_label = if other_connected && was_connected {
        // Other peer is still connected — send ready.connected
        let channel = store.get(ch).unwrap();
        let other_id = channel.other_peer_id(expected_role).unwrap().to_string();
        let ready = build_ready_connected(ch, expected_role, from, &other_id, &new_token);
        let _ = try_send(sender, ready, metrics);
        "success_connected"
    } else {
        // Other peer not connected — send ready.waiting
        let ready = build_ready_waiting(ch, expected_role, from, &new_token);
        let _ = try_send(sender, ready, metrics);
        "success_waiting"
    };

    metrics
        .reconnect_attempts_total
        .with_label_values(&[result_label])
        .inc();
    tracing::info!(
        ch = %ch,
        role = %expected_role,
        peer = %from,
        result = %result_label,
        "peer reconnected"
    );
    ProcessResult::Ok
}
