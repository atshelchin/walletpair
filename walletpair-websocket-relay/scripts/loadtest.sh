#!/usr/bin/env bash
# WalletPair Relay Load Test Runner
#
# Usage:
#   ./scripts/loadtest.sh                          # defaults: 1000 channels, 10 msgs
#   ./scripts/loadtest.sh --channels 5000 --messages 20
#   RELAY_URL=ws://remote:8080/v1 ./scripts/loadtest.sh
#
# Prerequisites:
#   - Rust toolchain installed
#   - Relay server running (the script starts one if RELAY_URL is not set)

set -euo pipefail
cd "$(dirname "$0")/.."

RELAY_URL="${RELAY_URL:-}"
RELAY_PID=""

cleanup() {
    if [ -n "$RELAY_PID" ]; then
        echo "Stopping relay (PID $RELAY_PID)..."
        kill "$RELAY_PID" 2>/dev/null || true
        wait "$RELAY_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

# Build loadtest tool
echo "Building loadtest tool..."
cargo build --release --manifest-path tools/loadtest/Cargo.toml 2>&1 | tail -1

# Start relay if no URL provided
if [ -z "$RELAY_URL" ]; then
    echo "Building relay..."
    cargo build --release 2>&1 | tail -1

    echo "Starting relay on 127.0.0.1:18080..."
    WALLETPAIR_CONFIG=/dev/null ./target/release/walletpair-websocket-relay &
    RELAY_PID=$!
    sleep 1

    if ! kill -0 "$RELAY_PID" 2>/dev/null; then
        echo "ERROR: relay failed to start"
        exit 1
    fi

    RELAY_URL="ws://127.0.0.1:8080/v1"
fi

echo ""
echo "Relay URL: $RELAY_URL"
echo ""

# Run loadtest
./tools/loadtest/target/release/walletpair-loadtest \
    --url "$RELAY_URL" \
    --test-oversize \
    --test-near-limit \
    "$@"

echo ""
echo "Load test complete."
