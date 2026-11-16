#!/bin/sh
# v0.38.0, desktop hub + local computer. Data for the two LAZY migrations:
# - v201 (per-tab session scope): a task whose agent sessions span the main chat tab AND
#   a second chat tab of the same mode — exactly what v201 stages for recovery.
# - v209 (usage cursors to the computer): the user opened Usage once, so the hub parsed
#   the agents' session logs and kept its read offsets (usage_parse_state).
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
T1=$(task_id Webapp "$(slay tasks create "Two chat tabs" --project Webapp --priority 1 | created)")
T2=$(task_id Webapp "$(slay tasks create "One chat tab" --project Webapp | created)")
slay tasks update "$T1" --agent claude-chat >/dev/null
slay tasks update "$T2" --agent claude-chat >/dev/null
slay chat send "Main tab: plan the refactor." --task "$T1" --wait >/dev/null && echo "chat turn done: $T1 main"
TAB2=$(trpc_call 51100 mutation taskTerminals.create "{taskId:'$T1',mode:'claude-chat',label:'Deploy'}" | json_id)
trpc_call 51100 mutation chat.start "{tabId:'$TAB2',taskId:'$T1',mode:'claude-chat',cwd:'$H/repos/webapp'}" >/dev/null
sleep 5
slay chat send "Second tab: write the deploy script." --task "$T1" --tab "$TAB2" --wait >/dev/null && echo "chat turn done: $T1 tab $TAB2"
slay chat send "Main tab again: status?" --task "$T1" --wait >/dev/null && echo "chat turn done: $T1 main again"
slay chat send "Summarize the README." --task "$T2" --wait >/dev/null && echo "chat turn done: $T2"
# The user opens Usage once.
trpc_call 51100 mutation usageAnalytics.refresh "'all'" >/dev/null
sleep 3
echo "agent_sessions for T1: $(sqlite3 "$DB" "SELECT count(*) FROM agent_sessions WHERE task_id='$T1'")"
echo "non-main chat tabs:   $(sqlite3 "$DB" "SELECT count(*) FROM terminal_tabs WHERE task_id='$T1' AND is_main=0")"
echo "usage_parse_state:    $(sqlite3 "$DB" "SELECT count(*) FROM usage_parse_state")"
echo JOURNEY OK
