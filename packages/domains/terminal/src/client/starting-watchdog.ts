/**
 * The client's safety net for a terminal stuck in `starting` — what to do when it
 * fires.
 *
 * It exists for lost events: the backend moved on (or died) and this view never
 * heard. It must NOT judge a session the backend still holds as starting. Such a
 * session may be waiting for an agent-start slot on its computer (restoring a
 * workspace starts agents a few at a time, the visible tab first), and the backend
 * runs the authoritative startup deadline from the moment its process really
 * starts. Declaring it dead here showed the retry overlay over an agent that was
 * about to start. So: keep waiting while the backend says it is live and starting,
 * up to {@link STARTING_WATCHDOG_MAX_WAIT_MS} as a last-resort bound.
 *
 * @module terminal/client/starting-watchdog
 */

import type { TerminalState } from '@slayzone/terminal-contracts'

/** How often the watchdog re-checks the backend while a session is starting. */
export const STARTING_WATCHDOG_INTERVAL_MS = 20_000

/**
 * Last-resort bound on waiting for a session the backend still reports as
 * starting. Far above any admission wait (dozens of agents, a few at a time).
 */
export const STARTING_WATCHDOG_MAX_WAIT_MS = 5 * 60_000

export type StartingWatchdogVerdict =
  /** The backend has moved on — adopt its state. */
  | { kind: 'adopt'; state: TerminalState }
  /** The backend holds it as starting — check again later. */
  | { kind: 'wait' }
  /** Gone, or starting for implausibly long — show it as dead. */
  | { kind: 'dead' }
  /** Nothing to do (the backend already reports it dead; its exit event owns that). */
  | { kind: 'none' }

export function startingWatchdogVerdict(input: {
  exists: boolean
  actual: TerminalState | null | undefined
  waitedMs: number
}): StartingWatchdogVerdict {
  const { exists, actual, waitedMs } = input
  if (actual && actual !== 'starting' && actual !== 'dead') return { kind: 'adopt', state: actual }
  if (exists && actual === 'starting' && waitedMs < STARTING_WATCHDOG_MAX_WAIT_MS) {
    return { kind: 'wait' }
  }
  if (!exists || !actual || actual === 'starting') return { kind: 'dead' }
  return { kind: 'none' }
}
