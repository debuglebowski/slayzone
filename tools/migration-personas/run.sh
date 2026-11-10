#!/usr/bin/env bash
# Run today's migrations against every persona (or the ones named) and compare with
# each persona's expected output.
#
#   tools/migration-personas/run.sh [--update] [--twice] [persona ...]
#
#   --update  replace personas/<p>/expected with this run's output (review the diff!)
#   --twice   run each persona twice and fail if the two outputs differ (determinism)
#
# Everything runs in Docker with no network: the harness image is today's working tree
# built for Linux. A persona's data stays inside its container; only the normalized
# dump comes out (personas/<p>/actual). Exit 1 = output differs from expected,
# 2 = an invariant failed, 3 = the run itself broke.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
UPDATE=0; TWICE=0; PERSONAS=()
for a in "$@"; do
  case "$a" in
    --update) UPDATE=1 ;;
    --twice) TWICE=1 ;;
    -*) echo "unknown flag $a" >&2; exit 64 ;;
    *) PERSONAS+=("$a") ;;
  esac
done
if [ ${#PERSONAS[@]} -eq 0 ]; then
  for d in "$HERE"/personas/*/; do [ -f "$d/input.tar.gz" ] && PERSONAS+=("$(basename "$d")"); done
fi

IMAGE=slz-migration-harness:latest
echo "building harness image from the working tree…"
# Context = tracked + untracked-not-ignored files (the working tree as it is now), minus
# the personas' frozen inputs (copied into each container at run time instead).
(cd "$REPO" && git ls-files -z -co --exclude-standard \
  | grep -zv '^tools/migration-personas/personas/.*/input\.tar\.gz$' \
  | tar --null -T - -cf - \
  | (tar_dir=$(mktemp -d); tar -xf - -C "$tar_dir"; cp tools/migration-personas/harness/Dockerfile "$tar_dir/Dockerfile.harness"; \
     docker build -q -f "$tar_dir/Dockerfile.harness" -t "$IMAGE" "$tar_dir" >/dev/null; rc=$?; rm -rf "$tar_dir"; exit $rc))

run_one() { # <persona> <out dir>
  local p=$1 out=$2 c="slz-migration-harness-$1" rc=0
  docker rm -f "$c" >/dev/null 2>&1 || true
  docker run -d --name "$c" --network none "$IMAGE" sleep infinity >/dev/null
  docker cp "$HERE/personas/$p/persona.json" "$c:/tmp/persona.json"
  docker cp "$HERE/personas/$p/input.tar.gz" "$c:/tmp/input.tar.gz"
  docker exec -e HOME=/home/persona -w /home/persona "$c" node /repo/tools/migration-personas/harness/dist/harness.cjs \
    /tmp/persona.json /tmp/input.tar.gz /tmp/out || rc=$?
  rm -rf "$out"; mkdir -p "$out"
  docker cp "$c:/tmp/out/." "$out/" || true
  docker rm -f "$c" >/dev/null
  return $rc
}

status=0
for p in "${PERSONAS[@]}"; do
  PD="$HERE/personas/$p"
  echo "=== $p"
  rc=0; run_one "$p" "$PD/actual" || rc=$?
  if [ $rc -eq 1 ] || [ $rc -gt 2 ]; then echo "[$p] RUN BROKE (exit $rc) — logs in $PD/actual/logs"; status=3; continue; fi
  [ $rc -eq 2 ] && { echo "[$p] INVARIANT FAILED (see $PD/actual/invariants.txt)"; [ $status -lt 2 ] && status=2; }
  if [ $TWICE -eq 1 ]; then
    rc2=0; run_one "$p" "$PD/actual-2" || rc2=$?
    if ! diff -r -x logs "$PD/actual" "$PD/actual-2" >/dev/null; then
      echo "[$p] NOT DETERMINISTIC:"; { diff -r -x logs "$PD/actual" "$PD/actual-2" | head -60 || true; }; status=3
    else
      echo "[$p] deterministic across two runs"; rm -rf "$PD/actual-2"
    fi
  fi
  if [ $UPDATE -eq 1 ]; then
    rm -rf "$PD/expected"; mkdir -p "$PD/expected"
    (cd "$PD/actual" && tar -cf - --exclude=./logs .) | (cd "$PD/expected" && tar -xf -)
    echo "[$p] expected/ updated — review: git diff -- $PD/expected"
  elif [ ! -d "$PD/expected" ]; then
    echo "[$p] no expected/ yet — run with --update to create it"; [ $status -lt 1 ] && status=1
  elif ! diff -r -x logs "$PD/expected" "$PD/actual" >/dev/null; then
    echo "[$p] OUTPUT DIFFERS from expected:"; { diff -r -u -x logs "$PD/expected" "$PD/actual" | head -120 || true; }
    [ $status -lt 1 ] && status=1
  else
    echo "[$p] output matches expected"
  fi
done
exit $status
