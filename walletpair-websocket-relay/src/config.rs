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
    /// Max channel creations per IP per minute (§17.3). 0 = disabled.
    pub max_creates_per_ip_per_min: u32,
    /// Max concurrent connections per IP (§17.3). 0 = disabled.
    pub max_connections_per_ip: usize,
    pub allowed_origins: Option<Vec<String>>,
    /// Path to persist channel state on shutdown. When set, the relay saves
    /// all channel metadata to this file during graceful shutdown, and restores
    /// them on the next startup. Set to `None` or omit to disable persistence.
    pub state_file: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            listen_addr: "0.0.0.0:8080".parse().unwrap(),
            websocket_path: "/v1".to_string(),
            max_connections: 10_000,
            max_channels: 50_000,
            max_creates_per_ip_per_min: 10, // §17.3
            max_connections_per_ip: 50,    // §17.3
            max_message_bytes: 65_536,     // 64 KB — protocol §15 rule 10
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_listen_addr() {
        let c = Config::default();
        assert_eq!(c.listen_addr, "0.0.0.0:8080".parse::<SocketAddr>().unwrap());
    }

    #[test]
    fn default_websocket_path() {
        let c = Config::default();
        assert_eq!(c.websocket_path, "/v1");
    }

    #[test]
    fn default_max_connections() {
        let c = Config::default();
        assert_eq!(c.max_connections, 10_000);
    }

    #[test]
    fn default_max_channels() {
        let c = Config::default();
        assert_eq!(c.max_channels, 50_000);
    }

    #[test]
    fn default_max_message_bytes() {
        let c = Config::default();
        assert_eq!(c.max_message_bytes, 65_536);
    }

    #[test]
    fn default_outbound_queue_size() {
        let c = Config::default();
        assert_eq!(c.outbound_queue_size, 64);
    }

    #[test]
    fn default_pending_request_limit() {
        let c = Config::default();
        assert_eq!(c.pending_request_limit, 32);
    }

    #[test]
    fn default_ttls() {
        let c = Config::default();
        assert_eq!(c.unpaired_channel_ttl_secs, 300);
        assert_eq!(c.connected_channel_ttl_secs, 86_400);
    }

    #[test]
    fn default_cleanup_interval() {
        let c = Config::default();
        assert_eq!(c.cleanup_interval_secs, 30);
    }

    #[test]
    fn default_graceful_shutdown() {
        let c = Config::default();
        assert_eq!(c.graceful_shutdown_timeout_secs, 10);
    }

    #[test]
    fn default_log_level() {
        let c = Config::default();
        assert_eq!(c.log_level, "info");
    }

    #[test]
    fn default_metrics_enabled() {
        let c = Config::default();
        assert!(c.metrics_enabled);
    }

    #[test]
    fn default_allowed_origins_none() {
        let c = Config::default();
        assert!(c.allowed_origins.is_none());
    }

    #[test]
    fn default_state_file_none() {
        let c = Config::default();
        assert!(c.state_file.is_none());
    }

    #[test]
    fn parse_from_toml_full() {
        let toml_str = r#"
            listen_addr = "127.0.0.1:9090"
            websocket_path = "/ws"
            max_connections = 500
            max_channels = 1000
            max_message_bytes = 1024
            outbound_queue_size = 16
            pending_request_limit = 8
            unpaired_channel_ttl_secs = 60
            connected_channel_ttl_secs = 3600
            cleanup_interval_secs = 10
            graceful_shutdown_timeout_secs = 5
            log_level = "debug"
            metrics_enabled = false
            allowed_origins = ["https://example.com"]
            state_file = "/tmp/state.json"
        "#;
        let c: Config = toml::from_str(toml_str).unwrap();
        assert_eq!(c.listen_addr, "127.0.0.1:9090".parse::<SocketAddr>().unwrap());
        assert_eq!(c.websocket_path, "/ws");
        assert_eq!(c.max_connections, 500);
        assert_eq!(c.max_channels, 1000);
        assert_eq!(c.max_message_bytes, 1024);
        assert_eq!(c.outbound_queue_size, 16);
        assert_eq!(c.pending_request_limit, 8);
        assert_eq!(c.unpaired_channel_ttl_secs, 60);
        assert_eq!(c.connected_channel_ttl_secs, 3600);
        assert_eq!(c.cleanup_interval_secs, 10);
        assert_eq!(c.graceful_shutdown_timeout_secs, 5);
        assert_eq!(c.log_level, "debug");
        assert!(!c.metrics_enabled);
        assert_eq!(c.allowed_origins.unwrap(), vec!["https://example.com"]);
        assert_eq!(c.state_file.unwrap(), "/tmp/state.json");
    }

    #[test]
    fn parse_from_toml_partial_uses_defaults() {
        let toml_str = r#"
            max_connections = 200
        "#;
        let c: Config = toml::from_str(toml_str).unwrap();
        assert_eq!(c.max_connections, 200);
        // Everything else should be default
        assert_eq!(c.listen_addr, "0.0.0.0:8080".parse::<SocketAddr>().unwrap());
        assert_eq!(c.max_channels, 50_000);
        assert_eq!(c.websocket_path, "/v1");
        assert!(c.metrics_enabled);
    }

    #[test]
    fn parse_from_empty_toml_all_defaults() {
        let c: Config = toml::from_str("").unwrap();
        let d = Config::default();
        assert_eq!(c.listen_addr, d.listen_addr);
        assert_eq!(c.max_connections, d.max_connections);
        assert_eq!(c.max_channels, d.max_channels);
        assert_eq!(c.log_level, d.log_level);
    }

    #[test]
    fn parse_from_toml_invalid_field_type_errors() {
        let toml_str = r#"
            max_connections = "not_a_number"
        "#;
        let result: Result<Config, _> = toml::from_str(toml_str);
        assert!(result.is_err());
    }

    #[test]
    fn parse_from_toml_invalid_listen_addr_errors() {
        let toml_str = r#"
            listen_addr = "not-an-address"
        "#;
        let result: Result<Config, _> = toml::from_str(toml_str);
        assert!(result.is_err());
    }

    #[test]
    fn default_values_are_sensible() {
        let c = Config::default();
        assert!(c.max_connections > 0);
        assert!(c.max_channels > 0);
        assert!(c.max_message_bytes > 0);
        assert!(c.outbound_queue_size > 0);
        assert!(c.pending_request_limit > 0);
        assert!(c.unpaired_channel_ttl_secs > 0);
        assert!(c.connected_channel_ttl_secs > 0);
        assert!(c.cleanup_interval_secs > 0);
        assert!(c.graceful_shutdown_timeout_secs > 0);
        // Connected TTL should be longer than unpaired TTL
        assert!(c.connected_channel_ttl_secs > c.unpaired_channel_ttl_secs);
    }
}
