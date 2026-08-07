#!/usr/bin/env bash
# Run e2e tests in parallel — one group per subdirectory, one Electron per group.
#
# Usage:
#   ./e2e-parallel.sh                 full suite, one process per group
#   ./e2e-parallel.sh <args...>       forwarded verbatim to `playwright test`
#
# Group-per-subdirectory is the configuration to run the FULL suite in. Measured
# on a 10-core machine, same build, back to back:
#
#   groups (6 processes)   918 passed   1 failed    0 not run   5m40s
#   --workers=12           882 passed  13 failed   24 not run   5m18s
#   --workers=12           862 passed  13 failed   44 not run   5m24s
#
# Twelve workers buys no wall clock — the box is already saturated at six — and
# the extra workers only steal CPU from each other. Every one of those 13 is a
# starved timeout (a 4s toBeVisible, a 5s predicate, a 30s test budget); each
# passes in isolation, and which ones fail rotates per run, so they read as a
# dozen unrelated product bugs. They are one scheduling choice.
#
# Group-per-subdirectory was re-measured later against 3, 2 and 1 process:
#
#   6 groups   309-450s   (median 327)
#   3 procs    484s       (+49%)
#   2 procs    523s       (+60%)
#   1 serial  1213s      (+271%)   and STILL failed
#
# Failure count is not monotonic in parallelism — the variance WITHIN the 6-group
# config exceeded the differences between configs — so cutting processes buys wall
# clock loss without buying green. `core` (53 specs) is the critical path and
# equals total wall clock; rebalance IT before touching the process count.
set -uo pipefail
cd "$(dirname "$0")"

# Targeted runs (a spec path, -g, --headed, …) still mean "just run playwright".
# Keeps `pnpm test:e2e <file>` working now that this script backs that script.
if [[ $# -gt 0 ]]; then
  exec npx playwright test --config playwright.config.ts "$@"
fi

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

# Discover groups from subdirectories.
#
# `perf` is deliberately NOT one of them: it asserts wall-clock budgets, and a
# latency measured while five other Electron apps share the cores measures the
# machine, not the product. It runs alone, after the parallel phase, below.
PERF_GROUP=perf
groups=()
total=0
for dir in e2e/*/; do
  [[ -d "$dir" ]] || continue
  name=$(basename "$dir")
  [[ "$name" == "fixtures" ]] && continue
  [[ "$name" == "$PERF_GROUP" ]] && continue
  specs=("$dir"*.spec.ts)
  [[ -e "${specs[0]}" ]] || continue
  groups+=("$name")
  total=$((total + ${#specs[@]}))
done

echo "Running $total specs across ${#groups[@]} groups: ${groups[*]}"

# ── Host covariates ──────────────────────────────────────────────────────────
# A suite result is not interpretable without them. Measured on this box, the
# SAME commit went from 21 failures / 5 runs (0 green) to 1 failure / 5 runs
# (4 green) with no code change at all — the only difference was that the
# co-resident dev app had been restarted. Wall clock moved with it (327s -> 289s
# median), which is the tell: a degrading host shows up in the clock before it
# shows up in the failures. Print these on every run so the next anomaly is
# diagnosable instead of arguable.
print_covariates() {
  local when=$1
  echo "[covariates:$when] $(uptime | sed 's/.*load averages*: //')  load"
  # SlayZone processes NOT belonging to this test run (no PLAYWRIGHT marker) —
  # the co-resident dev app, its sidecar and its runner. `etime` is process AGE,
  # the variable that correlated here; `rss` is in KB.
  local procs
  procs=$(pgrep -f 'out/main/index\.js|hub/dist/bin\.c?js|runner/dist/bin\.cjs' 2>/dev/null || true)
  local count=0 total_rss=0 oldest="-"
  for pid in $procs; do
    ps eww -o command= -p "$pid" 2>/dev/null | grep -q 'PLAYWRIGHT=' && continue
    count=$((count + 1))
    local rss etime
    rss=$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ')
    etime=$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ')
    [[ -n "$rss" ]] && total_rss=$((total_rss + rss))
    [[ "$oldest" == "-" ]] && oldest=$etime
  done
  echo "[covariates:$when] $count foreign SlayZone proc(s), $((total_rss / 1024))MB RSS, oldest age $oldest"
}
print_covariates before

start_time=$SECONDS

# Launch each group in parallel
pids=()
for name in "${groups[@]}"; do
  logfile="$tmpdir/log-$name.txt"

  npx playwright test \
    --config playwright.config.ts \
    "e2e/$name/" \
    > "$logfile" 2>&1 &
  pids+=($!)
done

echo "Launched ${#pids[@]} groups, waiting..."

# Wait and collect results
fail=0
for i in "${!pids[@]}"; do
  if ! wait "${pids[$i]}"; then
    fail=1
  fi
done

# ── Serial perf phase ────────────────────────────────────────────────────────
# Runs ALONE, after every parallel group has exited, so its latency assertions
# measure the product rather than the contention. Skipped when the group is
# absent or empty.
perf_specs=(e2e/$PERF_GROUP/*.spec.ts)
if [[ -d "e2e/$PERF_GROUP" && -e "${perf_specs[0]}" ]]; then
  echo ""
  echo "Parallel phase done — running '$PERF_GROUP' alone (latency budgets need a quiet box)"
  perf_log="$tmpdir/log-$PERF_GROUP.txt"
  if npx playwright test --config playwright.config.ts "e2e/$PERF_GROUP/" > "$perf_log" 2>&1; then
    :
  else
    fail=1
  fi
  groups+=("$PERF_GROUP")
fi

elapsed=$(( SECONDS - start_time ))

# Print results per group
echo ""
echo "========================================="
for name in "${groups[@]}"; do
  logfile="$tmpdir/log-$name.txt"
  timing=$(grep -oE '\([0-9.]+[ms]+\)' "$logfile" 2>/dev/null | tail -1)
  summary=$(grep -oE '[0-9]+ (passed|failed|skipped)' "$logfile" 2>/dev/null | paste -sd', ' -)
  printf "%-15s %s %s\n" "$name" "$summary" "$timing"
done

# Print failures from all groups
echo ""
failed_tests=()
for name in "${groups[@]}"; do
  logfile="$tmpdir/log-$name.txt"
  while IFS= read -r line; do
    failed_tests+=("$line")
  done < <(grep -E '^\s+[0-9]+\)' "$logfile" 2>/dev/null)
done

if [[ ${#failed_tests[@]} -gt 0 ]]; then
  echo "Failed tests:"
  for t in "${failed_tests[@]}"; do
    echo "  $t"
  done
fi

echo ""
print_covariates after
echo "Wall clock: ${elapsed}s ($((elapsed / 60))m $((elapsed % 60))s)"
echo "========================================="
exit $fail
