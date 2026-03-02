#!/usr/bin/env bash
# debug-poker.sh — Quick CLI for agent-poker diagnostics
set -euo pipefail

# Source poker env vars from openclaw.json if not already in environment
if [[ -z "${POKER_BACKEND_URL:-}" ]]; then
  OC_CFG="${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}"
  [[ -f "$OC_CFG" ]] || { echo "No openclaw.json found at $OC_CFG"; exit 1; }
  POKER_BACKEND_URL=$(jq -r '.env.vars.POKER_BACKEND_URL // empty' "$OC_CFG")
  POKER_API_KEY=$(jq -r '.env.vars.POKER_API_KEY // empty' "$OC_CFG")
  POKER_ADMIN_API_KEY=$(jq -r '.env.vars.POKER_ADMIN_API_KEY // empty' "$OC_CFG")
fi

BACKEND="${POKER_BACKEND_URL:?Set POKER_BACKEND_URL in openclaw.json env.vars}"
ADMIN_KEY="${POKER_ADMIN_API_KEY:?Set POKER_ADMIN_API_KEY in openclaw.json env.vars}"
PLAYER_KEY="${POKER_API_KEY:?Set POKER_API_KEY in openclaw.json env.vars}"

usage() {
  cat <<'EOF'
Usage: debug-poker.sh <command> [args]

Poker backend queries:
  tables                  List active tables
  history <tableId>       Hand history for a table
  players                 List all players
  balance                 Player chip balance
  leaderboard             Weekly leaderboard
  views <tableId>         God-mode views (all players' cards)
  recent                  Recent hands across all tables

OpenClaw logs & messages:
  logs [--follow]         Tail gateway logs (last 200 lines, or follow)
  telegram [limit]        Read recent Telegram messages (default: 20)
  sessions                List OpenClaw sessions

Listener diagnostics:
  context                 Show current poker-game-context.json
  session-log             Show poker-session-log.md
EOF
}

api() {
  local key=$1 path=$2
  curl -sf -H "x-api-key: $key" "$BACKEND$path" | jq .
}

case "${1:-help}" in
  tables)
    api "$ADMIN_KEY" "/api/admin/tables"
    ;;
  history)
    [[ -z "${2:-}" ]] && { echo "Usage: debug-poker.sh history <tableId>"; exit 1; }
    api "$ADMIN_KEY" "/api/admin/tables/$2/history"
    ;;
  players)
    api "$ADMIN_KEY" "/api/admin/players"
    ;;
  balance)
    api "$PLAYER_KEY" "/api/chips/balance"
    ;;
  leaderboard)
    curl -sf "$BACKEND/api/public/leaderboard" | jq .
    ;;
  views)
    [[ -z "${2:-}" ]] && { echo "Usage: debug-poker.sh views <tableId>"; exit 1; }
    api "$ADMIN_KEY" "/api/admin/game/$2/views"
    ;;
  recent)
    curl -sf "$BACKEND/api/public/hands/recent" | jq .
    ;;
  logs)
    if [[ "${2:-}" == "--follow" ]]; then
      openclaw logs --follow --local-time
    else
      openclaw logs --limit 200 --local-time
    fi
    ;;
  telegram)
    local_limit="${2:-20}"
    openclaw message read --channel telegram --limit "$local_limit" --json | jq .
    ;;
  sessions)
    openclaw sessions --active 360 --json | jq .
    ;;
  context)
    jq . ~/agent-poker/agent-poker-skill/poker-game-context.json 2>/dev/null || echo "No context file found"
    ;;
  session-log)
    cat ~/agent-poker/agent-poker-skill/poker-session-log.md 2>/dev/null || echo "No session log found"
    ;;
  help|--help|-h)
    usage
    ;;
  *)
    echo "Unknown command: $1"
    usage
    exit 1
    ;;
esac
