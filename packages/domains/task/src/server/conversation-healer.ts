import type { SlayzoneDb } from '@slayzone/platform'
import {
  setConversationHealer,
  setConversationResolver,
  claudeTranscriptExists,
  claudeTranscriptPath,
  listClaudeTranscriptIds,
  readClaudeTranscriptMeta,
  type ConversationHealRequest
} from '@slayzone/terminal/server'
import { getCurrentBranch } from '@slayzone/worktrees/server'
import { recordDiagnosticEvent } from '@slayzone/diagnostics/server'
import { decideConversationHeal, parseSqliteUtc, type HealTranscriptMeta } from '../shared/index.js'
import {
  getTaskOp,
  collectReferencedConversationIds,
  recordConversation,
  getCurrentConversationId
} from './ops/index.js'

/** Max gap between task creation and the real Claude session's first message,
 *  used to bound the orphan candidate window. */
const HEAL_WINDOW_MS = 5 * 60 * 1000

/** Tasks created before the fix shipped have no recorded `conversationHistory`, so
 *  they rely on the conservative on-disk orphan match. Newer tasks build history
 *  from real SessionStarts and use ONLY that zero-guess path — the orphan
 *  heuristic can never run on them. Retire this gate once the legacy backlog has
 *  drained. */
const FIX_SHIP_TS = Date.parse('2026-06-04T00:00:00Z')

/**
 * Register the conversation self-heal + authoritative resolver invoked by
 * `createPty` before a resume. Lives in `task/server` (not the composition root)
 * so BOTH hosts — the Electron main process AND the slice-9 sidecar, which now
 * owns the pty runtime — wire the SAME implementation by importing this one
 * module. Pre-fix it lived in `apps/app/src/main`, so post-inversion the sidecar
 * (where `createPty` actually runs) had a null healer/resolver and a stale
 * conversation id looped `--resume` forever. See plans/conv-id-robustness-v2.md
 * and the slice-9 orphaned-listener class (composition.ts state-change note).
 *
 * The package graph runs task → terminal/worktrees/diagnostics, so this module
 * can reach the task DB ops, transcript helpers, branch lookup, and diagnostics
 * without a cycle — the reason it could not live in `terminal/server` directly.
 *
 * Safety: never guesses. A healthy pointer is left untouched; any ambiguity in the
 * legacy orphan path resolves to the honest "session expired" overlay. The decision
 * matrix is the pure, unit-tested `decideConversationHeal`; this wrapper only does
 * the IO (disk stats, transcript head parsing, referenced-id lookup) and the
 * atomic compare-and-swap repoint.
 */
export function registerConversationHealer(db: SlayzoneDb, notifyRenderer: () => void): void {
  setConversationHealer(async ({ taskId, mode, cwd, storedId }: ConversationHealRequest) => {
    // Only claude-code persists transcripts at the path we read.
    if (mode !== 'claude-code') return { id: storedId, healed: false }
    try {
      const task = await getTaskOp(db, taskId)
      if (!task) return { id: storedId, healed: false }

      const history = task.provider_config?.[mode]?.conversationHistory ?? []
      const storedInHistory = history.includes(storedId)
      const storedExists = claudeTranscriptExists(cwd, storedId)

      // Rule 1 (hot path): a transcript ON DISK is the only proof the stored id
      // is resumable → keep, no disk scan. History membership alone is NOT proof
      // (a zero-turn/pruned session is in history but has no `.jsonl`), so it no
      // longer short-circuits here — it flows into decideConversationHeal, which
      // repoints to a surviving sibling or surfaces the honest overlay.
      if (storedExists) return { id: storedId, healed: false }

      const createdAtMs = parseSqliteUtc(task.created_at)
      const isLegacy = !Number.isNaN(createdAtMs) && createdAtMs < FIX_SHIP_TS

      // Rule 2: exact history fallback (which recorded ids still exist on disk).
      const historyExists = history.map((id) => ({ id, exists: claudeTranscriptExists(cwd, id) }))

      // Rule 3: orphan candidates — gathered lazily, legacy-only.
      let candidates: HealTranscriptMeta[] = []
      let taskBranch: string | null = null
      if (isLegacy) {
        const ids = await listClaudeTranscriptIds(cwd)
        if (ids.length > 0) {
          const [referenced, branch, metas] = await Promise.all([
            collectReferencedConversationIds(db),
            getCurrentBranch(cwd),
            Promise.all(
              ids.map(async (id) => ({
                id,
                meta: await readClaudeTranscriptMeta(claudeTranscriptPath(cwd, id))
              }))
            )
          ])
          taskBranch = branch
          candidates = metas.map(({ id, meta }) => ({
            id,
            cwd: meta.cwd ?? '',
            firstTsMs: meta.firstTsMs,
            gitBranch: meta.gitBranch,
            hasHumanTurn: meta.hasHumanTurn,
            referenced: referenced.has(id)
          }))
        }
      }

      const decision = decideConversationHeal({
        storedId,
        storedExists,
        storedInHistory,
        history: historyExists,
        task: { cwd, gitBranch: taskBranch, createdAtMs, isLegacy },
        candidates,
        windowMs: HEAL_WINDOW_MS
      })

      if (decision.action === 'keep') return { id: storedId, healed: false }
      if (decision.action === 'overlay') {
        recordDiagnosticEvent({
          level: 'info',
          source: 'pty',
          event: 'conv_id.heal_skipped',
          taskId,
          message: storedId,
          payload: { reason: candidates.length ? 'ambiguous' : 'none', candidateCount: candidates.length }
        })
        return { id: storedId, healed: false }
      }

      // history | orphan → append a `cas-repoint-heal` row to task_conversations.
      // Under append-only semantics there is no CAS to fail: getCurrentConversationId
      // picks up the newest honored row on the next read.
      await recordConversation(db, {
        taskId,
        mode,
        conversationId: decision.id,
        origin: 'cas-repoint-heal'
      })
      notifyRenderer()
      recordDiagnosticEvent({
        level: 'info',
        source: 'pty',
        event: 'conv_id.heal',
        taskId,
        message: `${storedId} -> ${decision.id}`,
        payload: { via: decision.action, oldId: storedId, newId: decision.id }
      })
      return { id: decision.id, healed: true }
    } catch {
      // Best-effort — on any failure resume the original id (→ overlay if stale).
      return { id: storedId, healed: false }
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
export function registerConversationResolver(db: SlayzoneDb): void {
  setConversationResolver(async ({ taskId, mode }) => {
    try {
      return await getCurrentConversationId(db, taskId, mode)
    } catch {
      return null
    }
  })
}
