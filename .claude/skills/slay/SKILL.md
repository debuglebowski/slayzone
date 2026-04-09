---
name: slay
description: "Full CLI reference for the slay command — interact with tasks, terminals, browser, assets, and the SlayZone app"
trigger: auto
---

Use the `slay` CLI to interact with SlayZone. Your terminal has `$SLAYZONE_TASK_ID` set — every command that accepts `[id]` defaults to it, so you can omit the task ID entirely.

**Always pass `--dev`** to all `slay` commands (e.g. `slay --dev tasks view`) — this targets the development database.

<!-- Canonical CLI reference. The end-user template lives in
     packages/apps/cli/src/commands/init.ts (SKILL constant) — keep in sync. -->

## Global flags

- `--dev` — use development database (`slayzone.dev.sqlite`)

## Environment variables

| Variable | Description |
|----------|-------------|
| `SLAYZONE_TASK_ID` | Current task ID (set by PTY manager) |
| `SLAYZONE_MCP_PORT` | MCP server port |
| `SLAYZONE_MCP_HOST` | MCP server host (localhost) |
| `SLAYZONE_DEV` | `1` when `--dev` flag is used |
| `SLAYZONE_DB_PATH` | Full database path override |
| `SLAYZONE_DB_DIR` | Database directory override |

## Commands

### Task lifecycle

CRUD operations on the current task. Most commands default to `$SLAYZONE_TASK_ID`.

- `slay tasks view [id]` — show task title, status, priority, project, due date, tags, and description
- `slay tasks update [id] [--title <title>] [--description <text>] [--append-description <text>] [--status <status>] [--priority <1-5>] [--due <date>] [--no-due]` — update task fields. `--append-description` adds text without replacing existing content
- `slay tasks done [id]` — move task to the project's done status
- `slay tasks create <title> --project <name> [--description <text>] [--status <status>] [--priority <1-5>] [--due <date>] [--template <name|id>] [--external-id <id>] [--external-provider <provider>]` — create task in a project, optionally from a template. `--external-id` enables idempotent creation

### Subtasks

Break a task into trackable sub-items. Subtasks appear nested under the parent on the kanban board.

- `slay tasks subtasks [id] [--json]` — list subtasks of the current task
- `slay tasks subtask-add [parentId] <title> [--description <text>] [--status <status>] [--priority <1-5>] [--external-id <id>] [--external-provider <provider>]` — add a subtask to the current or specified parent task

### Task management

Query, search, and organize tasks across projects.

- `slay tasks list [--project <name>] [--status <status>] [--done] [--limit <n>] [--json]` — list tasks with optional filtering by project or status. `--done` includes completed tasks
- `slay tasks search <query> [--project <name>] [--limit <n>] [--json]` — full-text search across task titles and descriptions
- `slay tasks open [id]` — open task in the desktop app via `slayzone://` URL scheme
- `slay tasks archive <id>` — hide from kanban without deleting — task stays in DB for queries
- `slay tasks delete <id>` — permanently delete task from the database

### Tags

Categorize tasks with colored labels. Per-task operations under `tasks tag`, project-wide management under `tags`.

- `slay tasks tag [id] [--json]` — show tags on the current task
- `slay tasks tag [id] --set <name1> [name2...]` — replace all tags with the given set
- `slay tasks tag [id] --add <name>` — add a tag
- `slay tasks tag [id] --remove <name>` — remove a tag
- `slay tasks tag [id] --clear` — remove all tags
- `slay tags list --project <name> [--json]` — list all tags in a project
- `slay tags create <name> --project <name> [--color <hex>] [--text-color <hex>]` — create a project tag with optional custom colors
- `slay tags delete <id>` — delete a tag from the project

### Templates

Reusable task defaults — status, priority, terminal mode, and provider config. One template per project can be marked as the default, applied to all new tasks.

- `slay templates list --project <name> [--json]` — list templates in a project
- `slay templates view <id> [--json]` — view template details and provider configuration
- `slay templates create <name> --project <name> [--terminal-mode <mode>] [--priority <1-5>] [--status <s>] [--default] [--description <text>]` — create a template with optional defaults
- `slay templates update <id> [--name <n>] [--terminal-mode <m>] [--priority <1-5>] [--status <s>] [--default] [--no-default] [--description <text>]` — update template properties
- `slay templates delete <id>` — delete a template

### Browser panel

Control the embedded browser in a task's workspace. Useful for web testing, scraping page content, and capturing screenshots. `--panel` selects which browser panel instance when multiple exist.

- `slay tasks browser navigate <url> [--panel <state>]` — navigate to a URL in the task's browser panel
- `slay tasks browser url [--panel <state>]` — get the current URL
- `slay tasks browser screenshot [-o <path>] [--panel <state>]` — capture a screenshot to file
- `slay tasks browser content [--json] [--panel <state>]` — extract page text and interactive elements (links, buttons, inputs) with CSS selectors
- `slay tasks browser click <selector> [--panel <state>]` — click an element by CSS selector
- `slay tasks browser type <selector> <text> [--panel <state>]` — type text into an input field
- `slay tasks browser eval <code> [--panel <state>]` — execute JavaScript in the browser context and return the result

### Assets

File-like storage attached to tasks — text, images, or any file, organized into folders. Content is piped via stdin for `create`, `write`, and `append`. Reference assets in task descriptions with `[title](asset:<id>)`.

- `slay tasks assets list <taskId> [--json] [--tree]` — list assets, optionally as a folder tree
- `slay tasks assets read <assetId>` — output asset content to stdout
- `slay tasks assets create <title> [--task <id>] [--copy-from <path>] [--render-mode <mode>] [--folder <id>] [--json]` — create asset from stdin or `--copy-from` a local file
- `slay tasks assets upload <sourcePath> [--task <id>] [--title <name>] [--json]` — upload a local file as an asset (auto-detects render mode)
- `slay tasks assets update <assetId> [--title <name>] [--render-mode <mode>] [--json]` — update asset title or render mode
- `slay tasks assets write <assetId>` — replace asset content from stdin
- `slay tasks assets append <assetId>` — append to asset content from stdin
- `slay tasks assets delete <assetId>` — delete an asset
- `slay tasks assets path <assetId>` — print the asset's file system path
- `slay tasks assets mkdir <name> [--task <id>] [--parent <id>] [--json]` — create a folder, optionally nested under a parent
- `slay tasks assets rmdir <folderId> [--json]` — delete a folder (contained assets move to root)
- `slay tasks assets mvdir <folderId> --parent <id|"root"> [--json]` — move a folder under another parent or to root
- `slay tasks assets mv <assetId> --folder <id|"root"> [--json]` — move an asset into a folder or to root

### Projects

Organizational containers for tasks. Each project maps to a directory on disk and has its own kanban board, statuses, and tags.

- `slay projects list [--json]` — list all projects with task counts
- `slay projects create <name> [--path <path>] [--color <hex>] [--json]` — create a project linked to an optional directory
- `slay projects update <name|id> [--name <n>] [--color <hex>] [--path <path>] [--json]` — update project name, color, or path

### Automations

Automatic actions triggered by task events or cron schedules. Actions execute shell commands in the app's process manager.

- `slay automations list --project <name> [--json]` — list automations with run counts
- `slay automations view <id> [--json]` — view trigger, conditions, and action configuration
- `slay automations create <name> --project <name> --trigger <type> [--action-command <cmd>] [--trigger-from-status <s>] [--trigger-to-status <s>] [--cron <expr>] [--description <text>] [--config <file>]` — create an automation with a trigger type and shell command action
- `slay automations update <id> [--name <n>] [--description <text>] [--enabled] [--disabled] [--trigger <type>] [--action-command <cmd>] [--trigger-from-status <s>] [--trigger-to-status <s>] [--cron <expr>]` — update automation configuration
- `slay automations delete <id>` — delete an automation
- `slay automations toggle <id>` — toggle enabled/disabled state
- `slay automations run <id>` — manually trigger an automation (requires app running)
- `slay automations runs <id> [--limit <n>] [--json]` — view execution history with status and duration

### Processes

Monitor and control long-running background processes managed by the app (dev servers, watchers, build tools).

- `slay processes list [--json]` — list active processes with status, label, and command
- `slay processes logs <id> [-n <lines>]` — print last N lines of process output
- `slay processes kill <id>` — terminate a running process
- `slay processes follow <id>` — stream process logs via SSE — stays open until process exits or ctrl+c

### PTY sessions

Interact with terminal sessions in task workspaces. Key for AI agent orchestration — `submit` and `wait` enable programmatic control of AI CLI tools.

- `slay pty list [--json]` — list active PTY sessions with mode, state, and age
- `slay pty buffer <id>` — dump the full terminal buffer contents
- `slay pty follow <id> [--full]` — stream live PTY output. `--full` replays the buffer first
- `slay pty write <id> <data>` — send raw data to PTY stdin (low-level, prefer `submit`)
- `slay pty submit <id> [text] [--wait] [--no-wait] [--timeout <ms>]` — submit text to PTY with smart newline handling. Auto-waits for attention state on AI modes. Reads stdin if no text arg
- `slay pty wait <id> [--state <state>] [--timeout <ms>] [--json]` — block until PTY reaches a state (default: attention, timeout: 60s). Essential for AI agent loops
- `slay pty kill <id>` — terminate a PTY session

### Web panels

Custom web panels embedded in the task view sidebar. Each panel loads a URL and can be toggled via keyboard shortcut.

- `slay panels list [--json]` — list all configured web panels
- `slay panels create <name> <url> [-s <letter>] [--block-handoff] [--protocol <protocol>]` — register a web panel with URL and optional shortcut key
- `slay panels delete <id-or-name>` — remove a web panel
- `slay panels enable <id-or-name>` — show panel in task view
- `slay panels disable <id-or-name>` — hide panel from task view

## Notes

- All ID arguments support prefix matching (e.g. `a1b2` matches `a1b2c3d4-...`).
- Commands accepting `[id]` default to `$SLAYZONE_TASK_ID`.
- Automation trigger types: `task_status_change`, `task_created`, `task_archived`, `task_tag_changed`, `cron`, `manual`.
- `--external-id` on `create`/`subtask-add` enables idempotent creation — if a task with the same `(project, external_provider, external_id)` exists, the command returns the existing task instead of creating a duplicate.
- `slay pty submit` auto-waits for `attention` state on AI modes and encodes newlines via Kitty protocol.
- Asset content via stdin for `create` (without `--copy-from`), `write`, and `append`.
- Reference assets in task descriptions: `[title](asset:<asset-id>)`.
