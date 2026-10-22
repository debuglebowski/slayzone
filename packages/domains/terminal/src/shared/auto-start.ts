/** Settings key: regular tasks start their agent on open instead of showing the Start gate. */
export const TERMINAL_AUTO_START_SETTING = 'terminal_auto_start'

/**
 * Whether a newly opened task starts its agent at once, without the Start gate.
 * Temporary tasks always do (scratch terminals are "always live"); regular tasks
 * follow the `terminal_auto_start` setting.
 *
 * One rule for both sides: the task view decides with it whether to spawn, and task
 * create decides with it whether to reserve a warm agent for that spawn — so the two
 * cannot drift, which would boot an agent no tab ever adopts.
 */
export function agentAutoStarts(task: {
  isTemporary: boolean
  /** Raw value of the `terminal_auto_start` setting, or null when unset. */
  autoStartSetting: string | null | undefined
}): boolean {
  return task.isTemporary || task.autoStartSetting === '1'
}
