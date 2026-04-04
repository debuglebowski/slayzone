#!/usr/bin/env bash
# Run e2e tests one file at a time in a shared Electron instance.
# Usage: ./e2e-loop.sh [--stop-on-fail] [glob pattern]
# Examples:
#   ./e2e-loop.sh                    # run all
#   ./e2e-loop.sh --stop-on-fail     # stop at first failure
#   ./e2e-loop.sh '4[0-9]-*'        # run 40-49
#   ./e2e-loop.sh --stop-on-fail '1[1-2]-*'  # 11-12, stop on fail

set -uo pipefail
cd "$(dirname "$0")"
shopt -s globstar

stop_on_fail=false
pattern="*.spec.ts"

for arg in "$@"; do
  if [[ "$arg" == "--stop-on-fail" ]]; then
    stop_on_fail=true
  else
    pattern="$arg"
  fi
done

files=(e2e/**/$pattern)
total=${#files[@]}
passed=0
failed=0
failed_files=()

echo "Running $total test files one at a time"
echo "========================================="

for f in "${files[@]}"; do
  name=$(basename "$f")
  printf "\n── %s ──\n" "$name"

  if npx --silent playwright test --config playwright.config.ts "$f"; then
    ((passed++))
  else
    ((failed++))
    failed_files+=("$name")
    if $stop_on_fail; then
      echo ""
      echo "Stopping on first failure (--stop-on-fail)"
      break
    fi
  fi
done

echo ""
echo "========================================="
echo "Results: $passed passed, $failed failed out of $total"
if [[ ${#failed_files[@]} -gt 0 ]]; then
  echo "Failed:"
  for f in "${failed_files[@]}"; do
    echo "  ✘ $f"
  done
  exit 1
fi
