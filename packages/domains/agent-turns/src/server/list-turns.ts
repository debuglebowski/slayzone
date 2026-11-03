import type { SlayzoneDb } from '@slayzone/platform'
import { listTurnsForWorktree } from './db'
import { computerForTurnPath, runTurnGitOp } from './turn-git-routing'
import type { AgentTurnRange } from '../shared/types'

/**
 * All agent-turns for a worktree, filtered + rethreaded for display (the filter's
 * rules: `filterAndRethread` in ./turn-git). Its git — the realpath and every
 * diff the filter reads — runs on the computer that holds the checkout; the hub
 * supplies only the rows. Shared by the tRPC `agentTurns.list` query and the
 * Electron IPC handler.
 */
export async function listAgentTurnsForWorktree(
  db: SlayzoneDb,
  worktreePath: string
): Promise<AgentTurnRange[]> {
  if (!worktreePath) return []
  // No computer: refused ("connect a computer") — the hub reads no checkout itself.
  const computerId = await computerForTurnPath(worktreePath)
  const path = await runTurnGitOp(computerId, 'canonical', { repoPath: worktreePath })
  const raw = await listTurnsForWorktree(db, path)
  return runTurnGitOp(computerId, 'filterTurns', {
    repoPath: path,
    rows: raw as unknown as Array<Record<string, unknown>>
  })
}
