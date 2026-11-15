/**
 * Dropping a chat's stored timeline projection (derived: rebuilt from the events on
 * next open). Its pages can be hundreds of MB, and secure-delete zero-fills every
 * freed byte: deleted at once, a chat's projection froze the computer for seconds
 * (2026-11-15: 63 chats reset by the blob backfill, 12.7 s). So it goes in
 * byte-bounded steps (`ChatStorage.dropTimelineStep`, checkpoint first), each in its
 * turn of the process's history work — the event loop runs between every two.
 */
import { historyReadTurns } from '@slayzone/terminal/history-turns'
import { TIMELINE_DROP_STEP_BYTES, type ChatStorage } from './storage'

export async function dropTimelineInSteps(
  store: Pick<ChatStorage, 'dropTimelineStep'>,
  id: string,
  epoch: number
): Promise<void> {
  // A loop turn before the first step too: drops run one chat after another (the
  // backfill's resets), never on a path an agent's start waits for.
  const job = historyReadTurns.job({ yieldFirst: true })
  while (!(await job.step(() => store.dropTimelineStep(id, epoch, TIMELINE_DROP_STEP_BYTES))));
}
