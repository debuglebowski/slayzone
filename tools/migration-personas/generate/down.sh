#!/bin/sh
# Graceful stop of everything the journey started, so every database is closed and its
# WAL checkpointed the way a user's quit leaves it.
# Patterns are ^-anchored: an unanchored `pkill -f` matches this very shell.
# Order: desktop app (stops its own hub + local computer), standalone computers, hubs.
stop() {
  pkill -TERM -f "$1" || return 0
  i=0
  while [ $i -lt 60 ]; do pgrep -f "$1" >/dev/null || return 0; i=$((i + 1)); sleep 1; done
  echo "STILL RUNNING after 60s: $1" >&2; return 1
}
stop '^/opt/SlayZone/slayzone --no-sandbox'
stop '^/opt/SlayZone/slayzone /opt/SlayZone/resources/computer/bin.cjs'
stop '^/opt/SlayZone/slayzone /opt/SlayZone/resources/hub/bin.cjs'
sleep 2
left=$(ps -eo args | grep -c '^/opt/SlayZone/slayzone')
[ "$left" -eq 0 ] || { echo "processes left: $left" >&2; exit 1; }
echo "DOWN OK"
