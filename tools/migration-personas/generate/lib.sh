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
  echo "{\"computerName\":\"$2\",\"allowedRoots\":[\"$4\"]}" > "$1/computer.config.json"
  log="/tmp/computer-$(basename "$1").log"
  ( cd "$1" && ELECTRON_RUN_AS_NODE=1 NODE_PATH=$NP SLAYZONE_ROOT="$1" SLAYZONE_NONINTERACTIVE=1 \
      SLAYZONE_HUB_ADDRESS="127.0.0.1:$3" SLAYZONE_HUB_JOIN_TOKEN="$tok" setsid $E $R/computer/bin.cjs > "$log" 2>&1 & )
  wait_log "$log" "connected to hub"
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
