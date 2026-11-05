/**
 * A git op names a checkout path; the hub routes it to whose checkout that is. On a
 * hub with login, user B must never run a git op on user A's computer, by ANY path
 * form — and the hub's own background reads (no caller) must keep working.
 *
 * Round-3 finding F2: R7 gated a caller's op on a task's path as "that task's work"
 * (does the computer serve the task?), never "may this caller use it". With the
 * path's `..` left in, `<A's worktree>/../../.ssh` matched A's task, the policy saw a
 * hub-wide /home/a/.ssh, and the op ran on A's computer. Now: the path is normalized
 * before it is matched, and a caller's op always needs the caller to be allowed on
 * the computer it lands on.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import { executeGitOp, setGitOpTransport, setWorktreesRouterDeps } from '@slayzone/worktrees/hub'
import type { ComputerWork } from '@slayzone/computer-transport/server'
import { createGitOpGate } from './git-op-gate'

const h = await createTestHarness()
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run('pa', 'A', '#000')
h.db
  .prepare('INSERT INTO tasks (id, project_id, title, worktree_path) VALUES (?, ?, ?, ?)')
  .run('tA', 'pa', 'A task', '/home/a/wt/feat')

let actor: string | null = 'userB'
const reached: string[] = []
/** The computer work gate (login): a computer works only for its owner. */
const computerOwner: Record<string, string> = { 'computer-A': 'userA', 'computer-B': 'userB' }
const placementGate = async (computerId: string, work: ComputerWork): Promise<void> => {
  if (work === null) {
    if (computerOwner[computerId] !== actor) throw new Error('not your computer')
    return
  }
  // The task's work: does the computer serve that task (A's task → A's computer)?
  if (!(work.id === 'tA' && computerId === 'computer-A')) throw new Error('not its task')
}
const gate = createGitOpGate(placementGate, () => actor)

beforeAll(() => {
  setWorktreesRouterDeps({
    getWorkspace: () => ({
      fs: {} as never,
      // forTask(tA) = A's computer; no target = the caller's own default.
      resolveComputer: async (target) =>
        target.taskId === 'tA'
          ? 'computer-A'
          : (target.computerId ?? (actor === 'userA' ? 'computer-A' : 'computer-B'))
    }),
    shellOpenPath: async () => ''
  })
  setGitOpTransport({
    request: async (computerId, _params, _timeoutMs, target) => {
      await gate(computerId, target)
      reached.push(computerId)
      return null
    },
    watchStart: async () => undefined,
    watchStop: async () => undefined
  })
})
afterAll(() => setGitOpTransport(null))

const op = (repoPath: string) =>
  executeGitOp('getStatusSummary', { repoPath } as never, false, h.slayDb).then(
    () => 'ran',
    () => 'refused'
  )

describe("user B and A's computer", () => {
  for (const path of [
    '/home/a/wt/feat', // A's worktree, absolute
    '/home/a/wt/feat/', // trailing separator
    '/home/a/wt/feat/sub/../', // `..` back into it
    '/home/a/wt/feat/../../.ssh', // `..` out of it (the F2 repro)
    '/home/a/wt/feat/../feat', // `..` and back
    '/home/b/../a/wt/feat', // `..` from B's home into A's worktree
    '/home/a/wt/feat/./x', // `.` segments
    '/home/a\\wt\\feat', // mixed separators (a POSIX name, not A's path)
    '/home/b/link-to-a-worktree' // a symlink: resolved on the computer it lands on
  ]) {
    test(`${path}: never runs on A's computer`, async () => {
      actor = 'userB'
      reached.length = 0
      await op(path)
      expect(reached, 'reached computers').not.toContain('computer-A')
    })
  }
})

describe("the hub's own background reads (no caller)", () => {
  test("a read of A's worktree reaches A's computer", async () => {
    actor = null
    reached.length = 0
    expect(await op('/home/a/wt/feat')).toBe('ran')
    expect(reached).toEqual(['computer-A'])
  })

  test("A's own op on A's worktree runs there", async () => {
    actor = 'userA'
    reached.length = 0
    expect(await op('/home/a/wt/feat/sub/..')).toBe('ran')
    expect(reached).toEqual(['computer-A'])
  })
})
