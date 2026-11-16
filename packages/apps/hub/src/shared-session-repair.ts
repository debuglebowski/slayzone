import type { SlayzoneDb } from '@slayzone/platform'
import { createChatOwnershipStore } from '@slayzone/chat-runtime/hub'
import type { DiagnosticEvent } from '@slayzone/diagnostics/shared'
import { relinquishSession } from '@slayzone/task/server'
import type { ComputerSessionLedger } from '@slayzone/chat-runtime/hub'

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
 *   driving the transcript; the computer names it (`chatSessionOwner`). Without the tombstone the earlier claimant would
 *   keep resolving the session and the hub would refuse its agent;
 * - the winner deleting the session later can never hand it to a loser.
 *
 * Tombstones are reversible (drop the row); transcripts on disk are never
 * touched. Idempotent — a tombstoned claim is no longer listed once its tombstone
 * is delivered — so it runs whenever a computer connects: the session ledger lives
 * on each computer (robustness plan §9), and the claims it lists are that
 * computer's. The tombstones are the hub's intent, delivered like any deletion.
 */
export async function repairSharedSessionClaims(deps: {
  db: SlayzoneDb
  record: (event: DiagnosticEvent) => void
  ledger: Pick<ComputerSessionLedger, 'listSharedSessionClaims' | 'chatSessionOwner'>
  computerId: string
}): Promise<SharedSessionRepair[]> {
  const ownership = createChatOwnershipStore(deps.db)
  const repairs: SharedSessionRepair[] = []
  for (const { conversationId, claims } of await deps.ledger.listSharedSessionClaims(
    deps.computerId
  )) {
    let bound: string | null = null
    for (const mode of new Set(claims.map((c) => c.mode))) {
      // The chat holding the session on this computer (its own record, v208).
      const held = await deps.ledger.chatSessionOwner(deps.computerId, conversationId, mode)
      const owner = held ? await ownership.get(held.conversationId) : null
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
