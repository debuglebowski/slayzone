#!/usr/bin/env bash
# Renderer/client code must not reach the preload bridge (`window.api`) — tRPC only,
# bar the bootstrap-only access in @slayzone/transport/client/electron-bootstrap.
#
# Searches with `git grep`: git is present wherever a checkout is, unlike ripgrep,
# whose absence on CI used to read as "no matches" and pass silently. Every outcome
# other than a clean "no match" fails: a match is a violation, and a search that
# could not run (no git, not a repo, a missing search root) is an error, never a pass.
#
# `--untracked` keeps new, not-yet-added files in scope (ignored files stay out).
# The pattern is POSIX ERE only (`[[:space:]]`, explicit word-boundary classes, no
# `\b`/`\s`), so it means the same under every git build's regex engine.
set -euo pipefail

cd "$(dirname "$0")/.."

fail_error() {
  echo "check-renderer-window-api: $1 — cannot verify, failing." >&2
  exit 2
}

command -v git >/dev/null 2>&1 || fail_error "git not found on PATH"

# Each search root must exist: a moved directory would otherwise just match nothing.
shopt -s nullglob
RENDERER=(packages/apps/app/src/renderer)
DOMAIN_CLIENTS=(packages/domains/*/src/client)
SHARED_SRCS=(packages/shared/*/src)
shopt -u nullglob
[[ -d "${RENDERER[0]}" ]] || fail_error "search root ${RENDERER[0]} does not exist (moved? repoint it)"
((${#DOMAIN_CLIENTS[@]})) || fail_error "no packages/domains/*/src/client directories (moved? repoint it)"
((${#SHARED_SRCS[@]})) || fail_error "no packages/shared/*/src directories (moved? repoint it)"
ROOTS=("${RENDERER[@]}" "${DOMAIN_CLIENTS[@]}" "${SHARED_SRCS[@]}")

PATTERN='(window\.api\.|\([^)]*window[^)]*\)\.api\.|(^|[^[:alnum:]_])api:[[:space:]]*ElectronAPI([^[:alnum:]_]|$))'

status=0
matches="$(
  git grep -n -I -E --untracked "$PATTERN" -- \
    "${ROOTS[@]}" \
    ':(exclude,glob)**/*.test.*' \
    ':(exclude,glob)**/*.spec.*' \
    ':(exclude,glob)**/*.d.ts' \
    ':(exclude)packages/shared/transport/src/client/electron-bootstrap.ts' \
    ':(exclude,glob)packages/shared/window-api-shim/**'
)" || status=$?

case "$status" in
  0)
    cat >&2 <<'EOF'
renderer/client window.api access is forbidden.
Use tRPC, or add bootstrap-only access to @slayzone/transport/client/electron-bootstrap.

EOF
    printf '%s\n' "$matches" >&2
    exit 1
    ;;
  1) echo "window-api lint passed — no renderer/client window.api access." ;;
  *) fail_error "git grep failed (exit $status)" ;;
esac
