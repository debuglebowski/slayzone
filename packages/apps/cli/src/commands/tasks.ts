import { Command } from 'commander'
import http from 'node:http'
import { openDb, notifyApp, resolveProject, getAssetsDir, getMcpPort, type SlayDb } from '../db'
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
import {
  getExtensionFromTitle,
  getEffectiveRenderMode,
  isBinaryRenderMode,
  canExportAsPdf,
  canExportAsPng,
  canExportAsHtml,
  type RenderMode,
} from '@slayzone/task/shared/types'
import { apiPost } from '../api'
import archiver from 'archiver'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

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

function printTasks(tasks: TaskRow[], blockedIds?: Set<string>) {
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
    const prefix = blockedIds?.has(t.id) ? '[B] ' : ''
    console.log(`${id}  ${status}  ${project}  ${prefix}${t.title}`)
  }
}

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

      // Query blocked task IDs
      const blockedRows = db.query<{ id: string }>(
        `SELECT DISTINCT blocks_task_id AS id FROM task_dependencies
         UNION
         SELECT id FROM tasks WHERE is_blocked = 1 AND deleted_at IS NULL`
      )
      const blockedIds = new Set(blockedRows.map((r) => r.id))

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
          is_blocked: blockedIds.has(t.id),
          tags: tagMap[t.id] ?? [],
        }))
        console.log(JSON.stringify(enriched, null, 2))
      } else {
        printTasks(filteredTasks, blockedIds)
      }
    })

  // slay tasks create
  cmd
    .command('create <title>')
    .description('Create a new task')
    .requiredOption('--project <name|id>', 'Project name (partial, case-insensitive) or ID')
    .option('--description <text>', 'Task description (reference task specific assets via `[title](asset:<asset-id>)`)')
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

      const blockers = db.query<{ id: string; title: string }>(
        `SELECT t.id, t.title FROM tasks t JOIN task_dependencies td ON t.id = td.task_id
         WHERE td.blocks_task_id = :tid`,
        { ':tid': t.id }
      )
      const blocking = db.query<{ id: string; title: string }>(
        `SELECT t.id, t.title FROM tasks t JOIN task_dependencies td ON t.id = td.blocks_task_id
         WHERE td.task_id = :tid`,
        { ':tid': t.id }
      )
      db.close()

      console.log(`ID:       ${t.id}`)
      console.log(`Title:    ${t.title}`)
      console.log(`Status:   ${t.status}`)
      console.log(`Priority: ${t.priority}`)
      console.log(`Project:  ${t.project_name}`)
      if (t.due_date) console.log(`Due:      ${t.due_date}`)
      if (tagNames.length > 0) console.log(`Tags:     ${tagNames.join(', ')}`)
      if ((t as Record<string, unknown>).is_blocked) {
        const comment = (t as Record<string, unknown>).blocked_comment
        console.log(`Blocked:  yes${comment ? ` (${comment})` : ''}`)
      }
      if (blockers.length > 0) console.log(`Blockers: ${blockers.map((b) => `${b.id.slice(0, 8)} (${b.title})`).join(', ')}`)
      if (blocking.length > 0) console.log(`Blocking: ${blocking.map((b) => `${b.id.slice(0, 8)} (${b.title})`).join(', ')}`)
      console.log(`Created:  ${t.created_at}`)
      if (t.description) console.log(`\n${t.description}`)
    })

  // slay tasks done
  cmd
    .command('done [id]')
    .description('Mark a task as done (id prefix supported; defaults to $SLAYZONE_TASK_ID)')
    .option('--close', 'Also close the task tab in the app')
    .action(async (idPrefix, opts) => {
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

      if (opts.close) {
        const port = getMcpPort()
        if (port) {
          await new Promise<void>((resolve) => {
            const req = http.request(
              { hostname: '127.0.0.1', port, path: `/api/close-task/${task.id}`, method: 'POST' },
              (res) => { res.resume(); res.on('end', resolve) },
            )
            req.on('error', () => resolve())
            req.setTimeout(3000, () => { req.destroy(); resolve() })
            req.end()
          })
        }
      }
    })

  // slay tasks update
  cmd
    .command('update [id]')
    .description('Update a task (id prefix supported; defaults to $SLAYZONE_TASK_ID)')
    .option('--title <title>', 'New title')
    .option('--description <text>', 'New description (reference task specific assets via `[title](asset:<asset-id>)`)')
    .option('--append-description <text>', 'Append to existing description')
    .option('--status <status>', 'New status key')
    .option('--priority <n>', 'New priority 1-5')
    .option('--due <date>', 'Set due date (YYYY-MM-DD or ISO 8601)')
    .option('--no-due', 'Clear due date')
    .option('--permanent', 'Convert temporary task to a real task')
    .action(async (idPrefix, opts) => {
      idPrefix = resolveId(idPrefix)
      if (opts.description !== undefined && opts.appendDescription !== undefined) {
        console.error('Cannot use both --description and --append-description.')
        process.exit(1)
      }
      if (opts.title === undefined && opts.description === undefined && opts.appendDescription === undefined && opts.status === undefined
        && opts.priority === undefined && opts.due === undefined && !opts.permanent) {
        console.error('Provide at least one of --title, --description, --append-description, --status, --priority, --due, --no-due, --permanent')
        process.exit(1)
      }

      const db = openDb()

      const tasks = db.query<{ id: string; title: string; project_id: string; description: string | null }>(
        `SELECT id, title, project_id, description FROM tasks WHERE id LIKE :prefix || '%' LIMIT 2`,
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
      if (opts.appendDescription) { sets.push('description = :description'); params[':description'] = (task.description ?? '') + '\n' + opts.appendDescription }
      if (resolvedStatus)   { sets.push('status = :status');           params[':status'] = resolvedStatus }
      if (opts.priority)    { sets.push('priority = :priority');       params[':priority'] = parseInt(opts.priority, 10) }
      if (typeof opts.due === 'string') { sets.push('due_date = :dueDate'); params[':dueDate'] = opts.due }
      else if (opts.due === false)      { sets.push('due_date = NULL') }
      if (opts.permanent)   { sets.push('is_temporary = 0') }

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
      db.close()

      const port = getMcpPort()
      if (!port) {
        console.error('No running SlayZone app found. Start the app first.')
        process.exit(1)
      }

      await new Promise<void>((resolve) => {
        const req = http.request(
          { hostname: '127.0.0.1', port, path: `/api/open-task/${task.id}`, method: 'POST' },
          (res) => { res.resume(); res.on('end', resolve) },
        )
        req.on('error', () => {
          console.error('Failed to reach SlayZone app. Is it running?')
          process.exit(1)
        })
        req.setTimeout(3000, () => { req.destroy(); console.error('Timed out reaching SlayZone app'); process.exit(1) })
        req.end()
      })
      console.log(`Opening: ${task.id.slice(0, 8)}  ${task.title}`)
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

  // slay tasks blockers [id]
  cmd
    .command('blockers [id]')
    .description('View or modify tasks that block this task (defaults to $SLAYZONE_TASK_ID)')
    .option('--add <ids...>', 'Add blocking tasks by ID prefix')
    .option('--remove <ids...>', 'Remove blocking tasks by ID prefix')
    .option('--set <ids...>', 'Replace all blockers with these tasks')
    .option('--clear', 'Remove all blockers')
    .option('--json', 'Output as JSON')
    .action(async (taskId, opts) => {
      taskId = resolveId(taskId)
      const db = openDb()

      const tasks = db.query<{ id: string }>(
        `SELECT id FROM tasks WHERE id LIKE :prefix || '%' LIMIT 2`,
        { ':prefix': taskId }
      )
      if (tasks.length === 0) { console.error(`Task not found: ${taskId}`); process.exit(1) }
      if (tasks.length > 1) {
        console.error(`Ambiguous id prefix "${taskId}". Matches: ${tasks.map((t) => t.id.slice(0, 8)).join(', ')}`)
        process.exit(1)
      }

      const task = tasks[0]

      function resolveTaskId(prefix: string): string {
        if (prefix === task.id || prefix === task.id.slice(0, prefix.length)) {
          // Check exact self-reference
          if (prefix === task.id || db.query<{ id: string }>(`SELECT id FROM tasks WHERE id LIKE :p || '%' LIMIT 1`, { ':p': prefix })[0]?.id === task.id) {
            console.error(`A task cannot block itself.`)
            process.exit(1)
          }
        }
        const matches = db.query<{ id: string }>(
          `SELECT id FROM tasks WHERE id LIKE :p || '%' LIMIT 2`,
          { ':p': prefix }
        )
        if (matches.length === 0) { console.error(`Task not found: ${prefix}`); process.exit(1) }
        if (matches.length > 1) {
          console.error(`Ambiguous id prefix "${prefix}". Matches: ${matches.map((t) => t.id.slice(0, 8)).join(', ')}`)
          process.exit(1)
        }
        if (matches[0].id === task.id) {
          console.error(`A task cannot block itself.`)
          process.exit(1)
        }
        return matches[0].id
      }

      const isWrite = opts.add || opts.remove || opts.set || opts.clear

      if (isWrite) {
        db.run('BEGIN')
        try {
          if (opts.set) {
            const blockerIds = (opts.set as string[]).map(resolveTaskId)
            db.run(`DELETE FROM task_dependencies WHERE blocks_task_id = :tid`, { ':tid': task.id })
            for (const bid of blockerIds) {
              db.run(`INSERT OR IGNORE INTO task_dependencies (task_id, blocks_task_id) VALUES (:bid, :tid)`, { ':bid': bid, ':tid': task.id })
            }
          } else if (opts.add) {
            for (const prefix of opts.add as string[]) {
              const bid = resolveTaskId(prefix)
              db.run(`INSERT OR IGNORE INTO task_dependencies (task_id, blocks_task_id) VALUES (:bid, :tid)`, { ':bid': bid, ':tid': task.id })
            }
          } else if (opts.remove) {
            for (const prefix of opts.remove as string[]) {
              const bid = resolveTaskId(prefix)
              db.run(`DELETE FROM task_dependencies WHERE task_id = :bid AND blocks_task_id = :tid`, { ':bid': bid, ':tid': task.id })
            }
          } else if (opts.clear) {
            db.run(`DELETE FROM task_dependencies WHERE blocks_task_id = :tid`, { ':tid': task.id })
          }
          db.run('COMMIT')
        } catch (e) {
          db.run('ROLLBACK')
          throw e
        }
      }

      // Show current blockers
      const blockers = db.query<TaskRow>(
        `SELECT t.id, t.project_id, t.title, t.status, t.priority, p.name AS project_name, t.created_at
         FROM tasks t JOIN task_dependencies td ON t.id = td.task_id
         JOIN projects p ON t.project_id = p.id
         WHERE td.blocks_task_id = :tid`,
        { ':tid': task.id }
      )
      db.close()

      if (isWrite) await notifyApp()

      if (opts.json) {
        console.log(JSON.stringify(blockers, null, 2))
      } else if (blockers.length > 0) {
        printTasks(blockers)
      } else {
        console.log('No blockers.')
      }
    })

  // slay tasks blocking [id]
  cmd
    .command('blocking [id]')
    .description('List tasks that this task is blocking (defaults to $SLAYZONE_TASK_ID)')
    .option('--json', 'Output as JSON')
    .action(async (taskId, opts) => {
      taskId = resolveId(taskId)
      const db = openDb()

      const tasks = db.query<{ id: string }>(
        `SELECT id FROM tasks WHERE id LIKE :prefix || '%' LIMIT 2`,
        { ':prefix': taskId }
      )
      if (tasks.length === 0) { console.error(`Task not found: ${taskId}`); process.exit(1) }
      if (tasks.length > 1) {
        console.error(`Ambiguous id prefix "${taskId}". Matches: ${tasks.map((t) => t.id.slice(0, 8)).join(', ')}`)
        process.exit(1)
      }

      const task = tasks[0]

      const blocking = db.query<TaskRow>(
        `SELECT t.id, t.project_id, t.title, t.status, t.priority, p.name AS project_name, t.created_at
         FROM tasks t JOIN task_dependencies td ON t.id = td.blocks_task_id
         JOIN projects p ON t.project_id = p.id
         WHERE td.task_id = :tid`,
        { ':tid': task.id }
      )
      db.close()

      if (opts.json) {
        console.log(JSON.stringify(blocking, null, 2))
      } else if (blocking.length > 0) {
        printTasks(blocking)
      } else {
        console.log('Not blocking any tasks.')
      }
    })

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
    .action(async (taskId, opts) => {
      taskId = resolveId(taskId)
      const db = openDb()

      const tasks = db.query<{ id: string; is_blocked: number; blocked_comment: string | null }>(
        `SELECT id, is_blocked, blocked_comment FROM tasks WHERE id LIKE :prefix || '%' LIMIT 2`,
        { ':prefix': taskId }
      )
      if (tasks.length === 0) { console.error(`Task not found: ${taskId}`); process.exit(1) }
      if (tasks.length > 1) {
        console.error(`Ambiguous id prefix "${taskId}". Matches: ${tasks.map((t) => t.id.slice(0, 8)).join(', ')}`)
        process.exit(1)
      }

      const task = tasks[0]
      const now = new Date().toISOString()

      if (opts.on) {
        db.run(`UPDATE tasks SET is_blocked = 1, updated_at = :now WHERE id = :id`, { ':now': now, ':id': task.id })
      } else if (opts.off) {
        db.run(`UPDATE tasks SET is_blocked = 0, blocked_comment = NULL, updated_at = :now WHERE id = :id`, { ':now': now, ':id': task.id })
      } else if (opts.toggle) {
        const newVal = task.is_blocked ? 0 : 1
        if (newVal === 0) {
          db.run(`UPDATE tasks SET is_blocked = 0, blocked_comment = NULL, updated_at = :now WHERE id = :id`, { ':now': now, ':id': task.id })
        } else {
          db.run(`UPDATE tasks SET is_blocked = 1, updated_at = :now WHERE id = :id`, { ':now': now, ':id': task.id })
        }
      } else if (opts.comment !== undefined && opts.comment !== false) {
        db.run(`UPDATE tasks SET is_blocked = 1, blocked_comment = :comment, updated_at = :now WHERE id = :id`, { ':comment': opts.comment, ':now': now, ':id': task.id })
      } else if (opts.comment === false) {
        // --no-comment (commander sets opts.comment = false when --no-comment is used)
        db.run(`UPDATE tasks SET blocked_comment = NULL, updated_at = :now WHERE id = :id`, { ':now': now, ':id': task.id })
      }

      const isWrite = opts.on || opts.off || opts.toggle || opts.comment !== undefined

      // Re-read current state
      const updated = db.query<{ is_blocked: number; blocked_comment: string | null }>(
        `SELECT is_blocked, blocked_comment FROM tasks WHERE id = :id`,
        { ':id': task.id }
      )[0]

      // Also show dependency-based blockers for context
      const blockers = db.query<{ id: string; title: string }>(
        `SELECT t.id, t.title FROM tasks t JOIN task_dependencies td ON t.id = td.task_id
         WHERE td.blocks_task_id = :tid`,
        { ':tid': task.id }
      )
      db.close()

      if (isWrite) await notifyApp()

      if (opts.json) {
        console.log(JSON.stringify({
          is_blocked: Boolean(updated.is_blocked),
          blocked_comment: updated.blocked_comment,
          blockers: blockers.map((b) => ({ id: b.id, title: b.title })),
        }, null, 2))
      } else {
        console.log(`Blocked: ${updated.is_blocked ? 'yes' : 'no'}${updated.blocked_comment ? ` (${updated.blocked_comment})` : ''}`)
        if (blockers.length > 0) {
          console.log(`Blockers: ${blockers.map((b) => `${b.id.slice(0, 8)} (${b.title})`).join(', ')}`)
        }
      }
    })

  cmd.addCommand(browserCommand())
  cmd.addCommand(assetsSubcommand())

  return cmd
}

// --- Task Assets ---

interface AssetRow extends Record<string, unknown> {
  id: string
  task_id: string
  folder_id: string | null
  title: string
  render_mode: string | null
  language: string | null
  order: number
  created_at: string
  updated_at: string
}

interface AssetFolderRow extends Record<string, unknown> {
  id: string
  task_id: string
  parent_id: string | null
  name: string
  order: number
  created_at: string
}

function resolveAsset(db: SlayDb, prefix: string): AssetRow {
  const rows = db.query<AssetRow>(
    `SELECT * FROM task_assets WHERE id LIKE :prefix || '%' LIMIT 2`,
    { ':prefix': prefix }
  )
  if (rows.length === 0) {
    console.error(`Asset not found: "${prefix}"`)
    process.exit(1)
  }
  if (rows.length > 1) {
    console.error(`Ambiguous asset id "${prefix}". Matches: ${rows.map((r) => r.id.slice(0, 8)).join(', ')}`)
    process.exit(1)
  }
  return rows[0]
}

function resolveTaskForAsset(db: SlayDb, taskOpt?: string): { id: string; title: string } {
  const ref = taskOpt ?? process.env.SLAYZONE_TASK_ID
  if (!ref) {
    console.error('No task ID provided and $SLAYZONE_TASK_ID is not set.')
    process.exit(1)
  }
  const rows = db.query<{ id: string; title: string }>(
    `SELECT id, title FROM tasks WHERE id LIKE :prefix || '%' LIMIT 2`,
    { ':prefix': ref }
  )
  if (rows.length === 0) {
    console.error(`Task not found: "${ref}"`)
    process.exit(1)
  }
  if (rows.length > 1) {
    console.error(`Ambiguous task id "${ref}". Matches: ${rows.map((r) => r.id.slice(0, 8)).join(', ')}`)
    process.exit(1)
  }
  return rows[0]
}

function resolveFolder(db: SlayDb, prefix: string): AssetFolderRow {
  const rows = db.query<AssetFolderRow>(
    `SELECT * FROM asset_folders WHERE id LIKE :prefix || '%' LIMIT 2`,
    { ':prefix': prefix }
  )
  if (rows.length === 0) {
    console.error(`Folder not found: "${prefix}"`)
    process.exit(1)
  }
  if (rows.length > 1) {
    console.error(`Ambiguous folder id "${prefix}". Matches: ${rows.map((r) => r.id.slice(0, 8)).join(', ')}`)
    process.exit(1)
  }
  return rows[0]
}

function assetFilePath(assetsDir: string, taskId: string, assetId: string, title: string): string {
  const ext = getExtensionFromTitle(title) || '.txt'
  return path.join(assetsDir, taskId, `${assetId}${ext}`)
}

function printAssets(assets: AssetRow[], folders?: AssetFolderRow[]) {
  if (assets.length === 0) {
    console.log('No assets.')
    return
  }
  const folderMap = new Map((folders ?? []).map(f => [f.id, f.name]))
  const idW = 9
  const titleW = 24
  const modeW = 16
  const folderW = 14
  console.log(`${'ID'.padEnd(idW)}  ${'TITLE'.padEnd(titleW)}  ${'FOLDER'.padEnd(folderW)}  ${'MODE'.padEnd(modeW)}  CREATED`)
  console.log(`${'-'.repeat(idW)}  ${'-'.repeat(titleW)}  ${'-'.repeat(folderW)}  ${'-'.repeat(modeW)}  ${'-'.repeat(20)}`)
  for (const a of assets) {
    const id = a.id.slice(0, 8).padEnd(idW)
    const title = a.title.slice(0, titleW).padEnd(titleW)
    const folder = (a.folder_id ? (folderMap.get(a.folder_id) ?? '?') : '').slice(0, folderW).padEnd(folderW)
    const mode = getEffectiveRenderMode(a.title, a.render_mode as RenderMode | null).padEnd(modeW)
    const created = a.created_at.slice(0, 19)
    console.log(`${id}  ${title}  ${folder}  ${mode}  ${created}`)
  }
}

function printAssetTree(assets: AssetRow[], folders: AssetFolderRow[]) {
  if (assets.length === 0 && folders.length === 0) {
    console.log('No assets.')
    return
  }
  // Build folder path map
  const byId = new Map(folders.map(f => [f.id, f]))
  function folderPath(id: string): string {
    const f = byId.get(id)
    if (!f) return '?'
    return f.parent_id ? `${folderPath(f.parent_id)}/${f.name}` : f.name
  }

  // Group: parentId -> children
  const childFolders = new Map<string | null, AssetFolderRow[]>()
  for (const f of folders) {
    const arr = childFolders.get(f.parent_id) ?? []
    arr.push(f)
    childFolders.set(f.parent_id, arr)
  }
  const assetsByFolder = new Map<string | null, AssetRow[]>()
  for (const a of assets) {
    const arr = assetsByFolder.get(a.folder_id) ?? []
    arr.push(a)
    assetsByFolder.set(a.folder_id, arr)
  }

  function printLevel(parentId: string | null, indent: string) {
    const subFolders = childFolders.get(parentId) ?? []
    for (const f of subFolders) {
      console.log(`${indent}${f.name}/  (${f.id.slice(0, 8)})`)
      printLevel(f.id, indent + '  ')
    }
    const subAssets = assetsByFolder.get(parentId) ?? []
    for (const a of subAssets) {
      console.log(`${indent}${a.title}  (${a.id.slice(0, 8)})`)
    }
  }

  printLevel(null, '')
}

async function readStdin(): Promise<Buffer> {
  if (process.stdin.isTTY) {
    console.error('No content provided. Pipe content via stdin.')
    process.exit(1)
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function assetsSubcommand(): Command {
  const cmd = new Command('assets')
    .description('Manage task assets')
    .showSuggestionAfterError(true)
    .showHelpAfterError(true)

  // slay tasks assets list <taskId>
  cmd
    .command('list <taskId>')
    .description('List assets for a task')
    .option('--json', 'Output as JSON')
    .option('--tree', 'Show as indented tree')
    .action(async (taskId: string, opts) => {
      const db = openDb()
      const task = resolveTaskForAsset(db, taskId)
      const rows = db.query<AssetRow>(
        `SELECT * FROM task_assets WHERE task_id = :taskId ORDER BY "order" ASC, created_at ASC`,
        { ':taskId': task.id }
      )
      const folderRows = db.query<AssetFolderRow>(
        `SELECT * FROM asset_folders WHERE task_id = :taskId ORDER BY "order" ASC, created_at ASC`,
        { ':taskId': task.id }
      )
      db.close()
      if (opts.json) {
        console.log(JSON.stringify({ folders: folderRows, assets: rows }, null, 2))
      } else if (opts.tree) {
        printAssetTree(rows, folderRows)
      } else {
        printAssets(rows, folderRows)
      }
    })

  // slay tasks assets read <assetId>
  cmd
    .command('read <assetId>')
    .description('Output asset content to stdout')
    .action(async (assetId: string) => {
      const db = openDb()
      const asset = resolveAsset(db, assetId)
      db.close()
      const dir = getAssetsDir()
      const fp = assetFilePath(dir, asset.task_id, asset.id, asset.title)
      if (!fs.existsSync(fp)) return
      const mode = getEffectiveRenderMode(asset.title, asset.render_mode as RenderMode | null)
      if (isBinaryRenderMode(mode)) {
        process.stdout.write(fs.readFileSync(fp))
      } else {
        process.stdout.write(fs.readFileSync(fp, 'utf-8'))
      }
    })

  // slay tasks assets create <title>
  cmd
    .command('create <title>')
    .description('Create a new asset')
    .option('--task <id>', 'Task ID (or $SLAYZONE_TASK_ID)')
    .option('--folder <id>', 'Folder ID to create asset in')
    .option('--copy-from <path>', 'Copy content from file')
    .option('--render-mode <mode>', 'Override render mode')
    .option('--json', 'Output as JSON')
    .action(async (title: string, opts) => {
      const db = openDb()
      const task = resolveTaskForAsset(db, opts.task)
      const folderId = opts.folder ? resolveFolder(db, opts.folder).id : null
      const id = crypto.randomUUID()
      const now = new Date().toISOString()
      const maxOrder = db.query<{ m: number | null }>(
        folderId
          ? `SELECT MAX("order") as m FROM task_assets WHERE task_id = :taskId AND folder_id = :folderId`
          : `SELECT MAX("order") as m FROM task_assets WHERE task_id = :taskId AND folder_id IS NULL`,
        folderId ? { ':taskId': task.id, ':folderId': folderId } : { ':taskId': task.id }
      )[0]?.m ?? -1

      db.run(
        `INSERT INTO task_assets (id, task_id, folder_id, title, render_mode, "order", created_at, updated_at)
         VALUES (:id, :taskId, :folderId, :title, :renderMode, :order, :now, :now)`,
        {
          ':id': id,
          ':taskId': task.id,
          ':folderId': folderId,
          ':title': title,
          ':renderMode': opts.renderMode ?? null,
          ':order': maxOrder + 1,
          ':now': now,
        }
      )

      const dir = getAssetsDir()
      const fp = assetFilePath(dir, task.id, id, title)
      fs.mkdirSync(path.dirname(fp), { recursive: true })

      if (opts.copyFrom) {
        if (!fs.existsSync(opts.copyFrom)) {
          console.error(`File not found: ${opts.copyFrom}`)
          process.exit(1)
        }
        fs.copyFileSync(opts.copyFrom, fp)
      } else {
        const content = await readStdin()
        fs.writeFileSync(fp, content)
      }

      db.close()
      await notifyApp()

      if (opts.json) {
        console.log(JSON.stringify({ id, task_id: task.id, title, render_mode: opts.renderMode ?? null, order: maxOrder + 1, created_at: now, updated_at: now }, null, 2))
      } else {
        console.log(`Created: ${id.slice(0, 8)}  ${title}`)
      }
    })

  // slay tasks assets upload <sourcePath>
  cmd
    .command('upload <sourcePath>')
    .description('Upload a file as an asset')
    .option('--task <id>', 'Task ID (or $SLAYZONE_TASK_ID)')
    .option('--title <name>', 'Asset title (defaults to filename)')
    .option('--json', 'Output as JSON')
    .action(async (sourcePath: string, opts) => {
      if (!fs.existsSync(sourcePath)) {
        console.error(`File not found: ${sourcePath}`)
        process.exit(1)
      }
      const db = openDb()
      const task = resolveTaskForAsset(db, opts.task)
      const id = crypto.randomUUID()
      const title = opts.title ?? path.basename(sourcePath)
      const now = new Date().toISOString()
      const maxOrder = db.query<{ m: number | null }>(
        `SELECT MAX("order") as m FROM task_assets WHERE task_id = :taskId`,
        { ':taskId': task.id }
      )[0]?.m ?? -1

      db.run(
        `INSERT INTO task_assets (id, task_id, title, "order", created_at, updated_at)
         VALUES (:id, :taskId, :title, :order, :now, :now)`,
        { ':id': id, ':taskId': task.id, ':title': title, ':order': maxOrder + 1, ':now': now }
      )

      const dir = getAssetsDir()
      const fp = assetFilePath(dir, task.id, id, title)
      fs.mkdirSync(path.dirname(fp), { recursive: true })
      fs.copyFileSync(sourcePath, fp)

      db.close()
      await notifyApp()

      if (opts.json) {
        console.log(JSON.stringify({ id, task_id: task.id, title, order: maxOrder + 1, created_at: now, updated_at: now }, null, 2))
      } else {
        console.log(`Uploaded: ${id.slice(0, 8)}  ${title}`)
      }
    })

  // slay tasks assets update <assetId>
  cmd
    .command('update <assetId>')
    .description('Update asset metadata')
    .option('--title <name>', 'New title')
    .option('--render-mode <mode>', 'New render mode')
    .option('--json', 'Output as JSON')
    .action(async (assetId: string, opts) => {
      if (!opts.title && !opts.renderMode) {
        console.error('Provide at least one of --title, --render-mode.')
        process.exit(1)
      }
      const db = openDb()
      const asset = resolveAsset(db, assetId)

      const sets: string[] = []
      const params: Record<string, string | number | bigint | null | Uint8Array> = { ':id': asset.id }

      if (opts.title !== undefined) {
        sets.push('title = :title')
        params[':title'] = opts.title
      }
      if (opts.renderMode !== undefined) {
        sets.push('render_mode = :renderMode')
        params[':renderMode'] = opts.renderMode
      }
      sets.push("updated_at = :now")
      params[':now'] = new Date().toISOString()

      db.run(`UPDATE task_assets SET ${sets.join(', ')} WHERE id = :id`, params)

      // Rename file on disk if extension changed
      if (opts.title) {
        const dir = getAssetsDir()
        const oldExt = getExtensionFromTitle(asset.title) || '.txt'
        const newExt = getExtensionFromTitle(opts.title) || '.txt'
        if (oldExt !== newExt) {
          const oldPath = path.join(dir, asset.task_id, `${asset.id}${oldExt}`)
          const newPath = path.join(dir, asset.task_id, `${asset.id}${newExt}`)
          if (fs.existsSync(oldPath)) {
            const content = fs.readFileSync(oldPath)
            fs.writeFileSync(newPath, content)
            fs.unlinkSync(oldPath)
          }
        }
      }

      db.close()
      await notifyApp()

      const newTitle = opts.title ?? asset.title
      if (opts.json) {
        const updated = { ...asset, title: newTitle, render_mode: opts.renderMode ?? asset.render_mode, updated_at: params[':now'] }
        console.log(JSON.stringify(updated, null, 2))
      } else {
        console.log(`Updated: ${asset.id.slice(0, 8)}  ${newTitle}`)
      }
    })

  // slay tasks assets write <assetId>
  cmd
    .command('write <assetId>')
    .description('Replace asset content from stdin')
    .action(async (assetId: string) => {
      const db = openDb()
      const asset = resolveAsset(db, assetId)
      db.run(
        `UPDATE task_assets SET updated_at = :now WHERE id = :id`,
        { ':id': asset.id, ':now': new Date().toISOString() }
      )
      db.close()

      const content = await readStdin()
      const dir = getAssetsDir()
      const fp = assetFilePath(dir, asset.task_id, asset.id, asset.title)
      fs.mkdirSync(path.dirname(fp), { recursive: true })
      fs.writeFileSync(fp, content)

      await notifyApp()
      console.log(`Written: ${asset.id.slice(0, 8)}  ${asset.title}`)
    })

  // slay tasks assets append <assetId>
  cmd
    .command('append <assetId>')
    .description('Append to asset content from stdin')
    .action(async (assetId: string) => {
      const db = openDb()
      const asset = resolveAsset(db, assetId)
      db.run(
        `UPDATE task_assets SET updated_at = :now WHERE id = :id`,
        { ':id': asset.id, ':now': new Date().toISOString() }
      )
      db.close()

      const content = await readStdin()
      const dir = getAssetsDir()
      const fp = assetFilePath(dir, asset.task_id, asset.id, asset.title)
      fs.mkdirSync(path.dirname(fp), { recursive: true })
      fs.appendFileSync(fp, content)

      await notifyApp()
      console.log(`Appended: ${asset.id.slice(0, 8)}  ${asset.title}`)
    })

  // slay tasks assets delete <assetId>
  cmd
    .command('delete <assetId>')
    .description('Delete an asset')
    .action(async (assetId: string) => {
      const db = openDb()
      const asset = resolveAsset(db, assetId)

      const dir = getAssetsDir()
      const fp = assetFilePath(dir, asset.task_id, asset.id, asset.title)
      if (fs.existsSync(fp)) fs.unlinkSync(fp)

      db.run(`DELETE FROM task_assets WHERE id = :id`, { ':id': asset.id })
      db.close()
      await notifyApp()
      console.log(`Deleted: ${asset.id.slice(0, 8)}  ${asset.title}`)
    })

  // slay tasks assets path <assetId>
  cmd
    .command('path <assetId>')
    .description('Print asset file path')
    .action(async (assetId: string) => {
      const db = openDb()
      const asset = resolveAsset(db, assetId)
      db.close()
      const dir = getAssetsDir()
      process.stdout.write(assetFilePath(dir, asset.task_id, asset.id, asset.title))
    })

  // slay tasks assets mkdir <name>
  cmd
    .command('mkdir <name>')
    .description('Create a folder')
    .option('--task <id>', 'Task ID (or $SLAYZONE_TASK_ID)')
    .option('--parent <id>', 'Parent folder ID')
    .option('--json', 'Output as JSON')
    .action(async (name: string, opts) => {
      const db = openDb()
      const task = resolveTaskForAsset(db, opts.task)
      const parentId = opts.parent ? resolveFolder(db, opts.parent).id : null
      const id = crypto.randomUUID()
      const now = new Date().toISOString()
      const maxOrder = db.query<{ m: number | null }>(
        parentId
          ? `SELECT MAX("order") as m FROM asset_folders WHERE task_id = :taskId AND parent_id = :parentId`
          : `SELECT MAX("order") as m FROM asset_folders WHERE task_id = :taskId AND parent_id IS NULL`,
        parentId ? { ':taskId': task.id, ':parentId': parentId } : { ':taskId': task.id }
      )[0]?.m ?? -1

      db.run(
        `INSERT INTO asset_folders (id, task_id, parent_id, name, "order", created_at)
         VALUES (:id, :taskId, :parentId, :name, :order, :now)`,
        { ':id': id, ':taskId': task.id, ':parentId': parentId, ':name': name, ':order': maxOrder + 1, ':now': now }
      )
      db.close()
      await notifyApp()

      if (opts.json) {
        console.log(JSON.stringify({ id, task_id: task.id, parent_id: parentId, name, order: maxOrder + 1, created_at: now }, null, 2))
      } else {
        console.log(`Created folder: ${id.slice(0, 8)}  ${name}`)
      }
    })

  // slay tasks assets rmdir <folderId>
  cmd
    .command('rmdir <folderId>')
    .description('Delete a folder (assets move to root)')
    .option('--json', 'Output as JSON')
    .action(async (folderId: string, opts) => {
      const db = openDb()
      const folder = resolveFolder(db, folderId)
      db.run(`DELETE FROM asset_folders WHERE id = :id`, { ':id': folder.id })
      db.close()
      await notifyApp()

      if (opts.json) {
        console.log(JSON.stringify({ deleted: folder.id, name: folder.name }))
      } else {
        console.log(`Deleted folder: ${folder.id.slice(0, 8)}  ${folder.name}`)
      }
    })

  // slay tasks assets mvdir <folderId>
  cmd
    .command('mvdir <folderId>')
    .description('Move a folder to another parent (or root)')
    .requiredOption('--parent <id>', 'Target parent folder ID, or "root" for top level')
    .option('--json', 'Output as JSON')
    .action(async (folderId: string, opts) => {
      const db = openDb()
      const folder = resolveFolder(db, folderId)
      let targetParentId: string | null = null
      let targetName = 'root'
      if (opts.parent !== 'root') {
        const parent = resolveFolder(db, opts.parent)
        targetParentId = parent.id
        targetName = parent.name
        // cycle check: walk ancestors of target — reject if source appears
        let cur: string | null = targetParentId
        while (cur) {
          if (cur === folder.id) {
            console.error('Cannot move folder into its own descendant')
            process.exit(1)
          }
          const row: { parent_id: string | null } | undefined = db.query<{ parent_id: string | null }>(
            `SELECT parent_id FROM asset_folders WHERE id = :id`,
            { ':id': cur }
          )[0]
          cur = row?.parent_id ?? null
        }
      }
      db.run(
        `UPDATE asset_folders SET parent_id = :parentId WHERE id = :id`,
        { ':parentId': targetParentId, ':id': folder.id }
      )
      db.close()
      await notifyApp()

      if (opts.json) {
        console.log(JSON.stringify({ id: folder.id, parent_id: targetParentId }))
      } else {
        console.log(`Moved folder: ${folder.id.slice(0, 8)} -> ${targetName}`)
      }
    })

  // slay tasks assets mv <assetId>
  cmd
    .command('mv <assetId>')
    .description('Move asset to a folder (or root)')
    .requiredOption('--folder <id>', 'Target folder ID, or "root" for top level')
    .option('--json', 'Output as JSON')
    .action(async (assetId: string, opts) => {
      const db = openDb()
      const asset = resolveAsset(db, assetId)
      let targetFolderId: string | null = null
      let targetName = 'root'
      if (opts.folder !== 'root') {
        const folder = resolveFolder(db, opts.folder)
        targetFolderId = folder.id
        targetName = folder.name
      }
      db.run(
        `UPDATE task_assets SET folder_id = :folderId, updated_at = :now WHERE id = :id`,
        { ':folderId': targetFolderId, ':now': new Date().toISOString(), ':id': asset.id }
      )
      db.close()
      await notifyApp()

      if (opts.json) {
        console.log(JSON.stringify({ id: asset.id, folder_id: targetFolderId }))
      } else {
        console.log(`Moved: ${asset.id.slice(0, 8)} -> ${targetName}`)
      }
    })

  // slay tasks assets download [assetId]
  cmd
    .command('download [assetId]')
    .description('Download an asset in a given format')
    .option('--type <type>', 'Export type: raw, pdf, png, html, zip', 'raw')
    .option('--output <path>', 'Output file path (default: ./<filename>)')
    .option('--task <id>', 'Task ID for zip (or $SLAYZONE_TASK_ID)')
    .option('--json', 'Output as JSON')
    .addHelpText('after', `
Download Types by Render Mode:
  raw   — always available (copies original file)
  pdf   — markdown, code, html, svg, mermaid
  png   — svg, mermaid
  html  — markdown, code, mermaid
  zip   — all assets in task (no assetId needed)

pdf/png/html require the SlayZone app to be running.
`)
    .action(async (assetId: string | undefined, opts) => {
      const validTypes = ['raw', 'pdf', 'png', 'html', 'zip']
      if (!validTypes.includes(opts.type)) {
        console.error(`Invalid type "${opts.type}". Valid types: ${validTypes.join(', ')}`)
        process.exit(1)
      }

      // --- ZIP: task-level ---
      if (opts.type === 'zip') {
        const db = openDb()
        const task = resolveTaskForAsset(db, opts.task)
        const assets = db.query<AssetRow>(
          `SELECT * FROM task_assets WHERE task_id = :taskId ORDER BY "order" ASC`,
          { ':taskId': task.id }
        )
        const folders = db.query<AssetFolderRow>(
          `SELECT * FROM asset_folders WHERE task_id = :taskId`,
          { ':taskId': task.id }
        )
        db.close()

        if (assets.length === 0) {
          console.error('No assets to download.')
          process.exit(1)
        }

        const dir = getAssetsDir()
        const outputPath = opts.output ? path.resolve(opts.output) : path.resolve('assets.zip')
        fs.mkdirSync(path.dirname(outputPath), { recursive: true })

        const byId = new Map(folders.map(f => [f.id, f]))
        function folderPath(id: string): string {
          const f = byId.get(id)
          if (!f) return ''
          return f.parent_id ? path.join(folderPath(f.parent_id), f.name) : f.name
        }

        const output = fs.createWriteStream(outputPath)
        const archive = archiver('zip', { zlib: { level: 9 } })
        archive.pipe(output)

        for (const asset of assets) {
          const fp = assetFilePath(dir, asset.task_id, asset.id, asset.title)
          if (!fs.existsSync(fp)) continue
          const rel = asset.folder_id
            ? path.join(folderPath(asset.folder_id), asset.title)
            : asset.title
          archive.file(fp, { name: rel })
        }

        await archive.finalize()
        await new Promise<void>((resolve, reject) => {
          output.on('close', resolve)
          output.on('error', reject)
        })

        if (opts.json) {
          console.log(JSON.stringify({ path: outputPath, type: 'zip', taskId: task.id }))
        } else {
          console.log(outputPath)
        }
        return
      }

      // --- Non-zip: assetId required ---
      if (!assetId) {
        console.error(`Asset ID required for --type ${opts.type}. Use --type zip for task-level download.`)
        process.exit(1)
      }

      const db = openDb()
      const asset = resolveAsset(db, assetId)
      db.close()

      const mode = getEffectiveRenderMode(asset.title, asset.render_mode as RenderMode | null)
      const baseName = asset.title.replace(/\.[^.]+$/, '') || asset.title

      // --- RAW ---
      if (opts.type === 'raw') {
        const dir = getAssetsDir()
        const srcPath = assetFilePath(dir, asset.task_id, asset.id, asset.title)
        if (!fs.existsSync(srcPath)) {
          console.error('Asset file not found on disk.')
          process.exit(1)
        }
        const outputPath = opts.output ? path.resolve(opts.output) : path.resolve(asset.title)
        fs.mkdirSync(path.dirname(outputPath), { recursive: true })
        fs.copyFileSync(srcPath, outputPath)

        if (opts.json) {
          console.log(JSON.stringify({ path: outputPath, type: 'raw', assetId: asset.id }))
        } else {
          console.log(outputPath)
        }
        return
      }

      // --- PDF / PNG / HTML (requires app) ---
      const available = getAvailableExportTypes(mode)
      if (!available.includes(opts.type)) {
        console.error(`Cannot export "${asset.title}" (${mode}) as ${opts.type}.\nAvailable types for ${mode}: ${available.join(', ')}`)
        process.exit(1)
      }

      const ext = opts.type
      const outputPath = opts.output ? path.resolve(opts.output) : path.resolve(`${baseName}.${ext}`)
      await apiPost(`/api/assets/${asset.id}/export/${opts.type}`, { outputPath })

      if (opts.json) {
        console.log(JSON.stringify({ path: outputPath, type: opts.type, assetId: asset.id }))
      } else {
        console.log(outputPath)
      }
    })

  return cmd
}

function getAvailableExportTypes(mode: RenderMode): string[] {
  const types = ['raw']
  if (canExportAsPdf(mode)) types.push('pdf')
  if (canExportAsPng(mode)) types.push('png')
  if (canExportAsHtml(mode)) types.push('html')
  return types
}
