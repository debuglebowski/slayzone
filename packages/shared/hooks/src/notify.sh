#!/bin/sh
# SlayZone agent lifecycle hook — BENIGN DUMB FORWARDER.
#
# SLAYZONE_NOTIFY_VERSION=2
# ^ Bump on EVERY change to this file. The installer (notify-script-installer.ts)
#   refuses to overwrite an on-disk script with a strictly-lower version, so a
#   stale/older SlayZone channel can never downgrade a newer script on the
#   shared ~/.slayzone/hooks/notify.sh. Newer is always backward-compatible.
#
# WHY THIS FILE IS LOGIC-FREE (the sustainable fix):
#   ~/.slayzone/hooks/notify.sh is a SINGLE file shared by every SlayZone channel
#   (getSlayzoneHomeDir() is NOT channel-scoped), and agents find it via the
#   shared ~/.claude/settings.json pointer — so it CANNOT be channel-scoped. A
#   shared file must therefore be BENIGN: it must contain no field-picking logic,
#   so it does not matter which channel's copy wins the last write. The previous
#   version cherry-picked named fields (taskId, slaySessionId, session_id,
#   hook_event_name, …) to forward; when an OLDER channel's copy won, its field
#   list was missing `slaySessionId`, so warm-pool sessions became invisible (no
#   task resolution → no running spinner, no unread dot). This version forwards
#   THREE opaque channels and lets the SERVER do all field extraction:
#     - ctx : $SLAYZONE_HOOK_CONTEXT — an opaque JSON blob the app packs at spawn
#             with every identity field (taskId/slaySessionId/projectId/agentId/
#             channel). Forwarded VERBATIM; this script never parses it.
#     - raw : the hook payload piped on stdin (Claude/Codex/Gemini/Antigravity).
#     - arg : argv $1 — Antigravity passes the EVENT NAME here (its payload omits
#             it); the OpenCode plugin passes the whole JSON payload here (no
#             stdin). Forwarded opaquely as a JSON string; the server decides.
#   Adding a new identity field later touches ONLY the app (writes ctx) and the
#   server (reads ctx) — NEVER this script. That is the whole point.
#
# Installed by the app at ~/.slayzone/hooks/notify.sh (mode 0755).
# Invoked by the host agent (e.g. Claude Code, Codex) via its hooks config.
#
# Required env (injected at PTY/chat spawn by buildMcpEnv):
#   SLAYZONE_AGENT_HOOK_URL  - target URL, e.g. http://127.0.0.1:PORT/api/agent-hook
#                              (a remote runner overlays its OWN loopback URL)
#   SLAYZONE_AGENT_ID        - claude-code | codex | gemini | antigravity | opencode
# Optional:
#   SLAYZONE_HOOK_CONTEXT    - opaque identity blob (see above); forwarded as `ctx`
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

# The three opaque channels. NO grep/parse/named-field extraction here.
#   ARG = argv $1 verbatim (may be an event name, a JSON payload, or empty).
#   RAW = stdin verbatim (the hook payload, or empty).
ARG="${1:-}"
# Read stdin ONLY when argv $1 is NOT already the JSON payload. This is
# load-bearing, not an optimization: the OpenCode plugin invokes us as
# `bash notify.sh '<json>'` with NO stdin write, and inside a SlayZone PTY the
# child inherits the terminal's stdin — which never sends EOF. An unconditional
# `cat` would block FOREVER there, hanging the plugin's awaited exec (dark
# badges — the exact failure this script exists to prevent). Every stdin-driven
# agent (Claude/Codex/Gemini/Antigravity) writes its payload then CLOSES stdin,
# so `cat` returns promptly for them. Mirrors the guard the pre-v2 script had.
case "$ARG" in
  '{'*) RAW="" ;;
  *) RAW=$(cat 2>/dev/null || true) ;;
esac

# JSON-encode an arbitrary string into a quoted JSON string literal. This is the
# ONLY logic left, and it is GENERIC string-escaping — NOT per-field naming, so
# it cannot rot the way a field list does. Escapes backslash, double-quote, and
# the whitespace control chars that occur in real hook data (\n \r \t). Other
# C0 control bytes (\x00-\x1f) are not escaped — they never appear in an event
# name or a JSON-stringified payload, the only two things that reach argv $1.
# POSIX awk; falls back to a bare empty string on any failure.
json_encode_string() {
  awk 'BEGIN {
    s = ARGV[1]
    out = "\""
    n = length(s)
    for (i = 1; i <= n; i++) {
      c = substr(s, i, 1)
      if (c == "\\") out = out "\\\\"
      else if (c == "\"") out = out "\\\""
      else if (c == "\n") out = out "\\n"
      else if (c == "\r") out = out "\\r"
      else if (c == "\t") out = out "\\t"
      else out = out c
    }
    print out "\""
    exit
  }' "$1" 2>/dev/null || printf '""'
}

# ctx: forwarded VERBATIM (already valid JSON from the app), or `{}` when unset.
CTX="$SLAYZONE_HOOK_CONTEXT"
[ -z "$CTX" ] && CTX='{}'

# raw: the stdin payload verbatim if it is present AND looks like JSON (starts
# with '{'); otherwise JSON `null`. The server treats a null raw as "no stdin".
case "$RAW" in
  '{'*) RAW_FIELD="$RAW" ;;
  *) RAW_FIELD="null" ;;
esac

# arg: argv $1 as a JSON string (or null when empty). Opaque — the server decides
# whether it is an event name (Antigravity) or a JSON payload (OpenCode plugin).
if [ -n "$ARG" ]; then
  ARG_FIELD=$(json_encode_string "$ARG")
else
  ARG_FIELD="null"
fi

AGENT_ID_FIELD=$(json_encode_string "$SLAYZONE_AGENT_ID")

ENVELOPE="{\"ctx\":$CTX,\"raw\":$RAW_FIELD,\"arg\":$ARG_FIELD,\"agentId\":$AGENT_ID_FIELD}"

# Fire-and-forget. Errors swallowed; never block the agent.
# curl is the primary path — present on macOS, most Linux, and bundled with
# Git for Windows (whose bash runs this script). wget is a fallback for minimal
# environments; if neither exists the POST is skipped silently. NO auth header:
# the target is always loopback (local sidecar, or the runner's own loopback),
# so no per-agent bearer is ever attached.
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
