/**
 * Sessions being restarted in another agent mode (an agent panel's provider
 * change, docs/plans/panel-model.md step 12). The old session is killed so the
 * tab's pane can start the new mode under the same session id — and every
 * `useTaskTerminals` of the task (each agent/terminal panel has one) would read
 * that exit as "the terminal ended" and close the tab. They ask here first.
 *
 * Window-wide on purpose: several containers watch the same session, so a mark is
 * checked, never consumed; it lapses on its own a few seconds later.
 */
const MODE_SWITCH_GRACE_MS = 5_000

const switching = new Map<string, number>()

/** `sessionId` is about to be killed for a mode switch: its exit closes no tab. */
export function beginModeSwitch(sessionId: string, now = Date.now()): void {
  switching.set(sessionId, now + MODE_SWITCH_GRACE_MS)
}

/** Whether an exit of `sessionId` right now is a mode switch's (keep the tab). */
export function isModeSwitchExit(sessionId: string, now = Date.now()): boolean {
  const until = switching.get(sessionId)
  if (until === undefined) return false
  if (now <= until) return true
  switching.delete(sessionId)
  return false
}
