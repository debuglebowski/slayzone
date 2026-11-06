/**
 * A git panel op names a checkout path, and the hub knows whose checkout that is: a
 * task's worktree, or a project's folder on a computer (`project_placements`). So
 * the op routes by its path — no caller has to remember to send a target — and an
 * explicit target still wins.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { gitTargetForPath, setGitOpTransport } from './git-op-routing'
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
  .prepare('INSERT INTO tasks (id, project_id, title, worktree_path) VALUES (?, ?, ?, ?)')
  .run('t1', 'p1', 'T', '/home/a/worktrees/feat-x')

describe('gitTargetForPath', () => {
  test("a task's worktree (or a path inside it) is that task's", async () => {
    expect(await gitTargetForPath(db, '/home/a/worktrees/feat-x')).toEqual({ taskId: 't1' })
    expect(await gitTargetForPath(db, '/home/a/worktrees/feat-x/sub')).toEqual({ taskId: 't1' })
  })

  test("a project's folder (or inside it) is that computer's", async () => {
    expect(await gitTargetForPath(db, '/home/a/proj')).toEqual({
      computerId: 'c-a',
      projectId: 'p1'
    })
    expect(await gitTargetForPath(db, '/home/a/proj/packages/x/')).toEqual({
      computerId: 'c-a',
      projectId: 'p1'
    })
  })

  // A Windows computer records `C:\Users\a\proj`: inside it is `\`-separated.
  test('a Windows folder: a path under it with `\\` separators is that computer’s', async () => {
    h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run('p3', 'W', '#000')
    place('c-b', 'p3', 'C:\\Users\\b\\proj')
    expect(await gitTargetForPath(db, 'C:\\Users\\b\\proj\\packages\\x')).toEqual({
      computerId: 'c-b',
      projectId: 'p3'
    })
    expect(await gitTargetForPath(db, 'C:\\Users\\b\\project-two')).toBeNull()
  })

  // The path is normalized before it is matched (as the owner policy reads it): a
  // `..` out of a worktree names where it points, never the worktree (F2).
  test('`.` and `..` segments are resolved before matching', async () => {
    expect(await gitTargetForPath(db, '/home/a/worktrees/feat-x/../../.ssh')).toBeNull()
    expect(await gitTargetForPath(db, '/home/a/worktrees/feat-x/sub/..')).toEqual({ taskId: 't1' })
    expect(await gitTargetForPath(db, '/srv/x/../../home/a/worktrees/feat-x/./y')).toEqual({
      taskId: 't1'
    })
    expect(await gitTargetForPath(db, 'C:\\Users\\b\\proj\\..\\other')).toBeNull()
  })

  // G2: the owner policy and routing share ONE normalizer. On a POSIX path a `\` is a
  // name character: `feat-x\y` is a sibling, not inside the worktree. A UNC path is
  // Windows: its `..` resolves within the share.
  test('G2: a POSIX `\\` is no boundary; UNC is Windows', async () => {
    expect(await gitTargetForPath(db, '/home/a/worktrees/feat-x\\y')).toBeNull()
    h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run('p4', 'U', '#000')
    place('c-a', 'p4', '\\\\srv\\share\\a-wt')
    expect(await gitTargetForPath(db, '\\\\srv\\share\\a-wt\\feat\\..\\..\\x')).toBeNull()
    expect(await gitTargetForPath(db, '\\\\srv\\share\\a-wt\\feat')).toEqual({
      computerId: 'c-a',
      projectId: 'p4'
    })
  })

  // G5: the STORED side is normalized too — a placement recorded as `C:/code/proj`,
  // or a worktree a POSIX hub built as `C:\…/task`, still matches.
  test('G5: stored Windows paths in either separator still match', async () => {
    h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run('p5', 'V', '#000')
    place('c-b', 'p5', 'C:/code/proj')
    expect(await gitTargetForPath(db, 'C:\\code\\proj\\src')).toEqual({
      computerId: 'c-b',
      projectId: 'p5'
    })
    h.db
      .prepare('INSERT INTO tasks (id, project_id, title, worktree_path) VALUES (?, ?, ?, ?)')
      .run('t5', 'p5', 'T', 'C:\\code\\proj-worktrees/task')
    expect(await gitTargetForPath(db, 'C:\\code\\proj-worktrees\\task\\x')).toEqual({
      taskId: 't5'
    })
  })

  test('a prefix that is not a path boundary does not match', async () => {
    expect(await gitTargetForPath(db, '/home/a/project-two')).toBeNull()
  })

  test('the same folder on two computers: the project decides', async () => {
    expect(await gitTargetForPath(db, '/srv/shared')).toEqual({ projectId: 'p2' })
  })

  test('a forgotten placement is nobody’s; an unknown path is null', async () => {
    expect(await gitTargetForPath(db, '/old/proj')).toBeNull()
    expect(await gitTargetForPath(db, '/nowhere')).toBeNull()
  })
})

describe('the router routes by path', () => {
  const targets: WorktreesComputerTarget[] = []
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
      request: async () => null,
      watchStart: async () => undefined,
      watchStop: async () => undefined
    })
  })
  afterAll(() => setGitOpTransport(null))

  const caller = worktreesRouter.createCaller({ db, dataRoot: '' } as never)

  test('no target sent: the path names it', async () => {
    await caller.stageAll({ path: '/home/a/worktrees/feat-x' })
    expect(targets.at(-1)).toEqual({ taskId: 't1' })
  })

  test('an explicit target wins', async () => {
    await caller.stageAll({ path: '/home/a/worktrees/feat-x', target: { projectId: 'p2' } })
    expect(targets.at(-1)).toEqual({ projectId: 'p2' })
  })

  test('an unknown path: the caller default', async () => {
    await caller.stageAll({ path: '/nowhere' })
    expect(targets.at(-1)).toEqual({})
  })
})
