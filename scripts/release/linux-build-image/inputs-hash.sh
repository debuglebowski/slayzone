#!/usr/bin/env bash
# Prints the hash of everything the Linux build image is made of: its Dockerfile and
# scripts/release/linux-build-env.sh. Used as the image tag (build.sh).
# The release build checks the per-file checksums the image carries
# (/etc/slayzone-linux-build-inputs.sha256), not this hash.
# Run from the repo root.
set -euo pipefail
cat scripts/release/linux-build-image/Dockerfile scripts/release/linux-build-env.sh \
  | sha256sum | cut -d' ' -f1
