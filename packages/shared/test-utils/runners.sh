#!/bin/bash
# Suite runners for run-all.sh (`pnpm test:unit`, also the CI unit-tests job). Source
# it; don't execute it.
#
# Two phases. The run_* helpers called from run-all.sh only REGISTER a suite (and its
# files, into RAN, for require_registered). run_suites at the bottom then runs them all
# in two concurrent lanes (LANES). The node harness run is bounded by its few longest
# files (real hubs booting for minutes); the app-config run and the package runs, back
# to back, fit beside it. More lanes only fight over the same cores: measured on a
# 10-core Mac, three lanes stretched the app-config run from 68s alone to 264s.
# Every lane's output is captured and printed grouped, one lane after the other, so
# CI logs stay readable.
#
# Every suite counts into PASS/FAIL and names what failed in FAILED (down to the file,
# for the vitest runs), so the caller decides the exit status (see print_summary). All
# are strict: a non-zero test exit counts as FAIL, and so does a vitest report that does
# not hold exactly one result per registered file.
#
# Bash 3.2 compatible (macOS /bin/bash): no associative arrays, no `wait -n`.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR" || exit 1
TEST_UTILS="packages/shared/test-utils"

PASS=0
FAIL=0
FAILED=()
RAN=()
SKIPPED=()
# Files skipped as part of a whole package (skip_package_tests): registered, but not
# listed one by one in the summary.
SKIPPED_FILES=()

# SLZ_UNIT_DRY=1: register every suite but run none, so require_registered can check in
# seconds that every test file is registered (`pnpm test:unit:registered`, a lint step).
dry_run() { [ "${SLZ_UNIT_DRY:-}" = 1 ]; }

# ---------------------------------------------------------------------------------------
# Registration (called from run-all.sh, in its order)
# ---------------------------------------------------------------------------------------

# Node-environment suites, run together in ONE vitest invocation under
# vitest.harness.config.ts — parallel forks, one fresh module graph per file.
# run_harness: Electron's node (ELECTRON_RUN_AS_NODE=1), so better-sqlite3's native ABI
#   matches. The default for node suites.
# run_harness_node: PLAIN node, same config, its own (small) invocation. Only for a file
#   that must not run inside the Electron binary — say why next to the registration.
# Usage: run_harness <file> / run_harness_node <file>
HARNESS_FILES=()
HARNESS_NODE_FILES=()
run_harness() {
  RAN+=("$1")
  HARNESS_FILES+=("$1")
}
run_harness_node() {
  RAN+=("$1")
  HARNESS_NODE_FILES+=("$1")
}

# Suites under the app's vitest config (jsdom + react plugin with the renderer build's
# React Compiler setup + '@' alias). Every group registered here runs in ONE vitest
# invocation; the label names the group a failing file belongs to. Explicit paths
# override vitest's default include glob, so only these run (no sweep of the harness
# *.test.ts). Usage: run_vitest_files <label> <file>...
APP_VITEST_FILES=()
APP_VITEST_LABELS=()
run_vitest_files() {
  local label="$1" file
  shift
  for file in "$@"; do
    RAN+=("$file")
    APP_VITEST_FILES+=("$file")
    APP_VITEST_LABELS+=("$label")
  done
}

# A package's own `test` script (own vitest config / runner). Registers exactly the
# files its vitest run collects (package_test_files, resolved in parallel by
# run_suites), so a new test file there needs no edit here.
# Usage: run_package_tests <dir> <workspace-name>
PACKAGE_DIRS=()
PACKAGE_NAMES=()
run_package_tests() {
  PACKAGE_DIRS+=("$1")
  PACKAGE_NAMES+=("$2")
}

# Live third-party API suites (run-all.sh gates them on their token): real modules,
# none of the harness mocks. Usage: run_test_no_loader <file>
INTEGRATION_FILES=()
run_test_no_loader() {
  RAN+=("$1")
  INTEGRATION_FILES+=("$1")
}

# Visible exclusion. Usage: skip_suite <path> <reason>. Counts as skipped, not passed,
# and satisfies require_registered.
skip_suite() {
  echo ""
  echo "=== $1 (SKIPPED: $2) ==="
  SKIPPED+=("$1")
}

# skip_suite for a whole package's own test run; its collected files count as skipped.
# Usage: skip_package_tests <dir> <workspace-name> <reason>
skip_package_tests() {
  local file
  skip_suite "$1 (own vitest config)" "$3"
  while IFS= read -r file; do SKIPPED_FILES+=("$file"); done < <(package_test_files "$2")
}

# The exact test files a package's own vitest run collects, repo-relative. Read from
# vitest itself rather than assumed from the directory: a package config may exclude
# files (shared/platform excludes its Electron-node suites), and those must still be
# registered file-by-file. Usage: package_test_files <workspace-name>
package_test_files() {
  pnpm --filter "$1" exec vitest list --filesOnly --json 2>/dev/null |
    node -e 'let s = ""
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        for (const { file } of JSON.parse(s || "[]")) console.log(require("path").relative(process.argv[1], file))
      })' "$ROOT_DIR"
}

# ---------------------------------------------------------------------------------------
# Execution (inside a lane: a background subshell whose stdout is that lane's log).
# A suite's verdict goes to the lane's results file as "PASS|FAIL<TAB><label>" lines;
# the parent shell turns them into PASS/FAIL/FAILED once the lane is done.
# ---------------------------------------------------------------------------------------

record() { printf '%s\t%s\n' "$1" "$2" >>"$LANE_RESULTS"; }

# One vitest invocation over an explicit file list, then check-vitest-report.mjs: the
# report must hold exactly one result per registered file, and each failing file is
# recorded by name (as "<label>: <file>"). The file list comes from <list>, one per
# line; <labels>, when not empty, holds a per-file group label on the same line number.
# Usage: vitest_suite <label> <list> <labels|""> <report.json> <command...>
vitest_suite() {
  local label="$1" list="$2" labels="$3" json="$4" ok=1 matched=1 failed file group
  shift 4
  echo ""
  echo "=== $label: $(wc -l <"$list" | tr -d ' ') files ==="
  # Files reach vitest as arguments; read into an array so paths stay single words.
  local files=()
  while IFS= read -r file; do files+=("$file"); done <"$list"
  "$@" --reporter=default --reporter=json --outputFile.json="$json" "${files[@]}" || ok=0
  if ! failed=$(node "$TEST_UTILS/check-vitest-report.mjs" "$json" "$list"); then
    echo "$label: the vitest report does not match the registered files (above)" >&2
    matched=0
  fi
  if [ "$ok" = 1 ] && [ "$matched" = 1 ]; then
    record PASS "$label"
    return 0
  fi
  [ "$matched" = 1 ] || record FAIL "$label: report does not match the registered files"
  if [ -z "$failed" ]; then
    # Non-zero exit with every file green: an unhandled error or a globalSetup failure.
    # The log above says which.
    [ "$ok" = 1 ] || record FAIL "$label"
    return 0
  fi
  while IFS= read -r file; do
    group="$label"
    if [ -n "$labels" ]; then
      group=$(awk -v f="$file" 'NR == FNR { if ($0 == f) n = FNR; next } FNR == n { print; exit }' "$list" "$labels")
    fi
    record FAIL "$group: $file"
  done <<<"$failed"
}

# Runs <command...> as one suite; its exit status is the verdict.
# Usage: command_suite <label> <command...>
command_suite() {
  local label="$1"
  shift
  echo ""
  echo "=== $label ==="
  if "$@"; then record PASS "$label"; else record FAIL "$label"; fi
}

# Writes the given lines to <file>, one per line (nothing for an empty list).
# Usage: write_list <file> <line>...
write_list() {
  local file="$1"
  shift
  : >"$file"
  [ "$#" -gt 0 ] && printf '%s\n' "$@" >"$file"
  return 0
}

package_test() {
  (set -o pipefail; pnpm --filter "$1" test 2>&1 | grep -v 'npm warn\|ExperimentalWarning')
}

integration_test() {
  (set -o pipefail; ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm "$1" 2>&1 | grep -v 'npm warn\|Migration\|ExperimentalWarning\|--trace-warnings\|--import')
}

# Lane: the node harness suites. The plain-node run follows the Electron one in this
# SAME lane on purpose: both runs' globalSetup rebuilds the hub/computer/cli bins into
# the same dist/, which must never happen while the other run's suites spawn them.
lane_harness() {
  if [ "${#HARNESS_FILES[@]}" -gt 0 ]; then
    vitest_suite "vitest (node harness suites, Electron's node)" "$WORK/harness.list" "" "$HARNESS_JSON" \
      env ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron ./node_modules/vitest/vitest.mjs run \
      --config "$TEST_UTILS/vitest.harness.config.ts"
  fi
  if [ "${#HARNESS_NODE_FILES[@]}" -gt 0 ]; then
    vitest_suite "vitest (node harness suites, plain node)" "$WORK/harness-node.list" "" "$WORK/harness-node.json" \
      env -u ELECTRON_RUN_AS_NODE node ./node_modules/vitest/vitest.mjs run \
      --config "$TEST_UTILS/vitest.harness.config.ts"
  fi
}

# Lane: every run_vitest_files group, in one invocation under the app's config; then
# every package's own test run and the live integration suites, in order.
lane_app_and_packages() {
  local i file
  if [ "${#APP_VITEST_FILES[@]}" -gt 0 ]; then
    vitest_suite "vitest (app config)" "$WORK/app.list" "$WORK/app.labels" "$WORK/app.json" \
      ./node_modules/.bin/vitest run --config packages/apps/app/vitest.config.ts --exclude '**/.claude/worktrees/**'
  fi
  for i in "${!PACKAGE_NAMES[@]}"; do
    command_suite "${PACKAGE_DIRS[$i]} (own vitest config)" package_test "${PACKAGE_NAMES[$i]}"
  done
  for file in ${INTEGRATION_FILES[@]+"${INTEGRATION_FILES[@]}"}; do
    command_suite "$file (integration)" integration_test "$file"
  done
}

# TERMs <pid> and every descendant (children first found, then the parent).
kill_tree() {
  local child
  for child in $(pgrep -P "$1"); do kill_tree "$child"; done
  kill -TERM "$1" 2>/dev/null || true
}

LANES=(lane_harness lane_app_and_packages)

# Runs everything registered above, then folds each lane's verdicts into PASS / FAIL /
# FAILED. SLZ_UNIT_JSON=<path> keeps the Electron harness run's JSON report (per-file
# test counts and durations). Usage: run_suites
run_suites() {
  local i j lane status verdict label file started=$SECONDS
  local list_pids=() lane_pids=()
  WORK=$(mktemp -d "${TMPDIR:-/tmp}/slz-unit.XXXXXX")
  HARNESS_JSON="${SLZ_UNIT_JSON:-$WORK/harness.json}"

  # Each package's file list (one `vitest list` each, ~2s apiece) resolves in the
  # background, alongside the lanes; RAN needs them only for require_registered.
  for i in "${!PACKAGE_NAMES[@]}"; do
    package_test_files "${PACKAGE_NAMES[$i]}" >"$WORK/package.$i.files" &
    list_pids+=($!)
  done

  if ! dry_run; then
    write_list "$WORK/harness.list" ${HARNESS_FILES[@]+"${HARNESS_FILES[@]}"}
    write_list "$WORK/harness-node.list" ${HARNESS_NODE_FILES[@]+"${HARNESS_NODE_FILES[@]}"}
    write_list "$WORK/app.list" ${APP_VITEST_FILES[@]+"${APP_VITEST_FILES[@]}"}
    write_list "$WORK/app.labels" ${APP_VITEST_LABELS[@]+"${APP_VITEST_LABELS[@]}"}

    # Background jobs of a non-interactive shell ignore SIGINT: on Ctrl-C (or TERM),
    # stop every lane's process tree explicitly, then exit.
    trap 'trap - INT TERM; for i in "${lane_pids[@]}" "${list_pids[@]}"; do kill_tree "$i"; done; exit 130' INT TERM
    echo ""
    echo "=== running ${#LANES[@]} lanes concurrently: ${LANES[*]} ==="
    for i in "${!LANES[@]}"; do
      lane="${LANES[$i]}"
      : >"$WORK/$lane.results"
      (
        set +e
        LANE_RESULTS="$WORK/$lane.results"
        "$lane"
      ) >"$WORK/$lane.log" 2>&1 &
      lane_pids+=($!)
    done

    # Print each lane's log as soon as it (and every lane before it) is done.
    for i in "${!LANES[@]}"; do
      lane="${LANES[$i]}"
      status=0
      wait "${lane_pids[$i]}" || status=$?
      echo ""
      echo "################ $lane (done at $((SECONDS - started))s) ################"
      cat "$WORK/$lane.log"
      [ "$status" = 0 ] || printf 'FAIL\t%s (lane exited %s)\n' "$lane" "$status" >>"$WORK/$lane.results"
      while IFS="	" read -r verdict label; do
        if [ "$verdict" = PASS ]; then
          PASS=$((PASS + 1))
        else
          FAIL=$((FAIL + 1))
          FAILED+=("$label")
        fi
      done <"$WORK/$lane.results"
    done
    trap - INT TERM
    echo ""
    echo "All lanes done in $((SECONDS - started))s"
  fi

  for j in "${!list_pids[@]}"; do
    wait "${list_pids[$j]}" || true
    while IFS= read -r file; do RAN+=("$file"); done <"$WORK/package.$j.files"
  done
  rm -rf "$WORK"
}

# Fails (counts into FAIL) for every test file under the given dirs that was neither
# run nor skipped above (file by file, or as part of a package run).
require_registered() {
  local dir file
  for dir in "$@"; do
    while IFS= read -r file; do
      if ! printf '%s\n' "${RAN[@]}" ${SKIPPED[@]+"${SKIPPED[@]}"} ${SKIPPED_FILES[@]+"${SKIPPED_FILES[@]}"} | grep -qxF -- "$file"; then
        echo "UNREGISTERED: $file (add it to the suite list, or skip_suite it with a reason)"
        FAIL=$((FAIL + 1))
        FAILED+=("unregistered: $file")
      fi
    done < <(find "$dir" \( -name node_modules -o -name dist \) -prune -o -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) -print | sort)
  done
}

print_summary() {
  echo ""
  echo "=== Summary ==="
  echo "Suites: $PASS passed, $FAIL failed"
  if [ "${#SKIPPED[@]}" -gt 0 ]; then
    echo "Skipped: ${#SKIPPED[@]}"
    printf '  - %s\n' "${SKIPPED[@]}"
  fi
  if [ "${#FAILED[@]}" -gt 0 ]; then
    echo "Failed:"
    printf '  - %s\n' "${FAILED[@]}"
  fi
}
