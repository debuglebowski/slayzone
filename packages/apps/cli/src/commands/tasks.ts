import { Command } from 'commander'
import { execSync } from 'child_process'
import { openDb, notifyApp, resolveProject, type SlayDb } from '../db'
import { browserCommand } from './browser'
import {
  getDefaultStatus,
  getDoneStatus,
  isCompletedStatus,
  parseColumnsConfig,
  resolveStatusId,
  type ColumnConfig,
} from '@slayzone/projects/shared'
import { DEFAULT_TERMINAL_MODES } from '@slayzone/terminal/shared'

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

function buildProviderConfig(db: SlayDb): Record<string, { flags: string }> {
  let rows: { id: string; default_flags: string | null }[] = []
  try {
    rows = db.query('SELECT id, default_flags FROM terminal_modes WHERE enabled = 1')
  } catch { /* table may not exist */ }

  if (rows.length === 0) {
    rows = DEFAULT_TERMINAL_MODES
      .filter((m) => m.enabled)
      .map((m) => ({ id: m.id, default_flags: m.defaultFlags ?? '' }))
  }

  const config: Record<string, { flags: string }> = {}
  for (const row of rows) {
    config[row.id] = { flags: row.default_flags ?? '' }
  }
  return config
}

interface TemplateRow extends Record<string, unknown> {
  id: string
  terminal_mode: string | null
  default_status: string | null
  default_priority: number | null
  provider_config: string | null
}

function resolveTaskTemplate(db: SlayDb, projectId: string, templateRef?: string): TemplateRow | null {
  if (templateRef) {
    // Try ID prefix first
    let rows = db.query<TemplateRow>(
      `SELECT * FROM task_templates WHERE id LIKE :prefix || '%' AND project_id = :pid LIMIT 2`,
      { ':prefix': templateRef, ':pid': projectId }
    )
    if (rows.length === 1) return rows[0]
    if (rows.length > 1) {
      console.error(`Ambiguous template id "${templateRef}". Matches: ${rows.map((r) => r.id.slice(0, 8)).join(', ')}`)
      process.exit(1)
    }
    // Try name match
    rows = db.query<TemplateRow>(
      `SELECT * FROM task_templates WHERE project_id = :pid AND LOWER(name) = LOWER(:name) LIMIT 2`,
      { ':pid': projectId, ':name': templateRef }
    )
    if (rows.length === 1) return rows[0]
    if (rows.length > 1) {
      console.error(`Ambiguous template name "${templateRef}".`)
      process.exit(1)
    }
    console.error(`Template not found: "${templateRef}"`)
    process.exit(1)
  }
  // Check for project default
  const defaults = db.query<TemplateRow>(
    `SELECT * FROM task_templates WHERE project_id = :pid AND is_default = 1 LIMIT 1`,
    { ':pid': projectId }
  )
  return defaults[0] ?? null
}

function mergeTemplateProviderConfig(
  base: Record<string, { flags: string }>,
  template: TemplateRow | null
): Record<string, { flags: string }> {
  if (!template?.provider_config) return base
  try {
    const tpc = JSON.parse(template.provider_config) as Record<string, { flags?: string }>
    const merged = { ...base }
    for (const [mode, conf] of Object.entries(tpc)) {
      if (conf.flags !== undefined) merged[mode] = { ...merged[mode], flags: conf.flags }
    }
    return merged
  } catch {
    return base
  }
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
      let status = doneFilter ? undefined : opts.status

      if (status) {
        let listColumns: ColumnConfig[] | null = null
        if (opts.project) {
          const row = db.query<{ id: string }>(`SELECT id FROM projects WHERE id = :proj OR LOWER(name) LIKE :projLike LIMIT 1`, {
            ':proj': opts.project, ':projLike': `%${opts.project.toLowerCase()}%`
          })[0]
          if (row) listColumns = getProjectColumnsConfig(db, row.id)
        }
        status = resolveStatusId(status, listColumns) ?? status
      }

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
        // Augment with tags and due_date
        const taskIds = filteredTasks.map((t) => t.id)
        const tagMap: Record<string, string[]> = {}
        if (taskIds.length > 0) {
          const placeholders = taskIds.map((_, i) => `:t${i}`).join(', ')
          const tagParams: Record<string, string> = {}
          taskIds.forEach((id, i) => { tagParams[`:t${i}`] = id })
          const tagRows = db.query<{ task_id: string; name: string }>(
            `SELECT tt.task_id, tg.name FROM task_tags tt JOIN tags tg ON tg.id = tt.tag_id
             WHERE tt.task_id IN (${placeholders})`,
            tagParams
          )
          for (const r of tagRows) {
            (tagMap[r.task_id] ??= []).push(r.name)
          }
        }
        const enriched = filteredTasks.map((t) => ({
          ...t,
          tags: tagMap[t.id] ?? [],
        }))
        console.log(JSON.stringify(enriched, null, 2))
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
    .option('--priority <n>', 'Priority 1-5 (1=highest)')
    .option('--due <date>', 'Due date (YYYY-MM-DD or ISO 8601)')
    .option('--template <name|id>', 'Task template for defaults')
    .option('--external-id <id>', 'External ID for deduplication (skips if already exists)')
    .option('--external-provider <provider>', 'External provider namespace', 'cli')
    .action(async (title, opts) => {
      const db = openDb()
      const project = resolveProject(db, opts.project)

      if (opts.externalId) {
        const existing = db.query<{ id: string; title: string; status: string }>(
          `SELECT id, title, status FROM tasks
           WHERE project_id = :projectId AND external_provider = :provider AND external_id = :externalId
           LIMIT 1`,
          { ':projectId': project.id, ':provider': opts.externalProvider, ':externalId': opts.externalId }
        )
        if (existing.length > 0) {
          const t = existing[0]
          db.close()
          console.log(`Exists: ${t.id.slice(0, 8)}  ${t.title}  [${t.status}]  ${project.name}`)
          return
        }
      }

      // Resolve template
      const template = resolveTaskTemplate(db, project.id, opts.template)

      if (opts.priority) {
        const p = parseInt(opts.priority, 10)
        if (isNaN(p) || p < 1 || p > 5) { console.error('Priority must be 1-5.'); process.exit(1) }
      }
      const effectivePriority = opts.priority
        ? parseInt(opts.priority, 10)
        : (template?.default_priority ?? 3)

      const projectColumns = getProjectColumnsConfig(db, project.id)
      const status = opts.status
        ? resolveStatusId(opts.status, projectColumns)
        : (template?.default_status
          ? (resolveStatusId(template.default_status, projectColumns) ?? getDefaultStatus(projectColumns))
          : getDefaultStatus(projectColumns))
      if (opts.status && !status) {
        console.error(`Unknown status "${opts.status}" for project "${project.name}".`)
        process.exit(1)
      }

      const terminalMode = template?.terminal_mode
        ?? db.query<{ value: string }>(`SELECT value FROM settings WHERE key = 'default_terminal_mode' LIMIT 1`)[0]?.value
        ?? 'claude-code'

      const providerConfig = mergeTemplateProviderConfig(buildProviderConfig(db), template)
      const id = crypto.randomUUID()
      const now = new Date().toISOString()

      try {
        db.run(
          `INSERT INTO tasks (id, project_id, title, description, status, priority, due_date, terminal_mode, provider_config,
             claude_flags, codex_flags, cursor_flags, gemini_flags, opencode_flags,
             external_id, external_provider,
             "order", created_at, updated_at)
           VALUES (:id, :projectId, :title, :description, :status, :priority, :dueDate, :terminalMode, :providerConfig,
             :claudeFlags, :codexFlags, :cursorFlags, :geminiFlags, :opencodeFlags,
             :externalId, :externalProvider,
             (SELECT COALESCE(MAX("order"), 0) + 1 FROM tasks WHERE project_id = :projectId),
             :now, :now)`,
          {
            ':id': id,
            ':projectId': project.id,
            ':title': title,
            ':description': opts.description ?? null,
            ':status': status,
            ':priority': effectivePriority,
            ':dueDate': opts.due ?? null,
            ':terminalMode': terminalMode,
            ':providerConfig': JSON.stringify(providerConfig),
            ':claudeFlags': providerConfig['claude-code']?.flags ?? '',
            ':codexFlags': providerConfig['codex']?.flags ?? '',
            ':cursorFlags': providerConfig['cursor-agent']?.flags ?? '',
            ':geminiFlags': providerConfig['gemini']?.flags ?? '',
            ':opencodeFlags': providerConfig['opencode']?.flags ?? '',
            ':externalId': opts.externalId ?? null,
            ':externalProvider': opts.externalId ? opts.externalProvider : null,
            ':now': now,
          }
        )
      } catch (err: unknown) {
        if (opts.externalId && err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
          const existing = db.query<{ id: string; title: string; status: string }>(
            `SELECT id, title, status FROM tasks
             WHERE project_id = :projectId AND external_provider = :provider AND external_id = :externalId
             LIMIT 1`,
            { ':projectId': project.id, ':provider': opts.externalProvider, ':externalId': opts.externalId }
          )
          if (existing.length > 0) {
            const t = existing[0]
            db.close()
            console.log(`Exists: ${t.id.slice(0, 8)}  ${t.title}  [${t.status}]  ${project.name}`)
            return
          }
        }
        throw err
      }

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

      const tagNames = db.query<{ name: string }>(
        `SELECT tg.name FROM tags tg JOIN task_tags tt ON tg.id = tt.tag_id
         WHERE tt.task_id = :tid ORDER BY tg.sort_order, tg.name`,
        { ':tid': t.id }
      ).map((r) => r.name)
      db.close()

      console.log(`ID:       ${t.id}`)
      console.log(`Title:    ${t.title}`)
      console.log(`Status:   ${t.status}`)
      console.log(`Priority: ${t.priority}`)
      console.log(`Project:  ${t.project_name}`)
      if (t.due_date) console.log(`Due:      ${t.due_date}`)
      if (tagNames.length > 0) console.log(`Tags:     ${tagNames.join(', ')}`)
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
    .option('--due <date>', 'Set due date (YYYY-MM-DD or ISO 8601)')
    .option('--no-due', 'Clear due date')
    .action(async (idPrefix, opts) => {
      idPrefix = resolveId(idPrefix)
      if (opts.title === undefined && opts.description === undefined && opts.status === undefined
        && opts.priority === undefined && opts.due === undefined) {
        console.error('Provide at least one of --title, --description, --status, --priority, --due, --no-due')
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
      let resolvedStatus: string | undefined
      if (opts.status) {
        const taskColumns = getProjectColumnsConfig(db, task.project_id)
        resolvedStatus = resolveStatusId(opts.status, taskColumns) ?? undefined
        if (!resolvedStatus) {
          console.error(`Unknown status "${opts.status}" for this task's project.`)
          process.exit(1)
        }
      }
      const sets: string[] = ['updated_at = :now']
      const params: Record<string, string | number | null> = { ':now': new Date().toISOString(), ':id': task.id }

      if (opts.title)       { sets.push('title = :title');             params[':title'] = opts.title }
      if (opts.description !== undefined) { sets.push('description = :description'); params[':description'] = opts.description || null }
      if (resolvedStatus)   { sets.push('status = :status');           params[':status'] = resolvedStatus }
      if (opts.priority)    { sets.push('priority = :priority');       params[':priority'] = parseInt(opts.priority, 10) }
      if (typeof opts.due === 'string') { sets.push('due_date = :dueDate'); params[':dueDate'] = opts.due }
      else if (opts.due === false)      { sets.push('due_date = NULL') }

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
    .option('--external-id <id>', 'External ID for deduplication (skips if already exists)')
    .option('--external-provider <provider>', 'External provider namespace', 'cli')
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

      if (opts.externalId) {
        const existing = db.query<{ id: string; title: string; status: string }>(
          `SELECT id, title, status FROM tasks
           WHERE project_id = :projectId AND external_provider = :provider AND external_id = :externalId
           LIMIT 1`,
          { ':projectId': parent.project_id, ':provider': opts.externalProvider, ':externalId': opts.externalId }
        )
        if (existing.length > 0) {
          const t = existing[0]
          db.close()
          console.log(`Exists: ${t.id.slice(0, 8)}  ${t.title}  [${t.status}]`)
          return
        }
      }

      const priority = parseInt(opts.priority, 10)
      if (isNaN(priority) || priority < 1 || priority > 5) {
        console.error('Priority must be 1-5.')
        process.exit(1)
      }
      const parentColumns = getProjectColumnsConfig(db, parent.project_id)
      const status = opts.status ? resolveStatusId(opts.status, parentColumns) : getDefaultStatus(parentColumns)
      if (opts.status && !status) {
        console.error(`Unknown status "${opts.status}" for parent task's project.`)
        process.exit(1)
      }

      const terminalMode = parent.terminal_mode
        ?? (db.query<{ value: string }>(`SELECT value FROM settings WHERE key = 'default_terminal_mode' LIMIT 1`)[0]?.value)
        ?? 'claude-code'

      const providerConfig = buildProviderConfig(db)
      const id = crypto.randomUUID()
      const now = new Date().toISOString()

      try {
        db.run(
          `INSERT INTO tasks (id, project_id, parent_id, title, description, status, priority, terminal_mode, provider_config,
             claude_flags, codex_flags, cursor_flags, gemini_flags, opencode_flags,
             external_id, external_provider,
             "order", created_at, updated_at, is_temporary)
           VALUES (:id, :projectId, :parentId, :title, :description, :status, :priority, :terminalMode, :providerConfig,
             :claudeFlags, :codexFlags, :cursorFlags, :geminiFlags, :opencodeFlags,
             :externalId, :externalProvider,
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
            ':providerConfig': JSON.stringify(providerConfig),
            ':claudeFlags': providerConfig['claude-code']?.flags ?? '',
            ':codexFlags': providerConfig['codex']?.flags ?? '',
            ':cursorFlags': providerConfig['cursor-agent']?.flags ?? '',
            ':geminiFlags': providerConfig['gemini']?.flags ?? '',
            ':opencodeFlags': providerConfig['opencode']?.flags ?? '',
            ':externalId': opts.externalId ?? null,
            ':externalProvider': opts.externalId ? opts.externalProvider : null,
            ':now': now,
          }
        )
      } catch (err: unknown) {
        if (opts.externalId && err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
          const existing = db.query<{ id: string; title: string; status: string }>(
            `SELECT id, title, status FROM tasks
             WHERE project_id = :projectId AND external_provider = :provider AND external_id = :externalId
             LIMIT 1`,
            { ':projectId': parent.project_id, ':provider': opts.externalProvider, ':externalId': opts.externalId }
          )
          if (existing.length > 0) {
            const t = existing[0]
            db.close()
            console.log(`Exists: ${t.id.slice(0, 8)}  ${t.title}  [${t.status}]`)
            return
          }
        }
        throw err
      }

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

  // slay tasks tag [taskId]
  cmd
    .command('tag [taskId]')
    .description('View or modify tags on a task (defaults to $SLAYZONE_TASK_ID)')
    .option('--set <names...>', 'Replace all tags with these (by name)')
    .option('--add <name>', 'Add a tag by name')
    .option('--remove <name>', 'Remove a tag by name')
    .option('--clear', 'Remove all tags')
    .option('--json', 'Output as JSON')
    .action(async (taskId, opts) => {
      taskId = resolveId(taskId)
      const db = openDb()

      const tasks = db.query<{ id: string; project_id: string }>(
        `SELECT id, project_id FROM tasks WHERE id LIKE :prefix || '%' LIMIT 2`,
        { ':prefix': taskId }
      )
      if (tasks.length === 0) { console.error(`Task not found: ${taskId}`); process.exit(1) }
      if (tasks.length > 1) {
        console.error(`Ambiguous id prefix "${taskId}". Matches: ${tasks.map((t) => t.id.slice(0, 8)).join(', ')}`)
        process.exit(1)
      }

      const task = tasks[0]

      function resolveTagByName(name: string): string {
        const tags = db.query<{ id: string; name: string }>(
          `SELECT id, name FROM tags WHERE project_id = :pid AND LOWER(name) = LOWER(:name)`,
          { ':pid': task.project_id, ':name': name }
        )
        if (tags.length === 0) {
          console.error(`Tag not found: "${name}" in this project`)
          process.exit(1)
        }
        return tags[0].id
      }

      const isWrite = opts.set || opts.add || opts.remove || opts.clear

      if (isWrite) {
        db.run('BEGIN')
        try {
          if (opts.set) {
            const tagIds = (opts.set as string[]).map(resolveTagByName)
            db.run(`DELETE FROM task_tags WHERE task_id = :tid`, { ':tid': task.id })
            for (const tagId of tagIds) {
              db.run(`INSERT INTO task_tags (task_id, tag_id) VALUES (:tid, :tagId)`, { ':tid': task.id, ':tagId': tagId })
            }
          } else if (opts.add) {
            const tagId = resolveTagByName(opts.add)
            db.run(
              `INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (:tid, :tagId)`,
              { ':tid': task.id, ':tagId': tagId }
            )
          } else if (opts.remove) {
            const tagId = resolveTagByName(opts.remove)
            db.run(`DELETE FROM task_tags WHERE task_id = :tid AND tag_id = :tagId`, { ':tid': task.id, ':tagId': tagId })
          } else if (opts.clear) {
            db.run(`DELETE FROM task_tags WHERE task_id = :tid`, { ':tid': task.id })
          }
          db.run('COMMIT')
        } catch (e) {
          db.run('ROLLBACK')
          throw e
        }
      }

      // Show current tags
      const tagNames = db.query<{ name: string }>(
        `SELECT tg.name FROM tags tg JOIN task_tags tt ON tg.id = tt.tag_id
         WHERE tt.task_id = :tid ORDER BY tg.sort_order, tg.name`,
        { ':tid': task.id }
      ).map((r) => r.name)
      db.close()

      if (isWrite) await notifyApp()

      if (opts.json) {
        console.log(JSON.stringify(tagNames))
      } else if (tagNames.length > 0) {
        console.log(tagNames.join(', '))
      } else {
        console.log('No tags.')
      }
    })

  cmd.addCommand(browserCommand())

  return cmd
}
