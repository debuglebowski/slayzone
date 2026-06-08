import type { Database } from 'better-sqlite3'
import type { AutomationRow } from '@slayzone/automations/shared'
import {
  finishAutomationActionRun,
  recordActivityEvent,
  startAutomationActionRun,
  type FinishAutomationActionRunInput,
  type StartAutomationActionRunInput
} from '@slayzone/history/recorder'

/**
 * Named-transaction adapters for the automations domain. These are the
 * operations that either read-then-write conditionally (create reads
 * MAX(sort_order)) or must bundle several writes — including the synchronous
 * `@slayzone/history` recorder helpers — atomically inside the DB worker. The
 * recorder helpers operate on a SYNCHRONOUS better-sqlite3 `Database`, so they
 * can only run here in the worker (the async `SlayzoneDb` proxy can't be handed
 * to them). Registered into the worker's txn registry via
 * `@slayzone/automations/db`. Each function owns its own `db.transaction(...)`
 * where atomicity is required, so the worker invokes it directly without
 * re-wrapping.
 *
 * Pure: imports only better-sqlite3 + the worker-safe `@slayzone/history/recorder`
 * recorder surface, so it is safe to pull into the worker bundle (unlike the
 * electron/child_process-laden engine + handlers).
 *
 * Returns are kept structured-cloneable (raw rows / scalars): the IPC layer
 * parses rows via `parseAutomationRow` after the call.
 */

export interface CreateAutomationTxnParams {
  id: string
  projectId: string
  name: string
  description: string | null
  triggerConfig: string
  conditions: string
  actions: string
  catchupOnStart: number
}

export interface StartActionRunTxnParams {
  input: StartAutomationActionRunInput
}

export interface FinishActionRunTxnParams {
  id: string
  input: FinishAutomationActionRunInput
}

export interface CompleteRunTxnParams {
  runId: string
  automationId: string
  durationMs: number
  runStatus: 'success' | 'error'
  runError: string | null
  /**
   * Pre-built timeline activity event to record alongside the run completion,
   * or `null` when there's no task to attribute it to. Recorded with the
   * synchronous recorder inside this same transaction.
   */
  timelineEvent: Parameters<typeof recordActivityEvent>[1] | null
}

export const automationsTxns = {
  // Reads MAX(sort_order)+1, then inserts at that order — conditional, so it
  // can't be a static op list. Returns the created row for `parseAutomationRow`.
  'automations:create': (db: Database, p: CreateAutomationTxnParams): AutomationRow =>
    db.transaction(() => {
      const maxOrder = db
        .prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM automations WHERE project_id = ?')
        .get(p.projectId) as { m: number }
      db.prepare(
        `INSERT INTO automations (id, project_id, name, description, trigger_config, conditions, actions, sort_order, catchup_on_start)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        p.id,
        p.projectId,
        p.name,
        p.description,
        p.triggerConfig,
        p.conditions,
        p.actions,
        maxOrder.m + 1,
        p.catchupOnStart
      )
      return db.prepare('SELECT * FROM automations WHERE id = ?').get(p.id) as AutomationRow
    })(),

  // Insert a 'running' action-run row and return its id. Wraps the synchronous
  // recorder helper so it runs in the worker.
  'automations:start-action-run': (db: Database, p: StartActionRunTxnParams): string =>
    startAutomationActionRun(db, p.input),

  // Update an action-run row to its terminal state. Wraps the synchronous
  // recorder helper so it runs in the worker.
  'automations:finish-action-run': (db: Database, p: FinishActionRunTxnParams): null => {
    finishAutomationActionRun(db, p.id, p.input)
    return null
  },

  // Finalize a run: update automation_runs + bump the automation's run_count /
  // last_run_at + record the timeline activity event — all atomic. Mirrors the
  // engine's former `db.transaction(...)` + `recordAutomationTimelineEvent`.
  'automations:complete-run': (db: Database, p: CompleteRunTxnParams): null => {
    db.transaction(() => {
      if (p.runStatus === 'success') {
        db.prepare(
          `UPDATE automation_runs SET status = 'success', error = NULL, duration_ms = ?, completed_at = datetime('now') WHERE id = ?`
        ).run(p.durationMs, p.runId)
      } else {
        db.prepare(
          `UPDATE automation_runs SET status = 'error', error = ?, duration_ms = ?, completed_at = datetime('now') WHERE id = ?`
        ).run(p.runError, p.durationMs, p.runId)
      }

      db.prepare(
        `UPDATE automations SET run_count = run_count + 1, last_run_at = datetime('now') WHERE id = ?`
      ).run(p.automationId)

      if (p.timelineEvent) {
        recordActivityEvent(db, p.timelineEvent)
      }
    })()
    return null
  }
}
