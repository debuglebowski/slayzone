import type { SlayzoneDb } from '@slayzone/platform'
import { createChatOwnershipStore } from '@slayzone/chat-runtime/server'
import type { DiagnosticEvent } from '@slayzone/diagnostics/shared'
import { listSharedSessionClaims, relinquishSession } from '@slayzone/task/server'

export interface SharedSessionRepair {
  conversationId: string
  winner: string
  /** `chat-binding`: a chat owner of the winner holds the session. */
  via: 'chat-binding' | 'earliest-claim'
  relinquished: Array<{ taskId: string; mode: string }>
}

/**
 * One task per provider session, made durable (#172 follow-up #4).
 *
 * Pre-ledger builds (before ed8ca45af, 2026-06-06) recorded one Claude session as
 * the session of two tasks, and the v-ledger backfill made both claims honored.
 * The readers already arbitrate (agent-sessions.ts `NOT_CLAIMED_ELSEWHERE_SQL`:
 * the earliest claim wins); this turns the verdict into data. Each losing (task,
 * mode) claim gets a `session_deletions` tombstone, so
 *
 * - a chat owner that holds the session decides the winner — it is the side
 *   driving the transcript, and the readers cannot see chat bindings (task does
 *   not depend on chat-runtime). Without the tombstone the earlier claimant would
 *   keep resolving the session and the hub would refuse its agent;
 * - the winner deleting the session later can never hand it to a loser.
 *
 * Tombstones are reversible (drop the row); transcripts on disk are never
 * touched. Idempotent — a tombstoned claim is no longer listed — so it runs at
 * every boot and also catches any future writer that records a shared id.
 */
export async function repairSharedSessionClaims(deps: {
  db: SlayzoneDb
  record: (event: DiagnosticEvent) => void
}): Promise<SharedSessionRepair[]> {
  const ownership = createChatOwnershipStore(deps.db)
  const repairs: SharedSessionRepair[] = []
  for (const { conversationId, claims } of await listSharedSessionClaims(deps.db)) {
    let bound: string | null = null
    for (const mode of new Set(claims.map((c) => c.mode))) {
      const owner = await ownership.forProviderSession(conversationId, mode)
      if (owner && owner.state !== 'deleted') {
        bound = owner.taskId
        break
      }
    }
    // Claims come earliest first (ties by task id): the readers' winner.
    const winner = bound ?? claims[0].taskId
    const relinquished = claims
      .filter((c) => c.taskId !== winner)
      .map(({ taskId, mode }) => ({ taskId, mode }))
    for (const { taskId, mode } of relinquished)
      await relinquishSession(deps.db, taskId, mode, conversationId)
    const repair: SharedSessionRepair = {
      conversationId,
      winner,
      via: bound ? 'chat-binding' : 'earliest-claim',
      relinquished
    }
    deps.record({
      level: 'warn',
      source: 'pty',
      event: 'conv_id.shared_session_repaired',
      taskId: winner,
      message: conversationId,
      payload: { winner, via: repair.via, relinquished, claims }
    })
    repairs.push(repair)
  }
  return repairs
}
