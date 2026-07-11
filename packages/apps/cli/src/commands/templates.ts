import { Command } from 'commander'
import { resolveProjectArg } from '../db'
import { apiGet, apiPost, apiPatch, apiDelete } from '../api'

interface TemplateRow extends Record<string, unknown> {
  id: string
  project_id: string
  name: string
  description: string | null
  terminal_mode: string | null
  default_status: string | null
  default_priority: number | null
  is_default: boolean | number
  sort_order: number
  created_at: string
  updated_at: string
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
      // GET /api/templates resolves the project and returns parsed TaskTemplate
      // rows (JSON blobs parsed, booleans) — the CLI's --json contract exactly.
      const project = resolveProjectArg(opts.project)
      const { data: templates } = await apiGet<{ ok: true; data: TemplateRow[] }>(
        `/api/templates?project=${encodeURIComponent(project)}`
      )

      if (opts.json) {
        console.log(JSON.stringify(templates, null, 2))
        return
      }

      if (templates.length === 0) {
        console.log('No templates found.')
        return
      }

      const idW = 9
      const nameW = 20
      const statusW = 12
      console.log(
        `${'ID'.padEnd(idW)}  ${'NAME'.padEnd(nameW)}  DEF  ${'STATUS'.padEnd(statusW)}  PRI  MODE`
      )
      console.log(
        `${'-'.repeat(idW)}  ${'-'.repeat(nameW)}  ---  ${'-'.repeat(statusW)}  ---  ${'-'.repeat(14)}`
      )
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
      // GET /api/templates/:id resolves the id prefix (404/400 parity).
      const { data: t } = await apiGet<{ ok: true; data: TemplateRow }>(
        `/api/templates/${encodeURIComponent(idPrefix)}`
      )

      if (opts.json) {
        console.log(JSON.stringify(t, null, 2))
        return
      }

      console.log(`ID:          ${t.id}`)
      console.log(`Name:        ${t.name}`)
      console.log(`Default:     ${t.is_default ? 'yes' : 'no'}`)
      if (t.description) console.log(`Description: ${t.description}`)
      if (t.terminal_mode) console.log(`Mode:        ${t.terminal_mode}`)
      if (t.default_status) console.log(`Status:      ${t.default_status}`)
      if (t.default_priority != null) console.log(`Priority:    ${t.default_priority}`)
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
      const project = resolveProjectArg(opts.project)
      if (opts.priority) {
        const p = parseInt(opts.priority, 10)
        if (isNaN(p) || p < 1 || p > 5) {
          console.error('Priority must be 1-5.')
          process.exit(1)
        }
      }

      // POST /api/templates resolves the project, allocates sort_order, and
      // owns the "creating a default clears the previous default" invariant.
      const { data: template } = await apiPost<{ ok: true; data: TemplateRow }>('/api/templates', {
        project,
        name,
        description: opts.description,
        terminalMode: opts.terminalMode,
        status: opts.status,
        priority: opts.priority ? parseInt(opts.priority, 10) : undefined,
        isDefault: opts.default === true
      })
      console.log(
        `Created template: ${template.id.slice(0, 8)}  ${name}${opts.default ? '  (default)' : ''}`
      )
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
      if (
        opts.name === undefined &&
        opts.terminalMode === undefined &&
        opts.priority === undefined &&
        opts.status === undefined &&
        opts.description === undefined &&
        opts.default === undefined
      ) {
        console.error('Provide at least one option to update.')
        process.exit(1)
      }

      if (opts.priority) {
        const p = parseInt(opts.priority, 10)
        if (isNaN(p) || p < 1 || p > 5) {
          console.error('Priority must be 1-5.')
          process.exit(1)
        }
      }

      const body: Record<string, unknown> = {}
      if (opts.name !== undefined) body.name = opts.name
      if (opts.description !== undefined) body.description = opts.description || null
      if (opts.terminalMode !== undefined) body.terminalMode = opts.terminalMode
      if (opts.status !== undefined) body.status = opts.status
      if (opts.priority !== undefined) body.priority = parseInt(opts.priority, 10)
      if (opts.default !== undefined) body.isDefault = opts.default

      // PATCH /api/templates/:id resolves the id prefix and owns the default
      // invariant; returns the updated template.
      const { data: template } = await apiPatch<{ ok: true; data: TemplateRow }>(
        `/api/templates/${encodeURIComponent(idPrefix)}`,
        body
      )
      console.log(`Updated template: ${template.id.slice(0, 8)}  ${opts.name ?? template.name}`)
    })

  // slay templates delete
  cmd
    .command('delete <id>')
    .description('Delete a template (id prefix supported)')
    .action(async (idPrefix: string) => {
      const { data: template } = await apiDelete<{ ok: true; data: { id: string; name: string } }>(
        `/api/templates/${encodeURIComponent(idPrefix)}`
      )
      console.log(`Deleted template: ${template.id.slice(0, 8)}  ${template.name}`)
    })

  return cmd
}
