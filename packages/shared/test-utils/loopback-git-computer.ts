/**
 * A "computer" for tests of the hub's git panel: the hub has no local git fallback,
 * so a router test needs somewhere for `git.op` to run. This one runs the same op
 * table (`runGitOpLocally`) on the test machine — the work a real computer does
 * after its jail — and answers watches with a real GitWatcher, reported back as a
 * computer's `git-watch` events. Call it before creating the caller.
 */
// Relative repo paths (as the other helpers here): no package edge, and the very
// module instances the tests under test load.
import { runTurnGitOpLocally } from '../../domains/agent-turns/src/server/turn-git'
import { setTurnGitRouting } from '../../domains/agent-turns/src/server/turn-git-routing'
import { deterministicLocalComputerId } from '../../domains/computers/src/server/store'
import { DEFAULT_LOCAL_COMPUTER_NAME } from '@slayzone/platform/computer-identity'
import { exec } from 'node:child_process'
import { setAutomationCommandRouting } from '../../domains/automations/src/server/command-routing'
import { localAiConfigFs } from '../../domains/ai-config/src/server/ai-config-fs'
import { setAiConfigFsRouting } from '../../domains/ai-config/src/server/ai-config-fs-routing'
import { createGitWatcher, runGitOpLocally } from '../../domains/worktrees/src/server/git-ops'
import {
  deliverGitWatchEvent,
  setGitOpTransport
} from '../../domains/worktrees/src/server/git-op-routing'
import { setWorktreesRouterDeps } from '../../domains/worktrees/src/server/worktrees-router-deps'

export const LOOPBACK_COMPUTER_ID = 'loopback-test-computer'

export function useLoopbackGitComputer(): void {
  setWorktreesRouterDeps({
    getWorkspace: () => ({
      fs: {} as never,
      resolveComputer: async () => LOOPBACK_COMPUTER_ID
    }),
    shellOpenPath: async () => ''
  })
  const watcher = createGitWatcher({ refuse: () => undefined })
  const watchIds = new Map<string, string>()
  watcher.on('git:diff-changed', ({ worktreePath, refsChanged }) => {
    for (const [id, p] of watchIds)
      if (p === worktreePath)
        deliverGitWatchEvent(LOOPBACK_COMPUTER_ID, { watchId: id, kind: 'changed', refsChanged })
  })
  setGitOpTransport({
    request: async (_computerId, { op, input }) =>
      (await runGitOpLocally(op, input as never)) ?? null,
    watchStart: async (_computerId, { watchId, worktreePath }) => {
      watchIds.set(watchId, worktreePath)
      watcher.subscribe(worktreePath)
    },
    watchStop: async (_computerId, { watchId }) => {
      const p = watchIds.get(watchId)
      watchIds.delete(watchId)
      if (p) watcher.unsubscribe(p)
    }
  })
}

/**
 * The same for agent-turn git (snapshots, the turn list's filter). It answers as the
 * LOCAL computer, where fixtures' project folders are placed (migration v176).
 */
export function useLoopbackTurnComputer(): void {
  const local = deterministicLocalComputerId(DEFAULT_LOCAL_COMPUTER_NAME)
  setTurnGitRouting({
    computerForPath: async () => local,
    computerForTask: async () => local,
    request: async (_computerId, op, input) =>
      (await runTurnGitOpLocally(op, input as never)) ?? null
  })
}

/**
 * The same for automation actions: `exec.run` on the test machine (shell, cwd,
 * timeout), answering as the LOCAL computer so fixtures' project folders resolve.
 */
export function useLoopbackCommandComputer(): void {
  const local = deterministicLocalComputerId(DEFAULT_LOCAL_COMPUTER_NAME)
  setAutomationCommandRouting({
    computerFor: async () => local,
    run: (_computerId, { command, cwd, timeoutMs }) =>
      new Promise((resolve) => {
        const child = exec(command, { cwd, timeout: timeoutMs }, (err, stdout, stderr) => {
          const killed = !!(err as { killed?: boolean } | null)?.killed
          resolve({
            stdout,
            stderr,
            status: err ? ((err as { code?: number }).code ?? 1) : 0,
            timedOut: killed
          })
        })
        void child
      })
  })
}

/**
 * The same for AI config: `agentConfig.fs` on the test machine's disk (the work a
 * real computer does after its jail), for project and computer-level files alike.
 */
export function useLoopbackAiConfigComputer(): void {
  setAiConfigFsRouting({
    computerForProject: async () => LOOPBACK_COMPUTER_ID,
    computerForCaller: async () => LOOPBACK_COMPUTER_ID,
    request: async (_computerId, call) => {
      const fs = localAiConfigFs
      switch (call.op) {
        case 'homedir':
          return fs.homedir()
        case 'writeFile':
          return fs.writeFile(call.path, call.content)
        case 'rename':
          return fs.rename(call.path, call.to)
        default:
          return fs[call.op](call.path)
      }
    }
  })
}
