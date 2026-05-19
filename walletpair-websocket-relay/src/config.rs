use std::net::SocketAddr;

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct Config {
    pub listen_addr: SocketAddr,
    pub websocket_path: String,
    pub max_connections: usize,
    pub max_channels: usize,
    pub max_message_bytes: usize,
    pub outbound_queue_size: usize,
    pub pending_request_limit: usize,
    pub unpaired_channel_ttl_secs: u64,
    pub connected_channel_ttl_secs: u64,
    pub cleanup_interval_secs: u64,
    pub graceful_shutdown_timeout_secs: u64,
    pub log_level: String,
    pub metrics_enabled: bool,
    pub allowed_origins: Option<Vec<String>>,
    /// Path to persist channel state on shutdown. When set, the relay saves
    /// all channel metadata and resume tokens to this file during graceful
    /// shutdown, and restores them on the next startup. This allows peers to
    /// reconnect with their saved resume tokens after a relay restart without
    /// re-pairing. Set to `None` or omit to disable persistence.
    pub state_file: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            listen_addr: "0.0.0.0:8080".parse().unwrap(),
            websocket_path: "/v1".to_string(),
            max_connections: 10_000,
            max_channels: 50_000,
            max_message_bytes: 65_536,
            outbound_queue_size: 64,
            pending_request_limit: 32,
            unpaired_channel_ttl_secs: 300,
            connected_channel_ttl_secs: 86_400,
            cleanup_interval_secs: 30,
            graceful_shutdown_timeout_secs: 10,
            log_level: "info".to_string(),
            metrics_enabled: true,
            allowed_origins: None,
            state_file: None,
        }
    }
}

impl Config {
    pub fn load() -> Self {
        // Try loading from file specified by env, then default path, then defaults
        let path = std::env::var("WALLETPAIR_CONFIG").unwrap_or_else(|_| "config.toml".to_string());

        match std::fs::read_to_string(&path) {
            Ok(contents) => match toml::from_str(&contents) {
                Ok(config) => config,
                Err(e) => {
                    eprintln!("warn: failed to parse {path}: {e}, using defaults");
                    Self::default()
                }
            },
            Err(_) => Self::default(),
        }
    }
}
