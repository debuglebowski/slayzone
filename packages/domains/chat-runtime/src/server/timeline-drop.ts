/**
 * Dropping a chat's stored timeline projection (derived: rebuilt from the events on
 * next open). Its pages can be hundreds of MB, and secure-delete zero-fills every
 * freed byte: deleted at once, a chat's projection froze the computer for seconds
 * (2026-11-15: 63 chats reset by the blob backfill, 12.7 s). So it goes in
 * byte-bounded steps (`ChatStorage.dropTimelineStep`, checkpoint first), each in its
 * turn of the process's history work — the event loop runs between every two.
 */
import type { ChatStorage } from './storage'

export async function dropTimelineInSteps(
  store: Pick<ChatStorage, 'dropTimelinePagesFrom'>,
  id: string,
  epoch: number
): Promise<void> {
  // The database owner serializes this with writes and takes one bounded turn
  // per step, including a loop turn before the first.
  await store.dropTimelinePagesFrom(id, epoch)
}
