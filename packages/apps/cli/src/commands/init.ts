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
trigger: auto
---

Use the \`slay\` CLI to interact with the SlayZone task management system. The current task ID is available via \`$SLAYZONE_TASK_ID\` (set automatically in task terminals).

## Commands

### Task lifecycle
- \`slay tasks view [id]\` — show task details (defaults to current task)
- \`slay tasks update [id] --status <status> --title <title> --description <text> --priority <1-5> --due <date> --no-due\` — update task
- \`slay tasks done [id]\` — mark task complete
- \`slay tasks create <title> --project <name> [--description <text>] [--status <status>] [--due <date>] [--template <name|id>]\` — create task

### Subtasks
- \`slay tasks subtasks [id]\` — list subtasks of current task
- \`slay tasks subtask-add [parentId] <title> [--description <text>] [--status <status>]\` — add subtask

### Tags
- \`slay tasks tag [id]\` — show current tags
- \`slay tasks tag [id] --set <name1> [name2...]\` — replace all tags
- \`slay tasks tag [id] --add <name>\` — add a tag
- \`slay tasks tag [id] --remove <name>\` — remove a tag
- \`slay tags list --project <name>\` — list tags for a project
- \`slay tags create <name> --project <name> [--color <hex>]\` — create a tag
- \`slay tags delete <id>\` — delete a tag

### Templates
- \`slay templates list --project <name>\` — list task templates
- \`slay templates view <id>\` — view template details
- \`slay templates create <name> --project <name> [--terminal-mode <mode>] [--priority <1-5>] [--status <s>] [--default]\` — create template
- \`slay templates update <id> [--name <n>] [--terminal-mode <m>] [--priority <1-5>] [--default] [--no-default]\` — update template
- \`slay templates delete <id>\` — delete template

### Browser panel
- \`slay tasks browser navigate <url>\` — open URL in task browser panel
- \`slay tasks browser url\` — get current URL
- \`slay tasks browser screenshot [-o <path>]\` — capture screenshot
- \`slay tasks browser content [--json]\` — get page text and interactive elements
- \`slay tasks browser click <selector>\` — click element
- \`slay tasks browser type <selector> <text>\` — type into input
- \`slay tasks browser eval <code>\` — execute JS in browser

### Projects
- \`slay projects list [--json]\` — list projects
- \`slay projects create <name> [--path <path>] [--color <hex>]\` — create project
- \`slay projects update <name|id> [--name <n>] [--color <hex>] [--path <path>]\` — update project

### Automations
- \`slay automations list --project <name> [--json]\` — list automations
- \`slay automations view <id> [--json]\` — view automation details
- \`slay automations create <name> --project <name> --trigger <type> --action-command <cmd> [--cron <expr>]\` — create automation
- \`slay automations update <id> [--name <n>] [--enabled] [--disabled] [--action-command <cmd>]\` — update
- \`slay automations delete <id>\` — delete automation
- \`slay automations toggle <id>\` — enable/disable automation
- \`slay automations run <id>\` — manually trigger (requires app running)
- \`slay automations runs <id> [--limit <n>]\` — view execution history

### Other
- \`slay tasks list [--project <name>] [--status <status>] [--done] [--json]\` — list tasks
- \`slay tasks search <query> [--project <name>]\` — search tasks
- \`slay tasks open [id]\` — open task in SlayZone app
`

export function initCommand(): Command {
  const cmd = new Command('init').description('Print SlayZone templates for AI agent configuration')

  cmd
    .command('instructions')
    .description('Print CLAUDE.md / AGENTS.md / GEMINI.md template')
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
