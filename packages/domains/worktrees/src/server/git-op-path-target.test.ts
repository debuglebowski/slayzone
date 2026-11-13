/**
 * The git panel's routing: by the task or project an op names — its path scope —
 * never by its path (no path routing is left, §9 Phase 7c).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { currentPathScope } from '@slayzone/platform/path-scope'
import { setGitOpTransport } from './git-op-routing'
import { setWorktreesRouterDeps, type WorktreesComputerTarget } from './worktrees-router-deps'
import { worktreesRouter } from './worktrees-router'

const h = await createTestHarness()
const db = h.slayDb

h.db
  .prepare(
    `INSERT INTO computers (id, name, platform, version, capabilities_json, created_at) VALUES (?, ?, 'darwin', '1', '[]', 1)`
  )
  .run('c-a', 'a')
h.db
  .prepare(
    `INSERT INTO computers (id, name, platform, version, capabilities_json, created_at) VALUES (?, ?, 'darwin', '1', '[]', 1)`
  )
  .run('c-b', 'b')
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run('p1', 'P', '#000')
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run('p2', 'Q', '#000')
const place = (computer: string, project: string, root: string, status = 'ready') =>
  h.db
    .prepare(
      `INSERT INTO project_placements (computer_id, project_id, root_path, status, updated_at) VALUES (?, ?, ?, ?, 1)`
    )
    .run(computer, project, root, status)
place('c-a', 'p1', '/home/a/proj')
place('c-b', 'p2', '/srv/shared')
place('c-a', 'p2', '/srv/shared')
place('c-b', 'p1', '/old/proj', 'forgotten')
h.db
  .prepare('INSERT INTO tasks (id, project_id, title, has_worktree) VALUES (?, ?, ?, 1)')
  .run('t1', 'p1', 'T')

describe('the router routes by path scope, never by path (§9 Phase 7b)', () => {
  const targets: WorktreesComputerTarget[] = []
  const sent: Array<{ scope: unknown }> = []
  beforeAll(() => {
    setWorktreesRouterDeps({
      getWorkspace: () => ({
        fs: {} as never,
        resolveComputer: async (target) => {
          targets.push(target)
          return 'resolved'
        }
      }),
      shellOpenPath: async () => ''
    })
    setGitOpTransport({
      request: async () => {
        sent.push({ scope: currentPathScope() })
        return null
      },
      watchStart: async () => undefined,
      watchStop: async () => undefined
    })
  })
  afterAll(() => setGitOpTransport(null))

  const caller = worktreesRouter.createCaller({ db, dataRoot: '' } as never)

  test("the task's scope: routed by it, sent under it (with the task's project)", async () => {
    await caller.stageAll({ path: '/home/a/worktrees/feat-x', target: { taskId: 't1' } })
    expect(targets.at(-1)).toEqual({ taskId: 't1' })
    expect(sent.at(-1)?.scope).toMatchObject({ kind: 'task', taskId: 't1', projectId: 'p1' })
  })

  test("a project's scope", async () => {
    await caller.stageAll({ path: '/srv/shared', target: { projectId: 'p2' } })
    expect(targets.at(-1)).toEqual({ projectId: 'p2' })
    expect(sent.at(-1)?.scope).toMatchObject({ kind: 'project', projectId: 'p2' })
  })

  test('a bare path names nobody: refused, nothing sent', async () => {
    const before = sent.length
    // No scope: refused at run time too (cast: the type requires one).
    await expect(caller.stageAll({ path: '/home/a/worktrees/feat-x' } as never)).rejects.toThrow(
      /must name the task or project/
    )
    await expect(
      caller.stageAll({ path: '/x', target: { computerId: 'c-a' } } as never)
    ).rejects.toThrow()
    expect(sent.length).toBe(before)
  })

  test('an unknown task: refused, named (NOT_FOUND)', async () => {
    await expect(
      caller.stageAll({ path: '/x', target: { taskId: 'no-such-task' } })
    ).rejects.toThrow(/task no-such-task is not on this hub/)
  })
})
