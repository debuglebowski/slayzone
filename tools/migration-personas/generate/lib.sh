#!/bin/sh
# Helpers shared by every journey. Sourced inside the GENERATE container (old release).
# Everything here talks to loopback only — the container runs with --network none.

E=/opt/SlayZone/slayzone
R=/opt/SlayZone/resources
NP=$R/app.asar.unpacked/node_modules
export PATH="$PATH:$R/bin"

# wait_http <url> — until it answers 2xx (max ~4 min).
wait_http() {
  i=0
  while [ $i -lt 120 ]; do
    node -e "fetch('$1').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" && return 0
    i=$((i + 1)); sleep 2
  done
  echo "TIMEOUT waiting for $1" >&2; return 1
}

# wait_log <file> <fixed string> — until the line shows up (max ~4 min).
wait_log() {
  i=0
  while [ $i -lt 120 ]; do
    grep -qF "$2" "$1" 2>/dev/null && return 0
    i=$((i + 1)); sleep 2
  done
  echo "TIMEOUT waiting for '$2' in $1" >&2; tail -20 "$1" >&2; return 1
}

# start_app — the desktop app, headless (Xvfb), detached from this shell.
start_app() {
  ( setsid dbus-launch xvfb-run -a -s "-screen 0 1440x900x24" $E --no-sandbox --disable-gpu \
      > /tmp/app.log 2>&1 & )
}

# start_hub <root> <host:port> [name] — a standalone hub (v0.36+), detached.
start_hub() {
  mkdir -p "$1"
  ( cd "$1" && ELECTRON_RUN_AS_NODE=1 NODE_PATH=$NP SLAYZONE_ROOT="$1" \
      SLAYZONE_HUB_LISTEN_ADDRESS="$2" SLAYZONE_HUB_NAME="${3:-}" \
      SLAYZONE_HUB_ENABLE_TELEMETRY=0 SLAYZONE_NONINTERACTIVE=1 \
      setsid $E $R/hub/bin.cjs > "/tmp/hub-$(basename "$1").log" 2>&1 & )
}

# mint <hub port> <label> — a single-use computer join token (login-off loopback hub).
mint() {
  node -e "fetch('http://127.0.0.1:$1/api/computers/join-token',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({label:'$2'})}).then(r=>r.json()).then(j=>{if(!j.token){console.error(JSON.stringify(j));process.exit(1)}console.log(j.token)})"
}

# start_computer <root> <name> <hub port> <allowed root> — a standalone computer (v0.36+),
# enrolled on one hub with a fresh token, then waited for.
start_computer() {
  mkdir -p "$1"
  tok=$(mint "$3" "$2")
  # autoUpgrade: off — v0.38+ computers upgrade themselves (no network here anyway).
  echo "{\"computerName\":\"$2\",\"allowedRoots\":[\"$4\"],\"autoUpgrade\":false}" > "$1/computer.config.json"
  log="/tmp/computer-$(basename "$1").log"
  ( cd "$1" && ELECTRON_RUN_AS_NODE=1 NODE_PATH=$NP SLAYZONE_ROOT="$1" SLAYZONE_NONINTERACTIVE=1 \
      SLAYZONE_HUB_ADDRESS="127.0.0.1:$3" SLAYZONE_HUB_JOIN_TOKEN="$tok" setsid $E $R/computer/bin.cjs > "$log" 2>&1 & )
  wait_connected "$3" "$2"
}

# wait_connected <hub port> <computer name> — until the hub lists it as connected.
# (v0.38+ computers log "connected" from a detached session host, not to our log.)
wait_connected() {
  i=0
  while [ $i -lt 120 ]; do
    computer_id "$1" "$2" >/dev/null 2>&1 && return 0
    i=$((i + 1)); sleep 2
  done
  echo "TIMEOUT: computer $2 never connected to :$1" >&2; return 1
}

# top_level <pid...> — the pids among these whose parent is not a SlayZone process: a
# computer is a TREE at v0.38 (launcher → supervisor → connectors + a detached session
# host); signal only its root, which stops the rest in order. Signalling every process
# at once leaves the session host hanging.
top_level() {
  for p in "$@"; do
    pp=$(awk '{print $4}' /proc/$p/stat 2>/dev/null) || continue
    case "$(tr '\0' ' ' < /proc/$pp/cmdline 2>/dev/null)" in /opt/SlayZone/slayzone*) ;; *) echo $p ;; esac
  done
}

# alive <pid...> — succeeds while any of them runs (zombies count as gone).
alive() {
  for p in "$@"; do
    st=$(awk '{print $3}' /proc/$p/stat 2>/dev/null) || continue
    [ "$st" != Z ] && return 0
  done
  return 1
}

# stop_root <root> — gracefully stop the computer running with SLAYZONE_ROOT=<root>.
stop_root() {
  pids=$(for p in $(pgrep -f '^/opt/SlayZone/slayzone'); do
    tr '\0' '\n' < /proc/$p/environ 2>/dev/null | grep -qx "SLAYZONE_ROOT=$1" && echo $p; done)
  [ -n "$pids" ] || return 0
  kill -TERM $(top_level $pids)
  i=0
  while [ $i -lt 60 ]; do alive $pids || return 0; i=$((i + 1)); sleep 1; done
  echo "STILL RUNNING: $1" >&2; return 1
}

# start_computer_two_hubs <root> <name> <primary port> <second port> <allowed root>
# (v0.38+) ONE computer process on two hubs: enroll on the second hub first, stop, then
# run with `hubUrls` naming both — the join token enrolls the primary hub, the stored
# credential reconnects the second.
start_computer_two_hubs() {
  start_computer "$1" "$2" "$4" "$5"
  stop_root "$1"
  tok=$(mint "$3" "$2")
  printf '{"computerName":"%s","allowedRoots":["%s"],"autoUpgrade":false,"hubUrl":"ws://127.0.0.1:%s/computers","hubUrls":["ws://127.0.0.1:%s/computers","ws://127.0.0.1:%s/computers"]}\n' \
    "$2" "$5" "$3" "$3" "$4" > "$1/computer.config.json"
  ( cd "$1" && ELECTRON_RUN_AS_NODE=1 NODE_PATH=$NP SLAYZONE_ROOT="$1" SLAYZONE_NONINTERACTIVE=1 \
      SLAYZONE_HUB_JOIN_TOKEN="$tok" setsid $E $R/computer/bin.cjs > "/tmp/computer-$(basename "$1").log" 2>&1 & )
  wait_connected "$3" "$2"
  wait_connected "$4" "$2"
}

# git_repo <dir> — an initialized repo with one empty commit.
git_repo() {
  mkdir -p "$1" && (cd "$1" && git init -q -b main && git -c user.email=p@example.invalid -c user.name=persona commit -q --allow-empty -m init)
}

# created — the id prefix out of `slay ... create` output ("Created: <prefix>  ...").
created() { sed -n 's/^Created[^:]*: \([0-9a-f]*\).*/\1/p' | head -1; }

# json_id — `.id` (or `.data.id`) of a JSON document on stdin.
json_id() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log((j.data??j).id)})'; }

# task_id <project> <prefix> — full task id from `slay tasks list --json`.
task_id() {
  slay tasks list --project "$1" --json --limit 500 | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const t=JSON.parse(s).find(t=>t.id.startsWith('$2'));if(!t){console.error('no task $2');process.exit(1)}console.log(t.id)})"
}

# computer_id <hub port> <name> — id of a CONNECTED computer by name.
computer_id() {
  node -e "fetch('http://127.0.0.1:$1/api/computers').then(r=>r.json()).then(a=>{const c=a.find(c=>c.name==='$2'&&c.connected);if(!c){console.error('no computer $2');process.exit(1)}console.log(c.id)})"
}

# trpc <hub port> <procedure path> <input JS object literal> — one mutation over the hub's
# tRPC WebSocket (superjson wire format: input wrapped as {json: ...}).
trpc() {
  node -e "
const ws=new WebSocket('ws://127.0.0.1:$1/trpc');
ws.onopen=()=>ws.send(JSON.stringify({id:1,jsonrpc:'2.0',method:'mutation',params:{path:'$2',input:{json:$3}}}));
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id!==1)return;if(m.error){console.error('$2 ERR',JSON.stringify(m.error).slice(0,400));process.exit(1)}console.log('$2 ok');ws.close();process.exit(0)};
setTimeout(()=>{console.error('$2 TIMEOUT');process.exit(1)},20000)"
}

# trpc_call <port> <query|mutation> <path> <input JS literal> — prints the result as JSON.
trpc_call() {
  node -e "
const ws=new WebSocket('ws://127.0.0.1:$1/trpc');
ws.onopen=()=>ws.send(JSON.stringify({id:1,jsonrpc:'2.0',method:'$2',params:{path:'$3',input:{json:$4}}}));
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id!==1)return;if(m.error){console.error('$3 ERR',JSON.stringify(m.error).slice(0,400));process.exit(1)}console.log(JSON.stringify(m.result?.data?.json??m.result?.data??null));ws.close();process.exit(0)};
setTimeout(()=>{console.error('$3 TIMEOUT');process.exit(1)},30000)"
}

# chat_open <port> <task id> <cwd> — make the task a Claude chat, open its tab and start
# its process (task.update → ensureMain → chat.start), then wait until the process is
# up. A user always types after that; sending into a session still spawning loses the
# message in these releases (the driver is attached after the first write).
chat_open() {
  trpc_call "$1" mutation task.update "{id:'$2',terminalMode:'claude-chat'}" >/dev/null
  trpc_call "$1" mutation taskTerminals.ensureMain "{taskId:'$2',mode:'claude-chat'}" >/dev/null
  trpc_call "$1" mutation chat.start "{tabId:'$2',taskId:'$2',mode:'claude-chat',cwd:'$3'}" >/dev/null
  sleep 5
}

# chat_results <db> <task id> — how many turns of this chat finished (result events).
chat_results() {
  sqlite3 "$1" "SELECT count(*) FROM chat_events WHERE tab_id='$2' AND json_extract(event,'\$.kind')='result'"
}

# chat_say <port> <db> <task id> <text> — send one message and wait for its turn to end.
chat_say() {
  before=$(chat_results "$2" "$3")
  trpc_call "$1" mutation chat.send "{tabId:'$3',text:$(node -p "JSON.stringify(process.argv[1])" "$4")}" >/dev/null
  i=0
  while [ $i -lt 120 ]; do
    [ "$(chat_results "$2" "$3")" -gt "$before" ] && { echo "chat turn done: $3 ($4)"; return 0; }
    i=$((i + 1)); sleep 1
  done
  echo "TIMEOUT: no result for chat turn on $3" >&2; return 1
}
