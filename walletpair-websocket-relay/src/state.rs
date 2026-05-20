use std::collections::HashSet;

use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::protocol::{ChannelId, PeerId, Role};

/// Channel-level state (relay's view, not peer's view).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelState {
    /// dApp created channel, waiting for wallet to join.
    WaitingForWallet,
    /// Wallet joined, waiting for dApp to accept.
    PendingAccept,
    /// Both peers accepted, data can flow.
    Connected,
    /// Terminal state.
    Closed,
}

impl ChannelState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::WaitingForWallet => "waiting_for_wallet",
            Self::PendingAccept => "pending_accept",
            Self::Connected => "connected",
            Self::Closed => "closed",
        }
    }

    /// Returns whether a message type is valid in this state for the given role.
    pub fn allows_message(self, msg_type: &str, role: Role) -> bool {
        match (self, msg_type, role) {
            // In WaitingForWallet, only wallet can join (but that's checked at store level)
            // In PendingAccept, dApp can accept or close
            (ChannelState::PendingAccept, "accept", Role::DApp) => true,
            // In Connected, role-based message routing
            (ChannelState::Connected, "req", Role::DApp) => true,
            (ChannelState::Connected, "res", Role::Wallet) => true,
            (ChannelState::Connected, "evt", Role::Wallet) => true,
            (ChannelState::Connected, "ping", _) => true,
            (ChannelState::Connected, "pong", _) => true,
            // Close is always allowed (except in Closed)
            (ChannelState::Closed, _, _) => false,
            (_, "close", _) => true,
            // Ping/pong allowed in PendingAccept too
            (ChannelState::PendingAccept, "ping", _) => true,
            (ChannelState::PendingAccept, "pong", _) => true,
            _ => false,
        }
    }
}

impl std::fmt::Display for ChannelState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A live connection to a peer.
pub struct PeerConn {
    pub sender: mpsc::Sender<String>,
    pub conn_id: u64,
}

/// A channel managed by the relay.
pub struct Channel {
    pub id: ChannelId,
    pub state: ChannelState,
    pub created_at: Instant,
    pub connected_at: Option<Instant>,

    // DApp
    pub dapp_peer_id: PeerId,
    pub dapp_conn: Option<PeerConn>,
    pub dapp_resume: Option<String>,

    // Wallet (set when wallet joins)
    pub wallet_peer_id: Option<PeerId>,
    pub wallet_conn: Option<PeerConn>,
    pub wallet_resume: Option<String>,

    // Pending request IDs (for limit enforcement)
    pub pending_requests: HashSet<String>,
}

impl Channel {
    pub fn new(id: ChannelId, dapp_peer_id: PeerId, dapp_conn: PeerConn) -> Self {
        Self {
            id,
            state: ChannelState::WaitingForWallet,
            created_at: Instant::now(),
            connected_at: None,
            dapp_peer_id,
            dapp_conn: Some(dapp_conn),
            dapp_resume: None,
            wallet_peer_id: None,
            wallet_conn: None,
            wallet_resume: None,
            pending_requests: HashSet::new(),
        }
    }

    pub fn is_dapp(&self, peer_id: &str) -> bool {
        self.dapp_peer_id == peer_id
    }

    pub fn is_wallet(&self, peer_id: &str) -> bool {
        self.wallet_peer_id.as_deref() == Some(peer_id)
    }

    pub fn role_of(&self, peer_id: &str) -> Option<Role> {
        if self.is_dapp(peer_id) {
            Some(Role::DApp)
        } else if self.is_wallet(peer_id) {
            Some(Role::Wallet)
        } else {
            None
        }
    }

    /// Get the sender for the other peer, if connected.
    pub fn other_sender(&self, role: Role) -> Option<&mpsc::Sender<String>> {
        match role {
            Role::DApp => self.wallet_conn.as_ref().map(|c| &c.sender),
            Role::Wallet => self.dapp_conn.as_ref().map(|c| &c.sender),
        }
    }

    /// Get the peer ID of the other peer.
    pub fn other_peer_id(&self, role: Role) -> Option<&str> {
        match role {
            Role::DApp => self.wallet_peer_id.as_deref(),
            Role::Wallet => Some(&self.dapp_peer_id),
        }
    }

    /// Check if the other peer is currently connected (has a live sender).
    pub fn is_other_connected(&self, role: Role) -> bool {
        match role {
            Role::DApp => self.wallet_conn.is_some(),
            Role::Wallet => self.dapp_conn.is_some(),
        }
    }

    /// Disconnect a peer by connection ID. Returns the role if found.
    pub fn disconnect_by_conn_id(&mut self, conn_id: u64) -> Option<Role> {
        if self
            .dapp_conn
            .as_ref()
            .is_some_and(|c| c.conn_id == conn_id)
        {
            self.dapp_conn = None;
            return Some(Role::DApp);
        }
        if self
            .wallet_conn
            .as_ref()
            .is_some_and(|c| c.conn_id == conn_id)
        {
            self.wallet_conn = None;
            return Some(Role::Wallet);
        }
        None
    }
}

// --- State machine tests ---

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connected_allows_req_from_dapp() {
        assert!(ChannelState::Connected.allows_message("req", Role::DApp));
    }

    #[test]
    fn connected_rejects_req_from_wallet() {
        assert!(!ChannelState::Connected.allows_message("req", Role::Wallet));
    }

    #[test]
    fn connected_allows_res_from_wallet() {
        assert!(ChannelState::Connected.allows_message("res", Role::Wallet));
    }

    #[test]
    fn connected_rejects_res_from_dapp() {
        assert!(!ChannelState::Connected.allows_message("res", Role::DApp));
    }

    #[test]
    fn connected_allows_evt_from_wallet() {
        assert!(ChannelState::Connected.allows_message("evt", Role::Wallet));
    }

    #[test]
    fn connected_rejects_evt_from_dapp() {
        assert!(!ChannelState::Connected.allows_message("evt", Role::DApp));
    }

    #[test]
    fn connected_allows_ping_from_either() {
        assert!(ChannelState::Connected.allows_message("ping", Role::DApp));
        assert!(ChannelState::Connected.allows_message("ping", Role::Wallet));
    }

    #[test]
    fn connected_allows_close_from_either() {
        assert!(ChannelState::Connected.allows_message("close", Role::DApp));
        assert!(ChannelState::Connected.allows_message("close", Role::Wallet));
    }

    #[test]
    fn pending_accept_allows_accept_from_dapp() {
        assert!(ChannelState::PendingAccept.allows_message("accept", Role::DApp));
    }

    #[test]
    fn pending_accept_rejects_req() {
        assert!(!ChannelState::PendingAccept.allows_message("req", Role::DApp));
    }

    #[test]
    fn waiting_rejects_everything_except_close() {
        assert!(!ChannelState::WaitingForWallet.allows_message("req", Role::DApp));
        assert!(!ChannelState::WaitingForWallet.allows_message("accept", Role::DApp));
        assert!(ChannelState::WaitingForWallet.allows_message("close", Role::DApp));
    }

    #[test]
    fn closed_rejects_everything() {
        assert!(!ChannelState::Closed.allows_message("req", Role::DApp));
        assert!(!ChannelState::Closed.allows_message("close", Role::DApp));
    }

    // --- Additional coverage ---

    #[test]
    fn pending_accept_allows_pong_from_either() {
        assert!(ChannelState::PendingAccept.allows_message("pong", Role::DApp));
        assert!(ChannelState::PendingAccept.allows_message("pong", Role::Wallet));
    }

    #[test]
    fn pending_accept_allows_ping_from_either() {
        assert!(ChannelState::PendingAccept.allows_message("ping", Role::DApp));
        assert!(ChannelState::PendingAccept.allows_message("ping", Role::Wallet));
    }

    #[test]
    fn pending_accept_rejects_accept_from_wallet() {
        assert!(!ChannelState::PendingAccept.allows_message("accept", Role::Wallet));
    }

    #[test]
    fn pending_accept_allows_close() {
        assert!(ChannelState::PendingAccept.allows_message("close", Role::DApp));
        assert!(ChannelState::PendingAccept.allows_message("close", Role::Wallet));
    }

    #[test]
    fn pending_accept_rejects_data_messages() {
        assert!(!ChannelState::PendingAccept.allows_message("res", Role::Wallet));
        assert!(!ChannelState::PendingAccept.allows_message("evt", Role::Wallet));
    }

    #[test]
    fn waiting_allows_close_from_wallet() {
        assert!(ChannelState::WaitingForWallet.allows_message("close", Role::Wallet));
    }

    #[test]
    fn waiting_rejects_ping() {
        assert!(!ChannelState::WaitingForWallet.allows_message("ping", Role::DApp));
    }

    #[test]
    fn connected_allows_pong_from_either() {
        assert!(ChannelState::Connected.allows_message("pong", Role::DApp));
        assert!(ChannelState::Connected.allows_message("pong", Role::Wallet));
    }

    #[test]
    fn connected_rejects_accept() {
        assert!(!ChannelState::Connected.allows_message("accept", Role::DApp));
    }

    #[test]
    fn connected_rejects_join() {
        assert!(!ChannelState::Connected.allows_message("join", Role::Wallet));
    }

    #[test]
    fn closed_rejects_all_message_types() {
        for msg_type in &["req", "res", "evt", "ping", "pong", "close", "accept", "join", "create"] {
            assert!(!ChannelState::Closed.allows_message(msg_type, Role::DApp));
            assert!(!ChannelState::Closed.allows_message(msg_type, Role::Wallet));
        }
    }

    #[test]
    fn channel_state_as_str() {
        assert_eq!(ChannelState::WaitingForWallet.as_str(), "waiting_for_wallet");
        assert_eq!(ChannelState::PendingAccept.as_str(), "pending_accept");
        assert_eq!(ChannelState::Connected.as_str(), "connected");
        assert_eq!(ChannelState::Closed.as_str(), "closed");
    }

    #[test]
    fn channel_state_display() {
        assert_eq!(format!("{}", ChannelState::WaitingForWallet), "waiting_for_wallet");
        assert_eq!(format!("{}", ChannelState::Closed), "closed");
    }

    // --- Channel helper method tests ---

    fn make_channel() -> Channel {
        let (tx, _rx) = mpsc::channel(1);
        let mut ch = Channel::new(
            "ab".repeat(32),
            "dapp_peer".to_string(),
            PeerConn { sender: tx, conn_id: 1 },
        );
        let (tx2, _rx2) = mpsc::channel(1);
        ch.wallet_peer_id = Some("wallet_peer".to_string());
        ch.wallet_conn = Some(PeerConn { sender: tx2, conn_id: 2 });
        ch
    }

    #[test]
    fn channel_new_initial_state() {
        let (tx, _rx) = mpsc::channel(1);
        let ch = Channel::new(
            "cd".repeat(32),
            "p1".to_string(),
            PeerConn { sender: tx, conn_id: 42 },
        );
        assert_eq!(ch.state, ChannelState::WaitingForWallet);
        assert!(ch.connected_at.is_none());
        assert!(ch.wallet_peer_id.is_none());
        assert!(ch.wallet_conn.is_none());
        assert!(ch.dapp_conn.is_some());
        assert!(ch.pending_requests.is_empty());
    }

    #[test]
    fn is_dapp_and_is_wallet() {
        let ch = make_channel();
        assert!(ch.is_dapp("dapp_peer"));
        assert!(!ch.is_dapp("wallet_peer"));
        assert!(!ch.is_dapp("unknown"));

        assert!(ch.is_wallet("wallet_peer"));
        assert!(!ch.is_wallet("dapp_peer"));
        assert!(!ch.is_wallet("unknown"));
    }

    #[test]
    fn is_wallet_none_when_no_wallet() {
        let (tx, _rx) = mpsc::channel(1);
        let ch = Channel::new("ab".repeat(32), "p".to_string(), PeerConn { sender: tx, conn_id: 1 });
        assert!(!ch.is_wallet("p"));
        assert!(!ch.is_wallet("anything"));
    }

    #[test]
    fn role_of_returns_correct_roles() {
        let ch = make_channel();
        assert_eq!(ch.role_of("dapp_peer"), Some(Role::DApp));
        assert_eq!(ch.role_of("wallet_peer"), Some(Role::Wallet));
        assert_eq!(ch.role_of("stranger"), None);
    }

    #[test]
    fn other_sender_dapp_gets_wallet_sender() {
        let ch = make_channel();
        assert!(ch.other_sender(Role::DApp).is_some());
        assert!(ch.other_sender(Role::Wallet).is_some());
    }

    #[test]
    fn other_sender_none_when_peer_disconnected() {
        let (tx, _rx) = mpsc::channel(1);
        let ch = Channel::new("ab".repeat(32), "p".to_string(), PeerConn { sender: tx, conn_id: 1 });
        // No wallet connected
        assert!(ch.other_sender(Role::DApp).is_none());
    }

    #[test]
    fn other_peer_id() {
        let ch = make_channel();
        assert_eq!(ch.other_peer_id(Role::DApp), Some("wallet_peer"));
        assert_eq!(ch.other_peer_id(Role::Wallet), Some("dapp_peer"));
    }

    #[test]
    fn other_peer_id_none_when_no_wallet() {
        let (tx, _rx) = mpsc::channel(1);
        let ch = Channel::new("ab".repeat(32), "p".to_string(), PeerConn { sender: tx, conn_id: 1 });
        assert_eq!(ch.other_peer_id(Role::DApp), None);
        // Wallet always sees dapp
        assert_eq!(ch.other_peer_id(Role::Wallet), Some("p"));
    }

    #[test]
    fn is_other_connected() {
        let ch = make_channel();
        assert!(ch.is_other_connected(Role::DApp));   // wallet is connected
        assert!(ch.is_other_connected(Role::Wallet));  // dapp is connected
    }

    #[test]
    fn is_other_connected_false_when_disconnected() {
        let (tx, _rx) = mpsc::channel(1);
        let ch = Channel::new("ab".repeat(32), "p".to_string(), PeerConn { sender: tx, conn_id: 1 });
        assert!(!ch.is_other_connected(Role::DApp)); // no wallet
    }

    #[test]
    fn disconnect_by_conn_id_dapp() {
        let mut ch = make_channel();
        let result = ch.disconnect_by_conn_id(1);
        assert_eq!(result, Some(Role::DApp));
        assert!(ch.dapp_conn.is_none());
        assert!(ch.wallet_conn.is_some());
    }

    #[test]
    fn disconnect_by_conn_id_wallet() {
        let mut ch = make_channel();
        let result = ch.disconnect_by_conn_id(2);
        assert_eq!(result, Some(Role::Wallet));
        assert!(ch.wallet_conn.is_none());
        assert!(ch.dapp_conn.is_some());
    }

    #[test]
    fn disconnect_by_conn_id_unknown() {
        let mut ch = make_channel();
        let result = ch.disconnect_by_conn_id(999);
        assert_eq!(result, None);
        assert!(ch.dapp_conn.is_some());
        assert!(ch.wallet_conn.is_some());
    }
}
