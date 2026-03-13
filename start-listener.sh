#!/usr/bin/env bash
# Start the clawplay-listener in the background.
# Reads systemdScope and agentId from clawplay-config.json (set at install time).
# On systemd systems, launches in a separate cgroup scope so the listener
# survives gateway restarts.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/clawplay-config.json"

# Read config values
USE_SCOPE=false
SCOPE_ID="main"
if [ -f "$CONFIG_FILE" ]; then
  USE_SCOPE=$(node -e "
    try {
      const c = JSON.parse(require('fs').readFileSync('$CONFIG_FILE', 'utf8'));
      process.stdout.write(c.systemdScope ? 'true' : 'false');
    } catch { process.stdout.write('false'); }
  " 2>/dev/null || echo "false")
  SCOPE_ID=$(node -e "
    try {
      const c = JSON.parse(require('fs').readFileSync('$CONFIG_FILE', 'utf8'));
      process.stdout.write(c.agentId || 'main');
    } catch { process.stdout.write('main'); }
  " 2>/dev/null || echo "main")
fi

SCOPE_UNIT="clawplay-listener-${SCOPE_ID}"

if [ "$USE_SCOPE" = "true" ]; then
  systemctl --user stop "${SCOPE_UNIT}.scope" 2>/dev/null || true
  systemd-run --user --scope --quiet --unit="$SCOPE_UNIT" -- \
    node "$SCRIPT_DIR/clawplay-listener.js" "$@" > /dev/null 2>&1 &
else
  node "$SCRIPT_DIR/clawplay-listener.js" "$@" > /dev/null 2>&1 &
fi
