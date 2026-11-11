import type { SlayzoneDb } from '@slayzone/platform'
import { computerStanding, type ComputerStanding } from '@slayzone/computers/server'
import { chatUnavailableMessage, type ChatUnavailableReason } from '@slayzone/terminal-contracts'
import type { HubChatOwnership } from './hub-ownership'

/** A chat's history cannot be had (its computer was removed, or did not return it). */
export class ChatUnavailableError extends Error {
  constructor(readonly reason: ChatUnavailableReason) {
    super(chatUnavailableMessage(reason))
    this.name = 'ChatUnavailableError'
  }
}

/**
 * The computer a chat lives on, and where it stands — the one answer for every hub
 * path that opens, shows or starts work on a chat (availability, the relay, agent
 * starts, artifacts). Decided as the hub's records read once its retirements are
 * applied (applyComputerRetirements), so it never depends on whether they were yet:
 *
 * - active (or deleted): its computer;
 * - legacy / copying / verified: the computer it is moving to, unless that one was
 *   removed for good (retiring it undoes the move), else its own computer;
 * - re-enrolled: its successor (`successor`); removed for good: `removed`.
 *
 * Null: the chat names no computer (the caller places it).
 */
export async function chatComputer(
  db: SlayzoneDb,
  owner: Pick<HubChatOwnership, 'state' | 'computerId' | 'destinationComputerId'>
): Promise<ComputerStanding | null> {
  if (owner.destinationComputerId && !['active', 'deleted'].includes(owner.state)) {
    const destination = await computerStanding(db, owner.destinationComputerId)
    if (destination.kind !== 'removed') return destination
  }
  return owner.computerId ? computerStanding(db, owner.computerId) : null
}
