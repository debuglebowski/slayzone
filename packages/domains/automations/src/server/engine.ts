import type { SlayzoneDb } from '@slayzone/platform'
import type {
  ActionConfig,
  Automation,
  AutomationEvent,
  AutomationRow,
  AutomationRun
} from '@slayzone/automations/shared'
import { trimOutputTail, type RecordActivityEventInput } from '@slayzone/history/server'
import { parseAutomationRow } from '@slayzone/automations/shared'
import {
  buildAiHeadlessCommand,
  resolveTemplate,
  type TemplateContext
} from '@slayzone/automations/shared'
import { taskEvents } from '@slayzone/task/server'
import { exec } from 'child_process'
import { assertAutomationActionsAllowed } from './hub-exec-actions'

const MAX_DEPTH = 5
const ACTION_TIMEOUT_MS = 30_000
const AI_ACTION_TIMEOUT_MS = 5 * 60_000
const MAX_RUNS_PER_AUTOMATION = 100

/**
 * Engine work runs off the caller's stack (event listeners, the cron timer), so a
 * failure there has nobody to answer to. It is logged and dropped, never left
 * floating: an automation row is client-written config (`automations.create` stores
 * it as sent), and one rejection with no handler ends the hub's process (T-102).
 */
function detach(work: Promise<unknown>, what: string): void {
  work.catch((err: unknown) => {
    console.warn(
      `[automations] ${what} failed: ${err instanceof Error ? err.message : String(err)}`
    )
  })
}

/** A row whose stored config the engine cannot read (a trigger, condition or action of
 *  the wrong shape) is skipped, so the automations after it still fire. */
function skipRow(id: string, err: unknown): void {
  console.warn(
    `[automations] skipped automation ${id}: ${err instanceof Error ? err.message : String(err)}`
  )
}

/**
 * Structural cross-domain completion-event bus. The Electron host passes
 * `ipcMain` verbatim (tags handlers emit `db:taskTags:setForTask:done` on it);
 * the standalone server passes its own EventEmitter-backed bus. Keeps this
 * module electron-free (`src/server` boundary guard).
 */
export type AutomationTriggerBus = {
  // Per-channel payloads are unknowable from here (the bus is one untyped
  // string→args channel map), so listeners take `unknown[]` and destructure
  // what the emitting side documents. Structurally matches IpcMain.on.
  on(channel: string, listener: (...args: unknown[]) => void): unknown
}

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
    return expr.split(',').some((v) => parseInt(v, 10) === value)
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
    private db: SlayzoneDb,
    private notifyRenderer: () => void
  ) {}

  start(bus: AutomationTriggerBus): void {
    // --- Task status change ---
    taskEvents.on('task:updated', ({ taskId, projectId, oldStatus }) => {
      if (oldStatus === undefined) return
      detach(
        (async () => {
          const row = await this.db.get<{ status: string }>(
            'SELECT status FROM tasks WHERE id = ?',
            [taskId]
          )
          if (!row) return
          if (oldStatus === row.status) return

          await this.handleEvent({
            type: 'task_status_change',
            taskId,
            projectId,
            oldStatus,
            newStatus: row.status,
            depth: this.currentDepth
          })
        })(),
        'task status change'
      )
    })

    // --- Task created ---
    taskEvents.on('task:created', ({ taskId, projectId }) => {
      detach(
        this.handleEvent({ type: 'task_created', taskId, projectId, depth: 0 }),
        'task created'
      )
    })

    // --- Task archived ---
    taskEvents.on('task:archived', ({ taskId, projectId }) => {
      detach(
        (async () => {
          const exists = await this.db.get('SELECT 1 FROM tasks WHERE id = ?', [taskId])
          if (!exists) return
          await this.handleEvent({ type: 'task_archived', taskId, projectId, depth: 0 })
        })(),
        'task archived'
      )
    })

    // --- Task tag changed ---
    // Emitted by the legacy IPC tags handler (host) AND, since slice 9, by the
    // tRPC `tags.setForTask` path via the task-trigger bus registry (set to this
    // same bus by the side-car composition).
    bus.on('db:taskTags:setForTask:done', (...args: unknown[]) => {
      // ipcMain-shaped payload: a leading event arg (null on the sidecar bus),
      // then the tags handler's own (taskId, tagIds).
      const [, taskId, tagIds] = args as [unknown, string, string[]]
      detach(
        (async () => {
          const task = await this.db.get<{ project_id: string }>(
            'SELECT project_id FROM tasks WHERE id = ?',
            [taskId]
          )
          if (task)
            await this.handleEvent({
              type: 'task_tag_changed',
              taskId,
              projectId: task.project_id,
              tagIds,
              depth: 0
            })
        })(),
        'task tags changed'
      )
    })

    // --- Cron ---
    this.cronInterval = setInterval(() => detach(this.tickCron(), 'cron tick'), 60_000)

    // Catch up on missed cron fires after offline period (app closed, sleep, etc.)
    detach(this.runCatchup(), 'cron catch-up')
  }

  /**
   * Scan enabled cron automations with catchup_on_start=1. If any cron slot
   * matched between last_run_at and now, fire once (coalesced — never replay
   * every missed slot).
   *
   * Public so external triggers (e.g. powerMonitor.resume) can re-run it.
   */
  async runCatchup(): Promise<void> {
    const rows = (await this.db.all<AutomationRow>(
      "SELECT * FROM automations WHERE enabled = 1 AND catchup_on_start = 1 AND last_run_at IS NOT NULL AND json_extract(trigger_config, '$.type') = 'cron'"
    )) as AutomationRow[]

    const now = new Date()
    const nowFloor = new Date(now)
    nowFloor.setSeconds(0, 0)

    for (const row of rows) {
      // One malformed row must not stop the rest (see `skipRow`).
      try {
        this.catchUp(row, nowFloor)
      } catch (err) {
        skipRow(row.id, err)
      }
    }
  }

  private catchUp(row: AutomationRow, nowFloor: Date): void {
    const automation = parseAutomationRow(row)
    const expression = automation.trigger_config.params.expression as string | undefined
    if (!expression || !row.last_run_at) return

    // SQLite stores datetime('now') as 'YYYY-MM-DD HH:MM:SS' (UTC, no zone).
    const lastRun = new Date(row.last_run_at.replace(' ', 'T') + 'Z')
    if (Number.isNaN(lastRun.getTime())) return
    if (lastRun >= nowFloor) return

    // Walk back minute-by-minute from previous minute to (lastRun, exclusive).
    // Stop at first match — we coalesce all missed fires into one run.
    const cursor = new Date(nowFloor)
    cursor.setMinutes(cursor.getMinutes() - 1)
    while (cursor > lastRun) {
      if (cronMatches(expression, cursor)) {
        detach(
          this.executeAutomation(
            automation,
            {
              type: 'cron',
              projectId: automation.project_id,
              cronExpression: expression,
              depth: 0,
              catchup: true
            },
            0
          ),
          `automation ${automation.id}`
        )
        break
      }
      cursor.setMinutes(cursor.getMinutes() - 1)
    }
  }

  stop(): void {
    if (this.cronInterval) {
      clearInterval(this.cronInterval)
      this.cronInterval = null
    }
  }

  private async tickCron(): Promise<void> {
    const now = new Date()
    const rows = (await this.db.all<AutomationRow>(
      "SELECT * FROM automations WHERE enabled = 1 AND json_extract(trigger_config, '$.type') = 'cron'"
    )) as AutomationRow[]

    for (const row of rows) {
      try {
        const automation = parseAutomationRow(row)
        const expression = automation.trigger_config.params.expression as string | undefined
        if (expression && cronMatches(expression, now)) {
          detach(
            this.executeAutomation(
              automation,
              {
                type: 'cron',
                projectId: automation.project_id,
                cronExpression: expression,
                depth: 0
              },
              0
            ),
            `automation ${automation.id}`
          )
        }
      } catch (err) {
        skipRow(row.id, err)
      }
    }
  }

  private async handleEvent(event: AutomationEvent): Promise<void> {
    const depth = event.depth ?? 0
    if (depth >= MAX_DEPTH) return
    if (!event.projectId) return

    const rows = await this.db.all<AutomationRow>(
      'SELECT * FROM automations WHERE project_id = ? AND enabled = 1',
      [event.projectId]
    )

    for (const row of rows) {
      try {
        const automation = parseAutomationRow(row)
        if (this.matchesTrigger(automation, event)) {
          if (await this.evaluateConditions(automation, event)) {
            detach(this.executeAutomation(automation, event, depth), `automation ${automation.id}`)
          }
        }
      } catch (err) {
        skipRow(row.id, err)
      }
    }
  }

  private matchesTrigger(automation: Automation, event: AutomationEvent): boolean {
    const trigger = automation.trigger_config
    if (trigger.type !== event.type) return false

    switch (trigger.type) {
      case 'task_status_change': {
        const { fromStatus, toStatus } = trigger.params as {
          fromStatus?: string
          toStatus?: string
        }
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

  private async evaluateConditions(
    automation: Automation,
    event: AutomationEvent
  ): Promise<boolean> {
    for (const condition of automation.conditions) {
      if (condition.type === 'task_property' && event.taskId) {
        const { field, operator, value } = condition.params as {
          field: string
          operator: string
          value: unknown
        }

        // tags_contains_some: check against task_tags join table
        if (field === 'tags') {
          const tagRows = await this.db.all<{ tag_id: string }>(
            'SELECT tag_id FROM task_tags WHERE task_id = ?',
            [event.taskId]
          )
          const taskTagIds = tagRows.map((r) => r.tag_id)
          if (operator === 'in' && Array.isArray(value)) {
            if (!value.some((v) => taskTagIds.includes(v as string))) return false
          }
          continue
        }

        // Regular task fields
        const task = await this.db.get<Record<string, unknown>>(
          'SELECT * FROM tasks WHERE id = ?',
          [event.taskId]
        )
        if (!task) return false

        const actual = task[field]

        switch (operator) {
          case 'equals':
            if (actual !== value) return false
            break
          case 'not_equals':
            if (actual === value) return false
            break
          case 'exists':
            if (actual == null || actual === '') return false
            break
          case 'not_exists':
            if (actual != null && actual !== '') return false
            break
          case 'in': {
            if (!Array.isArray(value)) return false
            // Coerce to string for comparison — UI stores values as strings, DB may return numbers
            if (!value.some((v) => String(v) === String(actual))) return false
            break
          }
          default:
            return false
        }
      }
    }
    return true
  }

  private async executeAutomation(
    automation: Automation,
    event: AutomationEvent,
    depth: number
  ): Promise<void> {
    const runId = crypto.randomUUID()
    const startTime = Date.now()

    await this.db.run(
      `INSERT INTO automation_runs (id, automation_id, trigger_event, status, started_at)
       VALUES (?, ?, ?, 'running', datetime('now'))`,
      [runId, automation.id, JSON.stringify(event)]
    )

    const ctx = await this.buildTemplateContext(event)
    const prevDepth = this.currentDepth
    let runStatus: 'success' | 'error' = 'success'
    let runError: string | null = null

    try {
      this.currentDepth = depth + 1
      for (let i = 0; i < automation.actions.length; i++) {
        const action = automation.actions[i]
        // Before anything is resolved or exec'd: a rule saved before the switch was
        // turned off, or written straight into the database, is refused here.
        assertAutomationActionsAllowed([action], { op: 'run', automationId: automation.id })
        const resolved = await this.resolveAction(action, ctx)
        const actionRunId = await this.db.namedTxn('automations:start-action-run', {
          input: {
            runId,
            automationId: automation.id,
            taskId: event.taskId ?? null,
            projectId: event.projectId ?? null,
            actionIndex: i,
            actionType: action.type,
            command: resolved.command
          }
        })
        const actionStart = Date.now()

        try {
          const result = await this.runResolvedAction(resolved)
          await this.db.namedTxn('automations:finish-action-run', {
            id: actionRunId,
            input: {
              status: 'success',
              outputTail: result.outputTail,
              durationMs: Date.now() - actionStart
            }
          })
        } catch (err) {
          await this.db.namedTxn('automations:finish-action-run', {
            id: actionRunId,
            input: {
              status: 'error',
              outputTail: err instanceof AutomationCommandError ? err.outputTail : null,
              error: err instanceof Error ? err.message : String(err),
              durationMs: Date.now() - actionStart
            }
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
    await this.db.namedTxn('automations:complete-run', {
      runId,
      automationId: automation.id,
      durationMs,
      runStatus,
      runError,
      timelineEvent: this.buildAutomationTimelineEvent(
        automation,
        event,
        runId,
        runStatus,
        runError
      )
    })

    await this.pruneOldRuns(automation.id)
    this.notifyRenderer()
  }

  private async resolveAction(
    action: ActionConfig,
    ctx: TemplateContext
  ): Promise<{ command: string; cwd?: string; timeoutMs: number }> {
    const params = action.params
    const cwd = params.cwd ? resolveTemplate(params.cwd as string, ctx) : ctx.project?.path

    if (action.type === 'ai') {
      const providerId = typeof params.provider === 'string' ? params.provider.trim() : ''
      if (!providerId) throw new Error('AI action missing provider')
      const row = await this.db.get<{
        id: string
        type: string
        default_flags: string | null
        headless_command: string | null
      }>('SELECT id, type, default_flags, headless_command FROM terminal_modes WHERE id = ?', [
        providerId
      ])
      if (!row) throw new Error(`AI action references unknown provider "${providerId}"`)

      const resolvedPrompt = resolveTemplate(params.prompt, ctx)
      if (!resolvedPrompt.trim()) throw new Error('AI action missing prompt')

      // Flags are NOT template-resolved — they're inserted unquoted into the
      // shell command, so allowing user-controlled task/project text in there
      // would be a shell-injection vector. Templates belong in the prompt
      // (which is shell-quoted). Engine + dialog mirror this guard.
      const rawFlags = typeof params.flags === 'string' ? params.flags : undefined
      if (rawFlags?.includes('{{')) {
        throw new Error(
          'AI action: template variables are not allowed in flags — put them in the prompt'
        )
      }

      const command = buildAiHeadlessCommand(
        { provider: providerId, prompt: resolvedPrompt, flags: rawFlags },
        {
          id: row.id,
          type: row.type,
          headlessCommand: row.headless_command,
          defaultFlags: row.default_flags
        }
      )
      if (!command) {
        throw new Error(
          `AI action: provider "${providerId}" has no headless command template configured`
        )
      }
      return { command, cwd, timeoutMs: AI_ACTION_TIMEOUT_MS }
    }

    if (action.type === 'run_command') {
      const command = resolveTemplate(params.command, ctx)
      if (!command.trim()) throw new Error('run_command action missing command')
      return { command, cwd, timeoutMs: ACTION_TIMEOUT_MS }
    }

    throw new Error(`Unknown action type: "${(action as ActionConfig).type}"`)
  }

  private async runResolvedAction(resolved: {
    command: string
    cwd?: string
    timeoutMs: number
  }): Promise<{ outputTail: string | null }> {
    const result = await this.runCommand(resolved.command, resolved.cwd, resolved.timeoutMs)
    return { outputTail: trimOutputTail(`${result.stdout}${result.stderr}`) }
  }

  private runCommand(
    command: string,
    cwd: string | undefined,
    timeoutMs: number
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = exec(command, { cwd, timeout: timeoutMs }, (err, stdout, stderr) => {
        const outputTail = trimOutputTail(`${stdout}${stderr}`)
        if (err)
          reject(
            new AutomationCommandError(`Command failed: ${err.message}\n${stderr}`, outputTail)
          )
        else resolve({ stdout, stderr })
      })
      setTimeout(() => child.kill(), timeoutMs + 1000)
    })
  }

  // Build the timeline activity event for a completed run. Returns `null` when
  // there's no task to attribute it to. The caller hands this to the
  // `automations:complete-run` named transaction, which records it atomically
  // with the run-completion writes via the synchronous recorder in the worker.
  private buildAutomationTimelineEvent(
    automation: Automation,
    event: AutomationEvent,
    runId: string,
    status: 'success' | 'error',
    error: string | null
  ): RecordActivityEventInput | null {
    if (!event.taskId) return null

    return {
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
        error
      }
    }
  }

  private async buildTemplateContext(event: AutomationEvent): Promise<TemplateContext> {
    const ctx: TemplateContext = {
      trigger: {
        old_status: event.oldStatus,
        new_status: event.newStatus
      }
    }

    if (event.taskId) {
      const task = await this.db.get<{
        id: string
        name: string
        status: string
        priority: number
        worktree_path: string | null
        branch: string | null
        terminal_mode: string | null
        project_id: string
      }>(
        'SELECT id, title AS name, status, priority, worktree_path, worktree_parent_branch AS branch, terminal_mode, project_id FROM tasks WHERE id = ?',
        [event.taskId]
      )
      if (task) {
        // Read flags from provider_config JSON
        let terminalModeFlags: string | null = null
        if (task.terminal_mode) {
          const raw = await this.db.get<{ provider_config: string | null }>(
            'SELECT provider_config FROM tasks WHERE id = ?',
            [event.taskId]
          )
          if (raw?.provider_config) {
            try {
              const config = JSON.parse(raw.provider_config)
              terminalModeFlags = config[task.terminal_mode]?.flags ?? null
            } catch {
              /* ignore */
            }
          }
        }
        ctx.task = {
          id: task.id,
          name: task.name,
          status: task.status,
          priority: task.priority,
          worktree_path: task.worktree_path,
          branch: task.branch,
          terminal_mode: task.terminal_mode,
          terminal_mode_flags: terminalModeFlags
        }
      }
    }

    if (event.projectId) {
      const project = await this.db.get<{
        id: string
        name: string
        path: string
      }>('SELECT id, name, path FROM projects WHERE id = ?', [event.projectId])
      if (project) {
        ctx.project = { id: project.id, name: project.name, path: project.path }
      }
    }

    return ctx
  }

  private async pruneOldRuns(automationId: string): Promise<void> {
    await this.db.run(
      `DELETE FROM automation_runs WHERE automation_id = ? AND id NOT IN (
        SELECT id FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT ?
      )`,
      [automationId, automationId, MAX_RUNS_PER_AUTOMATION]
    )
  }

  async executeManual(automationId: string): Promise<AutomationRun> {
    const row = await this.db.get<AutomationRow>('SELECT * FROM automations WHERE id = ?', [
      automationId
    ])
    if (!row) throw new Error('Automation not found')
    const automation = parseAutomationRow(row)
    // A manual run is a request: refuse it to the caller rather than recording a
    // failed run.
    assertAutomationActionsAllowed(automation.actions, { op: 'run', automationId: automation.id })

    const event: AutomationEvent = {
      type: 'manual',
      projectId: automation.project_id,
      automationId: automation.id,
      depth: 0
    }

    await this.executeAutomation(automation, event, 0)
    return (await this.db.get<AutomationRun>(
      'SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT 1',
      [automation.id]
    )) as AutomationRun
  }
}
