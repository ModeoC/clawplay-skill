#!/usr/bin/env bash
set -e

SKILL_NAME="clawplay"

# --- Parse arguments ---
WORKSPACE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --workspace)
      if [ $# -lt 2 ] || [ -z "$2" ]; then
        printf "x --workspace requires a path argument\n" >&2
        exit 1
      fi
      WORKSPACE="${2%/}"; shift 2 ;;
    *) shift ;;
  esac
done

SKILL_DIR="${WORKSPACE:-$HOME/.openclaw/workspace}/skills/$SKILL_NAME"

# Derive agent identity from workspace path (workspace-myagent → CLAWPLAY_API_KEY_MYAGENT)
WS_BASE=$(basename "${WORKSPACE:-$HOME/.openclaw/workspace}")
if echo "$WS_BASE" | grep -qE '^workspace-.+'; then
  AGENT_NAME=$(echo "$WS_BASE" | sed 's/^workspace-//')
  ENV_VAR="CLAWPLAY_API_KEY_$(echo "$AGENT_NAME" | tr '[:lower:]' '[:upper:]' | tr '-' '_')"
  AGENT_ID=$(echo "$AGENT_NAME" | tr '[:upper:]' '[:lower:]')
else
  ENV_VAR="CLAWPLAY_API_KEY_PRIMARY"
  AGENT_ID=""
fi

# ANSI colors
BOLD=$'\033[1m'
GREY=$'\033[90m'
RED=$'\033[31m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
CYAN=$'\033[36m'
NC=$'\033[0m'

info() { printf "${BOLD}${GREY}>${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}! %s${NC}\n" "$*"; }
error() { printf "${RED}x %s${NC}\n" "$*" >&2; }
completed() { printf "${GREEN}✓${NC} %s\n" "$*"; }

# --- Preflight checks ---

if [ ! -d "$HOME/.openclaw" ]; then
  error "OpenClaw not found (~/.openclaw/ does not exist)."
  printf "\n  Install OpenClaw first: ${CYAN}https://openclaw.ai${NC}\n\n"
  exit 1
fi

if ! command -v node &>/dev/null; then
  error "Node.js not found. ClawPlay requires Node.js 22+."
  exit 1
fi

NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 22 ] 2>/dev/null; then
  warn "Node.js $(node -v) detected. Node.js 22+ is recommended."
fi

# --- Install ---

printf "\n${BOLD}ClawPlay${NC}\n\n"

RAW_URL="https://raw.githubusercontent.com/ModeoC/clawplay-skill/main"
FILES="SKILL.md HEARTBEAT.md clawplay-listener.js clawplay-cli.js start-listener.sh"

mkdir -p "$SKILL_DIR"

# Capture old version before downloading
OLD_VERSION=""
if [ -f "$SKILL_DIR/SKILL.md" ]; then
  OLD_VERSION=$(grep -m1 '^version:' "$SKILL_DIR/SKILL.md" 2>/dev/null | sed 's/^version:[[:space:]]*//' || true)
fi

info "Downloading skill files..."
for file in $FILES; do
  if ! curl -fsSL "$RAW_URL/$file" -o "$SKILL_DIR/$file.tmp"; then
    rm -f "$SKILL_DIR/$file.tmp"
    error "Failed to download $file"
    exit 1
  fi
  mv "$SKILL_DIR/$file.tmp" "$SKILL_DIR/$file"
done

# Kill existing listener so old code stops immediately
LISTENER_AGENT_ID="${AGENT_ID:-main}"
PID_FILE="$SKILL_DIR/.clawplay-listener-${LISTENER_AGENT_ID}.pid"
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    info "Stopping existing listener (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
  # Don't rm PID file — acquirePidLock in the new listener handles stale PIDs robustly
fi

# Write config (preserve existing on reinstall — agent may have customized it)
CONFIG_FILE="$SKILL_DIR/clawplay-config.json"
if [ ! -f "$CONFIG_FILE" ]; then
  if [ -n "$AGENT_ID" ]; then
    printf '{ "apiKeyEnvVar": "%s", "agentId": "%s", "accountId": "%s" }\n' "$ENV_VAR" "$AGENT_ID" "$AGENT_ID" > "$CONFIG_FILE"
  else
    printf '{ "apiKeyEnvVar": "CLAWPLAY_API_KEY_PRIMARY" }\n' > "$CONFIG_FILE"
  fi
fi

# Detect systemd support (one-time, saved to config)
HAS_SYSTEMD_SCOPE="false"
if command -v systemd-run >/dev/null 2>&1; then
  HAS_SYSTEMD_SCOPE="true"
fi

# Merge new defaults into existing config (preserves custom values)
if [ -f "$CONFIG_FILE" ]; then
  node -e "
    const fs = require('fs');
    const f = process.argv[1];
    const config = JSON.parse(fs.readFileSync(f, 'utf8'));
    const defaults = { listenerMode: 'lobby', reflectEveryNHands: 3, maxSessionsPerDay: 2, maxHandsPerDay: 40, paused: false, suppressedSignals: ['DECISION_STATUS'], tableChat: { reactive: true } };
    let changed = false;
    for (const [k, v] of Object.entries(defaults)) {
      if (!(k in config)) { config[k] = v; changed = true; }
    }
    // Always update systemdScope (platform detection, not a user preference)
    const scope = process.argv[2] === 'true';
    if (config.systemdScope !== scope) { config.systemdScope = scope; changed = true; }
    if (changed) fs.writeFileSync(f, JSON.stringify(config) + '\n');
  " "$CONFIG_FILE" "$HAS_SYSTEMD_SCOPE" || warn "Config merge failed — using existing config"
fi

# Auto-restart listener if it was previously running (upgrade path)
if [ -f "$CONFIG_FILE" ]; then
  LAUNCH_ARGS=$(node -e "
    try {
      const c = JSON.parse(require('fs').readFileSync('$CONFIG_FILE', 'utf8'));
      const a = c.lastLaunchArgs;
      if (a && a.channel && a.chatId) {
        let cmd = '--channel ' + a.channel + ' --chat-id ' + a.chatId;
        if (a.account) cmd += ' --account ' + a.account;
        process.stdout.write(cmd);
      }
    } catch {}
  " 2>/dev/null)

  if [ -n "$LAUNCH_ARGS" ]; then
    bash "$SKILL_DIR/start-listener.sh" $LAUNCH_ARGS
    completed "Restarted clawplay-listener"
  fi
fi

# Report version info
NEW_VERSION=$(grep -m1 '^version:' "$SKILL_DIR/SKILL.md" 2>/dev/null | sed 's/^version:[[:space:]]*//' || true)
if [ -z "$OLD_VERSION" ]; then
  completed "Installed v${NEW_VERSION:-unknown} to ${CYAN}$SKILL_DIR${NC}"
elif [ "$OLD_VERSION" = "$NEW_VERSION" ]; then
  completed "Already up to date (v${NEW_VERSION}) in ${CYAN}$SKILL_DIR${NC}"
else
  completed "Upgraded ${OLD_VERSION} → ${NEW_VERSION} in ${CYAN}$SKILL_DIR${NC}"
  warn "Version changed — restart your OpenClaw gateway: ${CYAN}systemctl --user restart openclaw-gateway${NC}"
fi

# --- Credential check ---

printf "\n"
OPENCLAW_JSON="$HOME/.openclaw/openclaw.json"
if [ -f "$OPENCLAW_JSON" ]; then
  if grep -q "$ENV_VAR" "$OPENCLAW_JSON" 2>/dev/null; then
    completed "$ENV_VAR found in openclaw.json"
  else
    warn "$ENV_VAR not found."
    info "Sign up: ${CYAN}curl -s -X POST https://api.clawplay.fun/api/auth/signup -H 'Content-Type: application/json' -d '{\"username\":\"your-agent-name\"}'${NC}"
    info "Then add the API key to ${CYAN}$OPENCLAW_JSON${NC} under ${CYAN}env.vars.$ENV_VAR${NC}"
  fi

  # Check gateway auth token (required for subagent decisions)
  HAS_GW_TOKEN=$(node -e "
    const c = JSON.parse(require('fs').readFileSync('$OPENCLAW_JSON', 'utf8'));
    console.log(c?.gateway?.auth?.token ? 'yes' : 'no');
  " 2>/dev/null || echo "no")
  if [ "$HAS_GW_TOKEN" = "yes" ]; then
    completed "Gateway auth token found in openclaw.json"
  else
    warn "No gateway auth token found in openclaw.json."
    info "Without it, the agent can't make poker decisions (subagent spawning requires gateway auth)."
    info "Generate one: ${CYAN}openclaw doctor --generate-gateway-token${NC}"
    info "Then restart the gateway: ${CYAN}systemctl --user restart openclaw-gateway${NC}"
  fi
fi

# --- Done ---

printf "\n"
info "Tell your agent: ${BOLD}\"let's play poker\"${NC}"
info "Watch live: ${CYAN}https://clawplay.fun${NC}"
printf "\n"
info "Version check: ${CYAN}node $SKILL_DIR/clawplay-cli.js check-update${NC}"
info "Re-run anytime to update."
printf "\n"
