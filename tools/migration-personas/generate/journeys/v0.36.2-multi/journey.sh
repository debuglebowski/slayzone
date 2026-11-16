#!/bin/sh
# v0.36.2, two hubs and four computers, all on loopback in one container:
#   hub1 = the desktop app's own hub (:51100) + its local computer ("local-computer")
#   hub2 = a standalone "team-hub" (:51110), registered in the app via client.boot.json
#   build-box  -> hub1 (computers/c2)  and  -> hub2 (computers/c2b)
#   gpu-box    -> hub2 (computers/c3)
# v0.36.2's computer cannot serve two hubs from one process (its config loader drops
# `hubUrls`), so build-box on both hubs is two processes with the same name — what a
# user of that release had to do.
# Bindings: Webapp defaults to build-box, one Webapp task is pinned to local-computer;
# ML defaults to gpu-box, one ML task is pinned to build-box. Bindings go through the
# hub's tRPC API (the CLI has no flag for them).
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
git_repo $H/repos/infra
git_repo $H/repos/ml
start_computer $H/computers/c2 build-box 51100 $H/repos
start_computer $H/computers/c2b build-box 51110 $H/repos
start_computer $H/computers/c3 gpu-box 51110 $H/repos

# hub1 — the desktop app's hub
P1=$(slay projects create Webapp --path $H/repos/webapp --color "#10b981" --json | json_id)
slay projects create Infra --path $H/repos/infra --color "#f59e0b" --json >/dev/null
slay tags create bug --project Webapp --color "#ef4444"
slay templates create Bugfix --project Webapp --priority 2 --default
T1=$(slay tasks create "Fix login redirect" --project Webapp --priority 1 --description "bounce" | created)
slay tasks create "Dark mode" --project Webapp --status in_progress
slay tasks create "Rotate certs" --project Infra
slay tasks subtask-add "Regression test" --parent "$T1"
slay tasks tag "$T1" --add bug
printf 'notes\n' | slay tasks artifacts create notes.md --task "$T1"
trpc 51100 computers.setProjectDefaultComputer "{projectId:'$P1',computerId:'$(computer_id 51100 build-box)'}"
trpc 51100 computers.setTaskComputer "{taskId:'$(task_id Webapp "$T1")',computerId:'$(computer_id 51100 local-computer)'}"

# hub2 — the standalone team hub
export SLAYZONE_HUB_ADDRESS=127.0.0.1:51110
P3=$(slay projects create ML --path $H/repos/ml --color "#8b5cf6" --json | json_id)
slay tasks create "Train baseline" --project ML --priority 2
T5=$(slay tasks create "Eval harness" --project ML | created)
trpc 51110 computers.setProjectDefaultComputer "{projectId:'$P3',computerId:'$(computer_id 51110 gpu-box)'}"
trpc 51110 computers.setTaskComputer "{taskId:'$(task_id ML "$T5")',computerId:'$(computer_id 51110 build-box)'}"
unset SLAYZONE_HUB_ADDRESS
echo JOURNEY OK
