#!/usr/bin/env bash
# Emit host covariates as one JSON object on stdout.
#
# A suite result is not interpretable without these. Measured on this box, the
# SAME commit went from 21 failures / 5 runs (0 green) to 1 failure / 5 runs
# (4 green) with no code change — the only difference was that the co-resident
# dev app had been restarted. Wall clock moved with it (327s -> 289s median),
# which is the tell: a degrading host shows up in the clock before it shows up
# in the failures.
#
# WHY THE WHOLE PROCESS TREE, NOT `out/main/index.js`
# ---------------------------------------------------
# The first version of this matched only `out/main/index.js` and summed that.
# On a 15h-old dev app that reports ~246 MB — while the app's actual footprint
# is ~2.4 GB, because Electron splits across helper processes and the single
# largest one is `Electron Helper (Renderer)` at ~1.04 GB. The renderer is
# exactly where this codebase's known retained-JS leak lives, so the old metric
# excluded the one process the leak hypothesis is about: it could not move with
# the mechanism it existed to test. Sum the tree, and report the largest single
# process separately — that peak is the leak's signal.
set -uo pipefail

# Every SlayZone-owned process: the dev app (launched by electron-vite from the
# repo's own electron dist), its helpers, its sidecar, plus any hub/computer.
# Plain word-split rather than `mapfile` — macOS ships bash 3.2.
all_pids=$(
  pgrep -f 'node_modules/electron/dist/Electron\.app|out/main/index\.js|hub/dist/bin\.c?js|computer/dist/bin\.cjs' 2>/dev/null || true
)

# Convert ps etime ([[DD-]HH:]MM:SS) to seconds.
etime_seconds() {
  # Separate statements: bash 3.2 evaluates every RHS on a `local` line before
  # binding any of them, so `local e=$1 rest=$e` reads an unbound `e`.
  local e=$1
  local days=0
  local rest=$e
  [[ "$e" == *-* ]] && { days=${e%%-*}; rest=${e#*-}; }
  local IFS=:
  read -ra parts <<<"$rest"
  local h=0 m=0 s=0
  case ${#parts[@]} in
    3) h=${parts[0]}; m=${parts[1]}; s=${parts[2]} ;;
    2) m=${parts[0]}; s=${parts[1]} ;;
    1) s=${parts[0]} ;;
  esac
  echo $(( 10#$days * 86400 + 10#$h * 3600 + 10#$m * 60 + 10#$s ))
}

# Cumulative CPU seconds a process has burned. `ps -o cputime=` is MM:SS.ss and
# simply keeps growing the minutes field past 60 (125:30.82), so count colons
# rather than assuming HH:MM:SS.
cputime_seconds() {
  local t=$1
  local IFS=:
  local parts
  read -ra parts <<<"$t"
  case ${#parts[@]} in
    3) echo "${parts[0]} ${parts[1]} ${parts[2]}" | awk '{printf "%d", $1*3600 + $2*60 + $3}' ;;
    2) echo "${parts[0]} ${parts[1]}" | awk '{printf "%d", $1*60 + $2}' ;;
    *) echo 0 ;;
  esac
}

count=0
total_rss=0
renderer_rss=0
app_cpu_s=0
max_rss=0
max_cmd="-"
oldest_secs=0
oldest_etime="-"

for pid in $all_pids; do
  [[ -n "$pid" ]] || continue
  cmd=$(ps -o command= -p "$pid" 2>/dev/null) || continue
  [[ -n "$cmd" ]] || continue

  # Exclude this test run's own Electrons. Two independent discriminators, so a
  # miss in one still excludes: Playwright marks the env, and the harness always
  # points the app at a .e2e-runtime user-data-dir.
  [[ "$cmd" == *".e2e-runtime"* ]] && continue
  ps eww -o command= -p "$pid" 2>/dev/null | grep -q 'PLAYWRIGHT=' && continue

  # Orphaned crash handlers, not the app. They reparent to init when their app
  # dies and then linger for days at 3-9 MB. Counting them made `procs` mostly
  # noise and pinned `oldest_age` to an 8-day-old corpse instead of the live
  # app's 17h — i.e. it destroyed the one covariate the leak hypothesis needs.
  [[ "$cmd" == *chrome_crashpad_handler* ]] && continue

  rss=$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ')
  etime=$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ')
  [[ -n "$rss" ]] || continue

  count=$((count + 1))
  total_rss=$((total_rss + rss))

  # Cumulative CPU. The delta across one suite run is the throughput the
  # co-resident app stole from that run — a direct measurement of the
  # host-degradation mechanism, rather than a correlation against RSS.
  ctime=$(ps -o cputime= -p "$pid" 2>/dev/null | tr -d ' ')
  [[ -n "$ctime" ]] && app_cpu_s=$((app_cpu_s + $(cputime_seconds "$ctime")))

  # Electron distinguishes its helpers only by --type. The renderer is the one
  # that matters: it holds this codebase's known retained-JS leak, and it is by
  # far the largest process in an aged tree.
  kind=main
  case "$cmd" in
    *--type=*) kind="${cmd##*--type=}"; kind="${kind%% *}" ;;
  esac
  [[ "$kind" == renderer ]] && renderer_rss=$((renderer_rss + rss))

  if (( rss > max_rss )); then
    max_rss=$rss
    max_cmd=$kind
  fi

  if [[ -n "$etime" ]]; then
    secs=$(etime_seconds "$etime")
    if (( secs > oldest_secs )); then
      oldest_secs=$secs
      oldest_etime=$etime
    fi
  fi
done

read -r l1 l5 l15 < <(uptime | sed 's/.*load averages*: //' | tr -d ',' | awk '{print $1, $2, $3}')

printf '{"ts":"%s","load1":%s,"load5":%s,"load15":%s,"procs":%d,"total_rss_mb":%d,"renderer_rss_mb":%d,"max_rss_mb":%d,"max_rss_kind":"%s","app_age":"%s","app_age_s":%d,"app_cpu_s":%d}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "${l1:-0}" "${l5:-0}" "${l15:-0}" \
  "$count" \
  "$((total_rss / 1024))" \
  "$((renderer_rss / 1024))" \
  "$((max_rss / 1024))" \
  "$max_cmd" \
  "$oldest_etime" \
  "$oldest_secs" \
  "$app_cpu_s"
