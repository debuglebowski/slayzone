import { Command } from 'commander'
import fs from 'node:fs'
import { TEMPLATE_VARIABLES } from '@slayzone/automations/shared'
import { openDb, notifyApp, resolveProject, resolveProjectArg } from '../db'
import { apiPost } from '../api'

function templateVarsHelp(): string {
  const w = Math.max(...TEMPLATE_VARIABLES.map(v => v.name.length)) + 6
  const lines = TEMPLATE_VARIABLES.map(v => `  {{${v.name}}}`.padEnd(w + 4) + v.desc)
  return `\nTemplate variables (use in --action-command):\n${lines.join('\n')}\n`
}

interface AutomationRow extends Record<string, unknown> {
  id: string
  project_id: string
  name: string
  description: string | null
  enabled: number
  trigger_config: string
  conditions: string | null
  actions: string
  run_count: number
  last_run_at: string | null
  catchup_on_start: number
  sort_order: number
  created_at: string
  updated_at: string
}

interface RunRow extends Record<string, unknown> {
  id: string
  automation_id: string
  trigger_event: string | null
  status: string
  error: string | null
  duration_ms: number | null
  started_at: string
  completed_at: string | null
}

function isCatchupRun(row: RunRow): boolean {
  if (!row.trigger_event) return false
  try {
    const ev = JSON.parse(row.trigger_event) as { catchup?: boolean }
    return ev.catchup === true
  } catch { return false }
}

const TRIGGER_TYPES = ['task_status_change', 'task_created', 'task_archived', 'task_tag_changed', 'cron', 'manual'] as const

function safeJsonParse(s: string | null): unknown {
  if (!s) return null
  try { return JSON.parse(s) } catch { return null }
}

function resolveAutomation(db: ReturnType<typeof openDb>, idPrefix: string) {
  const rows = db.query<AutomationRow>(
    `SELECT * FROM automations WHERE id LIKE :prefix || '%' LIMIT 2`,
    { ':prefix': idPrefix }
  )
  if (rows.length === 0) { console.error(`Automation not found: ${idPrefix}`); process.exit(1) }
  if (rows.length > 1) {
    console.error(`Ambiguous id prefix "${idPrefix}". Matches: ${rows.map((r) => r.id.slice(0, 8)).join(', ')}`)
    process.exit(1)
  }
  return rows[0]
}

function parseRow(row: AutomationRow) {
  return {
    ...row,
    enabled: Boolean(row.enabled),
    catchup_on_start: Boolean(row.catchup_on_start),
    trigger_config: safeJsonParse(row.trigger_config),
    conditions: safeJsonParse(row.conditions) ?? [],
    actions: safeJsonParse(row.actions) ?? [],
  }
}

export function automationsCommand(): Command {
  const cmd = new Command('automations')
    .description('Manage automations')
    .showSuggestionAfterError(true)
    .showHelpAfterError(true)

  // slay automations list
  cmd
    .command('list')
    .description('List automations for a project')
    .option('--project <name|id>', 'Project name or ID (defaults to $SLAYZONE_PROJECT_ID)')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      const db = openDb()
      const project = resolveProject(db, resolveProjectArg(opts.project))

      const rows = db.query<AutomationRow>(
        `SELECT * FROM automations WHERE project_id = :pid ORDER BY sort_order, created_at`,
        { ':pid': project.id }
      )
      db.close()

      if (opts.json) {
        console.log(JSON.stringify(rows.map(parseRow), null, 2))
        return
      }

      if (rows.length === 0) {
        console.log('No automations found.')
        return
      }

      const idW = 9
      const nameW = 20
      const trigW = 20
      console.log(`${'ID'.padEnd(idW)}  ${'NAME'.padEnd(nameW)}  ON   ${'TRIGGER'.padEnd(trigW)}  RUNS  LAST RUN`)
      console.log(`${'-'.repeat(idW)}  ${'-'.repeat(nameW)}  ---  ${'-'.repeat(trigW)}  ----  ${'-'.repeat(19)}`)
      for (const r of rows) {
        const id = r.id.slice(0, 8).padEnd(idW)
        const name = r.name.slice(0, nameW).padEnd(nameW)
        const on = r.enabled ? 'yes' : 'no '
        const tc = safeJsonParse(r.trigger_config) as { type?: string } | null
        const trigger = (tc?.type ?? '?').slice(0, trigW).padEnd(trigW)
        const runs = String(r.run_count).padStart(4)
        const lastRun = r.last_run_at ?? '-'
        console.log(`${id}  ${name}  ${on}  ${trigger}  ${runs}  ${lastRun}`)
      }
    })

  // slay automations view
  cmd
    .command('view <id>')
    .description('View automation details (id prefix supported)')
    .option('--json', 'Output as JSON')
    .action(async (idPrefix: string, opts) => {
      const db = openDb()
      const row = resolveAutomation(db, idPrefix)
      db.close()

      const parsed = parseRow(row)

      if (opts.json) {
        console.log(JSON.stringify(parsed, null, 2))
        return
      }

      console.log(`ID:          ${row.id}`)
      console.log(`Name:        ${row.name}`)
      console.log(`Enabled:     ${parsed.enabled ? 'yes' : 'no'}`)
      if (row.description) console.log(`Description: ${row.description}`)
      console.log(`Trigger:     ${JSON.stringify(parsed.trigger_config)}`)
      const triggerType = (parsed.trigger_config as { type?: string } | null)?.type
      if (triggerType === 'cron') console.log(`Catchup:     ${parsed.catchup_on_start ? 'yes' : 'no'}`)
      if ((parsed.conditions as unknown[]).length > 0) console.log(`Conditions:  ${JSON.stringify(parsed.conditions)}`)
      console.log(`Actions:     ${JSON.stringify(parsed.actions)}`)
      console.log(`Runs:        ${row.run_count}`)
      if (row.last_run_at) console.log(`Last run:    ${row.last_run_at}`)
      console.log(`Created:     ${row.created_at}`)
    })

  // slay automations create
  cmd
    .command('create <name>')
    .description('Create an automation')
    .option('--project <name|id>', 'Project name or ID (defaults to $SLAYZONE_PROJECT_ID)')
    .requiredOption('--trigger <type>', `Trigger type: ${TRIGGER_TYPES.join(', ')}`)
    .option('--action-command <cmd>', 'Shell command to run')
    .option('--trigger-from-status <status>', 'From status (for task_status_change)')
    .option('--trigger-to-status <status>', 'To status (for task_status_change)')
    .option('--cron <expression>', 'Cron expression (for cron trigger)')
    .option('--no-catchup', 'Do not run on startup if a scheduled cron fire was missed (default: catchup on)')
    .option('--description <text>', 'Automation description')
    .option('--config <file>', 'JSON config file (overrides flags)')
    .addHelpText('after', templateVarsHelp())
    .action(async (name: string, opts) => {
      const db = openDb()
      const project = resolveProject(db, resolveProjectArg(opts.project))

      let triggerConfig: unknown
      let conditions: unknown[] = []
      let actions: unknown[]

      if (opts.config) {
        const raw = fs.readFileSync(opts.config, 'utf-8')
        const config = JSON.parse(raw) as { trigger_config?: unknown; conditions?: unknown[]; actions?: unknown[] }
        triggerConfig = config.trigger_config
        conditions = config.conditions ?? []
        actions = config.actions ?? []
        if (!triggerConfig || !actions?.length) {
          console.error('Config file must have trigger_config and actions')
          process.exit(1)
        }
      } else {
        if (!TRIGGER_TYPES.includes(opts.trigger as typeof TRIGGER_TYPES[number])) {
          console.error(`Invalid trigger type: ${opts.trigger}. Must be: ${TRIGGER_TYPES.join(', ')}`)
          process.exit(1)
        }

        const params: Record<string, string> = {}
        if (opts.trigger === 'task_status_change') {
          if (opts.triggerFromStatus) params.fromStatus = opts.triggerFromStatus
          if (opts.triggerToStatus) params.toStatus = opts.triggerToStatus
        } else if (opts.trigger === 'cron') {
          if (!opts.cron) { console.error('--cron <expression> required for cron trigger.'); process.exit(1) }
          params.expression = opts.cron
        }
        triggerConfig = { type: opts.trigger, params }

        if (!opts.actionCommand) {
          console.error('--action-command <cmd> or --config <file> required.')
          process.exit(1)
        }
        actions = [{ type: 'run_command', params: { command: opts.actionCommand } }]
      }

      const id = crypto.randomUUID()
      const now = new Date().toISOString()

      const { sort_order: nextOrder } = db.query<{ sort_order: number }>(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS sort_order FROM automations WHERE project_id = :pid`,
        { ':pid': project.id }
      )[0] ?? { sort_order: 0 }

      // commander's --no-catchup negates: opts.catchup === false when flag passed, true otherwise
      const catchupOnStart = opts.catchup === false ? 0 : 1

      db.run(
        `INSERT INTO automations (id, project_id, name, description, enabled, trigger_config, conditions, actions, sort_order, catchup_on_start, created_at, updated_at)
         VALUES (:id, :pid, :name, :desc, 1, :trigger, :conditions, :actions, :sortOrder, :catchup, :now, :now)`,
        {
          ':id': id,
          ':pid': project.id,
          ':name': name,
          ':desc': opts.description ?? null,
          ':trigger': JSON.stringify(triggerConfig),
          ':conditions': JSON.stringify(conditions),
          ':actions': JSON.stringify(actions),
          ':sortOrder': nextOrder,
          ':catchup': catchupOnStart,
          ':now': now,
        }
      )

      db.close()
      await notifyApp()
      console.log(`Created automation: ${id.slice(0, 8)}  ${name}`)
    })

  // slay automations update
  cmd
    .command('update <id>')
    .description('Update an automation (id prefix supported)')
    .option('--name <name>', 'New name')
    .option('--description <text>', 'New description')
    .option('--enabled', 'Enable')
    .option('--disabled', 'Disable')
    .option('--trigger <type>', 'New trigger type')
    .option('--action-command <cmd>', 'New shell command')
    .option('--trigger-from-status <status>', 'From status')
    .option('--trigger-to-status <status>', 'To status')
    .option('--cron <expression>', 'Cron expression')
    .option('--catchup', 'Enable run-on-startup-if-missed for cron triggers')
    .option('--no-catchup', 'Disable run-on-startup-if-missed for cron triggers')
    .action(async (idPrefix: string, opts) => {
      if (opts.name === undefined && opts.description === undefined
        && opts.enabled === undefined && opts.disabled === undefined
        && opts.trigger === undefined && opts.actionCommand === undefined
        && opts.catchup === undefined) {
        console.error('Provide at least one option to update.')
        process.exit(1)
      }

      const db = openDb()
      const automation = resolveAutomation(db, idPrefix)

      const sets: string[] = ['updated_at = :now']
      const params: Record<string, string | number | null> = { ':now': new Date().toISOString(), ':id': automation.id }

      if (opts.name !== undefined) { sets.push('name = :name'); params[':name'] = opts.name }
      if (opts.description !== undefined) { sets.push('description = :desc'); params[':desc'] = opts.description || null }
      if (opts.enabled) { sets.push('enabled = 1') }
      if (opts.disabled) { sets.push('enabled = 0') }

      if (opts.trigger) {
        if (!TRIGGER_TYPES.includes(opts.trigger as typeof TRIGGER_TYPES[number])) {
          console.error(`Invalid trigger type: ${opts.trigger}`)
          process.exit(1)
        }
        const tparams: Record<string, string> = {}
        if (opts.trigger === 'task_status_change') {
          if (opts.triggerFromStatus) tparams.fromStatus = opts.triggerFromStatus
          if (opts.triggerToStatus) tparams.toStatus = opts.triggerToStatus
        } else if (opts.trigger === 'cron') {
          if (opts.cron) tparams.expression = opts.cron
        }
        sets.push('trigger_config = :trigger')
        params[':trigger'] = JSON.stringify({ type: opts.trigger, params: tparams })
      }

      if (opts.actionCommand) {
        sets.push('actions = :actions')
        params[':actions'] = JSON.stringify([{ type: 'run_command', params: { command: opts.actionCommand } }])
      }

      if (opts.catchup !== undefined) {
        sets.push('catchup_on_start = :catchup')
        params[':catchup'] = opts.catchup ? 1 : 0
      }

      db.run(`UPDATE automations SET ${sets.join(', ')} WHERE id = :id`, params)
      db.close()
      await notifyApp()
      console.log(`Updated automation: ${automation.id.slice(0, 8)}  ${opts.name ?? automation.name}`)
    })

  // slay automations delete
  cmd
    .command('delete <id>')
    .description('Delete an automation (id prefix supported)')
    .action(async (idPrefix: string) => {
      const db = openDb()
      const automation = resolveAutomation(db, idPrefix)

      db.run(`DELETE FROM automations WHERE id = :id`, { ':id': automation.id })
      db.close()
      await notifyApp()
      console.log(`Deleted automation: ${automation.id.slice(0, 8)}  ${automation.name}`)
    })

  // slay automations toggle
  cmd
    .command('toggle <id>')
    .description('Toggle an automation on/off (id prefix supported)')
    .action(async (idPrefix: string) => {
      const db = openDb()
      const automation = resolveAutomation(db, idPrefix)

      const newEnabled = automation.enabled ? 0 : 1
      db.run(`UPDATE automations SET enabled = :enabled, updated_at = :now WHERE id = :id`, {
        ':enabled': newEnabled,
        ':now': new Date().toISOString(),
        ':id': automation.id,
      })
      db.close()
      await notifyApp()
      console.log(`${newEnabled ? 'Enabled' : 'Disabled'}: ${automation.id.slice(0, 8)}  ${automation.name}`)
    })

  // slay automations run
  cmd
    .command('run <id>')
    .description('Manually run an automation (requires app running)')
    .action(async (idPrefix: string) => {
      const db = openDb()
      const automation = resolveAutomation(db, idPrefix)
      db.close()

      const run = await apiPost<{ id: string; status: string; error?: string; duration_ms?: number }>(
        `/api/automations/${automation.id}/run`, {}
      )
      if (run.error) {
        console.error(`Run failed: ${run.error}`)
        process.exit(1)
      }
      console.log(`Run: ${run.id?.slice(0, 8) ?? '?'}  ${run.status}  ${run.duration_ms != null ? `${run.duration_ms}ms` : ''}`)
    })

  // slay automations runs
  cmd
    .command('runs <id>')
    .description('View execution history (id prefix supported)')
    .option('--limit <n>', 'Max results', '10')
    .option('--json', 'Output as JSON')
    .action(async (idPrefix: string, opts) => {
      const db = openDb()
      const automation = resolveAutomation(db, idPrefix)
      const limit = parseInt(opts.limit, 10)

      const runs = db.query<RunRow>(
        `SELECT * FROM automation_runs WHERE automation_id = :aid ORDER BY started_at DESC LIMIT :limit`,
        { ':aid': automation.id, ':limit': limit }
      )
      db.close()

      if (opts.json) {
        console.log(JSON.stringify(runs, null, 2))
        return
      }

      if (runs.length === 0) {
        console.log('No runs found.')
        return
      }

      const idW = 9
      const statusW = 8
      console.log(`${'ID'.padEnd(idW)}  ${'STATUS'.padEnd(statusW)}  ${'DURATION'.padEnd(10)}  STARTED`)
      console.log(`${'-'.repeat(idW)}  ${'-'.repeat(statusW)}  ${'-'.repeat(10)}  ${'-'.repeat(19)}`)
      for (const r of runs) {
        const id = r.id.slice(0, 8).padEnd(idW)
        const status = r.status.padEnd(statusW)
        const dur = r.duration_ms != null ? `${r.duration_ms}ms`.padEnd(10) : '-'.padEnd(10)
        const tag = isCatchupRun(r) ? '  (catchup)' : ''
        console.log(`${id}  ${status}  ${dur}  ${r.started_at}${tag}`)
        if (r.error) console.log(`         error: ${r.error.slice(0, 80)}`)
      }
    })

  return cmd
}
