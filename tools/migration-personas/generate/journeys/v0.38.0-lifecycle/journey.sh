#!/bin/sh
# v0.38.0 (schema v194), a desktop user whose computers came and went, with Trash and a
# backup — data for v194 (disabled computer), v200 (computer retirements) and v198/v199
# (artifact blob pins, Trash removed):
#   hub1 = desktop app hub (:51100) + local computer
#   idle-box   (computers/c2): project + task bound, a chat on it, then DISABLED (v0.38
#                              `computers.setDisabled`); still enrolled and running
#   ci-box     (computers/c3): project + task bound, a chat on it, then RE-ENROLLED: its
#                              credential lost, a fresh join token → a NEW computer id (v0.38
#                              gives a remote re-enroll a fresh uuid); the old row stays,
#                              offline, with the work and chat that name it
#   old-laptop (computers/c4): project + task bound, chats on it, then stopped and DELETED
#                              (v0.38 `computers.delete`: bindings NULLed; its chat
#                              bookkeeping still names the gone id) and the machine wiped
# Artifacts on a live task, a trashed task, a trashed-then-restored task and an archived
# task; a manual backup; then an artifact deleted after that backup (its blob is held
# only by the backup's 'hub-backup' pin).
set -e
. /gen/lib.sh
H=/home/persona
start_app
wait_http http://127.0.0.1:51100/health
wait_connected 51100 local-computer
for r in app ops lab old; do git_repo $H/repos/$r; done
start_computer $H/computers/c2 idle-box 51100 $H/repos
start_computer $H/computers/c3 ci-box 51100 $H/repos
start_computer $H/computers/c4 old-laptop 51100 $H/repos
trpc_call 51100 mutation settings.set "{key:'terminal_agent_startup',value:'manual'}" >/dev/null

# chat <task id> <text> — v0.38 CLI drives the task's main agent and waits for the answer.
chat() { slay chat send "$2" --task "$1" --wait >/dev/null && echo "chat turn done: $1 ($2)"; }
# restart_computer <root> — stop it and start it again on its stored credential (no token).
restart_computer() {
  stop_root "$1"
  ( cd "$1" && ELECTRON_RUN_AS_NODE=1 NODE_PATH=$NP SLAYZONE_ROOT="$1" SLAYZONE_NONINTERACTIVE=1 \
      SLAYZONE_HUB_ADDRESS=127.0.0.1:51100 setsid $E $R/computer/bin.cjs >> "/tmp/computer-$(basename "$1").log" 2>&1 & )
}
# artifact <task id> <title> <text> — a new artifact; prints its id.
artifact() { printf '%s\n' "$3" | slay tasks artifacts create "$2" --task "$1" --json | json_id; }

IDLE=$(computer_id 51100 idle-box)
CI=$(computer_id 51100 ci-box)
OLD=$(computer_id 51100 old-laptop)

P1=$(slay projects create App --path $H/repos/app --color "#10b981" --json | json_id)
slay projects create Ops --path $H/repos/ops --computer idle-box --color "#f59e0b" --json >/dev/null
slay projects create Lab --path $H/repos/lab --computer ci-box --color "#8b5cf6" --json >/dev/null
slay projects create Old --path $H/repos/old --computer old-laptop --color "#ef4444" --json >/dev/null
# App also has a folder on old-laptop (a placement the delete removes).
trpc_call 51100 mutation workspace.setProjectPath "{computerId:'$OLD',projectId:'$P1',path:'$H/repos/app'}" >/dev/null

TOPS=$(task_id Ops "$(slay tasks create "Patch ops box" --project Ops | created)")
TLAB=$(task_id Lab "$(slay tasks create "Fix CI flake" --project Lab | created)")
TOLD=$(task_id App "$(slay tasks create "Laptop-only job" --project App | created)")
TOLD2=$(task_id Old "$(slay tasks create "Old laptop notes" --project Old | created)")
trpc 51100 computers.setTaskComputer "{taskId:'$TOPS',computerId:'$IDLE'}"
trpc 51100 computers.setTaskComputer "{taskId:'$TLAB',computerId:'$CI'}"
trpc 51100 computers.setTaskComputer "{taskId:'$TOLD',computerId:'$OLD'}"
for t in $TOPS $TLAB $TOLD $TOLD2; do slay tasks update "$t" --agent claude-chat >/dev/null; done
chat "$TOPS" "Patch the ops box please."
chat "$TLAB" "Why is CI flaky?"
chat "$TOLD" "Run this on the laptop."
chat "$TOLD2" "What is still on the old laptop?"

# ---- artifacts, Trash, archive, backup
TLIVE=$(task_id App "$(slay tasks create "Live notes" --project App | created)")
TTRASH=$(task_id App "$(slay tasks create "Trashed spec" --project App | created)")
TBACK=$(task_id App "$(slay tasks create "Restored draft" --project App | created)")
TARCH=$(task_id App "$(slay tasks create "Archived report" --project App | created)")
artifact "$TLIVE" keep.md "kept artifact" >/dev/null
GONE=$(artifact "$TLIVE" gone.md "artifact deleted after the backup")
artifact "$TTRASH" spec.md "spec of a trashed task" >/dev/null
artifact "$TBACK" draft.md "draft of a task restored from Trash" >/dev/null
artifact "$TARCH" report.md "report of an archived task" >/dev/null
slay tasks delete "$TTRASH"
slay tasks delete "$TBACK"
trpc 51100 task.restore "{id:'$TBACK'}"
slay tasks archive "$TARCH"
trpc_call 51100 mutation app.backup.create "{name:'before cleanup'}" >/dev/null
slay tasks artifacts delete "$GONE"
artifact "$TLIVE" after.md "artifact made after the backup" >/dev/null

# ---- idle-box: disabled. Restarted first so no agent runs on it (v0.38 refuses to disable
# a computer with running terminals/agents).
restart_computer $H/computers/c2
sleep 5
wait_connected 51100 idle-box
trpc 51100 computers.setDisabled "{computerId:'$IDLE',disabled:true}"

# ---- ci-box: re-enrolled. Its credential is lost (reinstalled config, same machine and chat
# data); a fresh join token enrolls it again under a NEW id. New work goes to the new id.
# (No chat on it: v0.38 refuses one there, "Chat tab has another active owner".)
stop_root $H/computers/c3
rm -f $H/computers/c3/computer.state.json
start_computer $H/computers/c3 ci-box 51100 $H/repos
CI2=$(computer_id 51100 ci-box)
[ "$CI2" != "$CI" ] || { echo "ci-box kept its id $CI — not a re-enroll" >&2; exit 1; }
TLAB2=$(task_id Lab "$(slay tasks create "CI after reinstall" --project Lab | created)")
trpc 51100 computers.setTaskComputer "{taskId:'$TLAB2',computerId:'$CI2'}"

# ---- old-laptop: deleted, machine wiped.
stop_root $H/computers/c4
trpc 51100 computers.delete "{computerId:'$OLD'}"
rm -rf $H/computers/c4

# Ground truth for continuing each tab after the upgrade (a main tab's id is its task's).
REMOVED="Its computer was removed"
cat > /tmp/facts.json <<J
{"lifecycle":{"disabled":"$IDLE","reEnrolledOld":"$CI","reEnrolledNew":"$CI2","deleted":"$OLD",
"trashedTask":"$TTRASH","restoredTask":"$TBACK","archivedTask":"$TARCH","liveTask":"$TLIVE","deletedArtifact":"$GONE",
"escapeHatch":{"tab":"$TLAB","computer":"ci-box","availability":"ready"}},
"expect":{
"$TOPS":{"refused":"is disabled, so it takes no new work","availability":"ready","why":"its computer idle-box is disabled; history stays readable"},
"$TLAB":{"refused":"is not connected","availability":"offline","why":"ran on ci-box's old id: that row stays, offline (v0.38 re-enroll links no successor)"},
"$TOLD":{"refused":"$REMOVED","availability":"unavailable","why":"its computer old-laptop was deleted"},
"$TOLD2":{"refused":"$REMOVED","availability":"unavailable","why":"its computer old-laptop was deleted"},
"$TTRASH":{"refused":"paused or deleted","why":"trashed at v0.38: archived since Trash was removed (v198)"},
"$TARCH":{"refused":"paused or deleted","why":"archived"}}}
J
sleep 3
echo JOURNEY OK
