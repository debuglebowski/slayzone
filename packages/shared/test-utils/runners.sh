#!/bin/bash
# Suite runners shared by run-all.sh and scripts/ci/test-hosted.sh. Source it; don't
# execute it. Every run_* helper below counts into PASS/FAIL and names what failed in
# FAILED, so the caller decides the exit status (see print_summary).
#
# All of them are strict: `set -o pipefail` lets a real non-zero test exit propagate
# through the grep filter (a suite with no output at all also counts as FAIL).

# LOADER is deliberately left unquoted so it word-splits into node flags.
# shellcheck disable=SC2086

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR" || exit 1

# Node 24 removed the bare `--loader` flag; `--experimental-loader` is the working
# equivalent (eventual replacement: `--import` + `module.register()`). Registers the
# electron/dep mock loader for both the npx-tsx and Electron computers below.
LOADER="--experimental-loader ./packages/shared/test-utils/loader.ts"
TSX="npx tsx"
PASS=0
FAIL=0
FAILED=()
RAN=()
SKIPPED=()

run_test() {
  echo ""
  echo "=== $1 ==="
  RAN+=("$1")
  if ( set -o pipefail; $TSX $LOADER "$1" 2>&1 | grep -v 'npm warn\|Migration\|ExperimentalWarning\|--trace-warnings\|--import' ); then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILED+=("$1")
  fi
}

# Strict + custom loader. Uses Electron's node so better-sqlite3's native ABI
# matches. Prefer this for new tests.
run_test_electron_strict_loader() {
  echo ""
  echo "=== $1 (electron+loader, strict) ==="
  RAN+=("$1")
  if ( set -o pipefail; ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm $LOADER "$1" 2>&1 | grep -v 'npm warn\|Migration\|ExperimentalWarning\|--trace-warnings\|--import' ); then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILED+=("$1")
  fi
}

run_test_no_loader() {
  echo ""
  echo "=== $1 (integration) ==="
  RAN+=("$1")
  if ( set -o pipefail; ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm "$1" 2>&1 | grep -v 'npm warn\|Migration\|ExperimentalWarning\|--trace-warnings\|--import' ); then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILED+=("$1")
  fi
}

run_test_electron_loader() {
  echo ""
  echo "=== $1 (electron+loader) ==="
  RAN+=("$1")
  if ( set -o pipefail; ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm $LOADER "$1" 2>&1 | grep -v 'npm warn\|Migration\|ExperimentalWarning\|--trace-warnings\|--import' ); then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILED+=("$1")
  fi
}

run_test_electron_strict() {
  echo ""
  echo "=== $1 (electron, strict) ==="
  RAN+=("$1")
  if ( set -o pipefail; ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm "$1" 2>&1 | grep -v 'npm warn\|Migration\|ExperimentalWarning\|--trace-warnings\|--import' ); then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILED+=("$1")
  fi
}

# One vitest run over explicit files, under the app's vitest config (jsdom + react
# plugin + '@' alias). Explicit paths override vitest's default include glob, so only
# these run (no sweep of the tsx-harness *.test.ts). Usage: run_vitest_files <label> <file>...
run_vitest_files() {
  local label="$1"
  shift
  echo ""
  echo "=== $label ==="
  RAN+=("$@")
  if pnpm exec vitest run --config packages/apps/app/vitest.config.ts --exclude '**/.claude/worktrees/**' "$@"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILED+=("$label")
  fi
}

# A package's own `test` script (own vitest config / runner). Picks up new test files
# in the package on its own. Usage: run_package_tests <dir> <workspace-name>
run_package_tests() {
  echo ""
  echo "=== $1 (own vitest config) ==="
  if ( set -o pipefail; pnpm --filter "$2" test 2>&1 | grep -v 'npm warn\|ExperimentalWarning' ); then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILED+=("$1")
  fi
}

# Visible exclusion. Usage: skip_suite <path> <reason>. Counts as skipped, not passed,
# and satisfies require_registered.
skip_suite() {
  echo ""
  echo "=== $1 (SKIPPED: $2) ==="
  SKIPPED+=("$1")
}

# Fails (counts into FAIL) for every test file under the given dirs that was neither
# run nor skip_suite'd above. Only for dirs run file-by-file; a dir covered by
# run_package_tests picks up new files itself.
require_registered() {
  local dir file
  for dir in "$@"; do
    while IFS= read -r file; do
      if ! printf '%s\n' "${RAN[@]}" ${SKIPPED[@]+"${SKIPPED[@]}"} | grep -qxF -- "$file"; then
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
