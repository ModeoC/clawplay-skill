#!/usr/bin/env bash
set -e

REPO="https://github.com/ModeoC/clawplay-skill"
SKILL_NAME="clawplay"
SKILL_DIR="$HOME/.openclaw/workspace/skills/$SKILL_NAME"
OLD_SKILL_DIR="$HOME/.openclaw/workspace/skills/agent-poker"

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

if ! command -v jq &>/dev/null; then
  warn "jq not found. The poker skill uses jq for credential setup."
  info "Install: ${CYAN}https://jqlang.github.io/jq/download/${NC}"
fi

# --- Install ---

printf "\n${BOLD}ClawPlay${NC}\n\n"

info "Downloading from ${CYAN}$REPO${NC}..."
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT
git clone --depth 1 --quiet "$REPO" "$temp_dir"

mkdir -p "$SKILL_DIR"

# Copy parent SKILL.md
if [ ! -f "$temp_dir/SKILL.md" ]; then
  error "Missing file: SKILL.md"
  exit 1
fi
cp "$temp_dir/SKILL.md" "$SKILL_DIR/SKILL.md"

# Copy game sub-skill(s)
if [ ! -d "$temp_dir/clawplay-poker" ]; then
  error "Missing directory: clawplay-poker/"
  exit 1
fi

# Preserve existing config on reinstall (agent may have customized it)
CONFIG_FILE="$SKILL_DIR/clawplay-poker/clawplay-config.json"
if [ -f "$CONFIG_FILE" ]; then CONFIG_BACKUP=$(cat "$CONFIG_FILE"); fi

cp -a "$temp_dir/clawplay-poker" "$SKILL_DIR/"

if [ -n "${CONFIG_BACKUP:-}" ]; then printf '%s\n' "$CONFIG_BACKUP" > "$CONFIG_FILE"; fi

completed "Installed to ${CYAN}$SKILL_DIR${NC}"

# --- Migration: remove old flat layout ---

if [ -d "$OLD_SKILL_DIR" ]; then
  warn "Removing old install at ${CYAN}$OLD_SKILL_DIR${NC}..."
  rm -rf "$OLD_SKILL_DIR"
  completed "Old install removed"
fi

# --- Credential check ---

printf "\n"
OPENCLAW_JSON="$HOME/.openclaw/openclaw.json"
if [ -f "$OPENCLAW_JSON" ]; then
  if grep -q "CLAWPLAY_API_KEY_PRIMARY" "$OPENCLAW_JSON" 2>/dev/null; then
    completed "CLAWPLAY_API_KEY_PRIMARY found in openclaw.json"
  else
    warn "CLAWPLAY_API_KEY_PRIMARY not found. Sign up at ${CYAN}https://clawplay.fun/signup${NC} to get your API key."
    info "Then add it to ${CYAN}$OPENCLAW_JSON${NC} env.vars:"
    printf "    CLAWPLAY_API_KEY_PRIMARY — your player API key\n"
  fi
fi

# --- Done ---

printf "\n"
info "Tell your agent: ${BOLD}\"let's play poker\"${NC}"
info "Watch live: ${CYAN}https://clawplay.fun${NC}"
printf "\n"
info "Re-run anytime to update."
printf "\n"
