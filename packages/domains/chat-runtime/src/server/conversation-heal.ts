/**
 * The conversation self-heal, decided on the computer the agent runs on
 * (robustness plan §9, P0): before a terminal agent resumes `storedId`, is its
 * transcript there — and if not, is there a sibling session of the same tab to
 * repoint to, a never-written id to start fresh, or only the honest "session
 * expired" overlay?
 *
 * Every fact it decides on lives here: the session ledger (candidates, other
 * tasks' claims, first-seen time, the pre-ledger history), the transcripts on this
 * disk, the checkout's branch and Claude's retention setting. The hub only asks
 * (`ledger` op `healConversation`) and records the diagnostic this returns.
 *
 * Safety: never guesses. A healthy pointer is left untouched; an unknown answer
 * (the transcript locator could not tell) keeps the id; any ambiguity in the
 * legacy orphan path resolves to the overlay. The decision matrix is the pure,
 * unit-tested `decideConversationHeal`.
 *
 * @module chat-runtime/server/conversation-heal
 */
import type { SlayzoneDb } from '@slayzone/platform'
import { decideConversationHeal, type HealTranscriptMeta } from '@slayzone/task-contracts'
import {
  claudeTranscriptPath,
  claudeTranscriptRetentionMs,
  listClaudeTranscriptIds,
  locateClaudeTranscript,
  readClaudeTranscriptMeta
} from '@slayzone/terminal/claude-transcripts'
import * as ledger from './session-ledger'

/** Max gap between task creation and the real Claude session's first message. */
const HEAL_WINDOW_MS = 5 * 60 * 1000

/**
 * Tasks created before the history fix shipped have no recorded history, so they
 * rely on the conservative on-disk orphan match. Newer tasks use ONLY the
 * zero-guess history path.
 */
const FIX_SHIP_TS = Date.parse('2026-06-04T00:00:00Z')

/** What the heal reads from this computer's disk and checkout. */
export interface ConversationHealIo {
  /**
   * Where each transcript is: `found` per id. An id missing from the map is
   * UNKNOWN; null = unknown altogether. Unknown is never treated as absent.
   */
  locate(req: {
    cwd: string
    projectId: string | null
    sessionIds: string[]
  }): Promise<Map<string, { found: boolean }> | null>
  /** Transcript ids in `cwd`'s project dir (legacy orphan path only). */
  listTranscriptIds(cwd: string): Promise<string[]>
  /** Identity metadata of the transcript `id` in `cwd`'s project dir. */
  readTranscriptMeta(
    cwd: string,
    id: string
  ): Promise<Omit<HealTranscriptMeta, 'id' | 'referenced' | 'cwd'> & { cwd: string | null }>
  /** The checked-out branch of the repo at `cwd`, or null. */
  currentBranch(cwd: string): Promise<string | null>
  /** Claude's transcript retention in ms (null = unknown). */
  retentionMs(): number | null
}

/** This process's disk, unjailed — for tests and single-machine harnesses only. */
export const localConversationHealIo: ConversationHealIo = {
  async locate({ cwd, sessionIds }) {
    const out = new Map<string, { found: boolean }>()
    for (const id of sessionIds)
      out.set(id, { found: (await locateClaudeTranscript(id, cwd)) != null })
    return out
  },
  listTranscriptIds: listClaudeTranscriptIds,
  readTranscriptMeta: (cwd, id) => readClaudeTranscriptMeta(claudeTranscriptPath(cwd, id)),
  currentBranch: async () => null,
  retentionMs: claudeTranscriptRetentionMs
}

export interface HealConversationRequest {
  taskId: string
  mode: string
  /** Sessions are per tab (v201): a heal repoints only within the spawning tab. */
  tabId: string
  cwd: string
  projectId: string | null
  storedId: string
  /** The task's creation time (ms), from the hub's task row; NaN = unknown. */
  taskCreatedAtMs: number
}

/** A diagnostic the hub records for this decision. */
export interface HealDiagnostic {
  event: 'conv_id.heal' | 'conv_id.heal_fresh' | 'conv_id.heal_skipped'
  message: string
  payload: Record<string, unknown>
}

export interface HealConversationResult {
  id: string
  healed: boolean
  fresh?: true
  diagnostic?: HealDiagnostic
}

export async function healConversation(
  db: SlayzoneDb,
  io: ConversationHealIo,
  req: HealConversationRequest
): Promise<HealConversationResult> {
  const { taskId, mode, tabId, cwd, storedId } = req
  const keep: HealConversationResult = { id: storedId, healed: false }
  // Only claude-code persists transcripts at the path read here.
  if (mode !== 'claude-code') return keep
  // Candidates: every session this tab owns after its last reset (newest first),
  // plus the main tab's pre-ledger history (a warm-pool-adopted task has none of
  // the latter: its pooled agent booted with no task id).
  const legacyHistory =
    tabId === taskId ? await ledger.legacyConversationHistory(db, taskId, mode) : []
  const owned = await ledger.listResumeCandidates(db, taskId, mode, tabId)
  // One task per provider session: a pre-ledger history id another task owns
  // (a `/resume` in a shared cwd) is never a repoint target.
  const merged = [...new Set([...owned, ...legacyHistory])]
  const foreign = await ledger.claimedByOtherTasks(db, taskId, merged)
  const history = merged.filter((id) => !foreign.has(id))

  // Wherever each transcript is on this disk, in ANY project dir: a session that
  // used EnterWorktree keeps its file only under the worktree's.
  const located = await io.locate({
    cwd,
    projectId: req.projectId,
    sessionIds: [...new Set([storedId, ...history])]
  })
  // Unknown: it may well exist. Resume it — never fresh, never a repoint on a guess.
  const storedLocated = located?.get(storedId)
  if (!storedLocated) return keep
  // A transcript on disk is the only proof the stored id is resumable.
  if (storedLocated.found) return keep

  const createdAtMs = req.taskCreatedAtMs
  const isLegacy = !Number.isNaN(createdAtMs) && createdAtMs < FIX_SHIP_TS
  // Which recorded ids still exist; one the locator did not answer for counts as absent.
  const historyExists = history.map((id) => ({ id, exists: located?.get(id)?.found === true }))

  // Orphan candidates: legacy tasks only.
  let candidates: HealTranscriptMeta[] = []
  let taskBranch: string | null = null
  if (isLegacy) {
    const ids = await io.listTranscriptIds(cwd)
    if (ids.length > 0) {
      const [referenced, branch, metas] = await Promise.all([
        ledger.referencedConversationIds(db).then((r) => new Set(r)),
        io.currentBranch(cwd),
        Promise.all(ids.map(async (id) => ({ id, meta: await io.readTranscriptMeta(cwd, id) })))
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

  const storedFirstSeenAtMs = await ledger.getConversationFirstSeenAt(db, storedId)
  const retentionMs = io.retentionMs()
  const decision = decideConversationHeal({
    storedId,
    storedExists: false,
    storedInHistory: history.includes(storedId),
    history: historyExists,
    task: { cwd, gitBranch: taskBranch, createdAtMs, isLegacy },
    candidates,
    windowMs: HEAL_WINDOW_MS,
    storedFirstSeenAtMs,
    retentionMs,
    nowMs: Date.now()
  })

  if (decision.action === 'keep') return keep
  if (decision.action === 'fresh') {
    // Never prompted (no transcript was ever written): `--resume` could only fail,
    // so the same id starts fresh. Nothing is lost, and no false "session expired".
    return {
      ...keep,
      fresh: true,
      diagnostic: {
        event: 'conv_id.heal_fresh',
        message: storedId,
        payload: { firstSeenAgoMs: Date.now() - (storedFirstSeenAtMs ?? 0), retentionMs }
      }
    }
  }
  if (decision.action === 'overlay') {
    return {
      ...keep,
      diagnostic: {
        event: 'conv_id.heal_skipped',
        message: storedId,
        // `historyCount` tells "no other session" from "the candidate source was blind".
        payload: {
          reason: candidates.length ? 'ambiguous' : 'none',
          candidateCount: candidates.length,
          historyCount: history.length,
          historyOnDisk: historyExists.filter((h) => h.exists).length
        }
      }
    }
  }
  // history | orphan: append the repoint; the next current-session read picks it up.
  await ledger.recordConversation(db, {
    taskId,
    mode,
    tabId,
    conversationId: decision.id,
    origin: 'cas-repoint-heal'
  })
  return {
    id: decision.id,
    healed: true,
    diagnostic: {
      event: 'conv_id.heal',
      message: `${storedId} -> ${decision.id}`,
      payload: { via: decision.action, oldId: storedId, newId: decision.id, tabId }
    }
  }
}
