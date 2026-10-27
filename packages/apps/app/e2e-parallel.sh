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
# clock loss without buying green. `core` (73 specs, ~2x any other group) was
# the critical path and equalled total wall clock, so it is split into shards
# (see `shard_count` below) instead of raising the process count everywhere.
set -uo pipefail
cd "$(dirname "$0")"

# Targeted runs (a spec path, -g, --headed, …) still mean "just run playwright".
# Keeps `pnpm test:e2e <file>` working now that this script backs that script.
if [[ $# -gt 0 ]]; then
  exec npx playwright test --config playwright.config.ts "$@"
fi

# Where per-group logs and JSON reports land.
#
# Default stays a self-deleting tmpdir so an interactive run leaves no litter.
# Set E2E_RUN_DIR to keep them: a multi-run campaign needs per-test failure
# IDENTITY across runs, not just counts. That is what made the original flake
# diagnosis possible — two samples could not reveal that one file's five
# failures were one cause with four victims. Without durable per-run reports the
# error text is deleted by the exit trap and only the count survives.
if [[ -n "${E2E_RUN_DIR:-}" ]]; then
  tmpdir="$E2E_RUN_DIR"
  mkdir -p "$tmpdir"
else
  tmpdir=$(mktemp -d)
  trap 'rm -rf "$tmpdir"' EXIT
fi

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

# ── Sharded groups ───────────────────────────────────────────────────────────
# A group that alone outlasts the rest is split across several processes. The
# split is duration-balanced and DETERMINISTIC (e2e/shard-plan.mjs, weights in
# e2e/spec-durations.json): the same spec always shares an app with the same
# neighbours, so failure identity stays comparable run to run. Re-record weights
# from a kept run: `node e2e/shard-plan.mjs record "$E2E_RUN_DIR"/report-*.json`.
shard_count() {
  case "$1" in
    core) echo 2 ;;
    *) echo 1 ;;
  esac
}

# One "unit" = one Playwright process: a name plus the spec args it runs.
unit_names=()
unit_args=()
for name in "${groups[@]}"; do
  n=$(shard_count "$name")
  if [[ "$n" -le 1 ]]; then
    unit_names+=("$name")
    unit_args+=("e2e/$name/")
    continue
  fi
  i=0
  while IFS= read -r files; do
    i=$((i + 1))
    [[ -n "$files" ]] || continue
    unit_names+=("$name-$i")
    unit_args+=("$files")
  done < <(node e2e/shard-plan.mjs plan "e2e/$name" "$n")
done

echo "Running $total specs across ${#groups[@]} groups in ${#unit_names[@]} processes: ${unit_names[*]}"

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
  local json
  json=$(bash "$(dirname "$0")/e2e-covariates.sh")
  [[ -n "${E2E_RUN_DIR:-}" ]] && echo "$json" > "$tmpdir/covariates-$when.json"
  echo "[covariates:$when] $json"
}
print_covariates before

start_time=$SECONDS

# Launch each group in parallel
pids=()
for u in "${!unit_names[@]}"; do
  name=${unit_names[$u]}
  # Word-split on purpose: a shard's args are a space-separated spec list
  # (spec paths never contain spaces).
  # shellcheck disable=SC2206
  spec_args=(${unit_args[$u]})
  logfile="$tmpdir/log-$name.txt"

  # `list` keeps the human log readable; `json` is what the cross-run
  # failure-identity table is built from. Only added when the reports are being
  # kept — an interactive run has nothing to aggregate.
  if [[ -n "${E2E_RUN_DIR:-}" ]]; then
    PLAYWRIGHT_JSON_OUTPUT_NAME="$tmpdir/report-$name.json" \
      npx playwright test \
        --config playwright.config.ts \
        --reporter=list,json \
        "${spec_args[@]}" \
        > "$logfile" 2>&1 &
  else
    npx playwright test \
      --config playwright.config.ts \
      "${spec_args[@]}" \
      > "$logfile" 2>&1 &
  fi
  pids+=($!)
done

echo "Launched ${#pids[@]} processes, waiting..."

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
  perf_reporter=()
  if [[ -n "${E2E_RUN_DIR:-}" ]]; then
    perf_reporter=(--reporter=list,json)
    export PLAYWRIGHT_JSON_OUTPUT_NAME="$tmpdir/report-$PERF_GROUP.json"
  fi
  if npx playwright test --config playwright.config.ts "${perf_reporter[@]+"${perf_reporter[@]}"}" "e2e/$PERF_GROUP/" > "$perf_log" 2>&1; then
    :
  else
    fail=1
  fi
  unset PLAYWRIGHT_JSON_OUTPUT_NAME
  unit_names+=("$PERF_GROUP")
fi

elapsed=$(( SECONDS - start_time ))

# Print results per process
echo ""
echo "========================================="
for name in "${unit_names[@]}"; do
  logfile="$tmpdir/log-$name.txt"
  timing=$(grep -oE '\([0-9.]+[ms]+\)' "$logfile" 2>/dev/null | tail -1)
  summary=$(grep -oE '[0-9]+ (passed|failed|skipped)' "$logfile" 2>/dev/null | paste -sd', ' -)
  printf "%-15s %s %s\n" "$name" "$summary" "$timing"
done

# Print failures from all groups
echo ""
failed_tests=()
for name in "${unit_names[@]}"; do
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

# Durable run summary. `spec_sha` fingerprints the spec tree because Playwright
# reads spec files live from disk: if anything edits them mid-campaign, runs
# either side of that edit measured different suites and "N consecutive green"
# would be a claim about two different things. Recording it makes that
# detectable instead of assumed.
if [[ -n "${E2E_RUN_DIR:-}" ]]; then
  spec_sha=$(find e2e -name '*.spec.ts' -o -name '*.ts' -path 'e2e/fixtures/*' \
    | sort | xargs shasum 2>/dev/null | shasum | cut -c1-12)
  printf '{"elapsed_s":%d,"fail":%d,"git_sha":"%s","git_dirty":%s,"spec_sha":"%s"}\n' \
    "$elapsed" "$fail" \
    "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)" \
    "$([[ -n "$(git status --porcelain 2>/dev/null)" ]] && echo true || echo false)" \
    "$spec_sha" \
    > "$tmpdir/summary.json"
fi

exit $fail
