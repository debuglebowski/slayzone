#!/usr/bin/env bash
# Generate one persona's FROZEN INPUT by running its pinned release's real build.
#
#   tools/migration-personas/generate/generate.sh <persona>
#
# Reads personas/<persona>/persona.json (`release`, `journey`), downloads that release's
# amd64 .deb (checksum-verified, cached), installs it in a fresh container with NO
# network (the old build's auto-updater would otherwise install the latest release),
# runs the journey, stops everything gracefully and writes personas/<persona>/input.tar.gz.
#
# The persona's data never leaves the container until it is packed: SQLite WAL locking
# does not work across a macOS bind mount, and reading a live database through one
# silently discarded the app's writes during the spike.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
P=${1:?usage: generate.sh <persona>}
PD="$ROOT/personas/$P"
[ -f "$PD/persona.json" ] || { echo "no $PD/persona.json" >&2; exit 1; }
REL=$(node -p "require('$PD/persona.json').release")
JOURNEY=$(node -p "require('$PD/persona.json').journey")
[ -f "$HERE/journeys/$JOURNEY/journey.sh" ] || { echo "no journey $JOURNEY" >&2; exit 1; }

REPO=$(cd "$ROOT" && gh repo view --json nameWithOwner -q .nameWithOwner)
CACHE="${SLZ_PERSONA_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/slayzone-migration-personas}/$REL"
mkdir -p "$CACHE"
if [ ! -f "$CACHE/SlayZone-amd64.deb" ]; then
  gh release download "$REL" -R "$REPO" -D "$CACHE" -p SlayZone-amd64.deb -p SHA256SUMS.txt --clobber
fi
want=$(awk '$2 ~ /SlayZone-amd64\.deb$/ {print $1}' "$CACHE/SHA256SUMS.txt")
got=$(shasum -a 256 "$CACHE/SlayZone-amd64.deb" | awk '{print $1}')
[ -n "$want" ] && [ "$want" = "$got" ] || { echo "checksum mismatch for $REL .deb" >&2; exit 1; }

IMAGE="slz-persona-gen:$REL"
CTX=$(mktemp -d)
trap 'rm -rf "$CTX"' EXIT
cp "$HERE/Dockerfile" "$CTX/Dockerfile"
cp "$CACHE/SlayZone-amd64.deb" "$CTX/slayzone.deb"
TU="$ROOT/../../packages/shared/test-utils"
mkdir -p "$CTX/fake/fake-claude" "$CTX/fake/fake-cli"
cp "$TU/fake-claude/fake-claude.mjs" "$TU/fake-claude/fake-claude-tasks.mjs" "$CTX/fake/fake-claude/"
cp "$TU/fake-cli/runtime.mjs" "$CTX/fake/fake-cli/"
cp "$HERE/fake-claude/claude" "$HERE/fake-claude/scenario.json" "$CTX/fake/"
docker build --platform linux/amd64 -q -t "$IMAGE" "$CTX" >/dev/null

C="slz-persona-gen-$P"
docker rm -f "$C" >/dev/null 2>&1 || true
docker run -d --name "$C" --hostname slz-desktop --network none --platform linux/amd64 --shm-size=1g "$IMAGE" sleep infinity >/dev/null
cleanup() {
  rc=$?
  if [ $rc -ne 0 ]; then
    echo "[$P] FAILED (exit $rc) — container logs:" >&2
    docker exec "$C" sh -c 'for f in /tmp/*.log; do echo "--- $f"; tail -25 "$f"; done' >&2 2>/dev/null || true
  fi
  docker rm -f "$C" >/dev/null 2>&1 || true; rm -rf "$CTX"
}
trap cleanup EXIT

docker exec -u root "$C" mkdir -p /gen
docker cp "$HERE/lib.sh" "$C:/gen/lib.sh"
docker cp "$HERE/down.sh" "$C:/gen/down.sh"
docker cp "$HERE/pack.sh" "$C:/gen/pack.sh"
docker cp "$HERE/journeys/$JOURNEY/journey.sh" "$C:/gen/journey.sh"

echo "[$P] journey ($REL)"
docker exec "$C" sh /gen/journey.sh
echo "[$P] stopping"
docker exec "$C" sh /gen/down.sh
echo "[$P] packing"
docker exec "$C" sh /gen/pack.sh
docker cp "$C:/tmp/input.tar.gz" "$PD/input.tar.gz"
echo "[$P] wrote $PD/input.tar.gz ($(du -h "$PD/input.tar.gz" | cut -f1))"
