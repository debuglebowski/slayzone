#!/usr/bin/env bash
# Run the full e2e suite N times in sequence, keeping every run's reports.
#
#   ./e2e-campaign.sh <n> <label> [out-root]
#
# Produces  <out-root>/<label>/run-NN/  containing per-group logs, per-group
# Playwright JSON, covariates before+after, and a run summary. Feed the root to
# e2e-aggregate.mjs for the cross-run failure-identity table.
#
# WHY A DRIVER RATHER THAN A SHELL LOOP
# -------------------------------------
# Two suites running at once produce uninterpretable results — 12 Electron apps
# on 10 cores is a measurement of the scheduler. A loop typed by hand is one
# stray background `&` away from that. This serialises by construction, and
# refuses to start if a suite is already running.
set -uo pipefail
cd "$(dirname "$0")"

n=${1:?usage: e2e-campaign.sh <n> <label> [out-root]}
label=${2:?usage: e2e-campaign.sh <n> <label> [out-root]}
out_root=${3:-$HOME/.slayzone-e2e-campaign}

dest="$out_root/$label"
mkdir -p "$dest"

# Refuse to start on top of a live suite.
if pgrep -f 'playwright.*e2e/' >/dev/null 2>&1; then
  echo "REFUSING: a playwright suite is already running. Results would not be interpretable." >&2
  exit 2
fi

echo "Campaign '$label': $n run(s) -> $dest"
echo "Baseline: $(git rev-parse --short HEAD) $([[ -n "$(git status --porcelain)" ]] && echo '(DIRTY)' || echo '(clean)')"
echo ""

green_streak=0
for i in $(seq 1 "$n"); do
  run_dir=$(printf "%s/run-%02d" "$dest" "$i")

  # A re-run of the same index must not merge into stale reports.
  rm -rf "$run_dir"
  mkdir -p "$run_dir"

  echo "───────────────────────────────────────────"
  echo "[$label] run $i/$n  $(date '+%H:%M:%S')"

  E2E_RUN_DIR="$run_dir" bash ./e2e-parallel.sh > "$run_dir/console.txt" 2>&1
  rc=$?

  # Echo the parts worth watching live; the full console is on disk.
  grep -E '^\[covariates:|^Wall clock:|passed|failed' "$run_dir/console.txt" | head -20

  if [[ $rc -eq 0 ]]; then
    green_streak=$((green_streak + 1))
    echo "[$label] run $i: GREEN   (streak $green_streak)"
  else
    green_streak=0
    echo "[$label] run $i: RED     (streak reset)"
    grep -E '^\s+[0-9]+\)' "$run_dir/console.txt" | head -20
  fi
done

echo ""
echo "Campaign '$label' complete. Final green streak: $green_streak"
echo "Aggregate with:  node e2e-aggregate.mjs $dest"
