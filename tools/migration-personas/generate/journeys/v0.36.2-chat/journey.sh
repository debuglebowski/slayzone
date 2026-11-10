#!/bin/sh
# v0.36.2, Claude chat history on two hubs:
#   hub1 = the desktop app's hub (:51100) + local computer: two chats in Webapp
#   hub2 = standalone "team-hub" (:51110) + gpu-box: one chat in ML, run on gpu-box
# Chat state at this release lives in the hubs' DBs; today's code moves it to the
# computers (v200–v211) — the riskiest data move. `claude` is the scripted fake.
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
git_repo $H/repos/webapp
git_repo $H/repos/ml
start_computer $H/computers/c3 gpu-box 51110 $H/repos
# No warm-pool interactive `claude` (the fake only speaks the chat protocol).
trpc_call 51100 mutation settings.set "{key:'terminal_agent_startup',value:'manual'}" >/dev/null
trpc_call 51110 mutation settings.set "{key:'terminal_agent_startup',value:'manual'}" >/dev/null
# The desktop's local computer must be connected before a chat can spawn.
until [ -n "$(computer_id 51100 local-computer 2>/dev/null)" ]; do sleep 2; done

DB1=$H/.slayzone/stable/hub/slayzone.data.sqlite
slay projects create Webapp --path $H/repos/webapp --color "#10b981"
C1=$(task_id Webapp "$(slay tasks create "Chat: fix login redirect" --project Webapp --priority 1 | created)")
C2=$(task_id Webapp "$(slay tasks create "Chat: explain the router" --project Webapp | created)")
chat_open 51100 "$C1" $H/repos/webapp
chat_say 51100 "$DB1" "$C1" "Why does login redirect to / ?"
printf 'export const redirect = "/dashboard"\n' > $H/repos/webapp/redirect.ts
chat_say 51100 "$DB1" "$C1" "I changed redirect.ts — does that fix it?"
chat_open 51100 "$C2" $H/repos/webapp
chat_say 51100 "$DB1" "$C2" "Explain the router in two sentences."
slay tasks done "$C2"

DB2=$H/hubs/hub2/slayzone.data.sqlite
export SLAYZONE_HUB_ADDRESS=127.0.0.1:51110
P3=$(slay projects create ML --path $H/repos/ml --color "#8b5cf6" --json | json_id)
trpc 51110 computers.setProjectDefaultComputer "{projectId:'$P3',computerId:'$(computer_id 51110 gpu-box)'}"
C3=$(task_id ML "$(slay tasks create "Chat: tune the learning rate" --project ML | created)")
chat_open 51110 "$C3" $H/repos/ml
chat_say 51110 "$DB2" "$C3" "Which learning rate should I start with?"
chat_say 51110 "$DB2" "$C3" "And for fine-tuning?"
unset SLAYZONE_HUB_ADDRESS
sleep 3   # chat_events writes are fire-and-forget
echo JOURNEY OK
