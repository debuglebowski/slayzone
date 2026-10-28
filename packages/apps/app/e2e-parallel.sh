#!/usr/bin/env bash
# Run e2e tests in parallel — the suite split into a FIXED number of processes,
# one Electron each, balanced by measured per-spec duration.
#
# Usage:
#   ./e2e-parallel.sh                 full suite (all groups except perf)
#   ./e2e-parallel.sh <args...>       forwarded verbatim to `playwright test`
#
# The perf group is NOT part of the full suite: it asserts wall-clock budgets, so
# it must run alone on a quiet box. Run it on its own: `pnpm test:e2e:perf`.
#
# Process count: measured on a 10-core machine, same build, back to back:
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
# Fewer processes only lose wall clock (re-measured: 6 groups median 327s, 3 procs
# 484s, 2 procs 523s, 1 serial 1213s and STILL failed — failure count is not
# monotonic in parallelism).
#
# Partition: one process per subdirectory let the slowest DIRECTORY set the wall
# clock — measured 2026-10-28, browser ran 353s while web-shell was done at 79s
# and git at 227s. The specs are now split across all directories at once,
# duration-balanced and DETERMINISTIC (e2e/shard-plan.mjs, weights in
# e2e/spec-durations.json): the same spec set always lands in the same shards
# with the same neighbours, so failure identity stays comparable run to run.
# Re-record weights from a kept run:
#   node e2e/shard-plan.mjs record "$E2E_RUN_DIR"/report-*.json
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

# Process count. Seven = what the per-directory layout ran (six groups + core
# split in two), so the box carries no more contention than before; only the
# partition changed. See the header for why not more.
PROCESSES=7
PERF_GROUP=perf

# Discover group dirs. `perf` is deliberately excluded — see the header.
group_dirs=()
total=0
for dir in e2e/*/; do
  [[ -d "$dir" ]] || continue
  name=$(basename "$dir")
  [[ "$name" == "fixtures" ]] && continue
  [[ "$name" == "$PERF_GROUP" ]] && continue
  specs=("$dir"*.spec.ts)
  [[ -e "${specs[0]}" ]] || continue
  group_dirs+=("e2e/$name")
  total=$((total + ${#specs[@]}))
done

# One "unit" = one Playwright process: a name plus the spec args it runs.
unit_names=()
unit_args=()
i=0
while IFS= read -r files; do
  i=$((i + 1))
  [[ -n "$files" ]] || continue
  unit_names+=("shard-$i")
  unit_args+=("$files")
done < <(node e2e/shard-plan.mjs plan "$PROCESSES" "${group_dirs[@]}")

# A planner crash would otherwise read as "0 processes, 0 failures" — a green run
# that ran nothing. Every discovered spec must be in exactly one shard.
planned=0
for args in "${unit_args[@]+"${unit_args[@]}"}"; do
  # shellcheck disable=SC2206
  a=($args)
  planned=$((planned + ${#a[@]}))
done
if [[ "$planned" -ne "$total" ]]; then
  echo "✖ shard plan covers $planned of $total specs — refusing to run a partial suite" >&2
  exit 2
fi

# Which specs share an app is part of a failure's identity — keep it with the run.
if [[ -n "${E2E_RUN_DIR:-}" ]]; then
  for u in "${!unit_names[@]}"; do
    echo "${unit_names[$u]}: ${unit_args[$u]}"
  done > "$tmpdir/shards.txt"
fi

echo "Running $total specs from ${#group_dirs[@]} groups in ${#unit_names[@]} balanced processes"

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

# Launch each shard in parallel
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
