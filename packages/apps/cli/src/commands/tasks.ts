import { Command } from 'commander'
import { browserCommand } from './browser'
import { listAction } from './tasks/list'
import { createAction } from './tasks/create'
import { viewAction } from './tasks/view'
import { doneAction } from './tasks/done'
import { resetConversationAction } from './tasks/reset-conversation'
import { updateAction } from './tasks/update'
import { progressAction } from './tasks/progress'
import { archiveAction } from './tasks/archive'
import { deleteAction } from './tasks/delete'
import { openAction } from './tasks/open'
import { subtasksAction } from './tasks/subtasks'
import { subtaskAddAction } from './tasks/subtask-add'
import { searchAction } from './tasks/search'
import { tagAction } from './tasks/tag'
import { blockersAction } from './tasks/blockers'
import { blockingAction } from './tasks/blocking'
import { blockedAction } from './tasks/blocked'
import { artifactsSubcommand } from './tasks/artifacts'

export function tasksCommand(): Command {
  const cmd = new Command('tasks')
    .description('Manage tasks')
    .showSuggestionAfterError(true)
    .showHelpAfterError(true)

  // slay tasks list
  cmd
    .command('list')
    .description('List tasks')
    .option('--project <name|id>', 'Filter by project name (partial, case-insensitive) or ID')
    .option('--status <status>', 'Filter by status key')
    .option('--done', 'Show tasks in a completed category for each project')
    .option('--limit <n>', 'Max number of results', '100')
    .option('--json', 'Output as JSON')
    .action(listAction)

  // slay tasks create
  cmd
    .command('create <title>')
    .description('Create a new task')
    .option(
      '--project <name|id>',
      'Project name (partial, case-insensitive) or ID (defaults to $SLAYZONE_PROJECT_ID)'
    )
    .option(
      '--description <text>',
      'Task description (reference task specific artifacts via `[title](artifact:<artifact-id>)`)'
    )
    .option('--status <status>', 'Initial status key')
    .option('--priority <n>', 'Priority 1-5 (1=highest)')
    .option('--due <date>', 'Due date (YYYY-MM-DD or ISO 8601)')
    .option('--template <name|id>', 'Task template for defaults')
    .option('--external-id <id>', 'External ID for deduplication (skips if already exists)')
    .option('--external-provider <provider>', 'External provider namespace', 'cli')
    .action(createAction)

  // slay tasks view
  cmd
    .command('view [id]')
    .description('Show task details (id prefix supported; defaults to $SLAYZONE_TASK_ID)')
    .action(viewAction)

  // slay tasks done
  cmd
    .command('done [id]')
    .description('Mark a task as done (id prefix supported; defaults to $SLAYZONE_TASK_ID)')
    .option('--close', 'Also close the task tab in the app')
    .action(doneAction)

  // slay tasks reset-conversation
  cmd
    .command('reset-conversation [id]')
    .description(
      'Clear the stored conversation IDs for a task — the next agent spawn starts fresh. ' +
        'Appends a `manual-reset` row to task_conversations (append-only; never deletes).'
    )
    .option(
      '--mode <mode>',
      'Limit to one terminal mode (e.g. claude-code, codex). Default: every mode with a row for this task.'
    )
    .action(resetConversationAction)

  // slay tasks update
  cmd
    .command('update [id]')
    .description('Update a task (id prefix supported; defaults to $SLAYZONE_TASK_ID)')
    .option('--title <title>', 'New title')
    .option(
      '--description <text>',
      'New description (reference task specific artifacts via `[title](artifact:<artifact-id>)`)'
    )
    .option('--append-description <text>', 'Append to existing description')
    .option('--status <status>', 'New status key')
    .option('--priority <n>', 'New priority 1-5')
    .option('--due <date>', 'Set due date (YYYY-MM-DD or ISO 8601)')
    .option('--no-due', 'Clear due date')
    .option('--parent <id>', 'Reparent task under <id> (prefix supported, must be in same project)')
    .option('--no-parent', 'Detach task (make top-level)')
    .option('--permanent', 'Convert temporary task to a real task')
    .option(
      '--worktree-path <path>',
      'Link a git worktree to this task (auto-derives parent branch + repo from project layout)'
    )
    .action(updateAction)

  // slay tasks progress
  cmd
    .command('progress <idOrValue> [value]')
    .description(
      'Set task progress 0-100. Use `<id> <value>` or `<value>` (id defaults to $SLAYZONE_TASK_ID).'
    )
    .action(progressAction)

  // slay tasks archive
  cmd
    .command('archive <id>')
    .description('Archive a task — hidden from kanban but kept in DB (id prefix supported)')
    .action(archiveAction)

  // slay tasks delete
  cmd
    .command('delete <id>')
    .description('Permanently delete a task (id prefix supported)')
    .action(deleteAction)

  // slay tasks open
  cmd
    .command('open [id]')
    .description(
      'Open a task in the SlayZone app (id prefix supported; defaults to $SLAYZONE_TASK_ID)'
    )
    .option('--background', 'Open as background tab — do not switch focus or activate the tab')
    .option('--start', "Also start the task's main PTY (skip the idle gate)")
    .option('--no-wait', 'With --start: return immediately without waiting for the PTY to spawn')
    .option('--timeout <ms>', 'With --start: spawn wait timeout in milliseconds', '5000')
    .action(openAction)

  // slay tasks subtasks [id]
  cmd
    .command('subtasks [id]')
    .description('List subtasks of a task (id prefix supported; defaults to $SLAYZONE_TASK_ID)')
    .option('--json', 'Output as JSON')
    .action(subtasksAction)

  // slay tasks subtask-add <title>
  cmd
    .command('subtask-add <title>')
    .description('Add a subtask (parent defaults to $SLAYZONE_TASK_ID)')
    .option('--parent <id>', 'Parent task ID (defaults to $SLAYZONE_TASK_ID)')
    .option('--description <text>', 'Subtask description')
    .option('--status <status>', 'Initial status key')
    .option('--priority <n>', 'Priority 1-5', '3')
    .option('--external-id <id>', 'External ID for deduplication (skips if already exists)')
    .option('--external-provider <provider>', 'External provider namespace', 'cli')
    .action(subtaskAddAction)

  // slay tasks search <query>
  cmd
    .command('search <query>')
    .description('Search tasks by title or description (includes subtasks)')
    .option('--project <name|id>', 'Filter by project name or ID')
    .option('--limit <n>', 'Max results', '50')
    .option('--json', 'Output as JSON')
    .action(searchAction)

  // slay tasks tag [taskId]
  cmd
    .command('tag [taskId]')
    .description('View or modify tags on a task (defaults to $SLAYZONE_TASK_ID)')
    .option('--set <names...>', 'Replace all tags with these (by name)')
    .option('--add <name>', 'Add a tag by name')
    .option('--remove <name>', 'Remove a tag by name')
    .option('--clear', 'Remove all tags')
    .option('--json', 'Output as JSON')
    .action(tagAction)

  // slay tasks blockers [id]
  cmd
    .command('blockers [id]')
    .description('View or modify tasks that block this task (defaults to $SLAYZONE_TASK_ID)')
    .option('--add <ids...>', 'Add blocking tasks by ID prefix')
    .option('--remove <ids...>', 'Remove blocking tasks by ID prefix')
    .option('--set <ids...>', 'Replace all blockers with these tasks')
    .option('--clear', 'Remove all blockers')
    .option('--json', 'Output as JSON')
    .action(blockersAction)

  // slay tasks blocking [id]
  cmd
    .command('blocking [id]')
    .description('List tasks that this task is blocking (defaults to $SLAYZONE_TASK_ID)')
    .option('--json', 'Output as JSON')
    .action(blockingAction)

  // slay tasks blocked [id]
  cmd
    .command('blocked [id]')
    .description('View or modify blocked status on a task (defaults to $SLAYZONE_TASK_ID)')
    .option('--on', 'Mark task as blocked')
    .option('--off', 'Unblock task (clears comment)')
    .option('--toggle', 'Toggle blocked state')
    .option('--comment <text>', 'Set blocked with comment (implies --on)')
    .option('--no-comment', 'Clear blocked comment only')
    .option('--json', 'Output as JSON')
    .action(blockedAction)

  cmd.addCommand(browserCommand())
  cmd.addCommand(artifactsSubcommand())

  return cmd
}
