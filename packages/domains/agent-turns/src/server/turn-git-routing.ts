/**
 * Where a turn's git runs: on the computer that holds the checkout. The hub's
 * composition wires {@link setTurnGitRouting} (resolve the computer for a checkout
 * path or a task, send one `git.turnOp`). With no computer it is refused ("connect a
 * computer"): the hub never runs git itself.
 */
import { refuseNoComputer } from '@slayzone/platform/hub-switch-refusal'
import type { TurnGitOpInput, TurnGitOpName, TurnGitOpResult } from './turn-git'

export interface TurnGitRouting {
  computerForPath(path: string): Promise<string | null>
  computerForTask(taskId: string): Promise<string | null>
  request(computerId: string, op: TurnGitOpName, input: unknown): Promise<unknown>
}

let routing: TurnGitRouting | null = null

export function setTurnGitRouting(next: TurnGitRouting | null): void {
  routing = next
}

export function computerForTurnPath(path: string): Promise<string | null> {
  return routing ? routing.computerForPath(path) : Promise.resolve(null)
}

export function computerForTurnTask(taskId: string): Promise<string | null> {
  return routing ? routing.computerForTask(taskId) : Promise.resolve(null)
}

/** Run `op` on `computerId`; none = refused. */
export async function runTurnGitOp<K extends TurnGitOpName>(
  computerId: string | null,
  op: K,
  input: TurnGitOpInput<K>
): Promise<TurnGitOpResult<K>> {
  if (computerId == null || !routing) refuseNoComputer({ op: `agentTurns.${op}` })
  return (await routing.request(computerId, op, input)) as TurnGitOpResult<K>
}
