#!/bin/bash
# Suite runners for run-all.sh (`pnpm test:unit`, also the CI unit-tests job). Source
# it; don't execute it. Every run_* helper below counts into PASS/FAIL and names what
# failed in FAILED, so the caller decides the exit status (see print_summary).
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
# Files skipped as part of a whole package (skip_package_tests): registered, but not
# listed one by one in the summary.
SKIPPED_FILES=()

# SLZ_UNIT_DRY=1: register every suite but run none, so require_registered can check in
# seconds that every test file is registered (`pnpm test:unit:registered`, a lint step).
dry_run() { [ "${SLZ_UNIT_DRY:-}" = 1 ]; }

# The exact test files a package's own vitest run collects, repo-relative. Read from
# vitest itself rather than assumed from the directory: a package config may exclude
# files (shared/platform excludes its tsx-harness scripts), and those must still be
# registered file-by-file. Usage: package_test_files <workspace-name>
package_test_files() {
  pnpm --filter "$1" exec vitest list --filesOnly --json 2>/dev/null |
    node -e 'let s = ""
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        for (const { file } of JSON.parse(s || "[]")) console.log(require("path").relative(process.argv[1], file))
      })' "$ROOT_DIR"
}

run_test() {
  echo ""
  echo "=== $1 ==="
  RAN+=("$1")
  dry_run && return 0
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
  dry_run && return 0
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
  dry_run && return 0
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
  dry_run && return 0
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
  dry_run && return 0
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
  dry_run && return 0
  if pnpm exec vitest run --config packages/apps/app/vitest.config.ts --exclude '**/.claude/worktrees/**' "$@"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILED+=("$label")
  fi
}

# A package's own `test` script (own vitest config / runner). Registers exactly the
# files its vitest run collects (package_test_files), so a new test file there needs no
# edit here. Usage: run_package_tests <dir> <workspace-name>
run_package_tests() {
  local file
  echo ""
  echo "=== $1 (own vitest config) ==="
  while IFS= read -r file; do RAN+=("$file"); done < <(package_test_files "$2")
  dry_run && return 0
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

# skip_suite for a whole package's own test run; its collected files count as skipped.
# Usage: skip_package_tests <dir> <workspace-name> <reason>
skip_package_tests() {
  local file
  skip_suite "$1 (own vitest config)" "$3"
  while IFS= read -r file; do SKIPPED_FILES+=("$file"); done < <(package_test_files "$2")
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
