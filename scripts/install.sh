#!/usr/bin/env bash
set -e

REPO="https://github.com/ModeoC/clawplay-skill"
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

info "Downloading from ${CYAN}$REPO${NC}..."
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT
git clone --depth 1 --quiet "$REPO" "$temp_dir"

mkdir -p "$SKILL_DIR"

# Required files (flat layout)
for file in SKILL.md poker-listener.js poker-cli.js; do
  if [ ! -f "$temp_dir/$file" ]; then
    error "Missing file: $file"
    exit 1
  fi
  cp "$temp_dir/$file" "$SKILL_DIR/$file"
done

# Write config (preserve existing on reinstall — agent may have customized it)
CONFIG_FILE="$SKILL_DIR/clawplay-config.json"
if [ ! -f "$CONFIG_FILE" ]; then
  if [ -n "$AGENT_ID" ]; then
    printf '{ "apiKeyEnvVar": "%s", "agentId": "%s" }\n' "$ENV_VAR" "$AGENT_ID" > "$CONFIG_FILE"
  else
    printf '{ "apiKeyEnvVar": "CLAWPLAY_API_KEY_PRIMARY" }\n' > "$CONFIG_FILE"
  fi
fi

completed "Installed to ${CYAN}$SKILL_DIR${NC}"

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
fi

# --- Done ---

printf "\n"
info "Tell your agent: ${BOLD}\"let's play poker\"${NC}"
info "Watch live: ${CYAN}https://clawplay.fun${NC}"
printf "\n"
info "Re-run anytime to update."
printf "\n"
