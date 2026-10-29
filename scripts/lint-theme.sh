#!/usr/bin/env bash
# Guard against hardcoded color classes that bypass the theme system.
# Tutorial scenes and project-settings color palette are intentional, excluded.
#
# Two rules:
#   1. Everywhere under packages/ (*.tsx): no gray-family palette class and no
#      arbitrary hex, with any utility prefix or variant chain (bg-, text-, from-,
#      ring-, border-l-, hover:, dark:, placeholder:, …).
#   2. STRICT_PATHS (*.ts + *.tsx): additionally no chromatic palette family
#      (amber, indigo, emerald, …) — use the semantic tokens (success, warning,
#      info, agent, diff-added, diff-removed, destructive, …; see
#      packages/shared/ui/src/theme-types.ts). A path joins this list once it is
#      fully migrated; the rest of the repo still has chromatic hits, so the rule
#      ratchets path by path instead of failing everywhere at once.
#
# Every outcome other than a clean "no match" fails: a match is a violation, and a
# search that could not run (unreadable path, bad pattern, missing search root) is
# an error, never a pass. grep's exit status says which: 0 = matches, 1 = none,
# anything else = the search itself failed. (Plain `grep -r`, not `git grep`: this
# scans every file under packages/, ignored ones included.)

set -euo pipefail

cd "$(dirname "$0")/.."

fail_error() {
  echo "lint-theme: $1 — cannot verify, failing." >&2
  exit 2
}

# A utility (any prefix / variant chain) ending in a palette family + shade, e.g.
# `bg-zinc-800`, `dark:hover:text-amber-300/80`, `from-violet-500`.
GRAYS='neutral|zinc|slate|stone|gray'
CHROMATIC_FAMILIES='red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
PALETTE="[a-z]-($GRAYS)-(50|[1-9]00|950)"
HEX='[a-z]-\[#[0-9a-fA-F]+\]'
FORBIDDEN="($PALETTE)|($HEX)"
CHROMATIC="[a-z]-($CHROMATIC_FAMILIES)-(50|[1-9]00|950)"
EXCLUDE_REGEX='/tutorial/(scenes/|TutorialAnimationModal\.tsx)|project-settings-shared\.tsx'

STRICT_PATHS=(
  packages/domains/task-terminals/src/client/chat
  packages/domains/terminal/src/client/BackgroundJobsBanner.tsx
  packages/shared/diff-view/src
)

ROOT=packages
[[ -d "$ROOT" ]] || fail_error "search root $ROOT/ does not exist (moved? repoint it)"
for p in "${STRICT_PATHS[@]}"; do
  [[ -e "$p" ]] || fail_error "strict path $p does not exist (moved? repoint it)"
done

status=0
RAW=$(grep -rnE --include="*.tsx" -e "$FORBIDDEN" "$ROOT/") || status=$?
case "$status" in
  0) ;;
  1) RAW="" ;;
  *) fail_error "grep failed (exit $status)" ;;
esac

status=0
STRICT_RAW=$(grep -rnE --include="*.tsx" --include="*.ts" -e "$CHROMATIC" "${STRICT_PATHS[@]}") || status=$?
case "$status" in
  0) ;;
  1) STRICT_RAW="" ;;
  *) fail_error "strict grep failed (exit $status)" ;;
esac

# Drop the intentional exclusions. Here exit 1 means every hit was excluded.
MATCHES=""
if [ -n "$RAW" ]; then
  status=0
  MATCHES=$(printf '%s\n' "$RAW" | grep -vE "$EXCLUDE_REGEX") || status=$?
  case "$status" in
    0 | 1) ;;
    *) fail_error "exclusion filter failed (exit $status)" ;;
  esac
fi

if [ -n "$MATCHES" ] || [ -n "$STRICT_RAW" ]; then
  echo "Hardcoded color classes bypass the theme system. Use theme tokens instead (bg-surface-*, bg-accent, bg-muted, text-foreground, text-muted-foreground, border-border, text-success, bg-warning/10, text-info-foreground, etc)."
  echo ""
  if [ -n "$MATCHES" ]; then echo "$MATCHES"; fi
  if [ -n "$STRICT_RAW" ]; then echo "$STRICT_RAW"; fi
  exit 1
fi

echo "Theme lint passed — no hardcoded color classes found."
