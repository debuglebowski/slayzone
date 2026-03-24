import { Command } from 'commander'
import { execSync } from 'child_process'
import { openDb, notifyApp } from '../db'
import { browserCommand } from './browser'
import {
  getDefaultStatus,
  getDoneStatus,
  isCompletedStatus,
  isKnownStatus,
  parseColumnsConfig,
} from '@slayzone/projects/shared'

interface TaskRow extends Record<string, unknown> {
  id: string
  project_id: string
  title: string
  status: string
  priority: number
  project_name: string
  created_at: string
}

function getProjectColumnsConfig(db: ReturnType<typeof openDb>, projectId: string) {
  const rows = db.query<{ columns_config: string | null }>(
    `SELECT columns_config FROM projects WHERE id = :projectId LIMIT 1`,
    { ':projectId': projectId }
  )
  return parseColumnsConfig(rows[0]?.columns_config)
}

function resolveId(explicit?: string): string {
  const id = explicit ?? process.env.SLAYZONE_TASK_ID
  if (!id) {
    console.error('No task ID provided and $SLAYZONE_TASK_ID is not set.')
    process.exit(1)
  }
  return id
}

function printTasks(tasks: TaskRow[]) {
  if (tasks.length === 0) {
    console.log('No tasks found.')
    return
  }
  const idW = 9
  const statusW = 12
  console.log(`${'ID'.padEnd(idW)}  ${'STATUS'.padEnd(statusW)}  ${'PROJECT'.padEnd(16)}  TITLE`)
  console.log(`${'-'.repeat(idW)}  ${'-'.repeat(statusW)}  ${'-'.repeat(16)}  ${'-'.repeat(30)}`)
  for (const t of tasks) {
    const id = String(t.id).slice(0, 8).padEnd(idW)
    const status = String(t.status).padEnd(statusW)
    const project = String(t.project_name ?? '').slice(0, 16).padEnd(16)
    console.log(`${id}  ${status}  ${project}  ${t.title}`)
  }
}

export function tasksCommand(): Command {
  const cmd = new Command('tasks').description('Manage tasks')

  // slay tasks list
  cmd
    .command('list')
    .description('List tasks')
    .option('--project <name|id>', 'Filter by project name (partial, case-insensitive) or ID')
    .option('--status <status>', 'Filter by status key')
    .option('--done', 'Show tasks in a completed category for each project')
    .option('--limit <n>', 'Max number of results', '100')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      const db = openDb()

      const limit = parseInt(opts.limit, 10)
      const doneFilter = Boolean(opts.done)
      const status = doneFilter ? undefined : opts.status

      const conditions: string[] = ['t.archived_at IS NULL', 't.is_temporary = 0']
      const params: Record<string, string | number | null> = {}

      if (status) {
        conditions.push('t.status = :status')
        params[':status'] = status
      }

      if (opts.project) {
        conditions.push('(p.id = :proj OR LOWER(p.name) LIKE :projLike)')
        params[':proj'] = opts.project
        params[':projLike'] = `%${opts.project.toLowerCase()}%`
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

      const limitClause = doneFilter ? '' : 'LIMIT :limit'
      const tasks = db.query<TaskRow>(
        `SELECT t.id, t.project_id, t.title, t.status, t.priority, p.name AS project_name, t.created_at
         FROM tasks t
         JOIN projects p ON t.project_id = p.id
         ${where}
         ORDER BY t."order" ASC
         ${limitClause}`,
        doneFilter ? params : { ...params, ':limit': limit }
      )

      const filteredTasks = doneFilter
        ? tasks.filter((task) => {
            const projectColumns = getProjectColumnsConfig(db, task.project_id)
            return isCompletedStatus(task.status, projectColumns)
          }).slice(0, limit)
        : tasks

      if (opts.json) {
        console.log(JSON.stringify(filteredTasks, null, 2))
      } else {
        printTasks(filteredTasks)
      }
    })

  // slay tasks create
  cmd
    .command('create <title>')
    .description('Create a new task')
    .requiredOption('--project <name|id>', 'Project name (partial, case-insensitive) or ID')
    .option('--description <text>', 'Task description')
    .option('--status <status>', 'Initial status key')
    .option('--priority <n>', 'Priority 1-5 (1=highest)', '3')
    .action(async (title, opts) => {
      const db = openDb()

      const projects = db.query<{ id: string; name: string }>(
        `SELECT id, name FROM projects WHERE id = :proj OR LOWER(name) LIKE :projLike LIMIT 10`,
        { ':proj': opts.project, ':projLike': `%${opts.project.toLowerCase()}%` }
      )

      if (projects.length === 0) {
        const all = db.query<{ name: string }>('SELECT name FROM projects ORDER BY name')
        console.error(`No project matching "${opts.project}".`)
        console.error(`Available: ${all.map((p) => p.name).join(', ')}`)
        console.error('Use --project <name|id> to specify.')
        process.exit(1)
      }

      if (projects.length > 1) {
        console.error(`Ambiguous project "${opts.project}". Matches: ${projects.map((p) => p.name).join(', ')}`)
        console.error('Be more specific.')
        process.exit(1)
      }

      const project = projects[0]

      const priority = parseInt(opts.priority, 10)
      if (isNaN(priority) || priority < 1 || priority > 5) {
        console.error('Priority must be 1-5.')
        process.exit(1)
      }
      const projectColumns = getProjectColumnsConfig(db, project.id)
      if (opts.status && !isKnownStatus(opts.status, projectColumns)) {
        console.error(`Unknown status "${opts.status}" for project "${project.name}".`)
        process.exit(1)
      }
      const status = opts.status ?? getDefaultStatus(projectColumns)

      const id = crypto.randomUUID()
      const now = new Date().toISOString()

      db.run(
        `INSERT INTO tasks (id, project_id, title, description, status, priority, "order", created_at, updated_at)
         VALUES (:id, :projectId, :title, :description, :status, :priority,
           (SELECT COALESCE(MAX("order"), 0) + 1 FROM tasks WHERE project_id = :projectId),
           :now, :now)`,
        {
          ':id': id,
          ':projectId': project.id,
          ':title': title,
          ':description': opts.description ?? null,
          ':status': status,
          ':priority': priority,
          ':now': now,
        }
      )

      db.close()
      await notifyApp()
      console.log(`Created: ${id.slice(0, 8)}  ${title}  [${status}]  ${project.name}`)
    })

  // slay tasks view
  cmd
    .command('view [id]')
    .description('Show task details (id prefix supported; defaults to $SLAYZONE_TASK_ID)')
    .action(async (idPrefix) => {
      idPrefix = resolveId(idPrefix)
      const db = openDb()

      const tasks = db.query<TaskRow & { description: string; due_date: string }>(
        `SELECT t.*, p.name AS project_name
         FROM tasks t JOIN projects p ON t.project_id = p.id
         WHERE t.id LIKE :prefix || '%' LIMIT 2`,
        { ':prefix': idPrefix }
      )

      if (tasks.length === 0) {
        console.error(`Task not found: ${idPrefix}`)
        process.exit(1)
      }
      if (tasks.length > 1) {
        console.error(`Ambiguous id prefix "${idPrefix}". Matches: ${tasks.map((t) => t.id.slice(0, 8)).join(', ')}`)
        process.exit(1)
      }

      const t = tasks[0]
      console.log(`ID:       ${t.id}`)
      console.log(`Title:    ${t.title}`)
      console.log(`Status:   ${t.status}`)
      console.log(`Priority: ${t.priority}`)
      console.log(`Project:  ${t.project_name}`)
      console.log(`Created:  ${t.created_at}`)
      if (t.description) console.log(`\n${t.description}`)
    })

  // slay tasks done
  cmd
    .command('done [id]')
    .description('Mark a task as done (id prefix supported; defaults to $SLAYZONE_TASK_ID)')
    .action(async (idPrefix) => {
      idPrefix = resolveId(idPrefix)
      const db = openDb()

      const tasks = db.query<{ id: string; title: string; project_id: string }>(
        `SELECT id, title, project_id FROM tasks WHERE id LIKE :prefix || '%' LIMIT 2`,
        { ':prefix': idPrefix }
      )

      if (tasks.length === 0) {
        console.error(`Task not found: ${idPrefix}`)
        process.exit(1)
      }
      if (tasks.length > 1) {
        console.error(`Ambiguous id prefix "${idPrefix}". Matches: ${tasks.map((t) => t.id.slice(0, 8)).join(', ')}`)
        process.exit(1)
      }

      const task = tasks[0]
      const projectColumns = getProjectColumnsConfig(db, task.project_id)
      const doneStatus = getDoneStatus(projectColumns)
      db.run(`UPDATE tasks SET status = :status, updated_at = :now WHERE id = :id`, {
        ':status': doneStatus,
        ':now': new Date().toISOString(),
        ':id': task.id,
      })

      db.close()
      await notifyApp()
      console.log(`Done: ${task.id.slice(0, 8)}  ${task.title}`)
    })

  // slay tasks update
  cmd
    .command('update [id]')
    .description('Update a task (id prefix supported; defaults to $SLAYZONE_TASK_ID)')
    .option('--title <title>', 'New title')
    .option('--description <text>', 'New description')
    .option('--status <status>', 'New status key')
    .option('--priority <n>', 'New priority 1-5')
    .action(async (idPrefix, opts) => {
      idPrefix = resolveId(idPrefix)
      if (!opts.title && !opts.description && !opts.status && !opts.priority) {
        console.error('Provide at least one of --title, --description, --status, --priority')
        process.exit(1)
      }

      const db = openDb()

      const tasks = db.query<{ id: string; title: string; project_id: string }>(
        `SELECT id, title, project_id FROM tasks WHERE id LIKE :prefix || '%' LIMIT 2`,
        { ':prefix': idPrefix }
      )

      if (tasks.length === 0) { console.error(`Task not found: ${idPrefix}`); process.exit(1) }
      if (tasks.length > 1) {
        console.error(`Ambiguous id prefix "${idPrefix}". Matches: ${tasks.map((t) => t.id.slice(0, 8)).join(', ')}`)
        process.exit(1)
      }

      if (opts.priority) {
        const p = parseInt(opts.priority, 10)
        if (isNaN(p) || p < 1 || p > 5) { console.error('Priority must be 1-5.'); process.exit(1) }
      }

      const task = tasks[0]
      if (opts.status) {
        const taskColumns = getProjectColumnsConfig(db, task.project_id)
        if (!isKnownStatus(opts.status, taskColumns)) {
          console.error(`Unknown status "${opts.status}" for this task's project.`)
          process.exit(1)
        }
      }
      const sets: string[] = ['updated_at = :now']
      const params: Record<string, string | number | null> = { ':now': new Date().toISOString(), ':id': task.id }

      if (opts.title)       { sets.push('title = :title');             params[':title'] = opts.title }
      if (opts.description !== undefined) { sets.push('description = :description'); params[':description'] = opts.description || null }
      if (opts.status)      { sets.push('status = :status');           params[':status'] = opts.status }
      if (opts.priority)    { sets.push('priority = :priority');       params[':priority'] = parseInt(opts.priority, 10) }

      db.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = :id`, params)
      db.close()
      await notifyApp()
      console.log(`Updated: ${task.id.slice(0, 8)}  ${opts.title ?? task.title}`)
    })

  // slay tasks archive
  cmd
    .command('archive <id>')
    .description('Archive a task — hidden from kanban but kept in DB (id prefix supported)')
    .action(async (idPrefix) => {
      const db = openDb()

      const tasks = db.query<{ id: string; title: string }>(
        `SELECT id, title FROM tasks WHERE id LIKE :prefix || '%' AND archived_at IS NULL LIMIT 2`,
        { ':prefix': idPrefix }
      )

      if (tasks.length === 0) { console.error(`Task not found: ${idPrefix}`); process.exit(1) }
      if (tasks.length > 1) {
        console.error(`Ambiguous id prefix "${idPrefix}". Matches: ${tasks.map((t) => t.id.slice(0, 8)).join(', ')}`)
        process.exit(1)
      }

      const task = tasks[0]
      db.run(`UPDATE tasks SET archived_at = :now, updated_at = :now WHERE id = :id`, {
        ':now': new Date().toISOString(),
        ':id': task.id,
      })

      db.close()
      await notifyApp()
      console.log(`Archived: ${task.id.slice(0, 8)}  ${task.title}`)
    })

  // slay tasks delete
  cmd
    .command('delete <id>')
    .description('Permanently delete a task (id prefix supported)')
    .action(async (idPrefix) => {
      const db = openDb()

      const tasks = db.query<{ id: string; title: string }>(
        `SELECT id, title FROM tasks WHERE id LIKE :prefix || '%' LIMIT 2`,
        { ':prefix': idPrefix }
      )

      if (tasks.length === 0) { console.error(`Task not found: ${idPrefix}`); process.exit(1) }
      if (tasks.length > 1) {
        console.error(`Ambiguous id prefix "${idPrefix}". Matches: ${tasks.map((t) => t.id.slice(0, 8)).join(', ')}`)
        process.exit(1)
      }

      const task = tasks[0]
      db.run(`DELETE FROM tasks WHERE id = :id`, { ':id': task.id })
      db.close()
      await notifyApp()
      console.log(`Deleted: ${task.id.slice(0, 8)}  ${task.title}`)
    })

  // slay tasks open
  cmd
    .command('open [id]')
    .description('Open a task in the SlayZone app (id prefix supported; defaults to $SLAYZONE_TASK_ID)')
    .action(async (idPrefix) => {
      idPrefix = resolveId(idPrefix)
      const db = openDb()

      const tasks = db.query<{ id: string; title: string }>(
        `SELECT id, title FROM tasks WHERE id LIKE :prefix || '%' LIMIT 2`,
        { ':prefix': idPrefix }
      )

      if (tasks.length === 0) { console.error(`Task not found: ${idPrefix}`); process.exit(1) }
      if (tasks.length > 1) {
        console.error(`Ambiguous id prefix "${idPrefix}". Matches: ${tasks.map((t) => t.id.slice(0, 8)).join(', ')}`)
        process.exit(1)
      }

      const task = tasks[0]
      const url = `slayzone://task/${task.id}`

      const opener =
        process.platform === 'darwin' ? 'open' :
        process.platform === 'win32'  ? 'start' :
        'xdg-open'

      try {
        execSync(`${opener} "${url}"`, { stdio: 'ignore' })
        console.log(`Opening: ${task.id.slice(0, 8)}  ${task.title}`)
      } catch {
        console.error(`Failed to open URL. Try manually: ${url}`)
        process.exit(1)
      }
    })

  // slay tasks subtasks [id]
  cmd
    .command('subtasks [id]')
    .description('List subtasks of a task (id prefix supported; defaults to $SLAYZONE_TASK_ID)')
    .option('--json', 'Output as JSON')
    .action(async (idPrefix, opts) => {
      idPrefix = resolveId(idPrefix)
      const db = openDb()

      const parents = db.query<{ id: string }>(
        `SELECT id FROM tasks WHERE id LIKE :prefix || '%' LIMIT 2`,
        { ':prefix': idPrefix }
      )

      if (parents.length === 0) { console.error(`Task not found: ${idPrefix}`); process.exit(1) }
      if (parents.length > 1) {
        console.error(`Ambiguous id prefix "${idPrefix}". Matches: ${parents.map((t) => t.id.slice(0, 8)).join(', ')}`)
        process.exit(1)
      }

      const tasks = db.query<TaskRow>(
        `SELECT t.id, t.title, t.status, t.priority, p.name AS project_name, t.created_at
         FROM tasks t JOIN projects p ON t.project_id = p.id
         WHERE t.parent_id = :id AND t.archived_at IS NULL
         ORDER BY t."order" ASC`,
        { ':id': parents[0].id }
      )

      if (opts.json) {
        console.log(JSON.stringify(tasks, null, 2))
      } else {
        printTasks(tasks)
      }
    })

  // slay tasks subtask-add [parentId] <title>
  cmd
    .command('subtask-add [parentId] <title>')
    .description('Add a subtask (parentId defaults to $SLAYZONE_TASK_ID)')
    .option('--description <text>', 'Subtask description')
    .option('--status <status>', 'Initial status key')
    .option('--priority <n>', 'Priority 1-5', '3')
    .action(async (parentId, title, opts) => {
      parentId = resolveId(parentId)
      const db = openDb()

      const parents = db.query<{ id: string; project_id: string; terminal_mode: string | null }>(
        `SELECT id, project_id, terminal_mode FROM tasks WHERE id LIKE :prefix || '%' LIMIT 2`,
        { ':prefix': parentId }
      )

      if (parents.length === 0) { console.error(`Task not found: ${parentId}`); process.exit(1) }
      if (parents.length > 1) {
        console.error(`Ambiguous id prefix "${parentId}". Matches: ${parents.map((t) => t.id.slice(0, 8)).join(', ')}`)
        process.exit(1)
      }

      const parent = parents[0]

      const priority = parseInt(opts.priority, 10)
      if (isNaN(priority) || priority < 1 || priority > 5) {
        console.error('Priority must be 1-5.')
        process.exit(1)
      }
      const parentColumns = getProjectColumnsConfig(db, parent.project_id)
      if (opts.status && !isKnownStatus(opts.status, parentColumns)) {
        console.error(`Unknown status "${opts.status}" for parent task's project.`)
        process.exit(1)
      }
      const status = opts.status ?? getDefaultStatus(parentColumns)

      const terminalMode = parent.terminal_mode
        ?? (db.query<{ value: string }>(`SELECT value FROM settings WHERE key = 'default_terminal_mode' LIMIT 1`)[0]?.value)
        ?? 'claude-code'

      const id = crypto.randomUUID()
      const now = new Date().toISOString()

      db.run(
        `INSERT INTO tasks (id, project_id, parent_id, title, description, status, priority, terminal_mode, "order", created_at, updated_at, is_temporary)
         VALUES (:id, :projectId, :parentId, :title, :description, :status, :priority, :terminalMode,
           (SELECT COALESCE(MAX("order"), 0) + 1 FROM tasks WHERE project_id = :projectId),
           :now, :now, 0)`,
        {
          ':id': id,
          ':projectId': parent.project_id,
          ':parentId': parent.id,
          ':title': title,
          ':description': opts.description ?? null,
          ':status': status,
          ':priority': priority,
          ':terminalMode': terminalMode,
          ':now': now,
        }
      )

      db.close()
      await notifyApp()
      console.log(`Created subtask: ${id.slice(0, 8)}  ${title}`)
    })

  // slay tasks search <query>
  cmd
    .command('search <query>')
    .description('Search tasks by title or description (includes subtasks)')
    .option('--project <name|id>', 'Filter by project name or ID')
    .option('--limit <n>', 'Max results', '50')
    .option('--json', 'Output as JSON')
    .action(async (query, opts) => {
      const db = openDb()
      const q = `%${query.toLowerCase()}%`
      const limit = parseInt(opts.limit, 10)

      const conditions: string[] = [
        't.is_temporary = 0',
        '(LOWER(t.title) LIKE :q OR LOWER(COALESCE(t.description, \'\')) LIKE :q)',
      ]
      const params: Record<string, string | number | null> = { ':q': q, ':limit': limit }

      if (opts.project) {
        conditions.push('(p.id = :proj OR LOWER(p.name) LIKE :projLike)')
        params[':proj'] = opts.project
        params[':projLike'] = `%${opts.project.toLowerCase()}%`
      }

      const tasks = db.query<TaskRow>(
        `SELECT t.id, t.title, t.status, t.priority, p.name AS project_name, t.created_at
         FROM tasks t JOIN projects p ON t.project_id = p.id
         WHERE ${conditions.join(' AND ')}
         ORDER BY t.updated_at DESC LIMIT :limit`,
        params
      )

      if (opts.json) {
        console.log(JSON.stringify(tasks, null, 2))
      } else {
        printTasks(tasks)
      }
    })

  cmd.addCommand(browserCommand())

  return cmd
}
