#!/usr/bin/env bash
# Run e2e tests in parallel — one group per subdirectory, one Electron per group.
# Large directories are split into multiple groups for better load balancing.
# Usage: ./e2e-parallel.sh [max-per-group]   (default: 16)
set -uo pipefail
cd "$(dirname "$0")"

max_per_group=${1:-16}
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

# Collect all specs per subdirectory, split large dirs into chunks
group_idx=0
total=0
declare -a group_names
declare -a group_files

for dir in e2e/*/; do
  [[ -d "$dir" ]] || continue
  name=$(basename "$dir")
  [[ "$name" == "fixtures" ]] && continue
  specs=("$dir"*.spec.ts)
  [[ -e "${specs[0]}" ]] || continue
  total=$((total + ${#specs[@]}))

  # Split into chunks of max_per_group
  chunk=0
  for i in "${!specs[@]}"; do
    if (( i > 0 && i % max_per_group == 0 )); then
      ((chunk++))
    fi
    idx="$group_idx"
    if (( chunk > 0 )); then
      idx=$((group_idx + chunk))
    fi
    echo "${specs[$i]}" >> "$tmpdir/group-$idx.txt"
  done

  chunks=$(( (${#specs[@]} + max_per_group - 1) / max_per_group ))
  for c in $(seq 0 $((chunks - 1))); do
    if (( chunks > 1 )); then
      group_names+=("${name}.$((c + 1))")
    else
      group_names+=("$name")
    fi
  done
  group_idx=$((group_idx + chunks))
done

echo "Running $total specs across ${#group_names[@]} groups: ${group_names[*]}"
start_time=$SECONDS

# Launch each group in parallel
pids=()
for i in "${!group_names[@]}"; do
  groupfile="$tmpdir/group-$i.txt"
  [[ -f "$groupfile" ]] || continue
  logfile="$tmpdir/log-$i.txt"

  npx playwright test \
    --config playwright.config.ts \
    $(cat "$groupfile" | tr '\n' ' ') \
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
for i in "${!group_names[@]}"; do
  logfile="$tmpdir/log-$i.txt"
  timing=$(grep -oE '\([0-9.]+[ms]+\)' "$logfile" 2>/dev/null | tail -1)
  summary=$(grep -oE '[0-9]+ (passed|failed|skipped)' "$logfile" 2>/dev/null | paste -sd', ' -)
  printf "%-15s %s %s\n" "${group_names[$i]}" "$summary" "$timing"
done

# Print failures from all groups
echo ""
failed_tests=()
for i in "${!group_names[@]}"; do
  logfile="$tmpdir/log-$i.txt"
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
