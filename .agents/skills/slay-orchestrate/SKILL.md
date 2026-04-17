---
name: slay-orchestrate
description: "Supervise a set of slay tasks through planning, execution, and verification"
trigger: manual
depends_on:
  - slay-tasks
  - slay-pty
  - slay-assets
---

Orchestrate any set of slay tasks toward completion. The user tells you *which* tasks to supervise (free-form: ids, tags, a project, a filter, or a description like "all refactor tasks in backlog"); you dispatch each to its own PTY, review plans, keep agents unblocked, and drive them to done. Works equally well for top-level tasks and subtasks — the skill does not care.

**Never commit.** Your job ends at `slay tasks done`.

## 1. Resolve the target set

1. Parse the user's free-form selector.
2. Resolve to concrete task IDs via `slay --dev tasks list --json` (filter client-side as needed), `slay --dev tasks search`, or `slay --dev tasks subtasks <parent>`.
3. If **zero** tasks match, stop and tell the user no tasks were found for that selector. Do not guess or expand scope.
4. List matched tasks (id + title) back to the user as confirmation, then proceed.

## 2. Create the progress log asset

Create an asset on the orchestrator's own task (`$SLAYZONE_TASK_ID`) named `orchestration-log.md`. Use a markdown table:

```markdown
# Orchestration log

| time | task | event | note |
|------|------|-------|------|
```

Create once:
```bash
printf '# Orchestration log\n\n| time | task | event | note |\n|------|------|-------|------|\n' | slay --dev tasks assets create "orchestration-log.md"
```

Append rows throughout the run:
```bash
printf '| %s | %s | %s | %s |\n' "$(date -u +%FT%TZ)" "<taskId>" "<event>" "<note>" | slay --dev tasks assets append <assetId>
```

Event vocabulary: `started`, `plan-ready`, `plan-refined`, `plan-approved`, `question`, `stuck`, `done`, `error`.

## 3. Dispatch

**Default: parallel.** Override to serial if the user says so (e.g. "one at a time", "serial") or if tasks obviously depend on each other.

Per task:
```bash
slay --dev tasks open <id>
slay --dev pty wait <id> --state attention
slay --dev pty submit <id> "Enter plan mode. Read the task with \`slay --dev tasks view\`. Design the most sustainable, robust long-term solution. Preserve all requested functionality — do not drop features to simplify."
slay --dev pty write <id> $'\r'
```

Log `started`.

Parallelize by backgrounding each dispatch block with `&` and `wait`.

## 4. Supervise

Poll `slay --dev pty list --json` on a short interval. Act on each task that enters `attention`:

1. Read buffer: `slay --dev pty buffer <id>`.
2. Classify what the agent is waiting on and respond per the table below.
3. Append a log row.

| Situation | Response |
|-----------|----------|
| Plan-mode exit prompt (agent presenting plan) | Review plan vs task description. Check: sustainable long-term? preserves all requested functionality? no scope creep? If yes → send `1` (Yes, and use auto mode). If no → send `4` + specific feedback, wait for re-plan, review again. Loop until plan meets the bar. |
| Edit approval prompt during execution | Send `2` (Yes, allow all edits during this session) — plan was already vetted. |
| Ultraplan trap ("◆ ultraplan ready" or "Run ultraplan in the cloud?") | Recovery: `pty write <id> $'\x1b[B'` → `$'\r'` → `"2"` → `$'\r'`, then `pty submit <id> "Execute the plan directly, no more planning"`. For the cloud prompt, just send `2` + enter. |
| Agent asks a user-directed question it cannot answer from the task description | Append `question` row to log with the verbatim question, **ping the user** in chat, and wait. Do not guess on the user's behalf. |
| Agent appears stuck (no progress for an extended period, repeated same buffer) | Append `stuck` row, ping user with the last buffer snippet. |
| Agent finished (completion message + no prompt) | Verify: read changed files directly, run typecheck/build if the task warrants it. Then `slay --dev tasks done <id>`. Log `done`. |

After every approval/feedback action, always follow `pty submit` with `slay --dev pty write <id> $'\r'` — submit does not reliably press enter.

## 5. Plan review bar

Reject a plan and send feedback (option 4) if any of these are true:

- Proposes a quick hack where a sustainable refactor is possible within scope.
- Drops, hides, or defers functionality that the task description requests.
- Introduces abstractions or features the task did not ask for.
- Skips verification (tests, typecheck, build) when the change warrants it.
- Assumes state without reading the code.

Feedback should be specific ("use shared helper X instead of inlining", "preserve the Y callback that task description requires"), not vague ("make it better").

## 6. Completion

When all target tasks are `done` (or blocked on user), append a final summary row to the log and report back to the user:

- count done / count blocked / count errored
- link to the log asset (`[log](asset:<id>)`)
- outstanding questions for the user, if any

**Do not commit. Do not open PRs. Do not mark the orchestrator task done** — the user does that.

## Parallel polling pattern

```bash
while :; do
  slay --dev pty list --json | jq -r '.[] | select(.task_id | IN($ids[])) | "\(.task_id) \(.state)"' --argjson ids '["id1","id2"]'
  sleep 5
done
```

Break when every tracked task reaches a terminal state (`done` or a user-blocking `attention` you already handled).
