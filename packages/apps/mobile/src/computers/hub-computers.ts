/**
 * A hub's computers as the app reads them: the rows of `computers.list` (the procedure
 * desktop's Settings → Connections lists them with). Their words — status, names,
 * choice labels — are desktop's, from `@slayzone/computers/labels`.
 */
import { OFFLINE_MARK } from '@slayzone/computers/labels'
import type { RouterOutputs } from '../trpc'

/** One computer of a hub: `usable` = it can take work right now. */
export type HubComputer = RouterOutputs['computers']['list'][number]

/**
 * A computer as a choice (a task's computer, a project's default): its name, marked when it
 * can't take work now.
 */
export function choiceLabel(computer: HubComputer): string {
  return computer.usable === false ? `${computer.name} · ${OFFLINE_MARK}` : computer.name
}
