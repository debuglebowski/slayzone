#!/bin/sh
# Graceful stop of everything the journey started, so every database is closed and its
# WAL checkpointed the way a user's quit leaves it. Order: the desktop app (stops its
# own hub + local computer), standalone computers, standalone hubs. Only each process
# TREE's root is signalled (see top_level in lib.sh); patterns are ^-anchored so they
# never match this shell.
. /gen/lib.sh
stop() {
  pids=$(pgrep -f "$1") || return 0
  kill -TERM $(top_level $pids) 2>/dev/null
  i=0
  while [ $i -lt 60 ]; do alive $pids || return 0; i=$((i + 1)); sleep 1; done
  echo "STILL RUNNING after 60s: $1" >&2; return 1
}
stop '^/opt/SlayZone/slayzone --no-sandbox'
stop '^/opt/SlayZone/slayzone (/opt/SlayZone/resources/computer/bin\.cjs|.*/computer-runtime/launch\.cjs)'
stop '^/opt/SlayZone/slayzone /opt/SlayZone/resources/hub/bin\.cjs'
sleep 2
left=$(ps -eo stat=,args= | awk '$1 !~ /^Z/ && $2 == "/opt/SlayZone/slayzone"' | wc -l)
[ "$left" -eq 0 ] || { echo "processes left: $left" >&2; ps -eo pid,stat,args | grep '/opt/SlayZone' >&2; exit 1; }
echo "DOWN OK"
