#!/bin/sh
# SlayZone agent lifecycle hook.
#
# Installed by the app at ~/.slayzone/hooks/notify.sh (mode 0755).
# Invoked by the host agent (e.g. Claude Code, Codex) via its hooks config.
# Forwards the upstream hook event to the SlayZone app over loopback.
#
# Required env (injected at PTY/chat spawn by buildMcpEnv):
#   SLAYZONE_AGENT_HOOK_URL  - target URL, e.g. http://127.0.0.1:PORT/api/agent-hook
#   SLAYZONE_AGENT_ID        - claude-code | codex | gemini | antigravity | opencode
# Optional:
#   SLAYZONE_TASK_ID         - active task id
#   SLAYZONE_PROJECT_ID      - active project id
#
# Input shapes (handled transparently):
#   stdin  + event in payload "hook_event_name" — Claude Code, Codex, Gemini hooks
#   stdin  + event in env (CLAUDE_HOOK_EVENT)   — Claude/Mastra/Droid
#   stdin  + event NAME in argv $1              — Antigravity (agy) hooks
#   argv $1 = JSON payload                      — legacy / defensive fallback
#
# Contract: ALWAYS exit 0. Hook failures must NOT bubble into the agent TUI
# (Claude renders red error walls otherwise). Silent on any failure.

set -e

# Bail silently when not configured (e.g. agent run outside SlayZone).
[ -z "$SLAYZONE_AGENT_HOOK_URL" ] && exit 0
[ -z "$SLAYZONE_AGENT_ID" ] && exit 0

# Gemini blocks waiting for a JSON response on stdout; empty {} = no-op.
# Claude/Codex/Mastra/Droid discard our stdout, so this is universal.
# Emit before payload read so it fires even if downstream POST fails.
printf '{}\n'

# Hooks pipe JSON via stdin. argv $1: Antigravity (`agy`) passes the event NAME
# there (payload still on stdin) since its payload omits the event; legacy
# callers may pass the JSON payload. Distinguish by content — JSON starts '{'.
HOOK_EVENT_ARG=""
if [ -n "$1" ]; then
  case "$1" in
    '{'*) PAYLOAD="$1" ;;
    *) HOOK_EVENT_ARG="$1" ;;
  esac
fi
[ -z "$PAYLOAD" ] && PAYLOAD=$(cat 2>/dev/null || true)
[ -z "$PAYLOAD" ] && PAYLOAD='{}'

# Resolve hook event name (priority: argv → explicit env → payload hook_event_name → payload type).
HOOK_EVENT="${HOOK_EVENT_ARG:-${CLAUDE_HOOK_EVENT:-${HOOK_EVENT_NAME:-${AGENT_HOOK_EVENT:-}}}}"
if [ -z "$HOOK_EVENT" ]; then
  HOOK_EVENT=$(printf '%s' "$PAYLOAD" | grep -oE '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"' || true)
fi
if [ -z "$HOOK_EVENT" ]; then
  HOOK_EVENT=$(printf '%s' "$PAYLOAD" | grep -oE '"type"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"' || true)
fi
[ -z "$HOOK_EVENT" ] && HOOK_EVENT="Unknown"

# Wrap stdin in an envelope with the contextual env vars. Server merges.
TASK_FIELD=""
[ -n "$SLAYZONE_TASK_ID" ] && TASK_FIELD=",\"taskId\":\"$SLAYZONE_TASK_ID\""

CWD_FIELD=""
[ -n "$PWD" ] && CWD_FIELD=",\"cwd\":\"$PWD\""

# Upstream session id — forwarded as "sessionId" so the server can persist it
# to provider_config (resume-by-id capture). codex/claude carry "session_id";
# Antigravity (`agy`) carries "conversationId" + an ANTIGRAVITY_CONVERSATION_ID
# env var. UUIDs have no quotes/backslashes — a quote-delimited regex is robust.
SESSION_FIELD=""
SESSION_ID=$(printf '%s' "$PAYLOAD" | grep -oE '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"' || true)
[ -z "$SESSION_ID" ] && SESSION_ID="${ANTIGRAVITY_CONVERSATION_ID:-}"
[ -z "$SESSION_ID" ] && SESSION_ID=$(printf '%s' "$PAYLOAD" | grep -oE '"conversationId"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"' || true)
[ -n "$SESSION_ID" ] && SESSION_FIELD=",\"sessionId\":\"$SESSION_ID\""

# SlayZone runtime session id — set for a pre-warmed POOLED agent (no task yet);
# lets the server capture the conversation keyed by session (agent-sessions B).
SLAY_SESSION_FIELD=""
[ -n "$SLAYZONE_SESSION_ID" ] && SLAY_SESSION_FIELD=",\"slaySessionId\":\"$SLAYZONE_SESSION_ID\""

ENVELOPE="{\"agentId\":\"$SLAYZONE_AGENT_ID\",\"hookEvent\":\"$HOOK_EVENT\"$TASK_FIELD$CWD_FIELD$SESSION_FIELD$SLAY_SESSION_FIELD,\"raw\":$PAYLOAD}"

# Fire-and-forget. Errors swallowed; never block the agent.
# curl is the primary path — present on macOS, most Linux, and bundled with
# Git for Windows (whose bash runs this script). wget is a fallback for minimal
# environments; if neither exists the POST is skipped silently.
if command -v curl >/dev/null 2>&1; then
  curl -s \
    --connect-timeout 2 \
    --max-time 5 \
    -X POST \
    -H 'Content-Type: application/json' \
    --data-binary "$ENVELOPE" \
    "$SLAYZONE_AGENT_HOOK_URL" \
    >/dev/null 2>&1 || true
elif command -v wget >/dev/null 2>&1; then
  wget -q -O /dev/null \
    --timeout=5 \
    --header='Content-Type: application/json' \
    --post-data="$ENVELOPE" \
    "$SLAYZONE_AGENT_HOOK_URL" \
    >/dev/null 2>&1 || true
fi

exit 0
