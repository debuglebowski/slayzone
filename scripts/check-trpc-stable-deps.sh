#!/usr/bin/env bash
# Guard against the tRPC-cutover infinite-loop class: a useMutation() result
# object placed inside a React hook dependency array.
#
# useMutation()/useQuery() return a NEW object every render — only `.mutate`,
# `.mutateAsync`, `.refetch` are stable. Depending on the whole object makes the
# effect/callback re-run every render → mutate → re-render → mutate = infinite
# loop that saturates the tRPC WebSocket (see commit cecf1d75 / memory
# project_trpc_usemutation_unstable_deps_loops). The mutation's own state changes
# (pending → error/success) re-render its host, so even an effect that dedupes its
# writes loops as soon as a failure re-arms it (useTaskTerminalSession, 2026-10).
#
# Fix: for fire-and-forget mutations use the stable vanilla `useTRPCClient()`
# (`trpcClient.x.y.mutate(...)`); for state-driven `useMutation`, never put the
# result object in a dep array (`const { mutateAsync: x } = useMutation(...)`, or
# dep on `.mutateAsync`).
#
# Two passes, each reporting `file:line:text`:
#   (1) any `*Mutation`-named token bare in a one-line array literal (by name);
#   (2) any identifier bound to a whole `useMutation(` result in the same file, bare
#       in an array literal — multi-line arrays included (by binding).
#
# A search that could not run (missing root, unreadable file, grep/perl failure)
# fails the check with exit 2 — it is never read as "no matches".
#
# Usage: bash scripts/check-trpc-stable-deps.sh [dir-or-file ...]
#        (default: packages/domains packages/apps/app/src/renderer)

set -euo pipefail

if [ "$#" -gt 0 ]; then
  ROOTS=("$@")
else
  ROOTS=(packages/domains packages/apps/app/src/renderer)
fi

# Source files under ROOTS (node_modules / build output excluded), NUL-separated.
source_files() {
  find "${ROOTS[@]}" \( -name node_modules -o -name dist -o -name out \) -prune \
    -o -type f \( -name '*.ts' -o -name '*.tsx' \) -print0
}

# ── (1) by name ──────────────────────────────────────────────────────────────
# A dep-array literal `[ ... <ident>Mutation ]` where the token is the bare
# object (no `.` before the closing `]`, so `.mutate` usage is NOT flagged).
# `useMutation(` declarations have no `[` and are excluded. A token right after a
# quote is a string key (`OpDeps['onMutation']`), not a dep: the char before the
# identifier must not be a quote or part of a name.
#
# grep exits 0 = matches, 1 = none, anything else = it failed. xargs folds every
# non-zero batch status into one (123), so map them per batch first: "none" is
# success, a failed grep stays a failure — and with pipefail so does a failed find.
# shellcheck disable=SC2016 # single-quoted sh source: its $vars are the inner shell's
if ! CANDIDATES=$(source_files | xargs -0 sh -c '
  pattern=$1
  shift
  grep -HnE -- "$pattern" "$@" || [ "$?" -eq 1 ]
' sh '\[([^]]*[^]'"'"'"A-Za-z0-9_$])?[A-Za-z]+Mutation[^].]*\]'); then
  echo "check-trpc-stable-deps: the by-name pass failed to run" >&2
  exit 2
fi
if [ -n "$CANDIDATES" ]; then
  status=0
  CANDIDATES=$(printf '%s\n' "$CANDIDATES" | grep -vE 'useMutation\(') || status=$?
  if [ "$status" -gt 1 ]; then
    echo "check-trpc-stable-deps: the by-name filter failed (exit $status)" >&2
    exit 2
  fi
fi

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

# ── (2) by binding ───────────────────────────────────────────────────────────
# Pass (1) only sees names ending in `Mutation` on one line, so it missed
# `const updateTask = useMutation(...)` listed in a multi-line dep array. This pass
# keys on the binding instead of the name: every identifier bound to a WHOLE
# useMutation() result (`const x = useMutation(` / `useMutation<T>(` / `ns.useMutation(`;
# a destructured `{ mutateAsync: x }` is stable and not a binding of the object) is
# flagged wherever it appears bare in an array literal of that file. Bare = not a
# member of something else (`a.x`) and not itself dereferenced (`x.mutateAsync`,
# `x?.reset`, `x!.mutate`, `x(`, `x[`).
#
# perl slurps each file so arrays spanning lines are seen whole. Strings and comments
# are blanked first (same length, newlines kept, so offsets and line numbers hold)
# so a bracket or a name inside them can't create or hide a match. The array match
# allows one nesting level and the name search covers the WHOLE body, nested arrays
# included, so a mis-paired bracket can widen a match (cry wolf) but never drop a
# real dep out of it (go quiet). Same asymmetry as (1) — and a pass that fails to run
# fails the check rather than reporting nothing. A file perl cannot open is fatal
# (`-Mwarnings=FATAL,inplace`); by default perl warns, skips it and exits 0.
# shellcheck disable=SC2016 # single-quoted perl source: its $vars are perl's
if ! BOUND=$(source_files | xargs -0 perl -Mwarnings=FATAL,inplace -0777 -ne '
  my $src = $_;
  (my $code = $src) =~ s{
      //[^\n]*
    | /\*.*?\*/
    | "(?:\\.|[^"\\\n])*"
    | '\''(?:\\.|[^'\''\\\n])*'\''
    | `(?:\\.|[^`\\])*`
  }{ (my $s = $&) =~ s/[^\n]/ /g; $s }gsex;

  # The local names that call TanStack useMutation. convex/react exports a
  # useMutation too, but it returns a memoized function (stable): a file importing
  # THAT one under the bare name is not this hazard. An alias of the TanStack one
  # (`useMutation as useRqMutation`) is.
  my %callees = (useMutation => 1);
  while ($src =~ /import\s*\{([^}]*)\}\s*from\s*["\x27]([^"\x27]+)["\x27]/g) {
    my ($list, $from) = ($1, $2);
    delete $callees{useMutation}
      if $from eq "convex/react" && $list =~ /\buseMutation\b(?!\s+as\b)/;
    $callees{$1} = 1
      if $from eq "\@tanstack/react-query" && $list =~ /\buseMutation\s+as\s+([A-Za-z_\$][\w\$]*)/;
  }
  next unless %callees;
  my $callee = join "|", map { quotemeta } sort keys %callees;

  my %bound;
  while ($code =~ /\b(?:const|let|var)\s+([A-Za-z_\$][\w\$]*)\s*(?::[^=;]*)?=\s*(?:[\w\$]+\s*\.\s*)*(?:$callee)\b/g) {
    my $name = $1;
    # `useMutation(...).mutate` / `.mutateAsync` binds the (stable) member, not the
    # object. Only a call that parses as exactly that is let off; anything else
    # (an unparsed generic, say) stays bound.
    next if substr($code, pos($code)) =~
      /\A\s*(?<g><(?:[^<>]++|(?&g))*>)?\s*(?<p>\((?:[^()]++|(?&p))*\))\s*!?\s*\??\s*\./;
    $bound{$name} = 1;
  }
  next unless %bound;
  my $names = join "|", map { quotemeta } sort keys %bound;

  my @lines = split /\n/, $src, -1;
  my %seen;
  while ($code =~ /\[((?:[^\[\]]|\[[^\[\]]*\])*)\]/g) {
    my ($body, $start) = ($1, $-[1]);
    while ($body =~ /(?<![\w\$.])($names)(?![\w\$])(?!\s*!?\s*(?:\?\.|\.|\(|\[))/g) {
      my $line = 1 + (substr($code, 0, $start + $-[1]) =~ tr/\n//);
      next if $seen{$line}++;
      print "$ARGV:$line:$lines[$line - 1]\n";
    }
  }
'); then
  echo "check-trpc-stable-deps: the by-binding pass failed to run" >&2
  exit 2
fi

[ -n "$BOUND" ] && MATCHES="${MATCHES}${BOUND}"$'\n'

# A line both passes report is listed once.
MATCHES=$(printf '%s' "$MATCHES" | sed '/^$/d' | sort -t: -k1,1 -k2,2n -u)

if [ -n "$MATCHES" ]; then
  echo "Unstable tRPC mutation object in a hook dependency array (infinite-loop risk)."
  echo "useMutation() returns a new object each render. Use the stable vanilla"
  echo "useTRPCClient() for fire-and-forget mutations, or dep on .mutateAsync"
  echo "(\`const { mutateAsync: x } = useMutation(...)\`) — never the whole result"
  echo "object. See memory project_trpc_usemutation_unstable_deps_loops."
  echo ""
  echo "$MATCHES"
  exit 1
fi

echo "tRPC stable-deps lint passed — no useMutation() result objects in hook dep arrays."
