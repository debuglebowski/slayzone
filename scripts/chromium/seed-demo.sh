#!/usr/bin/env bash
# Launch the Chromium fork with the sidecar demo seed on.
#   Usage: seed-demo.sh [out-dir] [-- chrome-args...]
#
# The seed (packages/sidecar/src/handlers/demo-seed.ts) populates projects,
# tasklist, sidebar, taskheader, and statusbar state on boot so every region
# renders real content for manual smoke testing — until patch 0050+ lands
# the Mojo write surface + SQLite persistence required for full CRUD.
#
# Unset SLAYZONE_SEED_DEMO or use run.sh with SLAYZONE_SEED_DEMO=0 to get
# the vanilla empty-state launch.

set -euo pipefail

export SLAYZONE_SEED_DEMO=1
exec "$(dirname "${BASH_SOURCE[0]}")/run.sh" "$@"
