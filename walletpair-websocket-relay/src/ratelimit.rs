//! Per-IP rate limiting (protocol §17.3).
//!
//! Tracks channel creation rate and concurrent connections per IP address.
//! Uses a simple sliding window counter with periodic cleanup.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::Instant;

/// Per-IP rate limiter for the relay.
pub struct IpRateLimiter {
    /// Max channel creations per IP per window.
    pub max_creates_per_window: u32,
    /// Max concurrent connections per IP.
    pub max_connections_per_ip: usize,
    /// Window duration for create rate limiting.
    window_secs: u64,
    /// Per-IP state.
    state: Mutex<HashMap<IpAddr, IpState>>,
}

struct IpState {
    /// Timestamps of recent channel creation attempts within the current window.
    create_times: Vec<Instant>,
    /// Number of active connections from this IP.
    active_connections: usize,
}

impl IpRateLimiter {
    pub fn new(max_creates_per_window: u32, max_connections_per_ip: usize, window_secs: u64) -> Self {
        Self {
            max_creates_per_window,
            max_connections_per_ip,
            window_secs,
            state: Mutex::new(HashMap::new()),
        }
    }

    /// Check if a new connection from this IP is allowed, and track it.
    /// Returns false if the per-IP connection limit is exceeded.
    pub fn track_connection(&self, ip: IpAddr) -> bool {
        let mut state = self.state.lock().unwrap();
        let entry = state.entry(ip).or_insert_with(|| IpState {
            create_times: Vec::new(),
            active_connections: 0,
        });
        if entry.active_connections >= self.max_connections_per_ip {
            return false;
        }
        entry.active_connections += 1;
        true
    }

    /// Release a connection from this IP.
    pub fn release_connection(&self, ip: IpAddr) {
        let mut state = self.state.lock().unwrap();
        if let Some(entry) = state.get_mut(&ip) {
            entry.active_connections = entry.active_connections.saturating_sub(1);
            // Clean up entry if no connections and no recent creates
            if entry.active_connections == 0 && entry.create_times.is_empty() {
                state.remove(&ip);
            }
        }
    }

    /// Check if a channel creation from this IP is allowed.
    /// Returns false if the rate limit is exceeded.
    pub fn check_create(&self, ip: IpAddr) -> bool {
        let now = Instant::now();
        let window = std::time::Duration::from_secs(self.window_secs);
        let mut state = self.state.lock().unwrap();
        let entry = state.entry(ip).or_insert_with(|| IpState {
            create_times: Vec::new(),
            active_connections: 0,
        });
        // Prune old entries outside the window
        entry.create_times.retain(|t| now.duration_since(*t) < window);
        if entry.create_times.len() >= self.max_creates_per_window as usize {
            return false;
        }
        entry.create_times.push(now);
        true
    }

    /// Periodic cleanup of stale entries.
    pub fn cleanup(&self) {
        let now = Instant::now();
        let window = std::time::Duration::from_secs(self.window_secs);
        let mut state = self.state.lock().unwrap();
        state.retain(|_, entry| {
            entry.create_times.retain(|t| now.duration_since(*t) < window);
            entry.active_connections > 0 || !entry.create_times.is_empty()
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    #[test]
    fn connection_limit() {
        let rl = IpRateLimiter::new(10, 2, 60);
        let ip = IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1));
        assert!(rl.track_connection(ip));
        assert!(rl.track_connection(ip));
        assert!(!rl.track_connection(ip)); // 3rd connection rejected
        rl.release_connection(ip);
        assert!(rl.track_connection(ip)); // now allowed again
    }

    #[test]
    fn create_rate_limit() {
        let rl = IpRateLimiter::new(2, 50, 60);
        let ip = IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1));
        assert!(rl.check_create(ip));
        assert!(rl.check_create(ip));
        assert!(!rl.check_create(ip)); // 3rd create rejected
    }

    #[test]
    fn different_ips_independent() {
        let rl = IpRateLimiter::new(1, 1, 60);
        let ip1 = IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1));
        let ip2 = IpAddr::V4(Ipv4Addr::new(10, 0, 0, 2));
        assert!(rl.track_connection(ip1));
        assert!(rl.track_connection(ip2));
        assert!(!rl.track_connection(ip1));
        assert!(!rl.track_connection(ip2));
    }
}
