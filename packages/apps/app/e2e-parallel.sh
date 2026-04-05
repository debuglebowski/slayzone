#!/usr/bin/env bash
# Run e2e tests in parallel — one group per subdirectory, one Electron per group.
# Usage: ./e2e-parallel.sh
set -uo pipefail
cd "$(dirname "$0")"

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

# Discover groups from subdirectories
groups=()
total=0
for dir in e2e/*/; do
  [[ -d "$dir" ]] || continue
  name=$(basename "$dir")
  [[ "$name" == "fixtures" ]] && continue
  specs=("$dir"*.spec.ts)
  [[ -e "${specs[0]}" ]] || continue
  groups+=("$name")
  total=$((total + ${#specs[@]}))
done

echo "Running $total specs across ${#groups[@]} groups: ${groups[*]}"
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
echo "Wall clock: ${elapsed}s ($((elapsed / 60))m $((elapsed % 60))s)"
echo "========================================="
exit $fail
