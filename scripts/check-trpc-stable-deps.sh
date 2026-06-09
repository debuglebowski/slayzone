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
MATCHES=$(grep -rnE --include="*.ts" --include="*.tsx" \
  '\[[^]]*[A-Za-z]+Mutation[^].]*\]' \
  packages/domains packages/apps/app/src/renderer 2>/dev/null \
  | grep -v '/node_modules/' \
  | grep -v '/dist/' \
  | grep -vE 'useMutation\(' \
  || true)

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
