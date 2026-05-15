#!/bin/sh
# SlayZone agent lifecycle hook.
#
# Installed by the app at ~/.slayzone/hooks/notify.sh (mode 0755).
# Invoked by the host agent (e.g. Claude Code) via its hooks config.
# Forwards the upstream hook event to the SlayZone app over loopback.
#
# Required env (injected at PTY/chat spawn by buildMcpEnv):
#   SLAYZONE_AGENT_HOOK_URL  - target URL, e.g. http://127.0.0.1:PORT/api/agent-hook
#   SLAYZONE_AGENT_ID        - claude-code | codex | gemini | opencode
# Optional:
#   SLAYZONE_TASK_ID         - active task id
#   SLAYZONE_PROJECT_ID      - active project id
#
# stdin: agent-supplied JSON describing the hook event. Forwarded raw to the app
#        (server-side is the single source of truth for parsing).
#
# Contract: ALWAYS exit 0. Hook failures must NOT bubble into the agent TUI
# (Claude renders red error walls otherwise). Silent on any failure.

set -e

# Bail silently when not configured (e.g. agent run outside SlayZone).
[ -z "$SLAYZONE_AGENT_HOOK_URL" ] && exit 0
[ -z "$SLAYZONE_AGENT_ID" ] && exit 0

PAYLOAD=$(cat 2>/dev/null || true)
[ -z "$PAYLOAD" ] && PAYLOAD='{}'

# Wrap stdin in an envelope with the contextual env vars. Server merges.
TASK_FIELD=""
[ -n "$SLAYZONE_TASK_ID" ] && TASK_FIELD=",\"taskId\":\"$SLAYZONE_TASK_ID\""

# Detect hook event name from common env vars. Falls back to "Unknown".
HOOK_EVENT="${CLAUDE_HOOK_EVENT:-${HOOK_EVENT_NAME:-${AGENT_HOOK_EVENT:-Unknown}}}"

CWD_FIELD=""
[ -n "$PWD" ] && CWD_FIELD=",\"cwd\":\"$PWD\""

ENVELOPE="{\"agentId\":\"$SLAYZONE_AGENT_ID\",\"hookEvent\":\"$HOOK_EVENT\"$TASK_FIELD$CWD_FIELD,\"raw\":$PAYLOAD}"

# Fire-and-forget. Curl errors swallowed; never block the agent.
curl -s \
  --connect-timeout 2 \
  --max-time 5 \
  -X POST \
  -H 'Content-Type: application/json' \
  --data-binary "$ENVELOPE" \
  "$SLAYZONE_AGENT_HOOK_URL" \
  >/dev/null 2>&1 || true

exit 0
