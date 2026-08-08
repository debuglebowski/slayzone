#!/usr/bin/env bash
# Guard against the tRPC-cutover infinite-loop class: a useMutation() result
# object (named `*Mutation`) placed inside a React hook dependency array.
#
# useMutation()/useQuery() return a NEW object every render — only `.mutate`,
# `.mutateAsync`, `.refetch` are stable. Depending on the whole object makes the
# effect/callback re-run every render → mutate → re-render → mutate = infinite
# loop that saturates the tRPC WebSocket (see commit cecf1d75 / memory
# project_trpc_usemutation_unstable_deps_loops).
#
# Fix: for fire-and-forget mutations use the stable vanilla `useTRPCClient()`
# (`trpcClient.x.y.mutate(...)`); for state-driven `useMutation`, never put the
# result object in a dep array (dep on stable `.mutateAsync` / nothing).

set -euo pipefail

# A dep-array literal `[ ... <ident>Mutation ]` where the token is the bare
# object (no `.` before the closing `]`, so `.mutate` usage is NOT flagged).
# `useMutation(` declarations have no `[` and are excluded.
CANDIDATES=$(grep -rnE --include="*.ts" --include="*.tsx" \
  '\[[^]]*[A-Za-z]+Mutation[^].]*\]' \
  packages/domains packages/apps/app/src/renderer 2>/dev/null \
  | grep -v '/node_modules/' \
  | grep -v '/dist/' \
  | grep -vE 'useMutation\(' \
  || true)

# The match above is purely textual: it fires on ANY identifier ending in
# `Mutation`, including ones that have nothing to do with `useMutation()`. A
# `const runGroupMutation = useCallback(...)` is stable by construction and was
# being reported as an infinite-loop risk — a false positive that made this gate
# permanently red and therefore ignorable, which is worse than not having it.
#
# So drop a line only when EVERY `*Mutation` token on it is provably stable:
# declared in that same file as a useCallback/useMemo/useRef binding. The
# asymmetry is deliberate — an unrecognised declaration form (multi-line, say)
# leaves the line flagged. This check may still cry wolf; it must never go quiet
# on a real one.
MATCHES=""
while IFS= read -r line; do
  [ -z "$line" ] && continue
  file=${line%%:*}
  tokens=$(echo "$line" | grep -oE '[A-Za-z_][A-Za-z0-9_]*Mutation' | sort -u || true)

  keep=1
  if [ -n "$tokens" ]; then
    keep=0
    for tok in $tokens; do
      if ! grep -qE "const[[:space:]]+${tok}[[:space:]]*=[[:space:]]*(useCallback|useMemo|useRef)\(" \
        "$file" 2>/dev/null; then
        keep=1
        break
      fi
    done
  fi

  [ "$keep" -eq 1 ] && MATCHES="${MATCHES}${line}"$'\n'
done <<<"$CANDIDATES"

MATCHES=$(printf '%s' "$MATCHES")

if [ -n "$MATCHES" ]; then
  echo "Unstable tRPC mutation object in a hook dependency array (infinite-loop risk)."
  echo "useMutation() returns a new object each render. Use the stable vanilla"
  echo "useTRPCClient() for fire-and-forget mutations, or dep on .mutateAsync — never"
  echo "the whole *Mutation object. See memory project_trpc_usemutation_unstable_deps_loops."
  echo ""
  echo "$MATCHES"
  exit 1
fi

echo "tRPC stable-deps lint passed — no *Mutation objects in hook dep arrays."
