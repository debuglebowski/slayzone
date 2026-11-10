#!/bin/sh
# v0.35.0, one machine: the desktop app only (v0.35 had no hubs or computers).
# A user with one project, tags, a default template, tasks in several states, a subtask,
# a tagged task, an artifact, an automation and a web panel.
# v0.35 CLI: `tasks create` has no --json (parse "Created: <prefix>"); it posts to the
# app's REST API, so the app must be up.
set -e
. /gen/lib.sh
start_app
wait_log /tmp/app.log "[MCP] Server listening"

cd /home/persona
git_repo repos/webapp
P=$(slay projects create Webapp --path repos/webapp --color "#10b981" --json | json_id)
slay tags create bug --project "$P" --color "#ef4444"
slay tags create feature --project "$P" --color "#3b82f6"
slay templates create Bugfix --project "$P" --priority 2 --default --description "bug template"
T1=$(slay tasks create "Fix login redirect" --project "$P" --priority 1 --due 2026-07-01 --description "Users bounce to /" | created)
slay tasks create "Add dark mode" --project "$P" --status in_progress --priority 3
slay tasks create "Write onboarding docs" --project "$P" --priority 4
slay tasks subtask-add "Write regression test" --parent "$T1"
slay tasks tag "$T1" --add bug
printf '# Notes\nRepro: log in, refresh.\n' | slay tasks artifacts create notes.md --task "$T1"
slay automations create "Echo on done" --project "$P" --trigger task_status_change --trigger-to-status done --action-command "echo done"
slay panels create Docs https://example.com -s d
slay tasks done "$T1"
echo JOURNEY OK
