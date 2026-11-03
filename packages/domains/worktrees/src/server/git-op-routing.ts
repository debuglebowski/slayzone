/**
 * Where a git panel op runs: on the computer that holds the checkout. The caller's
 * target (task, project, explicit computer, or none = the caller's default) resolves
 * that computer exactly as the workspace fs does (`getWorkspace().resolveComputer`),
 * and the op leaves as one `git.op` request through the transport the hub wires
 * ({@link setGitOpTransport}). The computer runs the SAME table
 * (`@slayzone/worktrees/git-ops`) after validating and jailing the input.
 *
 * With no computer the op runs on the hub's own disk (the desktop before its local
 * computer enrolls) — refused first on a hub with processes switched off, so nothing
 * there ever touches project files.
 */
import { assertHubLocalExecEnabled } from '@slayzone/platform/hub-switch-refusal'
import type { GitOpInput, GitOpName } from '../shared/git-ops-contract'
import { runGitOpLocally, type GitOpResult } from './git-ops'
import { getWorktreesRouterDepsOrNull, type WorktreesComputerTarget } from './worktrees-router-deps'

export interface GitOpTransport {
  /** One `git.op` request to `computerId`; answers the op's result. */
  request(
    computerId: string,
    params: { op: GitOpName; input: unknown; mutates: boolean }
  ): Promise<unknown>
}

let transport: GitOpTransport | null = null

/** Wired by the hub's composition (its computer gateway); null = none (tests, unwired). */
export function setGitOpTransport(next: GitOpTransport | null): void {
  transport = next
}

export async function executeGitOp<K extends GitOpName>(
  op: K,
  { target, ...input }: GitOpInput<K> & { target?: WorktreesComputerTarget },
  mutates: boolean
): Promise<GitOpResult<K>> {
  const deps = getWorktreesRouterDepsOrNull()
  const computerId = deps ? await deps.getWorkspace().resolveComputer(target ?? {}) : null
  if (computerId != null && transport) {
    return (await transport.request(computerId, { op, input, mutates })) as GitOpResult<K>
  }
  assertHubLocalExecEnabled({ op: `worktrees.${op}` })
  return runGitOpLocally(op, input as GitOpInput<K>)
}
