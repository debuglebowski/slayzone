#!/bin/sh
# v0.38.0 (schema v194), desktop hub + local computer + build-box (computers/c2) on the
# same hub. Task worktrees and base dirs — what v197/v210/v211/v212 move off the hub:
#   Webapp (default: local computer), Infra (default: build-box)
#   - worktrees auto-created by the release itself on BOTH computers (custom global
#     base path `worktree_base_path`), one bound to build-box in a local-default project
#   - a subtask that inherits its parent's worktree (twice: local and build-box parent)
#   - base dirs alone and together with a worktree
#   - a done task and an ARCHIVED task still holding a worktree
#   - worktrees later cleared: to NULL (unlink) and to '' (the API accepts it)
# v0.38 has no project-level base dir: the base path template is a global setting.
# Ground truth (which computer holds each task's folders) goes to /tmp/facts.json.
set -e
. /gen/lib.sh
H=/home/persona
DB=$H/.slayzone/stable/hub/slayzone.data.sqlite
start_app
wait_http http://127.0.0.1:51100/health
wait_connected 51100 local-computer
for r in webapp infra; do git_repo $H/repos/$r; done
mkdir -p $H/repos/webapp/packages/api $H/repos/infra/modules
start_computer $H/computers/c2 build-box 51100 $H/repos
trpc_call 51100 mutation settings.set "{key:'terminal_agent_startup',value:'manual'}" >/dev/null
# A custom worktree base (global at v0.38): <repos>/wt/<project folder>/<branch>.
trpc_call 51100 mutation settings.set "{key:'worktree_base_path',value:'../wt/{project-folder-name}'}" >/dev/null

LOCAL=$(computer_id 51100 local-computer)
BB=$(computer_id 51100 build-box)
tid() { sqlite3 "$DB" "SELECT id FROM tasks WHERE title='$1'"; }
path_of() { sqlite3 "$DB" "SELECT coalesce(worktree_path,'∅') || ' | ' || coalesce(base_dir,'∅') FROM tasks WHERE id='$1'"; }
# link <task> <repo> <branch> — a worktree made by hand on the shared disk, linked the
# way the app's Worktree panel does it (task.update with the parent branch).
link() {
  wt=$H/repos/wt/$2/$3
  [ -d "$wt" ] || git -C $H/repos/$2 worktree add -q -b "$3" "$wt"
  trpc_call 51100 mutation task.update "{id:'$1',worktreePath:'$wt',worktreeParentBranch:'main'}" >/dev/null
}

P1=$(slay projects create Webapp --path $H/repos/webapp --color "#10b981" --json | json_id)
P2=$(slay projects create Infra --path $H/repos/infra --computer build-box --color "#f59e0b" --json | json_id)
# Webapp's folder on build-box too (tasks pinned there run there).
trpc_call 51100 mutation workspace.setProjectPath "{computerId:'$BB',projectId:'$P1',path:'$H/repos/webapp'}" >/dev/null

# ---- before auto-create: hand-linked worktrees and base dirs
slay tasks create "Pinned to build-box" --project Webapp >/dev/null
C=$(tid "Pinned to build-box")
trpc 51100 computers.setTaskComputer "{taskId:'$C',computerId:'$BB'}"
link "$C" webapp pinned-to-build-box
# The app's subtask create (tRPC task.create + parentId) inherits the parent's paths;
# the CLI's REST route does not, so the journey uses the app's.
subtask() { trpc_call 51100 mutation task.create "{projectId:'$1',title:'$2',parentId:'$3'}" >/dev/null; }
subtask "$P1" "Pinned child" "$C"
CS=$(tid "Pinned child")

slay tasks create "Api base dir" --project Webapp >/dev/null
E=$(tid "Api base dir")
trpc_call 51100 mutation task.update "{id:'$E',baseDir:'$H/repos/webapp/packages/api'}" >/dev/null

slay tasks create "Cleared to empty" --project Webapp >/dev/null
I=$(tid "Cleared to empty")
link "$I" webapp cleared-to-empty
trpc_call 51100 mutation task.update "{id:'$I',baseDir:'$H/repos/webapp/packages'}" >/dev/null
trpc_call 51100 mutation task.update "{id:'$I',worktreePath:'',baseDir:''}" >/dev/null

# ---- auto-create on task create, per project
trpc_call 51100 mutation projects.update "{id:'$P1',autoCreateWorktreeOnTaskCreate:true}" >/dev/null
trpc_call 51100 mutation projects.update "{id:'$P2',autoCreateWorktreeOnTaskCreate:true}" >/dev/null

slay tasks create "Local feature" --project Webapp >/dev/null
A=$(tid "Local feature")
subtask "$P1" "Local feature tests" "$A"
AS=$(tid "Local feature tests")

slay tasks create "Remote infra change" --project Infra >/dev/null
B=$(tid "Remote infra change")

slay tasks create "Infra module work" --project Infra >/dev/null
F=$(tid "Infra module work")
trpc_call 51100 mutation task.update "{id:'$F',baseDir:'$H/repos/infra/modules'}" >/dev/null

slay tasks create "Ship infra" --project Infra >/dev/null
G=$(tid "Ship infra")
slay tasks done "$G" >/dev/null

slay tasks create "Old webapp spike" --project Webapp >/dev/null
K=$(tid "Old webapp spike")
KWT=$(sqlite3 "$DB" "SELECT worktree_path FROM tasks WHERE id='$K'")
slay tasks archive "$K" >/dev/null
# v0.38 archive clears the paths; the user re-links the spike's worktree to the
# archived task (to keep it findable) — the task stays archived.
[ -d "$KWT" ] || git -C $H/repos/webapp worktree add -q "$KWT" old-webapp-spike
trpc_call 51100 mutation task.update "{id:'$K',worktreePath:'$KWT',worktreeParentBranch:'main'}" >/dev/null

slay tasks create "Abandoned worktree" --project Webapp >/dev/null
J=$(tid "Abandoned worktree")
trpc_call 51100 mutation task.update "{id:'$J',worktreePath:null,worktreeParentBranch:null}" >/dev/null

for t in $C $CS $E $I $A $AS $B $F $G $K $J; do echo "$(sqlite3 "$DB" "SELECT title FROM tasks WHERE id='$t'"): $(path_of "$t")"; done
# Every expected path must be there (a silently skipped auto-create would make the
# persona meaningless).
for t in $C $CS $A $AS $B $F $G $K; do
  [ -n "$(sqlite3 "$DB" "SELECT worktree_path FROM tasks WHERE id='$t' AND worktree_path <> ''")" ] || { echo "no worktree on $t" >&2; exit 1; }
done
sqlite3 "$DB" "SELECT archived_at IS NOT NULL FROM tasks WHERE id='$K'" | grep -qx 1 || { echo "spike not archived" >&2; exit 1; }

# Which computer holds each task's folders: where the release made (or the user linked)
# them. A subtask's inherited worktree is its parent's folder, on the parent's computer.
cat > /tmp/facts.json <<J
{
  "taskPathHolders": {
    "$C": "build-box", "$CS": "build-box",
    "$E": "local-computer",
    "$A": "local-computer", "$AS": "local-computer",
    "$B": "build-box", "$F": "build-box", "$G": "build-box",
    "$K": "local-computer"
  },
  "taskPathsCleared": ["$I", "$J"],
  "expect": {
    "$K": { "refused": "paused or deleted", "why": "archived: its agent starts only after a restore" }
  }
}
J
sleep 3
echo JOURNEY OK
