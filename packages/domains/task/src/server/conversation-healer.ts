import type { SlayzoneDb } from '@slayzone/platform'
import {
  setConversationHealer,
  setConversationResolver,
  type ConversationHealRequest
} from '@slayzone/terminal/hub'
import { recordDiagnosticEvent } from '@slayzone/diagnostics/server'
import { parseSqliteUtc, type TasksChange } from '@slayzone/task-contracts'
import { getTaskOp, taskSessionLedger } from './ops/index.js'

/** The computer's answer (`HealConversationResult`, chat-runtime/server/conversation-heal.ts). */
interface HealAnswer {
  id: string
  healed: boolean
  fresh?: true
  diagnostic?: { event: string; message: string; payload: Record<string, unknown> }
}

/**
 * Register the conversation self-heal invoked by `createPty` before a resume.
 * Lives in `task/server` so every host that runs the pty runtime wires the SAME
 * implementation (plans/conv-id-robustness-v2.md, slice-9 orphaned listeners).
 *
 * The heal is DECIDED on the computer the agent runs on (robustness plan §9, P0:
 * `ledger` op `healConversation`, chat-runtime/server/conversation-heal.ts): its
 * session ledger, its transcripts, its checkout and its Claude retention setting
 * are all there. The hub only forwards the request with the one fact it holds
 * (the task's creation time), records the diagnostic the computer returns, and
 * refreshes the task's board row after a repoint.
 *
 * Safety: any failure (computer offline, an error) resumes the stored id — the
 * CLI resumes it or the honest "session expired" overlay shows. Never fresh on a
 * failure.
 */
export function registerConversationHealer(
  db: SlayzoneDb,
  notifyRenderer: (change?: TasksChange) => void
): void {
  setConversationHealer(async (req: ConversationHealRequest) => {
    const { taskId, mode, cwd, storedId } = req
    const keep = { id: storedId, healed: false }
    // Only claude-code persists transcripts the heal can read.
    if (mode !== 'claude-code') return keep
    // The ledger and the transcripts are on the agent's computer; none = nothing to ask.
    const computerId = req.computerId ?? null
    if (!computerId) return keep
    try {
      const task = await getTaskOp(db, taskId)
      if (!task) return keep
      const createdAtMs = parseSqliteUtc(task.created_at)
      const result = await taskSessionLedger().call<HealAnswer>(computerId, 'healConversation', {
        taskId,
        mode,
        // Sessions are per tab (v201): a heal repoints only within the spawning tab.
        tabId: req.tabId ?? taskId,
        cwd,
        projectId: req.projectId ?? null,
        storedId,
        taskCreatedAtMs: Number.isNaN(createdAtMs) ? null : createdAtMs
      })
      if (result.diagnostic) {
        recordDiagnosticEvent({
          level: 'info',
          source: 'pty',
          event: result.diagnostic.event,
          taskId,
          message: result.diagnostic.message,
          payload: result.diagnostic.payload
        })
      }
      // The repoint lives in this task's ledger → only its board row changes.
      if (result.healed) notifyRenderer({ taskIds: [taskId] })
      return {
        id: result.id,
        healed: result.healed,
        ...(result.fresh ? { fresh: true as const } : {})
      }
    } catch {
      // Best-effort — on any failure resume the original id (→ overlay if stale).
      return keep
    }
  })
}

/**
 * Register the authoritative conversation-id resolver invoked by `createPty`
 * when the renderer passes no `existingConversationId`. Reads the latest honored
 * id from the append-only ledger (`getCurrentConversationId` — manual-reset
 * cutoff + provenance gate enforced in SQL).
 *
 * This is the structural fix for the restart-clobber: previously a boot-time
 * null hint from the renderer made every auto-respawned tab spawn fresh and
 * durably shadow its real conversation. With main resolving from the ledger,
 * a missing hint resumes the known conversation instead of minting over it.
 */
export function registerConversationResolver(): void {
  setConversationResolver(async ({ computerId, taskId, mode, tabId }) => {
    // The ledger is on the computer the agent runs on; none = nothing to resume.
    if (!computerId) return null
    try {
      const ledger = taskSessionLedger()
      // `store` reads prepare the computer first: the hub's remaining rows of the
      // task, its undelivered resets/deletions, its one-time tab recovery.
      const current = await ledger.store.getCurrentConversationId(computerId, taskId, mode, tabId)
      // Observability for the one new way this can answer null: the task HAS
      // sessions, but none has proven content yet (v158), so the spawn goes
      // fresh. Silence here is what made the warm-pool failure take 77 minutes
      // to notice — "no conversation" and "no RESUMABLE conversation" looked
      // identical from the outside.
      if (!current) {
        const owned = await ledger
          .listResumeCandidates(computerId, taskId, mode, tabId)
          .catch(() => [] as string[])
        if (owned.length > 0) {
          recordDiagnosticEvent({
            level: 'info',
            source: 'pty',
            event: 'conv_id.unproven_skipped',
            taskId,
            message: owned[0],
            payload: { mode, tabId, ownedCount: owned.length }
          })
        }
      }
      return current
    } catch {
      return null
    }
  })
}
