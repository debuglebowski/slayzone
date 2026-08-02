#!/usr/bin/env bash
# Launch fork in kHome w/ seeded sidecar. Run from repo root.
# `run.sh` spawns sidecar + traps cleanup; `SLAYZONE_SEED_DEMO=1` seeds
# a demo project + tasks on first sidecar start.

SLAYZONE_SEED_DEMO=1 ./scripts/chromium/run.sh -- \
  --slayzone-webui-bundle-dir="$(pwd)/packages/webui" \
  --slayzone-layout-mode=home \
  --window-size=1440,900

# Swap --slayzone-layout-mode=home → task-detail | overlay for other modes.
# Clean state between runs: rm -rf /tmp/slayzone-runtime*
