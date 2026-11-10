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
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agentTurnsStore,
  createAgentTurns,
  type TurnGit
} from '../../domains/chat-runtime/src/server/agent-turns'
import { openChatStorage } from '../../domains/chat-runtime/src/server/storage'
import { createTaskPaths } from '../../domains/chat-runtime/src/server/task-paths'
import { setTaskPathsDelegate } from '../../domains/task/src/server/ops/shared'
import type {
  StoredAgentTurn,
  StoredAgentTurnRange
} from '../../domains/chat-runtime/src/shared/agent-turns'
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

export function installLoopbackGitComputer(): void {
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
 * The same for agent turns: their git (snapshots, the list's filter) and their rows,
 * which live only on the computer (robustness plan §9; hub v207) — here a real chat
 * store in a temp dir. It answers as the LOCAL computer, where fixtures' project
 * folders are placed (migration v176). The handle reads the computer's rows.
 */
export function installLoopbackTurnComputer(
  /**
   * The fixture database standing in for what the computer knows of a task's
   * checkout (§9 Phase 7c: the computer resolves it): the task's worktree, else its
   * project's folder on the local computer. Read lazily, at each turn.
   */
  fixtureDb?: () => import('better-sqlite3').Database
): {
  rows(worktreePath: string): StoredAgentTurnRange[]
  /** Every turn of a task, whatever its checkout. */
  rowsForTask(taskId: string): StoredAgentTurn[]
  /** The task's deletion as the computer receives it (its lifecycle). */
  deleteTask(taskId: string): void
  /** The computer's chat database (raw SQL on its `agent_turns`). */
  db: import('better-sqlite3').Database
  store: ReturnType<typeof agentTurnsStore>
  /** Give a task a worktree here (the computer holds task folders, §9 7e). */
  setWorktree(taskId: string, worktreePath: string | null): void
} {
  const local = deterministicLocalComputerId(DEFAULT_LOCAL_COMPUTER_NAME)
  const storage = openChatStorage({
    stateDir: mkdtempSync(join(tmpdir(), 'slz-loopback-turns-')),
    hubScope: 'loopback'
  })
  const git: TurnGit = {
    canonical: (repoPath) => runTurnGitOpLocally('canonical', { repoPath }),
    snapshot: async (repoPath, turnId) =>
      (await runTurnGitOpLocally('snapshot', { repoPath, turnId })) ?? null,
    deleteTurnRef: async (repoPath, turnId) => {
      await runTurnGitOpLocally('deleteTurnRef', { repoPath, turnId })
    },
    diffIsEmpty: (repoPath, from, to, cached) =>
      runTurnGitOpLocally('diffIsEmpty', { repoPath, from, to, cached }),
    filterTurns: async (repoPath, rows) =>
      (await runTurnGitOpLocally('filterTurns', {
        repoPath,
        rows: rows as unknown as Array<Record<string, unknown>>
      })) as never
  }
  const turns = createAgentTurns(storage, git)
  // The task folders this computer holds (§9 7e): every hub write of a task's paths
  // lands here, and the turns' checkout is read from here.
  const paths = createTaskPaths(storage)
  let at = 0
  const write = (taskId: string, value: Record<string, unknown>) =>
    paths.handle({ op: 'set', taskId, projectId: null, ...value, at: ++at })
  setTaskPathsDelegate({
    changed: async (taskId, change) => {
      if (change.op === 'clear') paths.handle({ op: 'clear', taskId, at: ++at })
      else if (change.op === 'inherit')
        paths.handle({
          op: 'inherit',
          taskId,
          parentTaskId: change.parentTaskId,
          projectId: null,
          at: ++at
        })
      else write(taskId, { worktreePath: change.worktreePath, baseDir: change.baseDir })
    },
    apply: async (taskId, patch) => {
      write(taskId, patch)
    },
    read: async (taskIds) =>
      Object.fromEntries(
        taskIds.map((id) => [
          id,
          {
            state: 'ok' as const,
            worktreePath: paths.get(id)?.worktreePath ?? null,
            baseDir: paths.get(id)?.baseDir ?? null
          }
        ])
      ),
    release: async (taskId) => ({
      worktreePath: paths.get(taskId)?.worktreePath ?? null,
      shared: false,
      computerId: local
    }),
    forget: async () => undefined
  })
  setTurnGitRouting({
    computerForTask: async () => local,
    request: async (_computerId, op, input) =>
      (await runTurnGitOpLocally(op, input as never)) ?? null,
    record: async (_computerId, input) => {
      const repoPath = checkoutOf(input)
      if (!repoPath) return { recorded: false }
      return (await turns.handle({ op: 'record', ...input, repoPath })) as never
    },
    list: async (_computerId, input) => {
      const repoPath = checkoutOf(input)
      if (!repoPath) return { worktreePath: '', rows: [] } as never
      return (await turns.handle({ op: 'list', ...input, repoPath })) as never
    }
  })
  // The task's checkout, as the computer resolves it (worktree, else project folder).
  function checkoutOf(input: { taskId: string; projectId: string | null }): string | undefined {
    const db = fixtureDb?.()
    const placed = input.projectId
      ? (db
          ?.prepare('SELECT root_path FROM project_placements WHERE project_id=? AND computer_id=?')
          .get(input.projectId, local) as { root_path: string } | undefined)
      : undefined
    return paths.get(input.taskId)?.worktreePath || placed?.root_path
  }
  return {
    rows: (worktreePath) => turns.store.ranges(worktreePath),
    db: storage.compose((db) => db),
    deleteTask: (taskId) => storage.applyTaskLifecycle(taskId, 'deleted', 1),
    setWorktree: (taskId, worktreePath) => {
      write(taskId, { worktreePath })
    },
    rowsForTask: (taskId) =>
      storage.compose(
        (db) =>
          db.prepare('SELECT * FROM agent_turns WHERE task_id=?').all(taskId) as StoredAgentTurn[]
      ),
    store: turns.store
  }
}

/**
 * The same for automation actions: `exec.run` on the test machine (shell, cwd,
 * timeout), answering as the LOCAL computer so fixtures' project folders resolve.
 */
export function installLoopbackCommandComputer(): void {
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
export function installLoopbackAiConfigComputer(): void {
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
