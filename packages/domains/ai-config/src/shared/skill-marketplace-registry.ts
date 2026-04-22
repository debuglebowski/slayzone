export type SkillMarketplaceCategory =
  | 'cli'
  | 'configuration'
  | 'languages'
  | 'frameworks'
  | 'testing'
  | 'devops'
  | 'documentation'
  | 'workflow'
  | 'general'

export interface BuiltinSkillEntry {
  slug: string
  name: string
  description: string
  category: SkillMarketplaceCategory
  author: string
  content: string
}

export const BUILTIN_SKILLS: BuiltinSkillEntry[] = [
  // ── Orchestrator ──────────────────────────────────────────────

  {
    slug: 'slay',
    name: 'Slay',
    description: 'Full CLI reference for slay — orchestrates all slay domain skills',
    category: 'cli',
    author: 'SlayZone',

    content: `---
name: slay
description: "Full CLI reference for slay — orchestrates all slay domain skills"
trigger: auto
depends_on:
  - slay-context
  - slay-tasks
  - slay-browser
  - slay-assets
  - slay-automations
  - slay-projects
  - slay-processes
  - slay-pty
  - slay-panels
  - slay-auto-title
---

Use the \`slay\` CLI to interact with the SlayZone task management system. The current task ID is available via \`$SLAYZONE_TASK_ID\` and the current project via \`$SLAYZONE_PROJECT_ID\` (both set automatically in task terminals).

All ID arguments support prefix matching (e.g., \`a1b2\` matches the full UUID starting with \`a1b2\`).

## Domains

| Skill | Commands | Purpose |
|-------|----------|---------|
| slay-context | — | Ensure root instruction files include SlayZone context |
| slay-tasks | \`slay tasks\`, \`slay tags\`, \`slay templates\` | Task lifecycle, subtasks, tags, templates |
| slay-browser | \`slay tasks browser\` | Control the task browser panel |
| slay-assets | \`slay tasks assets\` | Manage files and folders attached to tasks |
| slay-automations | \`slay automations\` | Event-driven and cron automations |
| slay-projects | \`slay projects\` | Project CRUD |
| slay-processes | \`slay processes\` | Inspect and control running processes |
| slay-pty | \`slay pty\` | Interact with PTY terminal sessions |
| slay-panels | \`slay panels\` | Manage custom web panels |
| slay-auto-title | — | Auto-title tasks from conversation context |

## Other

- \`slay init instructions\` — print SlayZone agent configuration template
- \`slay init skills\` — install all built-in slay skills from the marketplace registry
- \`slay completions <shell>\` — generate shell completions (fish | zsh | bash)
`
  },

  // ── Context ────────────────────────────────────────────────────

  {
    slug: 'slay-context',
    name: 'Slay Context',
    description: 'Ensure root instruction files include SlayZone environment context',
    category: 'configuration',
    author: 'SlayZone',
    content: `---
name: slay-context
description: "Ensure root instruction files include SlayZone environment context"
trigger: auto
---

You are running inside **SlayZone** — a desktop task management app with integrated AI coding assistants (Claude Code, Codex, Gemini, Cursor, and more). Your terminal session, browser panel, and task metadata are all managed by the app. Use the \`slay\` CLI to interact with it (see the slay skill for full reference).

## Instruction file maintenance

When working in a project, check whether the project's root instruction files contain a **SlayZone Environment** section. The files to check depend on which ones already exist — never create a file that doesn't exist yet.

| File | Used by |
|------|---------|
| \`CLAUDE.md\` | Claude Code |
| \`AGENTS.md\` | Codex, Cursor, Gemini, Copilot |
| \`OPENCODE.md\` | OpenCode |
| \`QWEN.md\` | Qwen Code |

For each file that exists and does **not** already contain a "SlayZone Environment" section, add the following section (adapt the heading level to match the file's existing style):

\`\`\`markdown
## SlayZone Environment

You are running inside a SlayZone task terminal — a desktop task management app with integrated AI coding assistants. Your terminal session, browser panel, and task metadata are all managed by the app.

Use the \\\`slay\\\` CLI to read and update your task, manage subtasks, control the browser panel, and more. The current task ID is available via \\\`$SLAYZONE_TASK_ID\\\` and the current project via \\\`$SLAYZONE_PROJECT_ID\\\` (both set automatically in task terminals).
\`\`\`

**Rules:**
- Only modify files that already exist on disk
- If the section already exists (check for "SlayZone Environment" heading), leave it unchanged
- Place the section near the top of the file, after any title or introduction
`
  },

  // ── Domain skills ─────────────────────────────────────────────

  {
    slug: 'slay-tasks',
    name: 'Slay Tasks',
    description: 'Manage tasks, subtasks, tags, and templates via the slay CLI',
    category: 'cli',
    author: 'SlayZone',

    content: `---
name: slay-tasks
description: "Manage tasks, subtasks, tags, and templates via the slay CLI"
trigger: auto
---

Task commands are the core of the slay CLI. Most commands accept an optional \`[id]\` argument that defaults to \`$SLAYZONE_TASK_ID\`, which is automatically set in every task terminal. Commands that require a project (\`--project\`) default to \`$SLAYZONE_PROJECT_ID\` (also set automatically). All ID arguments support prefix matching — e.g. \`a1b2\` matches a full UUID starting with \`a1b2\`.

## Task lifecycle

- \`slay tasks list [--project <name|id>] [--status <status>] [--done] [--limit <n>] [--json]\` — list tasks.
  - \`--status\` filters by status key (resolved via the project's custom column config)
  - \`--done\` shows completed tasks across all projects using each project's column config; overrides \`--status\` if both given
  - Default limit: 100

- \`slay tasks create <title> [--project <name|id>] [--description <text>] [--status <status>] [--priority <1-5>] [--due <date>] [--template <name|id>] [--external-id <id>] [--external-provider <provider>]\` — create a task.
  - \`--project\` defaults to \`$SLAYZONE_PROJECT_ID\`
  - If \`--template\` is omitted, the project's default template auto-applies (if one exists). Templates set terminal mode, initial status, priority, and provider config
  - \`--external-id\` enables idempotent creation: if a task with the same \`(project, provider, external_id)\` exists, prints "Exists" and exits cleanly — useful for sync scripts
  - Reference assets in descriptions via \`[title](asset:<asset-id>)\`

- \`slay tasks view [id]\` — show task details including status, priority, description, tags, and subtasks.

- \`slay tasks update [id] [--title <title>] [--description <text>] [--append-description <text>] [--status <status>] [--priority <1-5>] [--due <date>] [--no-due] [--parent <id>] [--no-parent] [--permanent]\` — update a task.
  - \`--append-description\` adds text after a newline separator (mutually exclusive with \`--description\`)
  - \`--no-due\` clears the due date
  - \`--parent <id>\` reparents under another task in the same project; \`--no-parent\` makes it top-level
  - \`--permanent\` converts a temporary task to a real task

- \`slay tasks progress <idOrValue> [value]\` — set task progress (integer 0-100).
  - Two-arg form: \`slay tasks progress <id> <value>\`
  - One-arg form: \`slay tasks progress <value>\` — id defaults to \`$SLAYZONE_TASK_ID\`

- \`slay tasks done [id] [--close]\` — mark task complete using the project's configured "done" status.
  - \`--close\` also closes the task tab in the app

- \`slay tasks archive <id>\` — hide from kanban but keep in database.
  - Use for tasks you don't need visible but want to preserve

- \`slay tasks delete <id>\` — permanently remove the task and all its data.

- \`slay tasks open [id]\` — focus the task in the SlayZone app window.

- \`slay tasks search <query> [--project <name|id>] [--limit <n>] [--json]\` — case-insensitive substring search across title and description.
  - Includes subtasks in results
  - Results ordered by most recently updated
  - Default limit: 50

## Subtasks

- \`slay tasks subtasks [id] [--json]\` — list subtasks of a task.

- \`slay tasks subtask-add <title> [--parent <id>] [--description <text>] [--status <status>] [--priority <1-5>] [--external-id <id>] [--external-provider <provider>]\` — add a subtask.
  - \`--parent\` defaults to \`$SLAYZONE_TASK_ID\`
  - Subtask inherits the parent's terminal mode
  - \`--external-id\` deduplication works the same as task creation

## Blocking

Two independent blocking mechanisms: dependency-based blockers (task A blocks task B) and a standalone \`is_blocked\` flag with optional comment.

- \`slay tasks blockers [id] [--add <ids...>] [--remove <ids...>] [--set <ids...>] [--clear] [--json]\` — view or modify dependency blockers — tasks that must be done before this one.
  - Without write flags, lists current blockers
  - A task cannot block itself

- \`slay tasks blocking [id] [--json]\` — list tasks that this task is blocking.

- \`slay tasks blocked [id] [--on] [--off] [--toggle] [--comment <text>] [--no-comment] [--json]\` — view or modify the \`is_blocked\` flag.
  - \`--on\` / \`--off\` / \`--toggle\` set state
  - \`--comment <text>\` sets blocked with a note (implies \`--on\`)
  - \`--no-comment\` clears only the comment

## Task tags

Tags are project-scoped — a tag name must exist in the project before it can be applied to a task.

- \`slay tasks tag [taskId] [--json]\` — show current tags on a task.
- \`slay tasks tag [taskId] --set <name1> [name2...]\` — replace all tags with the given names.
- \`slay tasks tag [taskId] --add <name>\` — add a tag.
  - Idempotent — no error if already present
- \`slay tasks tag [taskId] --remove <name>\` — remove a tag by name.
- \`slay tasks tag [taskId] --clear\` — remove all tags from the task.

## Project tags

- \`slay tags list [--project <name|id>] [--json]\` — list all tags in a project.
  - \`--project\` defaults to \`$SLAYZONE_PROJECT_ID\`

- \`slay tags create <name> [--project <name|id>] [--color <hex>] [--text-color <hex>]\` — create a new tag.
  - \`--project\` defaults to \`$SLAYZONE_PROJECT_ID\`
  - Color defaults to #6366f1, text color to #ffffff

- \`slay tags delete <id>\` — delete a tag.

## Templates

Templates define defaults for new tasks: terminal mode, status, priority, provider config, panel visibility, browser tabs, and CCS profile.

- \`slay templates list [--project <name|id>] [--json]\` — list templates.
  - \`--project\` defaults to \`$SLAYZONE_PROJECT_ID\`
  - Shows which one is the project default

- \`slay templates view <id> [--json]\` — view template details including all configured defaults.

- \`slay templates create <name> [--project <name|id>] [--terminal-mode <mode>] [--priority <1-5>] [--status <status>] [--default] [--description <text>]\` — create a template.
  - \`--project\` defaults to \`$SLAYZONE_PROJECT_ID\`
  - \`--default\` makes it the project default, clearing any existing default (transactional)

- \`slay templates update <id> [--name <n>] [--terminal-mode <m>] [--priority <1-5>] [--status <s>] [--default] [--no-default] [--description <text>]\` — update a template.
  - \`--default\` clears all other defaults
  - \`--no-default\` unsets only this template's default flag

- \`slay templates delete <id>\` — delete a template.
`
  },

  {
    slug: 'slay-browser',
    name: 'Slay Browser',
    description: 'Control the task browser panel via the slay CLI',
    category: 'cli',
    author: 'SlayZone',

    content: `---
name: slay-browser
description: "Control the task browser panel via the slay CLI"
trigger: auto
---

Browser commands control the browser panel embedded in each task's detail view. All commands require \`$SLAYZONE_TASK_ID\` to be set (automatic in task terminals).

Every command accepts \`--panel <state>\` (visible | hidden). \`navigate\` defaults to \`visible\` (auto-opens the panel), all other commands default to \`hidden\` (operate without showing the panel).

## Commands

- \`slay tasks browser navigate <url> [--panel <state>]\` — navigate to a URL.
  - The only command that auto-shows the browser panel
  - Use to open pages for verification, testing, or reference

- \`slay tasks browser url [--panel <state>]\` — print the current URL.
  - Useful for checking where the browser is after navigation or redirects

- \`slay tasks browser screenshot [-o <path>] [--panel <state>]\` — capture a screenshot.
  - Returns the file path of the saved image
  - \`-o\` copies the screenshot to a specific path; without it, prints the temp file path

- \`slay tasks browser content [--json] [--panel <state>]\` — get the page's text content and interactive elements as JSON.
  - Text content truncated to 10k characters
  - Interactive elements include links, buttons, and inputs
  - Useful for understanding page structure before clicking or typing

- \`slay tasks browser click <selector> [--panel <state>]\` — click an element by CSS selector.
  - Returns the tag name and text of the clicked element

- \`slay tasks browser type <selector> <text> [--panel <state>]\` — type text into an input element by CSS selector.

- \`slay tasks browser eval <code> [--panel <state>]\` — execute JavaScript in the browser context and print the result.
  - Strings are printed as-is
  - Other values are pretty-printed as JSON

## Workflow tips

A typical browser verification flow:
1. \`navigate\` to the URL
2. \`content\` to inspect the page and find selectors
3. \`click\` or \`type\` to interact
4. \`screenshot\` to capture the result
`
  },

  {
    slug: 'slay-assets',
    name: 'Slay Assets',
    description: 'Manage task assets (files, folders) via the slay CLI',
    category: 'cli',
    author: 'SlayZone',

    content: `---
name: slay-assets
description: "Manage task assets (files, folders) via the slay CLI"
trigger: auto
---

Assets are files attached to tasks, stored on disk at \`{data-dir}/assets/{taskId}/{assetId}.ext\`. They can be text files, images, or any binary content. Use assets to attach specifications, screenshots, logs, or any reference material to a task.

The \`--task\` flag defaults to \`$SLAYZONE_TASK_ID\` for \`create\`, \`upload\`, and \`mkdir\`. Note: \`list\` requires an explicit task ID argument.

## Files

- \`slay tasks assets list <taskId> [--json] [--tree]\` — list all assets for a task.
  - \`--tree\` shows an indented folder structure

- \`slay tasks assets read <assetId>\` — output asset content to stdout.
  - Binary assets (images, etc.) are written as raw buffers
  - Text assets as UTF-8

- \`slay tasks assets create <title> [--task <id>] [--folder <id>] [--copy-from <path>] [--render-mode <mode>] [--json]\` — create a new asset.
  - Content is read from stdin (must be piped — errors on TTY), or from a file via \`--copy-from\`
  - Render mode is inferred from the title's file extension if not specified (defaults to plain text if no extension)
  - Reference created assets in task descriptions via \`[title](asset:<asset-id>)\`

- \`slay tasks assets upload <sourcePath> [--task <id>] [--title <name>] [--json]\` — upload a file from disk as an asset.
  - Title defaults to the filename

- \`slay tasks assets update <assetId> [--title <name>] [--render-mode <mode>] [--json]\` — update asset metadata.
  - If the title changes and the file extension differs, the file is renamed on disk

- \`slay tasks assets write <assetId> [--mutate-version [ref]]\` — replace the asset's content entirely from stdin (pipe required).
  - Default: creates a new version
  - \`--mutate-version\` (bare): autosave to current version (auto-branches if locked)
  - \`--mutate-version <ref>\`: bypass lock and mutate the target version in place

- \`slay tasks assets append <assetId> [--mutate-version [ref]]\` — append to the asset's content from stdin (pipe required).
  - Versioning behavior same as \`write\`

- \`slay tasks assets delete <assetId>\` — delete an asset and its file.

- \`slay tasks assets path <assetId>\` — print the asset's absolute file path on disk.

## Folders

Assets can be organized into folders. Folder operations support cycle detection — you can't move a folder into its own child.

- \`slay tasks assets mkdir <name> [--task <id>] [--parent <id>] [--json]\` — create a folder, optionally nested under a parent.
- \`slay tasks assets rmdir <folderId> [--json]\` — delete a folder.
  - Contained assets are moved to root, not deleted
- \`slay tasks assets mvdir <folderId> --parent <id|"root"> [--json]\` — move a folder to a new parent.
  - Use \`"root"\` to move to top level
- \`slay tasks assets mv <assetId> --folder <id|"root"> [--json]\` — move an asset into a folder.
  - Use \`"root"\` for top level

## Versions

Every asset has immutable, content-addressed version history. Writes via \`write\`/\`append\`/\`create\` or the app UI create new versions automatically. Versions can be referenced by: integer (\`5\`), hash prefix (\`a1b2\`), name (\`milestone-1\`), relative (\`-1\`, \`-2\`), or \`HEAD~N\`.

- \`slay tasks assets versions list <assetId> [--limit <n>] [--offset <n>] [--json]\` — list version history, newest first.
  - Default limit: 50

- \`slay tasks assets versions read <assetId> <version>\` — print content of a specific version to stdout.

- \`slay tasks assets versions diff <assetId> <a> [b] [--no-color] [--json]\` — diff two versions.
  - \`b\` defaults to latest
  - Colorized output in TTY

- \`slay tasks assets versions current <assetId> [--json]\` — print the current (HEAD) version.

- \`slay tasks assets versions set-current <assetId> <version> [--json]\` — set the current (HEAD) version.
  - Flushes bytes to disk
  - Next UI save branches if the target is locked

- \`slay tasks assets versions create <assetId> [--name <name>] [--json]\` — create a version from the working copy (no-op if content unchanged).

- \`slay tasks assets versions rename <assetId> <version> [newName] [--clear] [--json]\` — set, change, or clear a version's name.
  - Use \`--clear\` or omit \`newName\` to clear
  - Named versions are protected from \`prune\`

- \`slay tasks assets versions prune <assetId> [--keep-last <n>] [--no-keep-named] [--no-keep-current] [--dry-run] [--json]\` — remove old versions.
  - Named and current versions protected by default

## Download / Export

Download assets in various formats. Default type is \`raw\` (original file).

- \`slay tasks assets download <assetId> [--type raw|pdf|png|html] [--output <path>] [--json]\` — download a single asset.
- \`slay tasks assets download --type zip [--task <id>] [--output <path>] [--json]\` — download all task assets as a ZIP archive (no assetId needed).

**Available types by render mode:**
| Type | Available for |
|------|--------------|
| raw  | all files |
| pdf  | markdown, code, html, svg, mermaid |
| png  | svg, mermaid |
| html | markdown, code, mermaid |
| zip  | all (task-level) |

\`pdf\`, \`png\`, and \`html\` exports require the SlayZone app to be running. \`--output\` defaults to the current directory with an auto-generated filename.

## Piping examples

\`\`\`bash
echo "Meeting notes from standup" | slay tasks assets create "standup-notes.md"
cat report.csv | slay tasks assets write <assetId>
curl -s https://example.com/data.json | slay tasks assets append <assetId>
\`\`\`
`
  },

  {
    slug: 'slay-automations',
    name: 'Slay Automations',
    description: 'Create and manage automations via the slay CLI',
    category: 'cli',
    author: 'SlayZone',

    content: `---
name: slay-automations
description: "Create and manage automations via the slay CLI"
trigger: auto
---

Automations are project-scoped, event-driven actions. They fire shell commands in response to task events or on a cron schedule.

## Trigger types

| Type | Fires when | Extra flags |
|------|-----------|-------------|
| \`task_status_change\` | Task status changes | \`--trigger-from-status\`, \`--trigger-to-status\` (both optional, filter transitions) |
| \`task_created\` | New task created | — |
| \`task_archived\` | Task archived | — |
| \`task_tag_changed\` | Tags modified on a task | — |
| \`cron\` | On schedule | \`--cron <expression>\` (required) |
| \`manual\` | Only via \`slay automations run\` | — |

## Commands

- \`slay automations list --project <name|id> [--json]\` — list automations for a project.
  - Shows enabled state, trigger type, run count, and last run time

- \`slay automations view <id> [--json]\` — view full automation details including trigger config, conditions, and actions.

- \`slay automations create <name> --project <name|id> --trigger <type> [--action-command <cmd>] [--trigger-from-status <status>] [--trigger-to-status <status>] [--cron <expression>] [--description <text>] [--config <file>]\` — create an automation.
  - For simple automations, use \`--action-command\` to specify a shell command
  - For complex setups with multiple actions or conditions, use \`--config <file>\` with JSON \`{ trigger_config, conditions?, actions }\` — overrides all other flags

- \`slay automations update <id> [--name <n>] [--description <text>] [--enabled] [--disabled] [--trigger <type>] [--action-command <cmd>] [--trigger-from-status <s>] [--trigger-to-status <s>] [--cron <expr>]\` — update an automation.
  - At least one option required

- \`slay automations delete <id>\` — permanently delete an automation.

- \`slay automations toggle <id>\` — flip the enabled/disabled state.
  - You don't need to know the current state — it toggles automatically

- \`slay automations run <id>\` — manually trigger an automation.
  - Requires the SlayZone app to be running (uses the app's HTTP API)
  - Reports status and duration

- \`slay automations runs <id> [--limit <n>] [--json]\` — view execution history.
  - Shows status, duration, and any errors
  - Default limit: 10

## Config file example

\`\`\`json
{
  "trigger_config": { "type": "task_status_change", "params": { "toStatus": "done" } },
  "actions": [
    { "type": "run_command", "params": { "command": "echo 'Task completed!'" } }
  ]
}
\`\`\`
`
  },

  {
    slug: 'slay-projects',
    name: 'Slay Projects',
    description: 'Manage projects via the slay CLI',
    category: 'cli',
    author: 'SlayZone',

    content: `---
name: slay-projects
description: "Manage projects via the slay CLI"
trigger: auto
---

Projects group tasks, tags, templates, and automations. Each project can optionally be linked to a directory on disk.

Project names are resolved via case-insensitive substring matching — \`slay tasks list --project my\` matches "My Project". If multiple projects match, the CLI errors with all matching names to prevent ambiguity.

## Commands

- \`slay projects list [--json]\` — list all projects with task counts and paths.

- \`slay projects create <name> [--path <path>] [--color <hex>] [--json]\` — create a project.
  - \`--path\` is optional — projects can exist without a directory
  - Relative paths are resolved from the current working directory; directory is created recursively if it doesn't exist
  - Color defaults to #3b82f6

- \`slay projects update <name|id> [--name <n>] [--color <hex>] [--path <path>] [--json]\` — update a project.
  - At least one option required
  - Setting \`--path\` also auto-creates the directory
`
  },

  {
    slug: 'slay-processes',
    name: 'Slay Processes',
    description: 'List and manage running processes via the slay CLI',
    category: 'cli',
    author: 'SlayZone',

    content: `---
name: slay-processes
description: "List and manage running processes via the slay CLI"
trigger: auto
---

Processes are background tasks managed by the SlayZone app — distinct from PTY terminal sessions (see slay-pty). These include automation runners, background jobs, and other managed child processes.

All process commands require the SlayZone app to be running, as data comes from the app's HTTP API.

## Commands

- \`slay processes list [--json]\` — list all managed processes.
  - Shows ID, status, label, command, PID, and start time

- \`slay processes logs <id> [-n <lines>]\` — print the last N lines of a process's output buffer.
  - Default: 50 lines

- \`slay processes kill <id>\` — kill a running process.

- \`slay processes follow <id>\` — stream process output in real time.
  - For live processes: uses SSE (Server-Sent Events) and streams indefinitely until the process exits or the connection drops
  - For already-finished processes: dumps the full output as plain text and returns immediately
`
  },

  {
    slug: 'slay-pty',
    name: 'Slay PTY',
    description: 'Interact with PTY terminal sessions via the slay CLI',
    category: 'cli',
    author: 'SlayZone',

    content: `---
name: slay-pty
description: "Interact with PTY terminal sessions via the slay CLI"
trigger: auto
---

PTY commands interact with terminal sessions managed by the SlayZone app — the actual terminal tabs you see in each task. Use these to read output, send input, and orchestrate AI coding agents programmatically.

All commands support ID prefix matching.

## Commands

- \`slay pty list [--json]\` — list active PTY sessions.
  - Shows session ID, task ID, terminal mode, current state, and age

- \`slay pty buffer <id>\` — dump the full terminal buffer content to stdout.
  - Useful for reading what an AI agent has output without streaming

- \`slay pty follow <id> [--full]\` — stream PTY output in real time.
  - \`--full\` replays the existing buffer first before streaming new output
  - Streams until the session exits

- \`slay pty write <id> <data>\` — send raw data directly to PTY stdin.
  - No newline handling or encoding — sends exactly what you provide
  - Use for low-level control

- \`slay pty submit <id> [text] [--wait] [--no-wait] [--timeout <ms>]\` — high-level text submission with AI-mode awareness.
  - If no text argument is given, reads from stdin (pipe-friendly)
  - For AI modes like \`claude-code\`, internal newlines are encoded as Kitty shift-enter sequences (\`\\x1b[13;2u\`) so multi-line text is submitted as a single input
  - **Wait behavior:** by default waits for the session to reach the \`attention\` state (= AI CLI ready for input) before sending. Automatic for AI modes. Use \`--no-wait\` to send immediately (default for plain terminal modes)
  - Timeout defaults to 60 seconds

- \`slay pty wait <id> [--state <state>] [--timeout <ms>] [--json]\` — block until a session reaches a specific state.
  - Default state: \`attention\` (AI ready for input)
  - Default timeout: 60 seconds
  - Exit codes: 0 = reached state, 2 = timeout, 1 = session died

- \`slay pty kill <id>\` — terminate a PTY session.

## Orchestration patterns

Submit a prompt to a Claude Code session and wait for completion:
\`\`\`bash
slay pty submit <id> "Fix the failing tests in src/auth.ts"
slay pty wait <id> --state attention --timeout 300000
slay pty buffer <id>  # read the result
\`\`\`

Pipe multi-line input:
\`\`\`bash
cat prompt.md | slay pty submit <id>
\`\`\`
`
  },

  {
    slug: 'slay-panels',
    name: 'Slay Panels',
    description: 'Manage web panels via the slay CLI',
    category: 'cli',
    author: 'SlayZone',

    content: `---
name: slay-panels
description: "Manage web panels via the slay CLI"
trigger: auto
---

Web panels are custom browser views available in the task detail sidebar, alongside the built-in browser tab. Use them for dashboards, documentation, design tools, or any web app you want quick access to from every task.

SlayZone ships with predefined panels for Figma, Notion, GitHub, Excalidraw, and Monosketch. Deleting a predefined panel prevents it from being re-added automatically.

## Commands

- \`slay panels list [--json]\` — list all web panels with their ID, name, URL, keyboard shortcut, and enabled state.

- \`slay panels create <name> <url> [-s <letter>] [--block-handoff] [--protocol <protocol>]\` — create a custom web panel.
  - \`-s\` assigns a single-letter keyboard shortcut (some letters reserved: t, b, e, g, s)
  - \`--block-handoff\` prevents desktop app protocol URLs (e.g. \`figma://\`) from opening the native app — keeps navigation inside the panel
  - \`--protocol\` specifies which desktop protocol to block (inferred from URL hostname if omitted; requires \`--block-handoff\`)

- \`slay panels delete <id-or-name>\` — delete a web panel by ID or name (case-insensitive name match).

- \`slay panels enable <id-or-name>\` — show the panel in task view.
  - Panels are enabled by default when created

- \`slay panels disable <id-or-name>\` — hide the panel from task view without deleting it.
  - The panel config is preserved
`
  },

  // ── Workflow ──────────────────────────────────────────────────

  {
    slug: 'slay-auto-title',
    name: 'Slay Auto Title',
    description: 'Automatically title tasks based on conversation context',
    category: 'workflow',
    author: 'SlayZone',

    content: `---
name: slay-auto-title
description: "Automatically title tasks based on conversation context"
trigger: auto
---

Once you have enough context to understand what the task is about, update its title to reflect the actual work being done.

## Rules

- Derive a short, action-oriented title from the conversation (under 60 characters)
- Good titles start with a verb: "Fix …", "Add …", "Refactor …", "Investigate …"
- Only update when meaningful context exists — don't rename on trivial exchanges
- Update again if the scope shifts significantly during the conversation
- Use: \`slay tasks update --permanent --title "<title>"\`
`
  },
]
