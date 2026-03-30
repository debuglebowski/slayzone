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
- \`slay tasks update [id] --status <status> --title <title> --description <text> --priority <1-5>\` — update task
- \`slay tasks done [id]\` — mark task complete

### Subtasks
- \`slay tasks subtasks [id]\` — list subtasks of current task
- \`slay tasks subtask-add [parentId] <title> [--description <text>] [--status <status>]\` — add subtask

### Browser panel
- \`slay tasks browser navigate <url>\` — open URL in task browser panel
- \`slay tasks browser url\` — get current URL
- \`slay tasks browser screenshot [-o <path>]\` — capture screenshot
- \`slay tasks browser content [--json]\` — get page text and interactive elements
- \`slay tasks browser click <selector>\` — click element
- \`slay tasks browser type <selector> <text>\` — type into input
- \`slay tasks browser eval <code>\` — execute JS in browser

### Other
- \`slay tasks list [--project <name>] [--status <status>] [--done] [--json]\` — list tasks
- \`slay tasks search <query> [--project <name>]\` — search tasks
- \`slay tasks create <title> --project <name> [--description <text>] [--status <status>]\` — create task
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
