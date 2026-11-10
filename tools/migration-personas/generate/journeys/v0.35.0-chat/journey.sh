#!/bin/sh
# v0.35.0, one machine, Claude chat history: two chat tasks in a git repo — one with
# two turns and a file change between them (agent turn snapshots), one with one turn
# that is then marked done. `claude` is the scripted fake (generate/fake-claude).
set -e
. /gen/lib.sh
start_app
wait_log /tmp/app.log "[MCP] Server listening"
DB=/home/persona/.local/state/slayzone/slayzone.sqlite
PORT=$(sqlite3 "$DB" "SELECT value FROM settings WHERE key='trpc_server_port'")
[ -n "$PORT" ] || PORT=$(sed -n 's#.*WS server listening on ws://127.0.0.1:\([0-9]*\)/trpc.*#\1#p' /tmp/app.log | tail -1)
echo "tRPC port $PORT"

cd /home/persona
git_repo repos/webapp
slay projects create Webapp --path /home/persona/repos/webapp --color "#10b981"
C1=$(task_id Webapp "$(slay tasks create "Chat: fix login redirect" --project Webapp --priority 1 | created)")
C2=$(task_id Webapp "$(slay tasks create "Chat: explain the router" --project Webapp | created)")

chat_open "$PORT" "$C1" /home/persona/repos/webapp
chat_say "$PORT" "$DB" "$C1" "Why does login redirect to / ?"
printf 'export const redirect = "/dashboard"\n' > repos/webapp/redirect.ts
chat_say "$PORT" "$DB" "$C1" "I changed redirect.ts — does that fix it?"

chat_open "$PORT" "$C2" /home/persona/repos/webapp
chat_say "$PORT" "$DB" "$C2" "Explain the router in two sentences."
slay tasks done "$C2"
sleep 3   # chat_events writes are fire-and-forget
echo JOURNEY OK
