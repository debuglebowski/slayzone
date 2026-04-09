export type SkillMarketplaceCategory =
  | 'slayzone'
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
  tags: string[]
  content: string
}

export const BUILTIN_SKILLS: BuiltinSkillEntry[] = [
  // ── Domain skills ─────────────────────────────────────────────

  {
    slug: 'slay-tasks',
    name: 'Slay Tasks',
    description: 'Manage tasks, subtasks, tags, and templates via the slay CLI',
    category: 'slayzone',
    author: 'SlayZone',
    tags: ['slay', 'tasks', 'subtasks', 'tags', 'templates'],
    content: `---
name: slay-tasks
description: "Manage tasks, subtasks, tags, and templates via the slay CLI"
trigger: auto
---

Task commands are the core of the slay CLI. Most commands accept an optional \`[id]\` argument that defaults to \`$SLAYZONE_TASK_ID\`, which is automatically set in every task terminal. All ID arguments support prefix matching — e.g. \`a1b2\` matches a full UUID starting with \`a1b2\`.

## Task lifecycle

- \`slay tasks list [--project <name|id>] [--status <status>] [--done] [--limit <n>] [--json]\`
  List tasks. \`--status\` filters by status key (resolved via the project's custom column config). \`--done\` shows completed tasks across all projects using each project's column config to determine what "done" means — this overrides \`--status\` if both are given. Default limit is 100.

- \`slay tasks create <title> --project <name|id> [--description <text>] [--status <status>] [--priority <1-5>] [--due <date>] [--template <name|id>] [--external-id <id>] [--external-provider <provider>]\`
  Create a task. If \`--template\` is omitted, the project's default template is auto-applied (if one exists). Templates set the terminal mode, initial status, priority, and provider config. \`--external-id\` enables idempotent creation: if a task with the same \`(project, provider, external_id)\` already exists, it prints "Exists" and exits cleanly — useful for sync scripts. Reference assets in descriptions via \`[title](asset:<asset-id>)\`.

- \`slay tasks view [id]\` — show task details including status, priority, description, tags, and subtasks.

- \`slay tasks update [id] [--title <title>] [--description <text>] [--append-description <text>] [--status <status>] [--priority <1-5>] [--due <date>] [--no-due]\`
  Update a task. \`--append-description\` adds text after a newline separator (mutually exclusive with \`--description\`). \`--no-due\` clears the due date.

- \`slay tasks done [id]\` — mark task complete using the project's configured "done" status.

- \`slay tasks archive <id>\` — hide from kanban but keep in database. Use for tasks you don't need visible but want to preserve.

- \`slay tasks delete <id>\` — permanently remove the task and all its data.

- \`slay tasks open [id]\` — focus the task in the SlayZone app window.

- \`slay tasks search <query> [--project <name|id>] [--limit <n>] [--json]\`
  Case-insensitive substring search across title and description. Includes subtasks in results. Results ordered by most recently updated. Default limit is 50.

## Subtasks

- \`slay tasks subtasks [id] [--json]\` — list subtasks of a task.

- \`slay tasks subtask-add [parentId] <title> [--description <text>] [--status <status>] [--priority <1-5>] [--external-id <id>] [--external-provider <provider>]\`
  Add a subtask. Parent defaults to \`$SLAYZONE_TASK_ID\`. The subtask inherits the parent's terminal mode. \`--external-id\` deduplication works the same as task creation.

## Task tags

Tags are project-scoped — a tag name must exist in the project before it can be applied to a task.

- \`slay tasks tag [taskId] [--json]\` — show current tags on a task.
- \`slay tasks tag [taskId] --set <name1> [name2...]\` — replace all tags with the given names.
- \`slay tasks tag [taskId] --add <name>\` — add a tag. Idempotent — no error if already present.
- \`slay tasks tag [taskId] --remove <name>\` — remove a tag by name.
- \`slay tasks tag [taskId] --clear\` — remove all tags from the task.

## Project tags

- \`slay tags list --project <name|id> [--json]\` — list all tags in a project.
- \`slay tags create <name> --project <name|id> [--color <hex>] [--text-color <hex>]\` — create a new tag. Color defaults to #6366f1, text color to #ffffff.
- \`slay tags delete <id>\` — delete a tag.

## Templates

Templates define defaults for new tasks: terminal mode, status, priority, provider config, panel visibility, browser tabs, and CCS profile.

- \`slay templates list --project <name|id> [--json]\` — list templates. Shows which one is the project default.
- \`slay templates view <id> [--json]\` — view template details including all configured defaults.
- \`slay templates create <name> --project <name|id> [--terminal-mode <mode>] [--priority <1-5>] [--status <status>] [--default] [--description <text>]\`
  Create a template. \`--default\` makes it the project default, clearing any existing default (transactional).
- \`slay templates update <id> [--name <n>] [--terminal-mode <m>] [--priority <1-5>] [--status <s>] [--default] [--no-default] [--description <text>]\`
  Update a template. \`--default\` clears all other defaults. \`--no-default\` unsets only this template's default flag.
- \`slay templates delete <id>\` — delete a template.
`
  },

  {
    slug: 'slay-browser',
    name: 'Slay Browser',
    description: 'Control the task browser panel via the slay CLI',
    category: 'slayzone',
    author: 'SlayZone',
    tags: ['slay', 'browser', 'screenshot', 'automation'],
    content: `---
name: slay-browser
description: "Control the task browser panel via the slay CLI"
trigger: auto
---

Browser commands control the browser panel embedded in each task's detail view. All commands require \`$SLAYZONE_TASK_ID\` to be set (automatic in task terminals).

Every command accepts \`--panel <state>\` (visible | hidden). \`navigate\` defaults to \`visible\` (auto-opens the panel), all other commands default to \`hidden\` (operate without showing the panel).

## Commands

- \`slay tasks browser navigate <url> [--panel <state>]\`
  Navigate to a URL. This is the only command that auto-shows the browser panel. Use this to open pages for verification, testing, or reference.

- \`slay tasks browser url [--panel <state>]\`
  Print the current URL. Useful for checking where the browser is after navigation or redirects.

- \`slay tasks browser screenshot [-o <path>] [--panel <state>]\`
  Capture a screenshot. Returns the file path of the saved image. Use \`-o\` to copy the screenshot to a specific path; without it, prints the temp file path.

- \`slay tasks browser content [--json] [--panel <state>]\`
  Get the page's text content (truncated to 10k characters) and a list of interactive elements (links, buttons, inputs) as JSON. Useful for understanding page structure before clicking or typing.

- \`slay tasks browser click <selector> [--panel <state>]\`
  Click an element by CSS selector. Returns the tag name and text of the clicked element.

- \`slay tasks browser type <selector> <text> [--panel <state>]\`
  Type text into an input element by CSS selector.

- \`slay tasks browser eval <code> [--panel <state>]\`
  Execute JavaScript in the browser context and print the result. Strings are printed as-is, other values are pretty-printed as JSON.

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
    category: 'slayzone',
    author: 'SlayZone',
    tags: ['slay', 'assets', 'files', 'upload'],
    content: `---
name: slay-assets
description: "Manage task assets (files, folders) via the slay CLI"
trigger: auto
---

Assets are files attached to tasks, stored on disk at \`{data-dir}/assets/{taskId}/{assetId}.ext\`. They can be text files, images, or any binary content. Use assets to attach specifications, screenshots, logs, or any reference material to a task.

The \`--task\` flag defaults to \`$SLAYZONE_TASK_ID\` for \`create\`, \`upload\`, and \`mkdir\`. Note: \`list\` requires an explicit task ID argument.

## Files

- \`slay tasks assets list <taskId> [--json] [--tree]\`
  List all assets for a task. \`--tree\` shows an indented folder structure.

- \`slay tasks assets read <assetId>\`
  Output asset content to stdout. Binary assets (images, etc.) are written as raw buffers; text assets as UTF-8.

- \`slay tasks assets create <title> [--task <id>] [--folder <id>] [--copy-from <path>] [--render-mode <mode>] [--json]\`
  Create a new asset. Content is read from stdin (must be piped — errors on TTY), or from a file via \`--copy-from\`. The render mode is inferred from the title's file extension if not specified (defaults to plain text if no extension). Reference created assets in task descriptions via \`[title](asset:<asset-id>)\`.

- \`slay tasks assets upload <sourcePath> [--task <id>] [--title <name>] [--json]\`
  Upload a file from disk as an asset. Title defaults to the filename.

- \`slay tasks assets update <assetId> [--title <name>] [--render-mode <mode>] [--json]\`
  Update asset metadata. If the title changes and the file extension differs, the file is renamed on disk.

- \`slay tasks assets write <assetId>\`
  Replace the asset's content entirely. Reads from stdin (pipe required).

- \`slay tasks assets append <assetId>\`
  Append to the asset's content. Reads from stdin (pipe required).

- \`slay tasks assets delete <assetId>\` — delete an asset and its file.

- \`slay tasks assets path <assetId>\` — print the asset's absolute file path on disk.

## Folders

Assets can be organized into folders. Folder operations support cycle detection — you can't move a folder into its own child.

- \`slay tasks assets mkdir <name> [--task <id>] [--parent <id>] [--json]\` — create a folder, optionally nested under a parent.
- \`slay tasks assets rmdir <folderId> [--json]\` — delete a folder. Contained assets are moved to root, not deleted.
- \`slay tasks assets mvdir <folderId> --parent <id|"root"> [--json]\` — move a folder to a new parent. Use \`"root"\` to move to top level.
- \`slay tasks assets mv <assetId> --folder <id|"root"> [--json]\` — move an asset into a folder. Use \`"root"\` for top level.

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
    category: 'slayzone',
    author: 'SlayZone',
    tags: ['slay', 'automations', 'cron', 'triggers'],
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

- \`slay automations list --project <name|id> [--json]\`
  List automations for a project. Shows enabled state, trigger type, run count, and last run time.

- \`slay automations view <id> [--json]\`
  View full automation details including trigger config, conditions, and actions.

- \`slay automations create <name> --project <name|id> --trigger <type> [--action-command <cmd>] [--trigger-from-status <status>] [--trigger-to-status <status>] [--cron <expression>] [--description <text>] [--config <file>]\`
  Create an automation. For simple automations, use \`--action-command\` to specify a shell command. For complex setups with multiple actions or conditions, use \`--config <file>\` which accepts a JSON file with \`{ trigger_config, conditions?, actions }\` — this overrides all other flags.

- \`slay automations update <id> [--name <n>] [--description <text>] [--enabled] [--disabled] [--trigger <type>] [--action-command <cmd>] [--trigger-from-status <s>] [--trigger-to-status <s>] [--cron <expr>]\`
  Update an automation. At least one option required.

- \`slay automations delete <id>\` — permanently delete an automation.

- \`slay automations toggle <id>\`
  Flip the enabled/disabled state. You don't need to know the current state — it toggles automatically.

- \`slay automations run <id>\`
  Manually trigger an automation. Requires the SlayZone app to be running (uses the app's HTTP API). Reports status and duration.

- \`slay automations runs <id> [--limit <n>] [--json]\`
  View execution history. Shows status, duration, and any errors. Default limit is 10.

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
    category: 'slayzone',
    author: 'SlayZone',
    tags: ['slay', 'projects'],
    content: `---
name: slay-projects
description: "Manage projects via the slay CLI"
trigger: auto
---

Projects group tasks, tags, templates, and automations. Each project can optionally be linked to a directory on disk.

Project names are resolved via case-insensitive substring matching — \`slay tasks list --project my\` matches "My Project". If multiple projects match, the CLI errors with all matching names to prevent ambiguity.

## Commands

- \`slay projects list [--json]\`
  List all projects with task counts and paths.

- \`slay projects create <name> [--path <path>] [--color <hex>] [--json]\`
  Create a project. \`--path\` is optional — projects can exist without a directory. Relative paths are resolved from the current working directory and the directory is created recursively if it doesn't exist. Color defaults to #3b82f6.

- \`slay projects update <name|id> [--name <n>] [--color <hex>] [--path <path>] [--json]\`
  Update a project. At least one option required. Setting \`--path\` also auto-creates the directory.
`
  },

  {
    slug: 'slay-processes',
    name: 'Slay Processes',
    description: 'List and manage running processes via the slay CLI',
    category: 'slayzone',
    author: 'SlayZone',
    tags: ['slay', 'processes', 'logs'],
    content: `---
name: slay-processes
description: "List and manage running processes via the slay CLI"
trigger: auto
---

Processes are background tasks managed by the SlayZone app — distinct from PTY terminal sessions (see slay-pty). These include automation runners, background jobs, and other managed child processes.

All process commands require the SlayZone app to be running, as data comes from the app's HTTP API.

## Commands

- \`slay processes list [--json]\`
  List all managed processes. Shows ID, status, label, command, PID, and start time.

- \`slay processes logs <id> [-n <lines>]\`
  Print the last N lines of a process's output buffer. Default is 50 lines.

- \`slay processes kill <id>\`
  Kill a running process.

- \`slay processes follow <id>\`
  Stream process output in real time. For live processes, uses SSE (Server-Sent Events) and streams indefinitely until the process exits or the connection drops. For already-finished processes, dumps the full output as plain text and returns immediately.
`
  },

  {
    slug: 'slay-pty',
    name: 'Slay PTY',
    description: 'Interact with PTY terminal sessions via the slay CLI',
    category: 'slayzone',
    author: 'SlayZone',
    tags: ['slay', 'pty', 'terminal', 'sessions'],
    content: `---
name: slay-pty
description: "Interact with PTY terminal sessions via the slay CLI"
trigger: auto
---

PTY commands interact with terminal sessions managed by the SlayZone app — the actual terminal tabs you see in each task. Use these to read output, send input, and orchestrate AI coding agents programmatically.

All commands support ID prefix matching.

## Commands

- \`slay pty list [--json]\`
  List active PTY sessions. Shows session ID, task ID, terminal mode, current state, and age.

- \`slay pty buffer <id>\`
  Dump the full terminal buffer content to stdout. Useful for reading what an AI agent has output without streaming.

- \`slay pty follow <id> [--full]\`
  Stream PTY output in real time. \`--full\` replays the existing buffer first before streaming new output. Streams until the session exits.

- \`slay pty write <id> <data>\`
  Send raw data directly to PTY stdin. No newline handling or encoding — sends exactly what you provide. Use for low-level control.

- \`slay pty submit <id> [text] [--wait] [--no-wait] [--timeout <ms>]\`
  High-level text submission with AI-mode awareness. If no text argument is given, reads from stdin (pipe-friendly). For AI modes like \`claude-code\`, internal newlines are encoded as Kitty shift-enter sequences (\`\\x1b[13;2u\`) so multi-line text is submitted as a single input rather than being split into separate commands.

  **Wait behavior:** By default, \`submit\` waits for the session to reach the \`attention\` state (= the AI CLI is ready for input) before sending. This is automatic for AI modes. Use \`--no-wait\` to send immediately (default for plain terminal modes). Timeout defaults to 60 seconds.

- \`slay pty wait <id> [--state <state>] [--timeout <ms>] [--json]\`
  Block until a session reaches a specific state. Default state is \`attention\` (AI ready for input), timeout is 60 seconds. Exit codes: 0 = reached state, 2 = timeout, 1 = session died.

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
    category: 'slayzone',
    author: 'SlayZone',
    tags: ['slay', 'panels', 'web'],
    content: `---
name: slay-panels
description: "Manage web panels via the slay CLI"
trigger: auto
---

Web panels are custom browser views available in the task detail sidebar, alongside the built-in browser tab. Use them for dashboards, documentation, design tools, or any web app you want quick access to from every task.

SlayZone ships with predefined panels for Figma, Notion, GitHub, Excalidraw, and Monosketch. Deleting a predefined panel prevents it from being re-added automatically.

## Commands

- \`slay panels list [--json]\`
  List all web panels with their ID, name, URL, keyboard shortcut, and enabled state.

- \`slay panels create <name> <url> [-s <letter>] [--block-handoff] [--protocol <protocol>]\`
  Create a custom web panel. \`-s\` assigns a single-letter keyboard shortcut (some letters are reserved: t, b, e, g, s). \`--block-handoff\` prevents desktop app protocol URLs (e.g. \`figma://\`) from opening the native app — keeps navigation inside the panel. \`--protocol\` specifies which desktop protocol to block (inferred from URL hostname if omitted; requires \`--block-handoff\`).

- \`slay panels delete <id-or-name>\`
  Delete a web panel by ID or name (case-insensitive name match).

- \`slay panels enable <id-or-name>\`
  Show the panel in task view. Panels are enabled by default when created.

- \`slay panels disable <id-or-name>\`
  Hide the panel from task view without deleting it. The panel config is preserved.
`
  },

  // ── Orchestrator ──────────────────────────────────────────────

  {
    slug: 'slay',
    name: 'Slay CLI',
    description: 'Full CLI reference for slay — orchestrates all slay domain skills',
    category: 'slayzone',
    author: 'SlayZone',
    tags: ['slay', 'cli'],
    content: `---
name: slay
description: "Full CLI reference for slay — orchestrates all slay domain skills"
trigger: auto
depends_on:
  - slay-tasks
  - slay-browser
  - slay-assets
  - slay-automations
  - slay-projects
  - slay-processes
  - slay-pty
  - slay-panels
---

Use the \`slay\` CLI to interact with the SlayZone task management system. The current task ID is available via \`$SLAYZONE_TASK_ID\` (set automatically in task terminals).

**Global flag:** \`--dev\` — use development database.

All ID arguments support prefix matching (e.g., \`a1b2\` matches the full UUID starting with \`a1b2\`).

## Domains

| Skill | Commands | Purpose |
|-------|----------|---------|
| slay-tasks | \`slay tasks\`, \`slay tags\`, \`slay templates\` | Task lifecycle, subtasks, tags, templates |
| slay-browser | \`slay tasks browser\` | Control the task browser panel |
| slay-assets | \`slay tasks assets\` | Manage files and folders attached to tasks |
| slay-automations | \`slay automations\` | Event-driven and cron automations |
| slay-projects | \`slay projects\` | Project CRUD |
| slay-processes | \`slay processes\` | Inspect and control running processes |
| slay-pty | \`slay pty\` | Interact with PTY terminal sessions |
| slay-panels | \`slay panels\` | Manage custom web panels |

## Other

- \`slay init instructions\` — print SlayZone agent configuration template
- \`slay init skill\` — print slay skill reference markdown
- \`slay completions <shell>\` — generate shell completions (fish | zsh | bash)
`
  },
]
