#!/usr/bin/env bash
# Guard against hardcoded color classes that bypass the theme system.
# Tutorial scenes and project-settings color palette are intentional, excluded.
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

PALETTE='(bg|text|border|hover:bg|hover:text|dark:bg|dark:text|dark:border|dark:hover:bg|dark:hover:text|focus:border|focus:bg)-(neutral|zinc|slate|stone|gray)-[0-9]+'
HEX='(bg|text|border|fill|stroke|dark:bg|dark:text|dark:border)-\[#[0-9a-fA-F]+\]'
FORBIDDEN="($PALETTE)|($HEX)"
EXCLUDE_REGEX='/tutorial/(scenes/|TutorialAnimationModal\.tsx)|project-settings-shared\.tsx'

ROOT=packages
[[ -d "$ROOT" ]] || fail_error "search root $ROOT/ does not exist (moved? repoint it)"

status=0
RAW=$(grep -rnE --include="*.tsx" "$FORBIDDEN" "$ROOT/") || status=$?
case "$status" in
  0) ;;
  1) RAW="" ;;
  *) fail_error "grep failed (exit $status)" ;;
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

if [ -n "$MATCHES" ]; then
  echo "Hardcoded color classes bypass the theme system. Use theme tokens instead (bg-surface-*, bg-accent, bg-muted, text-foreground, text-muted-foreground, border-border, etc)."
  echo ""
  echo "$MATCHES"
  exit 1
fi

echo "Theme lint passed — no hardcoded color classes found."
