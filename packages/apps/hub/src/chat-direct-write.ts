/**
 * After a chat command a client sent straight to its computer (docs/direct-link.md),
 * the computer sends a journaled `chat-direct-write` notice. The hub then does what it
 * does after every chat command it relays itself: drain that computer's chat
 * metadata, so the hub's records (titles, agent state, …) stay current.
 *
 * Only a notice that matches the tab's current owner, epoch and conversation is
 * acted on. Draining is idempotent anyway, so a stray notice costs one drain at most.
 *
 * @module hub/chat-direct-write
 */
import { chatDirectWritePayloadSchema } from '@slayzone/computer-transport/shared'

export interface ChatDirectWriteDeps {
  forTab(tabId: string): Promise<{
    id: string
    computerId: string | null
    epoch: number
    state: string
  } | null>
  drainMetadata(computerId: string): Promise<unknown>
}

export function createChatDirectWriteHandler(
  deps: ChatDirectWriteDeps
): (computerId: string, payload: unknown) => Promise<void> {
  return async (computerId, payload) => {
    const parsed = chatDirectWritePayloadSchema.safeParse(payload)
    if (!parsed.success) return
    const owner = await deps.forTab(parsed.data.tabId)
    if (
      !owner ||
      owner.state !== 'active' ||
      owner.computerId !== computerId ||
      owner.epoch !== parsed.data.epoch ||
      owner.id !== parsed.data.conversationId
    )
      return
    await deps.drainMetadata(computerId)
  }
}
