#!/bin/sh
# v0.37.2 (schema v193), a full-featured user who skipped v0.38.0 and jumps v193 -> today:
#   hub1 = desktop app hub (:51100) + local computer
#   hub2 = standalone "team-hub" (:51110), registered in the app
#   build-box (computers/c2): ONE process on both hubs (`hubUrls`, already in v0.37)
#   gpu-box   (computers/c3): hub2 only
# Projects with folders on several computers, bindings, tags/template/subtask/artifact,
# Claude AND Codex chat history on every computer (computer-held chats, as at v0.38).
# Same journey as v0.38.0-full (v0.37.2's CLI/API cover all of it: `slay chat send
# --wait`, `projects create --computer`, `workspace.setProjectPath`,
# `computers.setTaskComputer`), plus Codex chats: a two-turn one and a done one on the
# local computer, one on build-box via hub2 and one on gpu-box.
# The desktop computer does not join hub2: that needs a hub sign-in at v0.37.
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

# chat <task id> <text> — v0.37 CLI drives the task's main agent and waits for the answer.
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
X1=$(task_id Webapp "$(slay tasks create "Codex: tidy the router" --project Webapp | created)")
X2=$(task_id Webapp "$(slay tasks create "Codex: write the changelog" --project Webapp | created)")
slay tasks subtask-add "Regression test" --parent "$T1"
slay tasks tag "$T1" --add bug
printf 'notes\n' | slay tasks artifacts create notes.md --task "$T1"
trpc 51100 computers.setTaskComputer "{taskId:'$T2',computerId:'$BB1'}"
for t in $T1 $T2 $T3; do slay tasks update "$t" --agent claude-chat >/dev/null; done
for t in $X1 $X2; do slay tasks update "$t" --agent codex-chat >/dev/null; done
chat "$T1" "Why does login redirect to / ?"
printf 'export const redirect = "/dashboard"\n' > $H/repos/webapp/redirect.ts
chat "$T1" "I changed redirect.ts — does that fix it?"
chat "$T2" "Build it on build-box please."
chat "$T3" "Which certs expire first?"
slay tasks done "$T3"
chat "$X1" "Which routes are unused?"
chat "$X1" "Remove them."
chat "$X2" "Write the changelog for 1.2."
slay tasks done "$X2"

# ---- hub2
export SLAYZONE_HUB_ADDRESS=127.0.0.1:51110
GPU=$(computer_id 51110 gpu-box); BB2=$(computer_id 51110 build-box)
P3=$(slay projects create ML --path $H/repos/ml --computer gpu-box --color "#8b5cf6" --json | json_id)
trpc_call 51110 mutation workspace.setProjectPath "{computerId:'$BB2',projectId:'$P3',path:'$H/repos/ml'}" >/dev/null
T4=$(task_id ML "$(slay tasks create "Train baseline" --project ML --priority 2 | created)")
T5=$(task_id ML "$(slay tasks create "Eval harness" --project ML | created)")
X3=$(task_id ML "$(slay tasks create "Codex: profile the dataloader" --project ML | created)")
X4=$(task_id ML "$(slay tasks create "Codex: port eval to build-box" --project ML | created)")
trpc 51110 computers.setTaskComputer "{taskId:'$T5',computerId:'$BB2'}"
trpc 51110 computers.setTaskComputer "{taskId:'$X4',computerId:'$BB2'}"
for t in $T4 $T5; do slay tasks update "$t" --agent claude-chat >/dev/null; done
for t in $X3 $X4; do slay tasks update "$t" --agent codex-chat >/dev/null; done
chat "$T4" "Which learning rate should I start with?"
chat "$T4" "And for fine-tuning?"
chat "$T5" "Run the eval on build-box."
chat "$X3" "Why is the dataloader slow?"
chat "$X4" "Port the eval script."
unset SLAYZONE_HUB_ADDRESS
sleep 3
echo JOURNEY OK
