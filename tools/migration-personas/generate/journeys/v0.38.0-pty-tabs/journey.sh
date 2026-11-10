#!/bin/sh
# v0.38.0 (pre-v201), desktop hub + local computer: TERMINAL Claude agents in two tabs
# of a task, started the way the v0.38 renderer starts them (pty.create; the main tab
# passes the task's currentConversationByMode, other tabs pass nothing). The fake fires
# Claude's hooks (SessionStart, and on a fresh start UserPromptSubmit + Stop).
# Before v201 the hub keyed sessions per TASK, so tabs shared/stole sessions:
#  T1 "Ship the release": main starts fresh (A); the Deploy tab then RESUMES A (shared).
#  T2 "Hotfix":           the Deploy tab starts first, fresh (B); main then RESUMES B.
# /tmp/facts.json: every spawn as it actually ran, and what v201 + its one-time
# recovery must do after the upgrade (session-tab-recovery.ts): a session belongs to
# the tab that MINTED it (fresh spawn), so
#   T1: main resumes A; Deploy minted nothing → starts fresh.
#   T2: Deploy resumes B; main minted nothing → starts fresh.
set -e
. /gen/lib.sh
H=/home/persona
LOG=/opt/fake/state/interactive.log
start_app
wait_http http://127.0.0.1:51100/health
wait_connected 51100 local-computer
trpc_call 51100 mutation settings.set "{key:'terminal_agent_startup',value:'manual'}" >/dev/null
git_repo $H/repos/webapp
slay projects create Webapp --path $H/repos/webapp --color "#10b981"

# current <task> — the task's currentConversationByMode[claude-code] (what v0.38's renderer passes).
current() {
  trpc_call 51100 query task.getAll "undefined" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const t=JSON.parse(s).find(t=>t.id==='$1');console.log((t&&t.currentConversationByMode&&t.currentConversationByMode['claude-code'])||'')})"
}
# start <task> <tab> <main 0|1> — start the tab's terminal agent like the renderer; prints the session it ran.
start() {
  n=$(wc -l < $LOG 2>/dev/null || echo 0)
  if [ "$3" = 1 ]; then ex=$(current "$1"); else ex=""; fi
  conv=$(cat /proc/sys/kernel/random/uuid)
  if [ -n "$ex" ]; then ids="existingConversationId:'$ex'"; else ids="conversationId:'$conv'"; fi
  trpc_call 51100 mutation pty.create "{sessionId:'$1:$2',cwd:'$H/repos/webapp',mode:'claude-code',$ids,cols:120,rows:30,foreground:true}" >/dev/null
  i=0; while [ "$(wc -l < $LOG 2>/dev/null || echo 0)" -le "$n" ] && [ $i -lt 30 ]; do sleep 1; i=$((i+1)); done
  sleep 3   # let the hooks land
  tail -1 $LOG | sed -n 's/.*--\(session-id\|resume\) \([0-9a-f-]*\).*/\1 \2/p'
}
mk_task() {
  T=$(task_id Webapp "$(slay tasks create "$1" --project Webapp | created)")
  slay tasks update "$T" --agent claude-code >/dev/null
  trpc_call 51100 mutation taskTerminals.ensureMain "{taskId:'$T',mode:'claude-code'}" >/dev/null
  TAB=$(trpc_call 51100 mutation taskTerminals.create "{taskId:'$T',mode:'claude-code',label:'Deploy'}" | json_id)
  echo "$T $TAB"
}

set -- $(mk_task "Ship the release"); T1=$1; D1=$2
S1M=$(start $T1 $T1 1); S1D=$(start $T1 $D1 0)
set -- $(mk_task "Hotfix"); T2=$1; D2=$2
S2D=$(start $T2 $D2 0); S2M=$(start $T2 $T2 1)
echo "T1 main: $S1M | deploy: $S1D"
echo "T2 deploy: $S2D | main: $S2M"
A=${S1M#* }; B=${S2D#* }
node -e "
const f={spawns:{'$T1':'$S1M','$D1':'$S1D','$D2':'$S2D','$T2':'$S2M'},
 expect:{'$T1':{resume:'$A'},'$D1':{fresh:true},'$D2':{resume:'$B'},'$T2':{fresh:true}}}
require('fs').writeFileSync('/tmp/facts.json',JSON.stringify(f,null,2)+'\n')"
cat /tmp/facts.json
echo JOURNEY OK
