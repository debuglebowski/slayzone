#!/usr/bin/env bash
# Run named tests in isolation with --repeat-each, one at a time, keeping output.
#
#   ./e2e-isolate.sh <out-dir> <repeat> <spec-path>::<test-title-substring> ...
#
# Half of a disposition. A test that fails here — alone, on a quiet box — is not
# losing a race against the other five groups, so "contention" is off the table
# and it is a product bug or a test defect. A test that passes 5/5 here but
# fails in the full suite is the opposite finding. Neither half concludes
# anything on its own, which is why "flake" is not a disposition.
set -uo pipefail
cd "$(dirname "$0")"

out=${1:?usage: e2e-isolate.sh <out-dir> <repeat> <spec::title> ...}
repeat=${2:?usage: e2e-isolate.sh <out-dir> <repeat> <spec::title> ...}
shift 2

mkdir -p "$out"

if pgrep -f 'playwright.*e2e/' >/dev/null 2>&1; then
  echo "REFUSING: a playwright suite is already running." >&2
  exit 2
fi

for target in "$@"; do
  spec=${target%%::*}
  title=${target#*::}
  slug=$(echo "$spec" | sed 's#.*/##; s/\.spec\.ts$//')-$(echo "$title" | tr -cs '[:alnum:]' '-' | cut -c1-40)
  log="$out/$slug.txt"

  echo "───────────────────────────────────────────"
  echo "isolate x$repeat: $spec"
  echo "         title: $title"

  bash ./e2e-covariates.sh > "$out/$slug.covariates.json"

  PLAYWRIGHT_JSON_OUTPUT_NAME="$out/$slug.json" \
    npx playwright test \
      --config playwright.config.ts \
      --reporter=list,json \
      --repeat-each="$repeat" \
      -g "$title" \
      "$spec" > "$log" 2>&1
  rc=$?

  line=$(grep -oE '[0-9]+ (passed|failed|flaky|skipped)' "$log" | paste -sd', ' -)
  if [[ $rc -eq 0 ]]; then
    echo "  PASS  $line"
  else
    echo "  FAIL  $line   (rc=$rc)"
    grep -E '^\s+[0-9]+\)|Error:|expect\(' "$log" | head -8
  fi
done

echo ""
echo "Logs in $out"
