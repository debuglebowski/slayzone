/**
 * The turn git behind agent-turn snapshots on this computer (robustness plan §9,
 * P0): the same op table as `git.turnOp` (`@slayzone/agent-turns/turn-git`), every
 * checkout path judged by the computer's one path jail first. The chat store keeps
 * the rows (`@slayzone/chat-runtime` agent-turns); this is only its git.
 *
 * @module computer/handlers/turn-git-io
 */
import type { TurnGit } from '@slayzone/chat-runtime/server'
import { runTurnGitOpLocally } from '@slayzone/agent-turns/turn-git'
import { judgePath } from '../path-jail'
import type { HandlerContext } from './types'

export function createTurnGitIo(ctx: HandlerContext): TurnGit {
  // Read the jail through `ctx` on every call: `computer.setAllowedRoots` edits it live.
  const allow = (repoPath: string): string => judgePath(repoPath, ctx.config.allowedRoots)
  return {
    canonical: async (repoPath) => runTurnGitOpLocally('canonical', { repoPath: allow(repoPath) }),
    snapshot: async (repoPath, turnId) =>
      (await runTurnGitOpLocally('snapshot', { repoPath: allow(repoPath), turnId })) ?? null,
    deleteTurnRef: async (repoPath, turnId) => {
      await runTurnGitOpLocally('deleteTurnRef', { repoPath: allow(repoPath), turnId })
    },
    diffIsEmpty: async (repoPath, from, to, cached) =>
      runTurnGitOpLocally('diffIsEmpty', { repoPath: allow(repoPath), from, to, cached }),
    filterTurns: async (repoPath, rows) =>
      (await runTurnGitOpLocally('filterTurns', {
        repoPath: allow(repoPath),
        rows: rows as unknown as Array<Record<string, unknown>>
      })) as unknown as Awaited<ReturnType<TurnGit['filterTurns']>>
  }
}
