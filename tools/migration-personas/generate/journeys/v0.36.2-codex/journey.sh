#!/bin/sh
# v0.36.2, desktop hub + local computer, Codex chat history (hub-held at this release):
# a two-turn Codex chat, a one-turn Codex chat that is then done, and a Claude chat in
# the same project — a user mixing agents. `codex` / `claude` are the scripted fakes.
set -e
. /gen/lib.sh
H=/home/persona
start_app
wait_http http://127.0.0.1:51100/health
wait_connected 51100 local-computer
trpc_call 51100 mutation settings.set "{key:'terminal_agent_startup',value:'manual'}" >/dev/null
DB=$H/.slayzone/stable/hub/slayzone.data.sqlite
git_repo $H/repos/webapp
slay projects create Webapp --path $H/repos/webapp --color "#10b981"
X1=$(task_id Webapp "$(slay tasks create "Codex: fix login redirect" --project Webapp --priority 1 | created)")
X2=$(task_id Webapp "$(slay tasks create "Codex: write the changelog" --project Webapp | created)")
C1=$(task_id Webapp "$(slay tasks create "Claude: review the router" --project Webapp | created)")
chat_open 51100 "$X1" $H/repos/webapp codex-chat
chat_say 51100 "$DB" "$X1" "Why does login redirect to / ?"
printf 'export const redirect = "/dashboard"\n' > $H/repos/webapp/redirect.ts
chat_say 51100 "$DB" "$X1" "I changed redirect.ts — does that fix it?"
chat_open 51100 "$X2" $H/repos/webapp codex-chat
chat_say 51100 "$DB" "$X2" "Write the changelog for 1.2."
slay tasks done "$X2"
chat_open 51100 "$C1" $H/repos/webapp
chat_say 51100 "$DB" "$C1" "Review the router."
sleep 3
echo JOURNEY OK
