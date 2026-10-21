import { assertHubProcessesEnabled } from '@slayzone/platform/hub-switch-refusal'
import type { ActionConfig, ActionType } from '../shared'

/**
 * Does this action type run a process on the hub? Both do today: `run_command`
 * `exec`s its command, `ai` `exec`s the provider's headless command (an agent, from
 * a user-editable template). A `Record` over {@link ActionType}, so a new type has to
 * decide.
 */
const EXECS_ON_HUB: Record<ActionType, boolean> = {
  run_command: true,
  ai: true
}

/** An unknown type (a hand-written row) counts as exec — fail closed. */
export function actionExecsOnHub(type: string): boolean {
  return Object.hasOwn(EXECS_ON_HUB, type) ? EXECS_ON_HUB[type as ActionType] : true
}

/**
 * Refuse an automation whose actions would run a process on a hub with
 * `SLAYZONE_HUB_ENABLE_PROCESSES=0`: one `automation.run_command` audit line and a
 * `HubSwitchedOffError`. Called at save (`op: 'save'`) and before each run
 * (`op: 'run'`), so a rule written straight into the database is refused too.
 */
export function assertAutomationActionsAllowed(
  actions: readonly ActionConfig[] | undefined,
  refusal: { op: 'save' | 'run'; automationId?: string | null }
): void {
  if (!Array.isArray(actions)) return
  const blocked = actions.find((a) => actionExecsOnHub(a?.type))
  if (!blocked) return
  assertHubProcessesEnabled('automation.run_command', {
    op: refusal.op,
    detail: { automationId: refusal.automationId ?? null, actionType: String(blocked.type) }
  })
}
