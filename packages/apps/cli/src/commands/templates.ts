import { Command } from 'commander'
import { openDb, notifyApp, resolveProject, resolveProjectArg } from '../db'

interface TemplateRow extends Record<string, unknown> {
  id: string
  project_id: string
  name: string
  description: string | null
  terminal_mode: string | null
  default_status: string | null
  default_priority: number | null
  is_default: number
  sort_order: number
  created_at: string
  updated_at: string
  provider_config: string | null
  panel_visibility: string | null
  browser_tabs: string | null
  web_panel_urls: string | null
  dangerously_skip_permissions: number
  ccs_profile: string | null
}

function resolveTemplate(db: ReturnType<typeof openDb>, idPrefix: string) {
  const rows = db.query<TemplateRow>(
    `SELECT * FROM task_templates WHERE id LIKE :prefix || '%' LIMIT 2`,
    { ':prefix': idPrefix }
  )
  if (rows.length === 0) { console.error(`Template not found: ${idPrefix}`); process.exit(1) }
  if (rows.length > 1) {
    console.error(`Ambiguous id prefix "${idPrefix}". Matches: ${rows.map((r) => r.id.slice(0, 8)).join(', ')}`)
    process.exit(1)
  }
  return rows[0]
}

function safeJsonParse(s: string | null): unknown {
  if (!s) return null
  try { return JSON.parse(s) } catch { return null }
}

export function templatesCommand(): Command {
  const cmd = new Command('templates')
    .description('Manage task templates')
    .showSuggestionAfterError(true)
    .showHelpAfterError(true)

  // slay templates list
  cmd
    .command('list')
    .description('List templates for a project')
    .option('--project <name|id>', 'Project name or ID (defaults to $SLAYZONE_PROJECT_ID)')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      const db = openDb()
      const project = resolveProject(db, resolveProjectArg(opts.project))

      const templates = db.query<TemplateRow>(
        `SELECT * FROM task_templates WHERE project_id = :pid ORDER BY sort_order ASC, created_at ASC`,
        { ':pid': project.id }
      )
      db.close()

      if (opts.json) {
        const out = templates.map((t) => ({
          ...t,
          provider_config: safeJsonParse(t.provider_config),
          panel_visibility: safeJsonParse(t.panel_visibility),
          browser_tabs: safeJsonParse(t.browser_tabs),
          web_panel_urls: safeJsonParse(t.web_panel_urls),
        }))
        console.log(JSON.stringify(out, null, 2))
        return
      }

      if (templates.length === 0) {
        console.log('No templates found.')
        return
      }

      const idW = 9
      const nameW = 20
      const statusW = 12
      console.log(`${'ID'.padEnd(idW)}  ${'NAME'.padEnd(nameW)}  DEF  ${'STATUS'.padEnd(statusW)}  PRI  MODE`)
      console.log(`${'-'.repeat(idW)}  ${'-'.repeat(nameW)}  ---  ${'-'.repeat(statusW)}  ---  ${'-'.repeat(14)}`)
      for (const t of templates) {
        const id = t.id.slice(0, 8).padEnd(idW)
        const name = t.name.slice(0, nameW).padEnd(nameW)
        const def = t.is_default ? ' * ' : '   '
        const status = (t.default_status ?? '-').slice(0, statusW).padEnd(statusW)
        const pri = t.default_priority != null ? String(t.default_priority).padStart(3) : '  -'
        const mode = t.terminal_mode ?? '-'
        console.log(`${id}  ${name}  ${def}  ${status}  ${pri}  ${mode}`)
      }
    })

  // slay templates view
  cmd
    .command('view <id>')
    .description('View template details (id prefix supported)')
    .option('--json', 'Output as JSON')
    .action(async (idPrefix: string, opts) => {
      const db = openDb()
      const t = resolveTemplate(db, idPrefix)
      db.close()

      if (opts.json) {
        const out = {
          ...t,
          provider_config: safeJsonParse(t.provider_config),
          panel_visibility: safeJsonParse(t.panel_visibility),
          browser_tabs: safeJsonParse(t.browser_tabs),
          web_panel_urls: safeJsonParse(t.web_panel_urls),
        }
        console.log(JSON.stringify(out, null, 2))
        return
      }

      console.log(`ID:          ${t.id}`)
      console.log(`Name:        ${t.name}`)
      console.log(`Default:     ${t.is_default ? 'yes' : 'no'}`)
      if (t.description) console.log(`Description: ${t.description}`)
      if (t.terminal_mode) console.log(`Mode:        ${t.terminal_mode}`)
      if (t.default_status) console.log(`Status:      ${t.default_status}`)
      if (t.default_priority != null) console.log(`Priority:    ${t.default_priority}`)
      if (t.ccs_profile) console.log(`CCS Profile: ${t.ccs_profile}`)
      console.log(`Created:     ${t.created_at}`)
    })

  // slay templates create
  cmd
    .command('create <name>')
    .description('Create a task template')
    .option('--project <name|id>', 'Project name or ID (defaults to $SLAYZONE_PROJECT_ID)')
    .option('--terminal-mode <mode>', 'Default terminal mode')
    .option('--priority <n>', 'Default priority 1-5')
    .option('--status <status>', 'Default status')
    .option('--default', 'Set as project default template')
    .option('--description <text>', 'Template description')
    .action(async (name: string, opts) => {
      const db = openDb()
      const project = resolveProject(db, resolveProjectArg(opts.project))

      if (opts.priority) {
        const p = parseInt(opts.priority, 10)
        if (isNaN(p) || p < 1 || p > 5) { console.error('Priority must be 1-5.'); process.exit(1) }
      }

      const id = crypto.randomUUID()
      const now = new Date().toISOString()

      const { sort_order: nextOrder } = db.query<{ sort_order: number }>(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS sort_order FROM task_templates WHERE project_id = :pid`,
        { ':pid': project.id }
      )[0] ?? { sort_order: 0 }

      db.run('BEGIN')
      try {
        if (opts.default) {
          db.run(
            `UPDATE task_templates SET is_default = 0 WHERE project_id = :pid AND is_default = 1`,
            { ':pid': project.id }
          )
        }

        db.run(
          `INSERT INTO task_templates (id, project_id, name, description, terminal_mode, default_status, default_priority, is_default, sort_order, created_at, updated_at)
           VALUES (:id, :pid, :name, :desc, :mode, :status, :priority, :isDefault, :sortOrder, :now, :now)`,
          {
            ':id': id,
            ':pid': project.id,
            ':name': name,
            ':desc': opts.description ?? null,
            ':mode': opts.terminalMode ?? null,
            ':status': opts.status ?? null,
            ':priority': opts.priority ? parseInt(opts.priority, 10) : null,
            ':isDefault': opts.default ? 1 : 0,
            ':sortOrder': nextOrder,
            ':now': now,
          }
        )
        db.run('COMMIT')
      } catch (e) {
        db.run('ROLLBACK')
        throw e
      }

      db.close()
      await notifyApp()
      console.log(`Created template: ${id.slice(0, 8)}  ${name}${opts.default ? '  (default)' : ''}`)
    })

  // slay templates update
  cmd
    .command('update <id>')
    .description('Update a template (id prefix supported)')
    .option('--name <name>', 'New name')
    .option('--terminal-mode <mode>', 'Default terminal mode')
    .option('--priority <n>', 'Default priority 1-5')
    .option('--status <status>', 'Default status')
    .option('--default', 'Set as project default')
    .option('--no-default', 'Unset as project default')
    .option('--description <text>', 'Template description')
    .action(async (idPrefix: string, opts) => {
      if (opts.name === undefined && opts.terminalMode === undefined && opts.priority === undefined
        && opts.status === undefined && opts.description === undefined
        && opts.default === undefined) {
        console.error('Provide at least one option to update.')
        process.exit(1)
      }

      if (opts.priority) {
        const p = parseInt(opts.priority, 10)
        if (isNaN(p) || p < 1 || p > 5) { console.error('Priority must be 1-5.'); process.exit(1) }
      }

      const db = openDb()
      const template = resolveTemplate(db, idPrefix)

      const sets: string[] = ['updated_at = :now']
      const params: Record<string, string | number | null> = { ':now': new Date().toISOString(), ':id': template.id }

      if (opts.name !== undefined) { sets.push('name = :name'); params[':name'] = opts.name }
      if (opts.description !== undefined) { sets.push('description = :desc'); params[':desc'] = opts.description || null }
      if (opts.terminalMode !== undefined) { sets.push('terminal_mode = :mode'); params[':mode'] = opts.terminalMode }
      if (opts.status !== undefined) { sets.push('default_status = :status'); params[':status'] = opts.status }
      if (opts.priority !== undefined) { sets.push('default_priority = :priority'); params[':priority'] = parseInt(opts.priority, 10) }

      db.run('BEGIN')
      try {
        if (opts.default === true) {
          db.run(
            `UPDATE task_templates SET is_default = 0 WHERE project_id = :pid AND is_default = 1`,
            { ':pid': template.project_id }
          )
          sets.push('is_default = 1')
        } else if (opts.default === false) {
          sets.push('is_default = 0')
        }

        db.run(`UPDATE task_templates SET ${sets.join(', ')} WHERE id = :id`, params)
        db.run('COMMIT')
      } catch (e) {
        db.run('ROLLBACK')
        throw e
      }

      db.close()
      await notifyApp()
      console.log(`Updated template: ${template.id.slice(0, 8)}  ${opts.name ?? template.name}`)
    })

  // slay templates delete
  cmd
    .command('delete <id>')
    .description('Delete a template (id prefix supported)')
    .action(async (idPrefix: string) => {
      const db = openDb()
      const template = resolveTemplate(db, idPrefix)

      db.run(`DELETE FROM task_templates WHERE id = :id`, { ':id': template.id })
      db.close()
      await notifyApp()
      console.log(`Deleted template: ${template.id.slice(0, 8)}  ${template.name}`)
    })

  return cmd
}
