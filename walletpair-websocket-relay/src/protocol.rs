use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

// --- Identifiers ---

/// Channel ID: 64 lowercase hex chars = 32 bytes.
pub type ChannelId = String;

/// Peer ID: base64url-no-pad encoded X25519 public key (32 bytes → 43 chars).
pub type PeerId = String;

// --- Role ---

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Role {
    DApp,
    Wallet,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::DApp => "dapp",
            Role::Wallet => "wallet",
        }
    }
}

impl std::fmt::Display for Role {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

// --- Close Reason ---

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub enum CloseReason {
    Normal,
    UserRejected,
    UnsupportedCapability,
    ChannelNotFound,
    ChannelExists,
    AlreadyConnected,
    InvalidState,
    InvalidRole,
    InvalidResume,
    Timeout,
    PayloadTooLarge,
    ProtocolError,
    UnsupportedVersion,
    DecryptionFailed,
    // Relay-specific (not in protocol spec, used internally)
    SlowConsumer,
    ServerShutdown,
}

impl CloseReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::UserRejected => "user_rejected",
            Self::UnsupportedCapability => "unsupported_capability",
            Self::ChannelNotFound => "channel_not_found",
            Self::ChannelExists => "channel_exists",
            Self::AlreadyConnected => "already_connected",
            Self::InvalidState => "invalid_state",
            Self::InvalidRole => "invalid_role",
            Self::InvalidResume => "invalid_resume",
            Self::Timeout => "timeout",
            Self::PayloadTooLarge => "payload_too_large",
            Self::ProtocolError => "protocol_error",
            Self::UnsupportedVersion => "unsupported_version",
            Self::DecryptionFailed => "decryption_failed",
            Self::SlowConsumer => "slow_consumer",
            Self::ServerShutdown => "server_shutdown",
        }
    }
}

impl std::fmt::Display for CloseReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

// --- Parsed Client Messages ---

/// Messages sent by peers to the relay.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum ClientMessage {
    Create {
        ch: ChannelId,
        from: PeerId,
        resume: Option<String>,
    },
    Join {
        ch: ChannelId,
        from: PeerId,
        resume: Option<String>,
    },
    Accept {
        ch: ChannelId,
        from: PeerId,
        target: PeerId,
    },
    Req {
        ch: ChannelId,
        id: String,
        from: PeerId,
    },
    Res {
        ch: ChannelId,
        id: String,
        from: PeerId,
    },
    Evt {
        ch: ChannelId,
        from: PeerId,
    },
    Ping {
        ch: ChannelId,
        from: PeerId,
    },
    Pong {
        ch: ChannelId,
        from: PeerId,
    },
    Close {
        ch: ChannelId,
        from: PeerId,
        reason: String,
    },
}

impl ClientMessage {
    pub fn channel_id(&self) -> &str {
        match self {
            Self::Create { ch, .. }
            | Self::Join { ch, .. }
            | Self::Accept { ch, .. }
            | Self::Req { ch, .. }
            | Self::Res { ch, .. }
            | Self::Evt { ch, .. }
            | Self::Ping { ch, .. }
            | Self::Pong { ch, .. }
            | Self::Close { ch, .. } => ch,
        }
    }

    pub fn from_peer(&self) -> &str {
        match self {
            Self::Create { from, .. }
            | Self::Join { from, .. }
            | Self::Accept { from, .. }
            | Self::Req { from, .. }
            | Self::Res { from, .. }
            | Self::Evt { from, .. }
            | Self::Ping { from, .. }
            | Self::Pong { from, .. }
            | Self::Close { from, .. } => from,
        }
    }

    pub fn message_type(&self) -> &'static str {
        match self {
            Self::Create { .. } => "create",
            Self::Join { .. } => "join",
            Self::Accept { .. } => "accept",
            Self::Req { .. } => "req",
            Self::Res { .. } => "res",
            Self::Evt { .. } => "evt",
            Self::Ping { .. } => "ping",
            Self::Pong { .. } => "pong",
            Self::Close { .. } => "close",
        }
    }
}

// --- Parse errors ---

#[derive(Debug, Error)]
pub enum ParseError {
    #[error("invalid JSON: {0}")]
    InvalidJson(#[from] serde_json::Error),

    #[error("message is not a JSON object")]
    NotAnObject,

    #[error("missing required field: {0}")]
    MissingField(&'static str),

    #[error("unsupported version: {0}")]
    UnsupportedVersion(u64),

    #[error("unknown message type: {0}")]
    UnknownType(String),

    #[error("invalid channel id: must be 64 lowercase hex characters")]
    InvalidChannelId,

    #[error("invalid peer id: must be base64url-no-pad encoding of 32 bytes")]
    InvalidPeerId,

    #[error("field type error: {0}")]
    #[allow(dead_code)]
    FieldType(&'static str),
}

impl ParseError {
    /// Map parse error to the close reason the relay should send.
    pub fn to_close_reason(&self) -> CloseReason {
        match self {
            Self::UnsupportedVersion(_) => CloseReason::UnsupportedVersion,
            _ => CloseReason::ProtocolError,
        }
    }
}

// --- Validation ---

pub fn validate_channel_id(ch: &str) -> Result<(), ParseError> {
    if ch.len() != 64
        || !ch
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        return Err(ParseError::InvalidChannelId);
    }
    Ok(())
}

pub fn validate_peer_id(peer_id: &str) -> Result<(), ParseError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(peer_id)
        .map_err(|_| ParseError::InvalidPeerId)?;
    if bytes.len() != 32 {
        return Err(ParseError::InvalidPeerId);
    }
    Ok(())
}

// --- Parsing ---

fn get_str<'a>(
    obj: &'a serde_json::Map<String, Value>,
    key: &'static str,
) -> Result<&'a str, ParseError> {
    obj.get(key)
        .and_then(|v| v.as_str())
        .ok_or(ParseError::MissingField(key))
}

fn get_optional_str<'a>(obj: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a str> {
    obj.get(key).and_then(|v| v.as_str())
}

pub fn parse_message(raw: &str) -> Result<ClientMessage, ParseError> {
    let value: Value = serde_json::from_str(raw)?;
    let obj = value.as_object().ok_or(ParseError::NotAnObject)?;

    // Validate version
    let v = obj
        .get("v")
        .and_then(|v| v.as_u64())
        .ok_or(ParseError::MissingField("v"))?;
    if v != 1 {
        return Err(ParseError::UnsupportedVersion(v));
    }

    // Validate common envelope fields
    let t = get_str(obj, "t")?;
    let ch = get_str(obj, "ch")?;
    validate_channel_id(ch)?;
    let ch = ch.to_string();

    // ts must be present and a number
    if obj.get("ts").and_then(|v| v.as_u64()).is_none() {
        return Err(ParseError::MissingField("ts"));
    }

    // from must be present and a string
    let from = get_str(obj, "from")?.to_string();

    // body must be present and an object
    let body = obj
        .get("body")
        .and_then(|v| v.as_object())
        .ok_or(ParseError::MissingField("body"))?;

    match t {
        "create" => {
            validate_peer_id(&from)?;
            let resume = get_optional_str(body, "resume").map(String::from);
            Ok(ClientMessage::Create {
                ch,
                from,
                resume,
            })
        }
        "join" => {
            validate_peer_id(&from)?;
            let resume = get_optional_str(body, "resume").map(String::from);
            Ok(ClientMessage::Join {
                ch,
                from,
                resume,
            })
        }
        "accept" => {
            validate_peer_id(&from)?;
            let target = get_str(body, "target")?.to_string();
            validate_peer_id(&target)?;
            Ok(ClientMessage::Accept { ch, from, target })
        }
        "req" => {
            validate_peer_id(&from)?;
            let id = get_str(body, "id")?.to_string();
            Ok(ClientMessage::Req { ch, id, from })
        }
        "res" => {
            validate_peer_id(&from)?;
            let id = get_str(body, "id")?.to_string();
            if body.get("ok").is_none() {
                return Err(ParseError::MissingField("ok"));
            }
            Ok(ClientMessage::Res { ch, id, from })
        }
        "evt" => {
            validate_peer_id(&from)?;
            Ok(ClientMessage::Evt { ch, from })
        }
        "ping" => {
            validate_peer_id(&from)?;
            Ok(ClientMessage::Ping { ch, from })
        }
        "pong" => {
            validate_peer_id(&from)?;
            Ok(ClientMessage::Pong { ch, from })
        }
        "close" => {
            validate_peer_id(&from)?;
            let reason = get_str(body, "reason")?.to_string();
            Ok(ClientMessage::Close {
                ch,
                from,
                reason,
            })
        }
        "ready" | "terminate" => Err(ParseError::UnknownType(
            format!("{t} (peers must not send {t})")
        )),
        other => Err(ParseError::UnknownType(other.to_string())),
    }
}

// --- Outgoing message builders (relay-generated) ---

/// Current time in milliseconds since Unix epoch.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn build_ready_waiting(ch: &str, role: Role, peer_id: &str, resume: &str) -> String {
    serde_json::json!({
        "v": 1,
        "t": "ready",
        "ch": ch,
        "ts": now_ms(),
        "from": "_adapter",
        "body": {
            "state": "waiting",
            "role": role.as_str(),
            "self": peer_id,
            "remote": null,
            "resume": resume,
        }
    })
    .to_string()
}

pub fn build_ready_connected(
    ch: &str,
    role: Role,
    self_id: &str,
    remote_id: &str,
    resume: &str,
) -> String {
    serde_json::json!({
        "v": 1,
        "t": "ready",
        "ch": ch,
        "ts": now_ms(),
        "from": "_adapter",
        "body": {
            "state": "connected",
            "role": role.as_str(),
            "self": self_id,
            "remote": remote_id,
            "resume": resume,
        }
    })
    .to_string()
}

pub fn build_terminate(ch: &str, reason: CloseReason) -> String {
    serde_json::json!({
        "v": 1,
        "t": "terminate",
        "ch": ch,
        "ts": now_ms(),
        "from": "_adapter",
        "body": {
            "reason": reason.as_str(),
        }
    })
    .to_string()
}

pub fn build_terminate_with_target(ch: &str, reason: CloseReason, target: &str) -> String {
    serde_json::json!({
        "v": 1,
        "t": "terminate",
        "ch": ch,
        "ts": now_ms(),
        "from": "_adapter",
        "body": {
            "reason": reason.as_str(),
            "target": target,
        }
    })
    .to_string()
}

// --- Tests ---

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_channel_id() {
        let id = "a".repeat(64);
        assert!(validate_channel_id(&id).is_ok());
    }

    #[test]
    fn channel_id_wrong_length() {
        assert!(validate_channel_id("abcd").is_err());
    }

    #[test]
    fn channel_id_uppercase_rejected() {
        let id = "A".repeat(64);
        assert!(validate_channel_id(&id).is_err());
    }

    #[test]
    fn channel_id_non_hex_rejected() {
        let mut id = "a".repeat(63);
        id.push('g');
        assert!(validate_channel_id(&id).is_err());
    }

    #[test]
    fn valid_peer_id() {
        // 32 bytes base64url no pad = 43 chars
        let bytes = [0u8; 32];
        let encoded = URL_SAFE_NO_PAD.encode(bytes);
        assert!(validate_peer_id(&encoded).is_ok());
    }

    #[test]
    fn peer_id_wrong_length() {
        let bytes = [0u8; 16];
        let encoded = URL_SAFE_NO_PAD.encode(bytes);
        assert!(validate_peer_id(&encoded).is_err());
    }

    #[test]
    fn peer_id_invalid_base64() {
        assert!(validate_peer_id("not-valid-!!!").is_err());
    }

    fn make_peer_id() -> String {
        URL_SAFE_NO_PAD.encode([1u8; 32])
    }

    fn make_channel_id() -> String {
        "ab".repeat(32)
    }

    #[test]
    fn parse_create_valid() {
        let pid = make_peer_id();
        let ch = make_channel_id();
        let json = serde_json::json!({
            "v": 1, "t": "create", "ch": ch, "ts": 1234, "from": pid,
            "body": {}
        });
        let msg = parse_message(&json.to_string()).unwrap();
        assert!(matches!(msg, ClientMessage::Create { .. }));
        assert_eq!(msg.message_type(), "create");
    }

    #[test]
    fn parse_unsupported_version() {
        let pid = make_peer_id();
        let ch = make_channel_id();
        let json = serde_json::json!({
            "v": 2, "t": "create", "ch": ch, "ts": 1234, "from": pid, "body": {}
        });
        let err = parse_message(&json.to_string()).unwrap_err();
        assert!(matches!(err, ParseError::UnsupportedVersion(2)));
        assert_eq!(err.to_close_reason(), CloseReason::UnsupportedVersion);
    }

    #[test]
    fn parse_unknown_type() {
        let ch = make_channel_id();
        let pid = make_peer_id();
        let json = serde_json::json!({"v": 1, "t": "unknown", "ch": ch, "ts": 1234, "from": pid, "body": {}});
        let err = parse_message(&json.to_string()).unwrap_err();
        assert!(matches!(err, ParseError::UnknownType(_)));
    }

    #[test]
    fn parse_ready_rejected() {
        let ch = make_channel_id();
        let pid = make_peer_id();
        let json = serde_json::json!({"v": 1, "t": "ready", "ch": ch, "ts": 1234, "from": pid, "body": {}});
        let err = parse_message(&json.to_string()).unwrap_err();
        assert!(matches!(err, ParseError::UnknownType(_)));
    }

    #[test]
    fn parse_terminate_rejected() {
        let ch = make_channel_id();
        let pid = make_peer_id();
        let json = serde_json::json!({"v": 1, "t": "terminate", "ch": ch, "ts": 1234, "from": pid, "body": {}});
        let err = parse_message(&json.to_string()).unwrap_err();
        assert!(matches!(err, ParseError::UnknownType(_)));
    }

    #[test]
    fn parse_invalid_json() {
        let err = parse_message("not json").unwrap_err();
        assert!(matches!(err, ParseError::InvalidJson(_)));
    }

    #[test]
    fn parse_not_object() {
        let err = parse_message("[1,2,3]").unwrap_err();
        assert!(matches!(err, ParseError::NotAnObject));
    }

    #[test]
    fn parse_join_valid() {
        let pid = make_peer_id();
        let ch = make_channel_id();
        let json = serde_json::json!({
            "v": 1, "t": "join", "ch": ch, "ts": 1234, "from": pid,
            "body": {"sealed_join": "abc123"}
        });
        let msg = parse_message(&json.to_string()).unwrap();
        assert!(matches!(msg, ClientMessage::Join { .. }));
    }

    #[test]
    fn close_reason_mapping() {
        assert_eq!(CloseReason::Normal.as_str(), "normal");
        assert_eq!(CloseReason::ChannelNotFound.as_str(), "channel_not_found");
        assert_eq!(CloseReason::InvalidResume.as_str(), "invalid_resume");
        assert_eq!(CloseReason::PayloadTooLarge.as_str(), "payload_too_large");
        assert_eq!(
            CloseReason::UnsupportedVersion.as_str(),
            "unsupported_version"
        );
    }

    #[test]
    fn build_ready_waiting_valid_json() {
        let json = build_ready_waiting("ab".repeat(32).as_str(), Role::DApp, "peer", "tok");
        let v: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["t"], "ready");
        assert_eq!(v["from"], "_adapter");
        assert!(v["ts"].as_u64().is_some());
        assert_eq!(v["body"]["state"], "waiting");
        assert_eq!(v["body"]["role"], "dapp");
        assert_eq!(v["body"]["self"], "peer");
        assert!(v["body"]["remote"].is_null());
        assert_eq!(v["body"]["resume"], "tok");
    }

    #[test]
    fn build_ready_connected_valid_json() {
        let json = build_ready_connected(
            "ab".repeat(32).as_str(),
            Role::Wallet,
            "self",
            "remote",
            "tok",
        );
        let v: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["t"], "ready");
        assert_eq!(v["from"], "_adapter");
        assert!(v["ts"].as_u64().is_some());
        assert_eq!(v["body"]["state"], "connected");
        assert_eq!(v["body"]["remote"], "remote");
    }

    #[test]
    fn build_terminate_has_adapter_fields() {
        let json = build_terminate("ab".repeat(32).as_str(), CloseReason::Timeout);
        let v: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["t"], "terminate");
        assert_eq!(v["from"], "_adapter");
        assert!(v["ts"].as_u64().is_some());
        assert_eq!(v["body"]["reason"], "timeout");
    }

    // --- Additional coverage ---

    #[test]
    fn parse_accept_valid() {
        let pid1 = make_peer_id();
        let pid2 = URL_SAFE_NO_PAD.encode([2u8; 32]);
        let ch = make_channel_id();
        let json = serde_json::json!({
            "v": 1, "t": "accept", "ch": ch, "ts": 1234, "from": pid1,
            "body": {"target": pid2}
        });
        let msg = parse_message(&json.to_string()).unwrap();
        assert!(matches!(msg, ClientMessage::Accept { .. }));
        assert_eq!(msg.message_type(), "accept");
        assert_eq!(msg.channel_id(), ch);
        assert_eq!(msg.from_peer(), pid1);
    }

    #[test]
    fn parse_res_valid() {
        let pid = make_peer_id();
        let ch = make_channel_id();
        let json = serde_json::json!({
            "v": 1, "t": "res", "ch": ch, "ts": 1234, "from": pid,
            "body": {"id": "r1", "ok": true, "sealed": "xyz"}
        });
        let msg = parse_message(&json.to_string()).unwrap();
        assert!(matches!(msg, ClientMessage::Res { .. }));
        assert_eq!(msg.message_type(), "res");
    }

    #[test]
    fn parse_res_missing_ok() {
        let pid = make_peer_id();
        let ch = make_channel_id();
        let json = serde_json::json!({
            "v": 1, "t": "res", "ch": ch, "ts": 1234, "from": pid,
            "body": {"id": "r1"}
        });
        assert!(parse_message(&json.to_string()).is_err());
    }

    #[test]
    fn parse_evt_valid() {
        let pid = make_peer_id();
        let ch = make_channel_id();
        let json = serde_json::json!({
            "v": 1, "t": "evt", "ch": ch, "ts": 1234, "from": pid,
            "body": {"id": "e1", "sealed": "xyz"}
        });
        let msg = parse_message(&json.to_string()).unwrap();
        assert!(matches!(msg, ClientMessage::Evt { .. }));
        assert_eq!(msg.message_type(), "evt");
    }

    #[test]
    fn parse_ping_valid() {
        let pid = make_peer_id();
        let ch = make_channel_id();
        let json = serde_json::json!({
            "v": 1, "t": "ping", "ch": ch, "ts": 1234, "from": pid, "body": {}
        });
        let msg = parse_message(&json.to_string()).unwrap();
        assert!(matches!(msg, ClientMessage::Ping { .. }));
        assert_eq!(msg.message_type(), "ping");
    }

    #[test]
    fn parse_pong_valid() {
        let pid = make_peer_id();
        let ch = make_channel_id();
        let json = serde_json::json!({
            "v": 1, "t": "pong", "ch": ch, "ts": 1234, "from": pid, "body": {}
        });
        let msg = parse_message(&json.to_string()).unwrap();
        assert!(matches!(msg, ClientMessage::Pong { .. }));
        assert_eq!(msg.message_type(), "pong");
    }

    #[test]
    fn parse_close_valid() {
        let pid = make_peer_id();
        let ch = make_channel_id();
        let json = serde_json::json!({
            "v": 1, "t": "close", "ch": ch, "ts": 1234, "from": pid,
            "body": {"reason": "normal"}
        });
        let msg = parse_message(&json.to_string()).unwrap();
        assert!(matches!(msg, ClientMessage::Close { .. }));
        assert_eq!(msg.message_type(), "close");
    }

    #[test]
    fn parse_close_reason_extracted() {
        let pid = make_peer_id();
        let ch = make_channel_id();
        let json = serde_json::json!({
            "v": 1, "t": "close", "ch": ch, "ts": 1234, "from": pid,
            "body": {"reason": "user_rejected"}
        });
        let msg = parse_message(&json.to_string()).unwrap();
        match msg {
            ClientMessage::Close { reason, .. } => {
                assert_eq!(reason, "user_rejected");
            }
            _ => panic!("expected Close"),
        }
    }

    #[test]
    fn parse_missing_version() {
        let ch = make_channel_id();
        let json = serde_json::json!({"t": "create", "ch": ch});
        let err = parse_message(&json.to_string()).unwrap_err();
        assert!(matches!(err, ParseError::MissingField("v")));
    }

    #[test]
    fn parse_missing_type() {
        let ch = make_channel_id();
        let json = serde_json::json!({"v": 1, "ch": ch});
        let err = parse_message(&json.to_string()).unwrap_err();
        assert!(matches!(err, ParseError::MissingField("t")));
    }

    #[test]
    fn parse_missing_channel() {
        let json = serde_json::json!({"v": 1, "t": "create"});
        let err = parse_message(&json.to_string()).unwrap_err();
        assert!(matches!(err, ParseError::MissingField("ch")));
    }

    #[test]
    fn parse_invalid_channel_id_in_message() {
        let json = serde_json::json!({"v": 1, "t": "create", "ch": "tooshort"});
        let err = parse_message(&json.to_string()).unwrap_err();
        assert!(matches!(err, ParseError::InvalidChannelId));
    }

    #[test]
    fn parse_version_zero() {
        let ch = make_channel_id();
        let json = serde_json::json!({"v": 0, "t": "create", "ch": ch});
        let err = parse_message(&json.to_string()).unwrap_err();
        assert!(matches!(err, ParseError::UnsupportedVersion(0)));
    }

    #[test]
    fn parse_missing_ts() {
        let pid = make_peer_id();
        let ch = make_channel_id();
        let json = serde_json::json!({
            "v": 1, "t": "create", "ch": ch, "from": pid, "body": {}
        });
        let err = parse_message(&json.to_string()).unwrap_err();
        assert!(matches!(err, ParseError::MissingField("ts")));
    }

    #[test]
    fn parse_missing_body() {
        let pid = make_peer_id();
        let ch = make_channel_id();
        let json = serde_json::json!({
            "v": 1, "t": "create", "ch": ch, "ts": 1234, "from": pid
        });
        let err = parse_message(&json.to_string()).unwrap_err();
        assert!(matches!(err, ParseError::MissingField("body")));
    }

    #[test]
    fn parse_req_valid() {
        let pid = make_peer_id();
        let ch = make_channel_id();
        let json = serde_json::json!({
            "v": 1, "t": "req", "ch": ch, "ts": 1234, "from": pid,
            "body": {"id": "r42", "sealed": "encrypted_data"}
        });
        let msg = parse_message(&json.to_string()).unwrap();
        match msg {
            ClientMessage::Req { id, .. } => assert_eq!(id, "r42"),
            _ => panic!("expected Req"),
        }
    }

    #[test]
    fn parse_create_with_resume() {
        let pid = make_peer_id();
        let ch = make_channel_id();
        let json = serde_json::json!({
            "v": 1, "t": "create", "ch": ch, "ts": 1234, "from": pid,
            "body": {"resume": "some-token"}
        });
        let msg = parse_message(&json.to_string()).unwrap();
        match msg {
            ClientMessage::Create { resume, .. } => assert_eq!(resume.unwrap(), "some-token"),
            _ => panic!("expected Create"),
        }
    }

    #[test]
    fn all_close_reasons_as_str() {
        let reasons = vec![
            (CloseReason::Normal, "normal"),
            (CloseReason::UserRejected, "user_rejected"),
            (CloseReason::UnsupportedCapability, "unsupported_capability"),
            (CloseReason::ChannelNotFound, "channel_not_found"),
            (CloseReason::ChannelExists, "channel_exists"),
            (CloseReason::AlreadyConnected, "already_connected"),
            (CloseReason::InvalidState, "invalid_state"),
            (CloseReason::InvalidRole, "invalid_role"),
            (CloseReason::InvalidResume, "invalid_resume"),
            (CloseReason::Timeout, "timeout"),
            (CloseReason::PayloadTooLarge, "payload_too_large"),
            (CloseReason::ProtocolError, "protocol_error"),
            (CloseReason::UnsupportedVersion, "unsupported_version"),
            (CloseReason::DecryptionFailed, "decryption_failed"),
            (CloseReason::SlowConsumer, "slow_consumer"),
            (CloseReason::ServerShutdown, "server_shutdown"),
        ];
        for (reason, expected) in reasons {
            assert_eq!(reason.as_str(), expected);
            // Also test Display
            assert_eq!(format!("{}", reason), expected);
        }
    }

    #[test]
    fn role_as_str_and_display() {
        assert_eq!(Role::DApp.as_str(), "dapp");
        assert_eq!(Role::Wallet.as_str(), "wallet");
        assert_eq!(format!("{}", Role::DApp), "dapp");
        assert_eq!(format!("{}", Role::Wallet), "wallet");
    }

    #[test]
    fn parse_error_to_close_reason_protocol_error_for_most() {
        let err = ParseError::InvalidChannelId;
        assert_eq!(err.to_close_reason(), CloseReason::ProtocolError);

        let err = ParseError::MissingField("x");
        assert_eq!(err.to_close_reason(), CloseReason::ProtocolError);

        let err = ParseError::NotAnObject;
        assert_eq!(err.to_close_reason(), CloseReason::ProtocolError);
    }

    #[test]
    fn build_terminate_with_target_includes_target() {
        let ch = "ab".repeat(32);
        let json = build_terminate_with_target(&ch, CloseReason::ProtocolError, "some_target");
        let v: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["body"]["target"], "some_target");
        assert_eq!(v["body"]["reason"], "protocol_error");
        assert_eq!(v["v"], 1);
        assert_eq!(v["t"], "terminate");
        assert_eq!(v["from"], "_adapter");
    }

    #[test]
    fn channel_id_empty_string_rejected() {
        assert!(validate_channel_id("").is_err());
    }

    #[test]
    fn channel_id_65_chars_rejected() {
        let id = "a".repeat(65);
        assert!(validate_channel_id(&id).is_err());
    }

    #[test]
    fn channel_id_mixed_case_rejected() {
        let mut id = "a".repeat(63);
        id.push('A');
        assert!(validate_channel_id(&id).is_err());
    }

    #[test]
    fn valid_channel_id_all_hex_chars() {
        let id = "0123456789abcdef".repeat(4);
        assert!(validate_channel_id(&id).is_ok());
    }

    #[test]
    fn peer_id_empty_rejected() {
        assert!(validate_peer_id("").is_err());
    }
}
