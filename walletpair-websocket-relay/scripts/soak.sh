#!/usr/bin/env bash
# WalletPair Relay Soak Test
#
# Runs the load test repeatedly for a specified duration, checking for
# memory leaks, channel leaks, and stability.
#
# Usage:
#   ./scripts/soak.sh                    # 10 minutes by default
#   SOAK_DURATION=1800 ./scripts/soak.sh # 30 minutes
#   RELAY_URL=ws://host:8080/v1 ./scripts/soak.sh

set -euo pipefail
cd "$(dirname "$0")/.."

SOAK_DURATION="${SOAK_DURATION:-600}"  # seconds
RELAY_URL="${RELAY_URL:-ws://127.0.0.1:8080/v1}"
CHANNELS_PER_ROUND=500
MESSAGES_PER_CHANNEL=5
CONCURRENCY=50
RELAY_PID=""

cleanup() {
    if [ -n "$RELAY_PID" ]; then
        echo "Stopping relay (PID $RELAY_PID)..."
        kill "$RELAY_PID" 2>/dev/null || true
        wait "$RELAY_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

# Build tools
echo "Building..."
cargo build --release 2>&1 | tail -1
cargo build --release --manifest-path tools/loadtest/Cargo.toml 2>&1 | tail -1

# Start relay if not running
if ! curl -sf http://127.0.0.1:8080/healthz > /dev/null 2>&1; then
    echo "Starting relay..."
    WALLETPAIR_CONFIG=/dev/null ./target/release/walletpair-websocket-relay &
    RELAY_PID=$!
    sleep 1
fi

echo ""
echo "=== Soak Test ==="
echo "Duration:  ${SOAK_DURATION}s"
echo "Relay:     $RELAY_URL"
echo "Channels:  $CHANNELS_PER_ROUND per round"
echo ""

START=$(date +%s)
ROUND=0
TOTAL_ERRORS=0
INITIAL_RSS=$(ps -o rss= -p $(pgrep -f walletpair-websocket-relay | head -1) 2>/dev/null || echo "0")

while true; do
    NOW=$(date +%s)
    ELAPSED=$((NOW - START))
    if [ "$ELAPSED" -ge "$SOAK_DURATION" ]; then
        break
    fi

    ROUND=$((ROUND + 1))
    echo "--- Round $ROUND (elapsed: ${ELAPSED}s / ${SOAK_DURATION}s) ---"

    # Run a batch
    OUTPUT=$(./tools/loadtest/target/release/walletpair-loadtest \
        --url "$RELAY_URL" \
        --channels "$CHANNELS_PER_ROUND" \
        --messages "$MESSAGES_PER_CHANNEL" \
        --concurrency "$CONCURRENCY" \
        --timeout-secs 15 2>&1) || true

    # Extract key stats
    ERRORS=$(echo "$OUTPUT" | grep "^Errors:" | awk '{print $2}')
    COMPLETED=$(echo "$OUTPUT" | grep "^Channels completed:" | awk '{print $2}')
    P95=$(echo "$OUTPUT" | grep "p95:" | awk '{print $2}')

    ERRORS=${ERRORS:-0}
    TOTAL_ERRORS=$((TOTAL_ERRORS + ERRORS))

    # Get relay metrics
    RELAY_PID_ACTUAL=$(pgrep -f walletpair-websocket-relay | head -1 2>/dev/null || echo "")
    if [ -n "$RELAY_PID_ACTUAL" ]; then
        CURRENT_RSS=$(ps -o rss= -p "$RELAY_PID_ACTUAL" 2>/dev/null || echo "?")
    else
        CURRENT_RSS="?"
    fi
    ACTIVE_CH=$(curl -sf http://127.0.0.1:8080/metrics 2>/dev/null | grep "^walletpair_active_channels " | awk '{print $2}' || echo "?")
    ACTIVE_CONN=$(curl -sf http://127.0.0.1:8080/metrics 2>/dev/null | grep "^walletpair_active_connections " | awk '{print $2}' || echo "?")

    echo "  Completed: $COMPLETED | Errors: $ERRORS | p95: $P95"
    echo "  RSS: ${CURRENT_RSS}KB | Active channels: $ACTIVE_CH | Active conns: $ACTIVE_CONN"

    # Brief pause between rounds
    sleep 1
done

echo ""
echo "=== Soak Test Complete ==="
echo "Rounds:       $ROUND"
echo "Total errors: $TOTAL_ERRORS"
echo "Initial RSS:  ${INITIAL_RSS}KB"

RELAY_PID_ACTUAL=$(pgrep -f walletpair-websocket-relay | head -1 2>/dev/null || echo "")
if [ -n "$RELAY_PID_ACTUAL" ]; then
    FINAL_RSS=$(ps -o rss= -p "$RELAY_PID_ACTUAL" 2>/dev/null || echo "?")
    echo "Final RSS:    ${FINAL_RSS}KB"
fi

FINAL_CH=$(curl -sf http://127.0.0.1:8080/metrics 2>/dev/null | grep "^walletpair_active_channels " | awk '{print $2}' || echo "?")
echo "Final active channels: $FINAL_CH"

if [ "$TOTAL_ERRORS" -gt 0 ]; then
    echo "WARN: $TOTAL_ERRORS total errors across $ROUND rounds"
fi
