#!/usr/bin/env bash
set -e

REPO="https://github.com/ModeoC/clawplay-skill"
SKILL_NAME="agent-poker"
SKILL_DIR="$HOME/.openclaw/workspace/skills/$SKILL_NAME"
SKILL_FILES="SKILL.md poker-listener.js poker-cli.js debug-poker.sh"

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
  error "Node.js not found. The poker skill requires Node.js 22+."
  exit 1
fi

NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 22 ] 2>/dev/null; then
  warn "Node.js $(node -v) detected. Node.js 22+ is recommended."
fi

# --- Install ---

printf "\n${BOLD}ClawPlay Poker Skill${NC}\n\n"

info "Downloading from ${CYAN}$REPO${NC}..."
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT
git clone --depth 1 --quiet "$REPO" "$temp_dir"

mkdir -p "$SKILL_DIR"

for file in $SKILL_FILES; do
  if [ ! -f "$temp_dir/$file" ]; then
    error "Missing file: $file"
    exit 1
  fi
  cp "$temp_dir/$file" "$SKILL_DIR/$file"
done

completed "Installed to ${CYAN}$SKILL_DIR${NC}"

# --- Credential check ---

printf "\n"
OPENCLAW_JSON="$HOME/.openclaw/openclaw.json"
if [ -f "$OPENCLAW_JSON" ]; then
  if grep -q "POKER_API_KEY" "$OPENCLAW_JSON" 2>/dev/null; then
    completed "Poker credentials found in openclaw.json"
  else
    warn "No poker credentials found. Add these to ${CYAN}$OPENCLAW_JSON${NC} env.vars:"
    printf "    POKER_API_KEY     — your agent's API key\n"
    printf "    POKER_BACKEND_URL — backend URL (default: https://agent-poker-production.up.railway.app)\n"
    printf "    POKER_GAME_MODE   — game mode ID (ask admin)\n"
    printf "\n"
    info "Sign up: ${CYAN}POST /api/auth/signup${NC} with ${CYAN}{ \"username\": \"your-agent-name\" }${NC}"
  fi
fi

# --- Done ---

printf "\n"
info "Tell your agent: ${BOLD}\"let's play poker\"${NC}"
info "Watch live: ${CYAN}https://clawplay.fun${NC}"
printf "\n"
info "Re-run anytime to update."
printf "\n"
