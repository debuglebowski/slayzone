/**
 * Where a turn's work runs: on the computer that holds the checkout. Its git runs
 * there (`git.turnOp`), and since robustness plan §9 (hub migration v207) the turn
 * rows live only there too (`turns`: record a boundary, list a checkout). The hub's
 * composition wires {@link setTurnGitRouting}. With no computer it is refused
 * ("connect a computer"): the hub never runs git and keeps no turn.
 */
import { refuseNoComputer } from '@slayzone/platform/hub-switch-refusal'
import type { AgentTurnRange } from '../shared/types'
import type { TurnGitOpInput, TurnGitOpName, TurnGitOpResult } from './turn-git'

/** A boundary the computer recorded, or not (nothing changed, task deleted). */
export type TurnRecordOutcome =
  | { recorded: false }
  | { recorded: true; id: string; worktreePath: string; createdAt: number }

/** A checkout's turns as its computer lists them (no task titles: the hub adds those). */
export interface TurnListOutcome {
  worktreePath: string
  rows: Array<Omit<AgentTurnRange, 'task_title'>>
}

export interface TurnGitRouting {
  computerForTask(taskId: string): Promise<string | null>
  request(computerId: string, op: TurnGitOpName, input: unknown): Promise<unknown>
  /** Record one turn boundary on the computer holding the checkout. */
  record(
    computerId: string,
    input: { taskId: string; tabId: string; projectId: string | null; promptPreview: string }
  ): Promise<TurnRecordOutcome>
  /**
   * The turns of a task's checkout, filtered for display, from its computer — which
   * resolves the checkout (its worktree, else its project's folder: §9 Phase 7d, no
   * client or hub path).
   */
  list(
    computerId: string,
    input: { taskId: string; projectId: string | null }
  ): Promise<TurnListOutcome>
}

let routing: TurnGitRouting | null = null

export function setTurnGitRouting(next: TurnGitRouting | null): void {
  routing = next
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

/** Record a boundary on `computerId`; none = refused. */
export function recordTurnOnComputer(
  computerId: string | null,
  input: { taskId: string; tabId: string; projectId: string | null; promptPreview: string }
): Promise<TurnRecordOutcome> {
  if (computerId == null || !routing) refuseNoComputer({ op: 'agentTurns.record' })
  return routing.record(computerId, input)
}

/** List a task's checkout turns on `computerId`; none = refused. */
export function listTurnsOnComputer(
  computerId: string | null,
  input: { taskId: string; projectId: string | null }
): Promise<TurnListOutcome> {
  if (computerId == null || !routing) refuseNoComputer({ op: 'agentTurns.list' })
  return routing.list(computerId, input)
}
