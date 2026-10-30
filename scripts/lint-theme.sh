#!/usr/bin/env bash
# Guard against hardcoded colors that bypass the theme system.
#   1. Renderer (*.tsx under packages/): no gray-family palette class and no arbitrary
#      hex, with any utility prefix or variant chain (bg-, text-, from-, ring-,
#      border-l-, hover:, dark:, placeholder:, …). Tutorial scenes and project-settings
#      color palette are intentional, excluded.
#   2. STRICT_PATHS (*.ts + *.tsx): additionally no chromatic palette family (amber,
#      indigo, emerald, …) — use the semantic tokens (success, warning, info, agent,
#      diff-added, diff-removed, destructive, …; see ChromeColors in
#      packages/shared/theme-tokens/src/types.ts). A path joins this list once it is
#      fully migrated; the rest of the repo still has chromatic hits, so the rule
#      ratchets path by path instead of failing everywhere at once.
#   3. Mobile app (packages/apps/mobile/src): color literals. React Native styles take
#      color values, not classes; every color comes from src/theme.ts (the theme
#      presets as hex, `@slayzone/theme-tokens`). User data such as `project.color` is
#      a value, not a literal, so it passes.
#
# Usage: scripts/lint-theme.sh [--root <dir>]   (--root: check another tree, for tests)
#
# Every outcome other than a clean "no match" fails: a match is a violation, and a
# search that could not run (unreadable path, bad pattern, missing search root) is
# an error, never a pass. grep's exit status says which: 0 = matches, 1 = none,
# anything else = the search itself failed. (Plain `grep -r`, not `git grep`: this
# scans every file under packages/, ignored ones included.)

set -euo pipefail

fail_error() {
  echo "lint-theme: $1 — cannot verify, failing." >&2
  exit 2
}

if [[ "${1:-}" == "--root" ]]; then
  [[ -n "${2:-}" && -d "$2" ]] || fail_error "--root ${2:-<missing>} is not a directory"
  cd "$2"
else
  cd "$(dirname "$0")/.."
fi

# grep -rnE for pattern $1 with options + paths $2..; prints matches, nothing when
# none. Exits 2 when the search itself fails.
search() {
  local pattern=$1 status=0 out
  shift
  out=$(grep -rnE -e "$pattern" "$@") || status=$?
  case "$status" in
    0) printf '%s\n' "$out" ;;
    1) ;;
    *) fail_error "grep failed (exit $status)" ;;
  esac
}

# Drops lines matching $1 from stdin. Exits 2 when the filter itself fails.
drop() {
  local status=0 out
  out=$(grep -vE "$1") || status=$?
  case "$status" in
    0) printf '%s\n' "$out" ;;
    1) ;;
    *) fail_error "exclusion filter failed (exit $status)" ;;
  esac
}

failed=0

# ── 1 + 2. Renderer: color classes ───────────────────────────────────────────
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
  # Terminal-mode banners and overlays (what the terminal shows around the agent).
  packages/domains/terminal/src/client/SlayNudgeBanner.tsx
  packages/domains/terminal/src/client/LoopModeBanner.tsx
  packages/domains/terminal/src/client/TerminalDeadOverlay.tsx
  packages/domains/terminal/src/client/TerminalSearchBar.tsx
  packages/domains/terminal/src/client/TerminalLoadingAnimations.tsx
  packages/domains/terminal/src/client/Terminal.tsx
  packages/domains/task-terminals/src/client/TerminalStarter.tsx
)

ROOT=packages
[[ -d "$ROOT" ]] || fail_error "search root $ROOT/ does not exist (moved? repoint it)"
for p in "${STRICT_PATHS[@]}"; do
  [[ -e "$p" ]] || fail_error "strict path $p does not exist (moved? repoint it)"
done

RAW=$(search "$FORBIDDEN" --include="*.tsx" "$ROOT/")
MATCHES=""
[ -n "$RAW" ] && MATCHES=$(printf '%s\n' "$RAW" | drop "$EXCLUDE_REGEX")
STRICT_RAW=$(search "$CHROMATIC" --include="*.tsx" --include="*.ts" "${STRICT_PATHS[@]}")

if [ -n "$MATCHES" ] || [ -n "$STRICT_RAW" ]; then
  echo "Hardcoded color classes bypass the theme system. Use theme tokens instead (bg-surface-*, bg-accent, bg-muted, text-foreground, text-muted-foreground, border-border, text-success, bg-warning/10, text-info-foreground, etc)."
  echo ""
  if [ -n "$MATCHES" ]; then echo "$MATCHES"; fi
  if [ -n "$STRICT_RAW" ]; then echo "$STRICT_RAW"; fi
  echo ""
  failed=1
fi

# ── 3. Mobile app: color literals outside the theme module ───────────────────
MOBILE_SRC=packages/apps/mobile/src
MOBILE_THEME=$MOBILE_SRC/theme.ts
[[ -d "$MOBILE_SRC" ]] || fail_error "search root $MOBILE_SRC/ does not exist (moved? repoint it)"
[[ -f "$MOBILE_THEME" ]] || fail_error "$MOBILE_THEME does not exist (moved? repoint the exclusion)"

Q="['\"\`]"
# '#rgb' … '#rrggbbaa' as a string; rgb( rgba( hsl( hsla( oklch( oklab( as a call
# (not a method: `.rgb(` / `toRgb(` pass); a named color as a *Color / color value
# (`color: 'white'`, `placeholderTextColor="gray"`; `transparent` is no color, allowed).
MOBILE_HEX="$Q#[0-9a-fA-F]{3,8}$Q"
MOBILE_FN='(^|[^A-Za-z0-9_$.])(rgba?|hsla?|oklch|oklab)[[:space:]]*\('
MOBILE_NAMED="[cC]olor$Q?[[:space:]]*[:=][[:space:]]*\{?[[:space:]]*$Q[A-Za-z]+$Q"
MOBILE_FORBIDDEN="($MOBILE_HEX)|($MOBILE_FN)|($MOBILE_NAMED)"

MOBILE_ALLOWED="[cC]olor$Q?[[:space:]]*[:=][[:space:]]*\{?[[:space:]]*${Q}transparent$Q"

RAW=$(search "$MOBILE_FORBIDDEN" --include="*.ts" --include="*.tsx" "$MOBILE_SRC/")
MATCHES=""
[ -n "$RAW" ] && MATCHES=$(printf '%s\n' "$RAW" | drop "^$MOBILE_THEME:")
# A hit only by an allowed `transparent` is none: re-test each line without those.
if [ -n "$MATCHES" ]; then
  KEPT=""
  while IFS= read -r hit; do
    code=${hit#*:*:}
    while [[ $code =~ $MOBILE_ALLOWED ]]; do code=${code/"${BASH_REMATCH[0]}"/}; done
    [[ $code =~ $MOBILE_FORBIDDEN ]] && KEPT+="$hit"$'\n'
  done <<<"$MATCHES"
  MATCHES=${KEPT%$'\n'}
fi

if [ -n "$MATCHES" ]; then
  echo "Color literals in the mobile app bypass the user's theme. Take colors from useTheme() ($MOBILE_THEME: the theme presets' ChromeColors as hex)."
  echo ""
  echo "$MATCHES"
  echo ""
  failed=1
fi

if [ "$failed" -ne 0 ]; then
  exit 1
fi

echo "Theme lint passed — no hardcoded color classes or mobile color literals found."
