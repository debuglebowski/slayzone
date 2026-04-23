---
name: slay-tasks
description: "Manage tasks, subtasks, tags, and templates via the slay CLI"
trigger: auto
---

Task commands are the core of the slay CLI. Most commands accept an optional `[id]` argument that defaults to `$SLAYZONE_TASK_ID`, which is automatically set in every task terminal. Commands that require a project (`--project`) default to `$SLAYZONE_PROJECT_ID` (also set automatically). All ID arguments support prefix matching — e.g. `a1b2` matches a full UUID starting with `a1b2`.

## Task lifecycle

- `slay tasks list [--project <name|id>] [--status <status>] [--done] [--limit <n>] [--json]` — list tasks.
  - `--status` filters by status key (resolved via the project's custom column config)
  - `--done` shows completed tasks across all projects using each project's column config; overrides `--status` if both given
  - Default limit: 100

- `slay tasks create <title> [--project <name|id>] [--description <text>] [--status <status>] [--priority <1-5>] [--due <date>] [--template <name|id>] [--external-id <id>] [--external-provider <provider>]` — create a task.
  - `--project` defaults to `$SLAYZONE_PROJECT_ID`
  - If `--template` is omitted, the project's default template auto-applies (if one exists). Templates set terminal mode, initial status, priority, and provider config
  - `--external-id` enables idempotent creation: if a task with the same `(project, provider, external_id)` exists, prints "Exists" and exits cleanly — useful for sync scripts
  - Reference assets in descriptions via `[title](asset:<asset-id>)`

- `slay tasks view [id]` — show task details including status, priority, description, tags, and subtasks.

- `slay tasks update [id] [--title <title>] [--description <text>] [--append-description <text>] [--status <status>] [--priority <1-5>] [--due <date>] [--no-due] [--parent <id>] [--no-parent] [--permanent]` — update a task.
  - `--append-description` adds text after a newline separator (mutually exclusive with `--description`)
  - `--no-due` clears the due date
  - `--parent <id>` reparents under another task in the same project; `--no-parent` makes it top-level
  - `--permanent` converts a temporary task to a real task

- `slay tasks progress <idOrValue> [value]` — set task progress (integer 0-100).
  - Two-arg form: `slay tasks progress <id> <value>`
  - One-arg form: `slay tasks progress <value>` — id defaults to `$SLAYZONE_TASK_ID`

- `slay tasks done [id] [--close]` — mark task complete using the project's configured "done" status.
  - `--close` also closes the task tab in the app

- `slay tasks archive <id>` — hide from kanban but keep in database.
  - Use for tasks you don't need visible but want to preserve

- `slay tasks delete <id>` — permanently remove the task and all its data.

- `slay tasks open [id]` — focus the task in the SlayZone app window.

- `slay tasks search <query> [--project <name|id>] [--limit <n>] [--json]` — case-insensitive substring search across title and description.
  - Includes subtasks in results
  - Results ordered by most recently updated
  - Default limit: 50

## Subtasks

- `slay tasks subtasks [id] [--json]` — list subtasks of a task.

- `slay tasks subtask-add <title> [--parent <id>] [--description <text>] [--status <status>] [--priority <1-5>] [--external-id <id>] [--external-provider <provider>]` — add a subtask.
  - `--parent` defaults to `$SLAYZONE_TASK_ID`
  - Subtask inherits the parent's terminal mode
  - `--external-id` deduplication works the same as task creation

## Blocking

Two independent blocking mechanisms: dependency-based blockers (task A blocks task B) and a standalone `is_blocked` flag with optional comment.

- `slay tasks blockers [id] [--add <ids...>] [--remove <ids...>] [--set <ids...>] [--clear] [--json]` — view or modify dependency blockers — tasks that must be done before this one.
  - Without write flags, lists current blockers
  - A task cannot block itself

- `slay tasks blocking [id] [--json]` — list tasks that this task is blocking.

- `slay tasks blocked [id] [--on] [--off] [--toggle] [--comment <text>] [--no-comment] [--json]` — view or modify the `is_blocked` flag.
  - `--on` / `--off` / `--toggle` set state
  - `--comment <text>` sets blocked with a note (implies `--on`)
  - `--no-comment` clears only the comment

## Task tags

Tags are project-scoped — a tag name must exist in the project before it can be applied to a task.

- `slay tasks tag [taskId] [--json]` — show current tags on a task.
- `slay tasks tag [taskId] --set <name1> [name2...]` — replace all tags with the given names.
- `slay tasks tag [taskId] --add <name>` — add a tag.
  - Idempotent — no error if already present
- `slay tasks tag [taskId] --remove <name>` — remove a tag by name.
- `slay tasks tag [taskId] --clear` — remove all tags from the task.

## Project tags

- `slay tags list [--project <name|id>] [--json]` — list all tags in a project.
  - `--project` defaults to `$SLAYZONE_PROJECT_ID`

- `slay tags create <name> [--project <name|id>] [--color <hex>] [--text-color <hex>]` — create a new tag.
  - `--project` defaults to `$SLAYZONE_PROJECT_ID`
  - Color defaults to #6366f1, text color to #ffffff

- `slay tags delete <id>` — delete a tag.

## Templates

Templates define defaults for new tasks: terminal mode, status, priority, provider config, panel visibility, browser tabs, and CCS profile.

- `slay templates list [--project <name|id>] [--json]` — list templates.
  - `--project` defaults to `$SLAYZONE_PROJECT_ID`
  - Shows which one is the project default

- `slay templates view <id> [--json]` — view template details including all configured defaults.

- `slay templates create <name> [--project <name|id>] [--terminal-mode <mode>] [--priority <1-5>] [--status <status>] [--default] [--description <text>]` — create a template.
  - `--project` defaults to `$SLAYZONE_PROJECT_ID`
  - `--default` makes it the project default, clearing any existing default (transactional)

- `slay templates update <id> [--name <n>] [--terminal-mode <m>] [--priority <1-5>] [--status <s>] [--default] [--no-default] [--description <text>]` — update a template.
  - `--default` clears all other defaults
  - `--no-default` unsets only this template's default flag

- `slay templates delete <id>` — delete a template.
