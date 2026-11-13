#!/bin/sh
# v0.40.0 (schema v217), a full-featured user — the release every current user upgrades from:
#   hub1 = desktop app hub (:51100) + local computer
#   hub2 = standalone "team-hub" (:51110), registered in the app
#   build-box (computers/c2): ONE process on both hubs (v0.38 `hubUrls`)
#   gpu-box   (computers/c3): hub2 only
# Projects with folders on several computers, bindings, tags/template/subtask/artifact,
# and Claude chat history on every computer (chat state lives on the computers since v0.38).
# The desktop computer does not join hub2: that needs a hub sign-in at v0.38.
set -e
. /gen/lib.sh
H=/home/persona
mkdir -p $H/.slayzone/stable/client
cat > $H/.slayzone/stable/client/client.boot.json <<'J'
{"server_mode":"local","multi_hub":true,"hubs":[{"id":"hub:ws://127.0.0.1:51110/trpc","kind":"remote","label":"Team Hub","url":"ws://127.0.0.1:51110/trpc"}],"default_hub_id":"local"}
J
start_hub $H/hubs/hub2 127.0.0.1:51110 team-hub
wait_http http://127.0.0.1:51110/health
start_app
wait_http http://127.0.0.1:51100/health
wait_connected 51100 local-computer
for r in webapp infra ml; do git_repo $H/repos/$r; done
start_computer_two_hubs $H/computers/c2 build-box 51100 51110 $H/repos
start_computer $H/computers/c3 gpu-box 51110 $H/repos
trpc_call 51100 mutation settings.set "{key:'terminal_agent_startup',value:'manual'}" >/dev/null
trpc_call 51110 mutation settings.set "{key:'terminal_agent_startup',value:'manual'}" >/dev/null

# chat <task id> <text> — the release's CLI drives the task's main agent and waits for the answer.
chat() { slay chat send "$2" --task "$1" --wait >/dev/null && echo "chat turn done: $1 ($2)"; }

# ---- hub1
BB1=$(computer_id 51100 build-box)
P1=$(slay projects create Webapp --path $H/repos/webapp --color "#10b981" --json | json_id)
P2=$(slay projects create Infra --path $H/repos/infra --computer build-box --color "#f59e0b" --json | json_id)
trpc_call 51100 mutation workspace.setProjectPath "{computerId:'$BB1',projectId:'$P1',path:'$H/repos/webapp'}" >/dev/null
slay tags create bug --project Webapp --color "#ef4444"
slay templates create Bugfix --project Webapp --priority 2 --default
T1=$(task_id Webapp "$(slay tasks create "Fix login redirect" --project Webapp --priority 1 --description "bounce" | created)")
T2=$(task_id Webapp "$(slay tasks create "Build on the big box" --project Webapp | created)")
T3=$(task_id Infra "$(slay tasks create "Rotate certs" --project Infra | created)")
slay tasks subtask-add "Regression test" --parent "$T1"
slay tasks tag "$T1" --add bug
printf 'notes\n' | slay tasks artifacts create notes.md --task "$T1"
trpc 51100 computers.setTaskComputer "{taskId:'$T2',computerId:'$BB1'}"
for t in $T1 $T2 $T3; do slay tasks update "$t" --agent claude-chat >/dev/null; done
chat "$T1" "Why does login redirect to / ?"
printf 'export const redirect = "/dashboard"\n' > $H/repos/webapp/redirect.ts
chat "$T1" "I changed redirect.ts — does that fix it?"
chat "$T2" "Build it on build-box please."
chat "$T3" "Which certs expire first?"
slay tasks done "$T3"

# ---- hub2
export SLAYZONE_HUB_ADDRESS=127.0.0.1:51110
GPU=$(computer_id 51110 gpu-box); BB2=$(computer_id 51110 build-box)
P3=$(slay projects create ML --path $H/repos/ml --computer gpu-box --color "#8b5cf6" --json | json_id)
trpc_call 51110 mutation workspace.setProjectPath "{computerId:'$BB2',projectId:'$P3',path:'$H/repos/ml'}" >/dev/null
T4=$(task_id ML "$(slay tasks create "Train baseline" --project ML --priority 2 | created)")
T5=$(task_id ML "$(slay tasks create "Eval harness" --project ML | created)")
trpc 51110 computers.setTaskComputer "{taskId:'$T5',computerId:'$BB2'}"
for t in $T4 $T5; do slay tasks update "$t" --agent claude-chat >/dev/null; done
chat "$T4" "Which learning rate should I start with?"
chat "$T4" "And for fine-tuning?"
chat "$T5" "Run the eval on build-box."
unset SLAYZONE_HUB_ADDRESS
sleep 3
echo JOURNEY OK
