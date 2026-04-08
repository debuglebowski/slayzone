import { Command } from 'commander'

const INSTRUCTIONS = `\
# SlayZone Environment

You are running inside [SlayZone](https://slayzone.com), a desktop development environment built around a kanban board. Each task on the board is a full workspace with terminal panels, a file editor, a browser panel, and git integration. Your session is one of potentially many agents working in parallel on different tasks. A human or another agent may interact with you through the terminal.

Your task has a title, description, status, and subtasks — use the \`slay\` CLI to read and update them. See the \`slay\` skill for the full command reference.

\`$SLAYZONE_TASK_ID\` is set to the ID of the task you are running inside. Most \`slay\` commands default to it when no explicit ID is given.
`

const SKILL = `\
---
name: slay
description: "Full CLI reference for the slay command — interact with tasks, terminals, browser, assets, and the SlayZone app"
trigger: auto
---

Use the \`slay\` CLI to interact with the SlayZone task management system. \`$SLAYZONE_TASK_ID\` is set automatically in task terminals — most commands default to it when no explicit ID is given.

## Global flags

- \`--dev\` — use development database (\`slayzone.dev.sqlite\`)

## Commands

### Task lifecycle
- \`slay tasks view [id]\` — show task details (defaults to current task)
- \`slay tasks update [id] [--title <title>] [--description <text>] [--append-description <text>] [--status <status>] [--priority <1-5>] [--due <date>] [--no-due]\` — update task
- \`slay tasks done [id]\` — mark task complete
- \`slay tasks create <title> --project <name> [--description <text>] [--status <status>] [--priority <1-5>] [--due <date>] [--template <name|id>] [--external-id <id>] [--external-provider <provider>]\` — create task

### Subtasks
- \`slay tasks subtasks [id] [--json]\` — list subtasks of current task
- \`slay tasks subtask-add [parentId] <title> [--description <text>] [--status <status>] [--priority <1-5>] [--external-id <id>] [--external-provider <provider>]\` — add subtask

### Task management
- \`slay tasks list [--project <name>] [--status <status>] [--done] [--limit <n>] [--json]\` — list tasks
- \`slay tasks search <query> [--project <name>] [--limit <n>] [--json]\` — search tasks
- \`slay tasks open [id]\` — open task in SlayZone app
- \`slay tasks archive <id>\` — archive task (hidden from kanban, kept in DB)
- \`slay tasks delete <id>\` — permanently delete task

### Tags
- \`slay tasks tag [id] [--json]\` — show current tags
- \`slay tasks tag [id] --set <name1> [name2...]\` — replace all tags
- \`slay tasks tag [id] --add <name>\` — add tag
- \`slay tasks tag [id] --remove <name>\` — remove tag
- \`slay tasks tag [id] --clear\` — remove all tags
- \`slay tags list --project <name> [--json]\` — list project tags
- \`slay tags create <name> --project <name> [--color <hex>] [--text-color <hex>]\` — create tag
- \`slay tags delete <id>\` — delete tag

### Templates
- \`slay templates list --project <name> [--json]\` — list templates
- \`slay templates view <id> [--json]\` — view template details
- \`slay templates create <name> --project <name> [--terminal-mode <mode>] [--priority <1-5>] [--status <s>] [--default] [--description <text>]\` — create template
- \`slay templates update <id> [--name <n>] [--terminal-mode <m>] [--priority <1-5>] [--status <s>] [--default] [--no-default] [--description <text>]\` — update template
- \`slay templates delete <id>\` — delete template

### Browser panel
- \`slay tasks browser navigate <url> [--panel <state>]\` — open URL in task browser
- \`slay tasks browser url [--panel <state>]\` — get current URL
- \`slay tasks browser screenshot [-o <path>] [--panel <state>]\` — capture screenshot
- \`slay tasks browser content [--json] [--panel <state>]\` — get page text and interactive elements
- \`slay tasks browser click <selector> [--panel <state>]\` — click element
- \`slay tasks browser type <selector> <text> [--panel <state>]\` — type into input
- \`slay tasks browser eval <code> [--panel <state>]\` — execute JS in browser

### Assets
- \`slay tasks assets list <taskId> [--json] [--tree]\` — list assets
- \`slay tasks assets read <assetId>\` — output asset content to stdout
- \`slay tasks assets create <title> [--task <id>] [--copy-from <path>] [--render-mode <mode>] [--folder <id>] [--json]\` — create asset (stdin or --copy-from)
- \`slay tasks assets upload <sourcePath> [--task <id>] [--title <name>] [--json]\` — upload file as asset
- \`slay tasks assets update <assetId> [--title <name>] [--render-mode <mode>] [--json]\` — update asset metadata
- \`slay tasks assets write <assetId>\` — replace asset content (stdin)
- \`slay tasks assets append <assetId>\` — append to asset content (stdin)
- \`slay tasks assets delete <assetId>\` — delete asset
- \`slay tasks assets path <assetId>\` — print asset file path
- \`slay tasks assets mkdir <name> [--task <id>] [--parent <id>] [--json]\` — create folder (nested via --parent)
- \`slay tasks assets rmdir <folderId> [--json]\` — delete folder (assets move to root)
- \`slay tasks assets mvdir <folderId> --parent <id|"root"> [--json]\` — move folder to another parent
- \`slay tasks assets mv <assetId> --folder <id|"root"> [--json]\` — move asset to folder (or root)

### Projects
- \`slay projects list [--json]\` — list projects
- \`slay projects create <name> [--path <path>] [--color <hex>] [--json]\` — create project
- \`slay projects update <name|id> [--name <n>] [--color <hex>] [--path <path>] [--json]\` — update project

### Automations
- \`slay automations list --project <name> [--json]\` — list automations
- \`slay automations view <id> [--json]\` — view automation details
- \`slay automations create <name> --project <name> --trigger <type> [--action-command <cmd>] [--trigger-from-status <s>] [--trigger-to-status <s>] [--cron <expr>] [--description <text>] [--config <file>]\` — create automation
- \`slay automations update <id> [--name <n>] [--description <text>] [--enabled] [--disabled] [--trigger <type>] [--action-command <cmd>] [--trigger-from-status <s>] [--trigger-to-status <s>] [--cron <expr>]\` — update
- \`slay automations delete <id>\` — delete automation
- \`slay automations toggle <id>\` — enable/disable
- \`slay automations run <id>\` — manually trigger (requires app running)
- \`slay automations runs <id> [--limit <n>] [--json]\` — view execution history

### Processes
- \`slay processes list [--json]\` — list running processes
- \`slay processes logs <id> [-n <lines>]\` — print log output
- \`slay processes kill <id>\` — kill process
- \`slay processes follow <id>\` — stream logs in real time (SSE)

### PTY sessions
- \`slay pty list [--json]\` — list active PTY sessions
- \`slay pty buffer <id>\` — dump terminal buffer
- \`slay pty follow <id> [--full]\` — stream PTY output (--full replays buffer first)
- \`slay pty write <id> <data>\` — send raw data to PTY stdin
- \`slay pty submit <id> [text] [--wait] [--no-wait] [--timeout <ms>]\` — submit text to PTY (smart newline handling for AI modes; reads stdin if no text; auto-waits for AI modes)
- \`slay pty wait <id> [--state <state>] [--timeout <ms>] [--json]\` — wait for session state (default: attention, timeout: 60s)
- \`slay pty kill <id>\` — kill PTY session

### Web panels
- \`slay panels list [--json]\` — list configured web panels
- \`slay panels create <name> <url> [-s <letter>] [--block-handoff] [--protocol <protocol>]\` — create panel
- \`slay panels delete <id-or-name>\` — delete panel
- \`slay panels enable <id-or-name>\` — enable panel in task view
- \`slay panels disable <id-or-name>\` — disable panel in task view

## Notes

- All ID arguments support prefix matching (e.g. \`a1b2\` matches \`a1b2c3d4-...\`).
- Commands accepting \`[id]\` default to \`$SLAYZONE_TASK_ID\`.
- Automation trigger types: \`task_status_change\`, \`task_created\`, \`task_archived\`, \`task_tag_changed\`, \`cron\`, \`manual\`.
- \`--external-id\` on \`create\`/\`subtask-add\` enables idempotent creation — if a task with the same \`(project, external_provider, external_id)\` exists, the command returns the existing task instead of creating a duplicate.
- \`slay pty submit\` auto-waits for \`attention\` state on AI modes and encodes newlines via Kitty protocol.
- Asset content via stdin for \`create\` (without \`--copy-from\`), \`write\`, and \`append\`.
- Reference assets in task descriptions: \`[title](asset:<asset-id>)\`.
`

export function initCommand(): Command {
  const cmd = new Command('init').description('Print SlayZone templates for AI agent configuration')

  cmd
    .command('instructions')
    .description('Print CLAUDE.md / AGENTS.md template')
    .action(() => {
      process.stdout.write(INSTRUCTIONS)
    })

  cmd
    .command('skill')
    .description('Print SKILL.md template')
    .action(() => {
      process.stdout.write(SKILL)
    })

  return cmd
}
