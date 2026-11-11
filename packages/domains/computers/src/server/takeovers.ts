import type { SlayzoneDb } from '@slayzone/platform'
import {
  computerIsConnectedError,
  computerIsLocalError,
  computerReplacesItselfError,
  type ComputerStateError
} from './computer-state-errors'
import { getComputer } from './store'

/**
 * Re-enrolled computers (robustness: a remote computer whose credential was lost
 * enrolls again under a NEW id; its old row stays registered and offline). The hub
 * cannot prove the two are one machine — host ids are per OS host and may be shared —
 * so it only OFFERS the takeover, from evidence: the new computer holds chats the hub
 * assigns to the old one. The user confirms with `computers.replace`.
 *
 * Shared by the tRPC router and the REST twin (`slay hub computers takeovers|replace`),
 * so both offer and refuse exactly the same.
 */

/** A conversation `holderComputerId` holds that the hub assigns to `ownerComputerId`. */
export interface TakeoverCandidate {
  conversationId: string
  taskId: string
  ownerComputerId: string
  holderComputerId: string
}

/** "<successor> holds work of <former>": replace <former> with <successor>? */
export interface ComputerTakeover {
  former: { id: string; name: string; lastSeenAt: number | null; revoked: boolean }
  successor: { id: string; name: string; connected: boolean }
  /** Chats the successor holds that the hub assigns to the former. */
  conversations: number
  /** Tasks those chats belong to. */
  tasks: number
}

interface TakeoverScope {
  db: SlayzoneDb
  /** Socket-open computers: a connected former is still itself. */
  isConnected(computerId: string): boolean
  /** The desktop app's own computer on its own hub: never replaced. */
  localComputerId: string | null
  /** Whether the caller manages this computer (T-19): both sides must be theirs. */
  mayManage(computerId: string): Promise<boolean>
}

/**
 * The takeovers to offer, one per (former, successor) pair: the former registered and
 * not connected (revoked included: it is gone too), the successor registered and not
 * revoked, the caller managing both. Several formers for one successor, or several
 * successors for one former, are separate offers; replacing a former ends every offer
 * naming it (its row is gone).
 */
export async function listComputerTakeovers(
  scope: TakeoverScope,
  candidates: readonly TakeoverCandidate[]
): Promise<ComputerTakeover[]> {
  const pairs = new Map<string, TakeoverCandidate[]>()
  for (const c of candidates) {
    if (c.ownerComputerId === c.holderComputerId) continue
    const key = `${c.ownerComputerId}\n${c.holderComputerId}`
    pairs.set(key, [...(pairs.get(key) ?? []), c])
  }
  const offers: ComputerTakeover[] = []
  for (const items of pairs.values()) {
    const { ownerComputerId: formerId, holderComputerId: successorId } = items[0]
    if (formerId === scope.localComputerId || scope.isConnected(formerId)) continue
    const [former, successor] = await Promise.all([
      getComputer(scope.db, formerId),
      getComputer(scope.db, successorId)
    ])
    if (!former || !successor || successor.revoked_at !== null) continue
    if (!(await scope.mayManage(formerId)) || !(await scope.mayManage(successorId))) continue
    offers.push({
      former: {
        id: former.id,
        name: former.name,
        lastSeenAt: former.last_seen_at,
        revoked: former.revoked_at !== null
      },
      successor: {
        id: successor.id,
        name: successor.name,
        connected: scope.isConnected(successor.id)
      },
      conversations: new Set(items.map((i) => i.conversationId)).size,
      tasks: new Set(items.map((i) => i.taskId)).size
    })
  }
  return offers.sort(
    (a, b) => a.former.name.localeCompare(b.former.name) || a.former.id.localeCompare(b.former.id)
  )
}

/** Why `former` may not be replaced by `successorId` right now, if it may not. */
export function replaceRefusal(
  scope: Pick<TakeoverScope, 'isConnected' | 'localComputerId'>,
  former: { id: string; name: string },
  successorId: string
): { code: 'BAD_REQUEST' | 'PRECONDITION_FAILED'; error: ComputerStateError } | null {
  if (former.id === successorId)
    return { code: 'BAD_REQUEST', error: computerReplacesItselfError() }
  if (former.id === scope.localComputerId)
    return { code: 'BAD_REQUEST', error: computerIsLocalError('replaced') }
  if (scope.isConnected(former.id))
    return { code: 'PRECONDITION_FAILED', error: computerIsConnectedError(former.name) }
  return null
}
