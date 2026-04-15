---
name: slay-tasks
description: "Manage tasks, subtasks, tags, and templates via the slay CLI"
trigger: auto
---

Task commands are the core of the slay CLI. Most commands accept an optional `[id]` argument that defaults to `$SLAYZONE_TASK_ID`, which is automatically set in every task terminal. Commands that require a project (`--project`) default to `$SLAYZONE_PROJECT_ID` (also set automatically). All ID arguments support prefix matching — e.g. `a1b2` matches a full UUID starting with `a1b2`.

## Task lifecycle

- `slay tasks list [--project <name|id>] [--status <status>] [--done] [--limit <n>] [--json]`
  List tasks. `--status` filters by status key (resolved via the project's custom column config). `--done` shows completed tasks across all projects using each project's column config to determine what "done" means — this overrides `--status` if both are given. Default limit is 100.

- `slay tasks create <title> [--project <name|id>] [--description <text>] [--status <status>] [--priority <1-5>] [--due <date>] [--template <name|id>] [--external-id <id>] [--external-provider <provider>]`
  Create a task. `--project` defaults to `$SLAYZONE_PROJECT_ID`. If `--template` is omitted, the project's default template is auto-applied (if one exists). Templates set the terminal mode, initial status, priority, and provider config. `--external-id` enables idempotent creation: if a task with the same `(project, provider, external_id)` already exists, it prints "Exists" and exits cleanly — useful for sync scripts. Reference assets in descriptions via `[title](asset:<asset-id>)`.

- `slay tasks view [id]` — show task details including status, priority, description, tags, and subtasks.

- `slay tasks update [id] [--title <title>] [--description <text>] [--append-description <text>] [--status <status>] [--priority <1-5>] [--due <date>] [--no-due]`
  Update a task. `--append-description` adds text after a newline separator (mutually exclusive with `--description`). `--no-due` clears the due date.

- `slay tasks done [id]` — mark task complete using the project's configured "done" status.

- `slay tasks archive <id>` — hide from kanban but keep in database. Use for tasks you don't need visible but want to preserve.

- `slay tasks delete <id>` — permanently remove the task and all its data.

- `slay tasks open [id]` — focus the task in the SlayZone app window.

- `slay tasks search <query> [--project <name|id>] [--limit <n>] [--json]`
  Case-insensitive substring search across title and description. Includes subtasks in results. Results ordered by most recently updated. Default limit is 50.

## Subtasks

- `slay tasks subtasks [id] [--json]` — list subtasks of a task.

- `slay tasks subtask-add [parentId] <title> [--description <text>] [--status <status>] [--priority <1-5>] [--external-id <id>] [--external-provider <provider>]`
  Add a subtask. Parent defaults to `$SLAYZONE_TASK_ID`. The subtask inherits the parent's terminal mode. `--external-id` deduplication works the same as task creation.

## Task tags

Tags are project-scoped — a tag name must exist in the project before it can be applied to a task.

- `slay tasks tag [taskId] [--json]` — show current tags on a task.
- `slay tasks tag [taskId] --set <name1> [name2...]` — replace all tags with the given names.
- `slay tasks tag [taskId] --add <name>` — add a tag. Idempotent — no error if already present.
- `slay tasks tag [taskId] --remove <name>` — remove a tag by name.
- `slay tasks tag [taskId] --clear` — remove all tags from the task.

## Project tags

- `slay tags list [--project <name|id>] [--json]` — list all tags in a project. `--project` defaults to `$SLAYZONE_PROJECT_ID`.
- `slay tags create <name> [--project <name|id>] [--color <hex>] [--text-color <hex>]` — create a new tag. `--project` defaults to `$SLAYZONE_PROJECT_ID`. Color defaults to #6366f1, text color to #ffffff.
- `slay tags delete <id>` — delete a tag.

## Templates

Templates define defaults for new tasks: terminal mode, status, priority, provider config, panel visibility, browser tabs, and CCS profile.

- `slay templates list [--project <name|id>] [--json]` — list templates. `--project` defaults to `$SLAYZONE_PROJECT_ID`. Shows which one is the project default.
- `slay templates view <id> [--json]` — view template details including all configured defaults.
- `slay templates create <name> [--project <name|id>] [--terminal-mode <mode>] [--priority <1-5>] [--status <status>] [--default] [--description <text>]`
  Create a template. `--project` defaults to `$SLAYZONE_PROJECT_ID`. `--default` makes it the project default, clearing any existing default (transactional).
- `slay templates update <id> [--name <n>] [--terminal-mode <m>] [--priority <1-5>] [--status <s>] [--default] [--no-default] [--description <text>]`
  Update a template. `--default` clears all other defaults. `--no-default` unsets only this template's default flag.
- `slay templates delete <id>` — delete a template.
