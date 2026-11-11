#!/usr/bin/env bash
# Builds the Linux release build image for linux/amd64 and pushes it to ghcr.io,
# tagged with its inputs hash (inputs-hash.sh). Prints the digest to pin in
# .github/workflows/release-foundation.yml (matrix linux-x64 `container:`).
#
# Needs: docker with buildx, and a ghcr.io login with write:packages
# (`gh auth token | docker login ghcr.io -u <user> --password-stdin`).
# Context = scripts/release (the image copies linux-build-env.sh and its Dockerfile).
# Run from the repo root. Also run by .github/workflows/linux-build-image.yml.
set -euo pipefail

IMAGE=ghcr.io/debuglebowski/slayzone-linux-build
HASH=$(bash scripts/release/linux-build-image/inputs-hash.sh)
REF="$IMAGE:$HASH"

docker buildx build \
  --platform linux/amd64 \
  --file scripts/release/linux-build-image/Dockerfile \
  --tag "$REF" \
  --push \
  scripts/release

DIGEST=$(docker buildx imagetools inspect "$REF" --format '{{json .Manifest.Digest}}' | tr -d '"')
echo "Pushed $REF"
echo "Pin in release-foundation.yml:"
echo "  container: $IMAGE@$DIGEST"
