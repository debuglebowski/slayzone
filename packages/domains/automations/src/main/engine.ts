import type { IpcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import type { Automation, AutomationEvent, AutomationRow, AutomationRun } from '@slayzone/automations/shared'
import { finishAutomationActionRun, recordActivityEvent, startAutomationActionRun, trimOutputTail } from '@slayzone/history/main'
import { parseAutomationRow } from '@slayzone/automations/shared'
import { resolveTemplate, type TemplateContext } from '@slayzone/automations/shared'
import { exec } from 'child_process'

const MAX_DEPTH = 5
const ACTION_TIMEOUT_MS = 30_000
const MAX_RUNS_PER_AUTOMATION = 100

class AutomationCommandError extends Error {
  outputTail: string | null

  constructor(message: string, outputTail: string | null) {
    super(message)
    this.name = 'AutomationCommandError'
    this.outputTail = outputTail
  }
}

/** Minimal cron parser — supports: "* * * * *" (min hour dom month dow) */
export function cronMatches(expression: string, date: Date): boolean {
  const [minExpr, hourExpr, domExpr, monExpr, dowExpr] = expression.trim().split(/\s+/)
  if (!minExpr) return false
  const fieldMatch = (expr: string, value: number): boolean => {
    if (expr === '*') return true
    if (expr.startsWith('*/')) {
      const step = parseInt(expr.slice(2), 10)
      return !isNaN(step) && step > 0 && value % step === 0
    }
    return expr.split(',').some(v => parseInt(v, 10) === value)
  }
  return (
    fieldMatch(minExpr, date.getMinutes()) &&
    fieldMatch(hourExpr ?? '*', date.getHours()) &&
    fieldMatch(domExpr ?? '*', date.getDate()) &&
    fieldMatch(monExpr ?? '*', date.getMonth() + 1) &&
    fieldMatch(dowExpr ?? '*', date.getDay())
  )
}

export class AutomationEngine {
  private currentDepth = 0
  private cronInterval: ReturnType<typeof setInterval> | null = null

  constructor(
    private db: Database,
    private notifyRenderer: () => void
  ) {}

  start(ipcMain: IpcMain): void {

    // --- Task status change ---
    ipcMain.on('db:tasks:update:done', (_event, taskId: string, meta?: { oldStatus?: string }) => {
      const task = this.db.prepare('SELECT id, project_id, status FROM tasks WHERE id = ?').get(taskId) as {
        id: string; project_id: string; status: string
      } | undefined
      if (!task) return
      if (meta?.oldStatus === undefined || meta.oldStatus === task.status) return

      this.handleEvent({
        type: 'task_status_change',
        taskId: task.id,
        projectId: task.project_id,
        oldStatus: meta.oldStatus,
        newStatus: task.status,
        depth: this.currentDepth,
      })
    })

    // --- Task created ---
    ipcMain.on('db:tasks:create:done', (_event, taskId: string, projectId: string) => {
      this.handleEvent({ type: 'task_created', taskId, projectId, depth: 0 })
    })

    // --- Task archived ---
    ipcMain.on('db:tasks:archive:done', (_event, taskId: string) => {
      const task = this.db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId) as { project_id: string } | undefined
      if (task) this.handleEvent({ type: 'task_archived', taskId, projectId: task.project_id, depth: 0 })
    })

    // --- Task tag changed ---
    ipcMain.on('db:taskTags:setForTask:done', (_event, taskId: string, tagIds: string[]) => {
      const task = this.db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId) as { project_id: string } | undefined
      if (task) this.handleEvent({ type: 'task_tag_changed', taskId, projectId: task.project_id, tagIds, depth: 0 })
    })

    // --- Cron ---
    this.cronInterval = setInterval(() => this.tickCron(), 60_000)
  }

  stop(): void {
    if (this.cronInterval) {
      clearInterval(this.cronInterval)
      this.cronInterval = null
    }
  }

  private tickCron(): void {
    const now = new Date()
    const rows = this.db.prepare(
      "SELECT * FROM automations WHERE enabled = 1 AND json_extract(trigger_config, '$.type') = 'cron'"
    ).all() as AutomationRow[]

    for (const row of rows) {
      const automation = parseAutomationRow(row)
      const expression = automation.trigger_config.params.expression as string | undefined
      if (expression && cronMatches(expression, now)) {
        void this.executeAutomation(automation, {
          type: 'cron',
          projectId: automation.project_id,
          cronExpression: expression,
          depth: 0,
        }, 0)
      }
    }
  }

  private handleEvent(event: AutomationEvent): void {
    const depth = event.depth ?? 0
    if (depth >= MAX_DEPTH) return
    if (!event.projectId) return

    const rows = this.db.prepare(
      'SELECT * FROM automations WHERE project_id = ? AND enabled = 1'
    ).all(event.projectId) as AutomationRow[]

    const automations = rows.map(parseAutomationRow)

    for (const automation of automations) {
      if (this.matchesTrigger(automation, event)) {
        if (this.evaluateConditions(automation, event)) {
          void this.executeAutomation(automation, event, depth)
        }
      }
    }
  }

  private matchesTrigger(automation: Automation, event: AutomationEvent): boolean {
    const trigger = automation.trigger_config
    if (trigger.type !== event.type) return false

    switch (trigger.type) {
      case 'task_status_change': {
        const { fromStatus, toStatus } = trigger.params as { fromStatus?: string; toStatus?: string }
        if (fromStatus && event.oldStatus !== fromStatus) return false
        if (toStatus && event.newStatus !== toStatus) return false
        return true
      }
      case 'task_created':
      case 'task_archived':
      case 'task_tag_changed':
      case 'cron':
      case 'manual':
        return true
      default:
        return false
    }
  }

  private evaluateConditions(automation: Automation, event: AutomationEvent): boolean {
    for (const condition of automation.conditions) {
      if (condition.type === 'task_property' && event.taskId) {
        const { field, operator, value } = condition.params as { field: string; operator: string; value: unknown }

        // tags_contains_some: check against task_tags join table
        if (field === 'tags') {
          const tagRows = this.db.prepare('SELECT tag_id FROM task_tags WHERE task_id = ?').all(event.taskId) as { tag_id: string }[]
          const taskTagIds = tagRows.map(r => r.tag_id)
          if (operator === 'in' && Array.isArray(value)) {
            if (!value.some(v => taskTagIds.includes(v as string))) return false
          }
          continue
        }

        // Regular task fields
        const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(event.taskId) as Record<string, unknown> | undefined
        if (!task) return false

        const actual = task[field]

        switch (operator) {
          case 'equals': if (actual !== value) return false; break
          case 'not_equals': if (actual === value) return false; break
          case 'exists': if (actual == null || actual === '') return false; break
          case 'not_exists': if (actual != null && actual !== '') return false; break
          case 'in': {
            if (!Array.isArray(value)) return false
            // Coerce to string for comparison — UI stores values as strings, DB may return numbers
            if (!value.some(v => String(v) === String(actual))) return false
            break
          }
          default: return false
        }
      }
    }
    return true
  }

  private async executeAutomation(automation: Automation, event: AutomationEvent, depth: number): Promise<void> {
    const runId = crypto.randomUUID()
    const startTime = Date.now()

    this.db.prepare(
      `INSERT INTO automation_runs (id, automation_id, trigger_event, status, started_at)
       VALUES (?, ?, ?, 'running', datetime('now'))`
    ).run(runId, automation.id, JSON.stringify(event))

    const ctx = this.buildTemplateContext(event)
    const prevDepth = this.currentDepth
    let runStatus: 'success' | 'error' = 'success'
    let runError: string | null = null

    try {
      this.currentDepth = depth + 1
      for (let i = 0; i < automation.actions.length; i++) {
        const action = automation.actions[i]
        const { command } = this.resolveActionExecution(action.params, ctx)
        const actionRunId = startAutomationActionRun(this.db, {
          runId,
          automationId: automation.id,
          taskId: event.taskId ?? null,
          projectId: event.projectId ?? null,
          actionIndex: i,
          actionType: action.type,
          command,
        })
        const actionStart = Date.now()

        try {
          const result = await this.executeAction(action.params, ctx)
          finishAutomationActionRun(this.db, actionRunId, {
            status: 'success',
            outputTail: result.outputTail,
            durationMs: Date.now() - actionStart,
          })
        } catch (err) {
          finishAutomationActionRun(this.db, actionRunId, {
            status: 'error',
            outputTail: err instanceof AutomationCommandError ? err.outputTail : null,
            error: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - actionStart,
          })
          throw err
        }
      }
    } catch (err) {
      runStatus = 'error'
      runError = err instanceof Error ? err.message : String(err)
    } finally {
      this.currentDepth = prevDepth
    }

    const durationMs = Date.now() - startTime
    this.db.transaction(() => {
      if (runStatus === 'success') {
        this.db.prepare(
          `UPDATE automation_runs SET status = 'success', error = NULL, duration_ms = ?, completed_at = datetime('now') WHERE id = ?`
        ).run(durationMs, runId)
      } else {
        this.db.prepare(
          `UPDATE automation_runs SET status = 'error', error = ?, duration_ms = ?, completed_at = datetime('now') WHERE id = ?`
        ).run(runError, durationMs, runId)
      }

      this.db.prepare(
        `UPDATE automations SET run_count = run_count + 1, last_run_at = datetime('now') WHERE id = ?`
      ).run(automation.id)

      this.recordAutomationTimelineEvent(automation, event, runId, runStatus, runError)
    })()

    this.pruneOldRuns(automation.id)
    this.notifyRenderer()
  }

  private resolveActionExecution(params: Record<string, unknown>, ctx: TemplateContext): { command: string; cwd?: string } {
    return {
      command: resolveTemplate(params.command as string, ctx),
      cwd: params.cwd ? resolveTemplate(params.cwd as string, ctx) : ctx.project?.path,
    }
  }

  private async executeAction(params: Record<string, unknown>, ctx: TemplateContext): Promise<{ outputTail: string | null }> {
    const { command, cwd } = this.resolveActionExecution(params, ctx)
    const result = await this.runCommand(command, cwd)
    return { outputTail: trimOutputTail(`${result.stdout}${result.stderr}`) }
  }

  private runCommand(command: string, cwd?: string): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = exec(command, { cwd, timeout: ACTION_TIMEOUT_MS }, (err, stdout, stderr) => {
        const outputTail = trimOutputTail(`${stdout}${stderr}`)
        if (err) reject(new AutomationCommandError(`Command failed: ${err.message}\n${stderr}`, outputTail))
        else resolve({ stdout, stderr })
      })
      setTimeout(() => child.kill(), ACTION_TIMEOUT_MS + 1000)
    })
  }

  private recordAutomationTimelineEvent(
    automation: Automation,
    event: AutomationEvent,
    runId: string,
    status: 'success' | 'error',
    error: string | null
  ): void {
    if (!event.taskId) return

    recordActivityEvent(this.db, {
      entityType: 'automation_run',
      entityId: runId,
      projectId: event.projectId ?? automation.project_id,
      taskId: event.taskId,
      kind: status === 'success' ? 'automation.run_succeeded' : 'automation.run_failed',
      actorType: 'automation',
      source: 'automations',
      summary: `Automation "${automation.name}" ${status === 'success' ? 'succeeded' : 'failed'}`,
      payload: {
        automationId: automation.id,
        automationName: automation.name,
        status,
        error,
      },
    })
  }

  private buildTemplateContext(event: AutomationEvent): TemplateContext {
    const ctx: TemplateContext = {
      trigger: {
        old_status: event.oldStatus,
        new_status: event.newStatus,
      }
    }

    if (event.taskId) {
      const task = this.db.prepare(
        'SELECT id, title AS name, status, priority, worktree_path, worktree_parent_branch AS branch, terminal_mode, project_id FROM tasks WHERE id = ?'
      ).get(event.taskId) as {
        id: string; name: string; status: string; priority: number
        worktree_path: string | null; branch: string | null; terminal_mode: string | null; project_id: string
      } | undefined
      if (task) {
        // Read flags from provider_config JSON
        let terminalModeFlags: string | null = null
        if (task.terminal_mode) {
          const raw = this.db.prepare('SELECT provider_config FROM tasks WHERE id = ?').get(event.taskId) as { provider_config: string | null } | undefined
          if (raw?.provider_config) {
            try {
              const config = JSON.parse(raw.provider_config)
              terminalModeFlags = config[task.terminal_mode]?.flags ?? null
            } catch { /* ignore */ }
          }
        }
        ctx.task = {
          id: task.id, name: task.name, status: task.status, priority: task.priority,
          worktree_path: task.worktree_path, branch: task.branch,
          terminal_mode: task.terminal_mode, terminal_mode_flags: terminalModeFlags,
        }
      }
    }

    if (event.projectId) {
      const project = this.db.prepare('SELECT id, name, path FROM projects WHERE id = ?').get(event.projectId) as {
        id: string; name: string; path: string
      } | undefined
      if (project) {
        ctx.project = { id: project.id, name: project.name, path: project.path }
      }
    }

    return ctx
  }

  private pruneOldRuns(automationId: string): void {
    this.db.prepare(
      `DELETE FROM automation_runs WHERE automation_id = ? AND id NOT IN (
        SELECT id FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT ?
      )`
    ).run(automationId, automationId, MAX_RUNS_PER_AUTOMATION)
  }

  async executeManual(automationId: string): Promise<AutomationRun> {
    const row = this.db.prepare('SELECT * FROM automations WHERE id = ?').get(automationId) as AutomationRow | undefined
    if (!row) throw new Error('Automation not found')
    const automation = parseAutomationRow(row)

    const event: AutomationEvent = {
      type: 'manual',
      projectId: automation.project_id,
      automationId: automation.id,
      depth: 0,
    }

    await this.executeAutomation(automation, event, 0)
    return this.db.prepare('SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT 1').get(automation.id) as AutomationRun
  }
}
