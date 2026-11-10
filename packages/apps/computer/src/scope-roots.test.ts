/**
 * Review 2, B1 + B3 — the roots a scoped hub request may touch, at the dispatch
 * level (`createHubRequestHandler`, the one door every hub request comes through):
 *
 * B1: a PROJECT scope covers its worktrees — the default `../<folder>-workspaces`,
 *     the hub's configured `worktree_base_path`, and every root of its tasks held
 *     here — so the git panel's Worktrees tab (per-worktree `isDirty`, remove a
 *     sibling or orphan worktree) works from a project's panel and, through
 *     `projectWide`, from a task's.
 * B3: a folder the user chose is the task's / process's DECLARED root, judged by the
 *     machine bound only: a background process's own folder outside the project, two
 *     tasks sharing one custom folder, a custom folder inside another project, a
 *     worktree assigned to a second task.
 *
 * Still refused: a path outside every scope, another project's roots, another task's
 * worktree reached (not declared) from a task scope, a folder outside the machine
 * bound or through a link out of it, the computer's own state.
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ComputerTransportErrorCodes,
  HubToComputerMethods,
  RpcError
} from '@slayzone/computer-transport/shared'
import type { WirePathScope } from '@slayzone/platform/path-scope'
import type { ComputerConfig } from './config'
import type { ComputerDialer } from './handlers/types'
import { setProtectedPaths } from './path-jail'
import { projectScopedDeps } from './project-scope.fixture'
import { createHubRequestHandler } from './main'

const dialer: ComputerDialer = { notify: () => true }
const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, stdio: 'ignore' })

let dir: string
let root: string
let app: string
let other: string
let backend: string
let stateDir: string
let dispatch: ReturnType<typeof createHubRequestHandler>

/** A committed repo at `path`. */
function repo(path: string): string {
  mkdirSync(path, { recursive: true })
  git(['init', '-q', '-b', 'main'], path)
  git(['config', 'user.email', 't@t'], path)
  git(['config', 'user.name', 't'], path)
  writeFileSync(join(path, 'seed.txt'), 'x')
  git(['add', '.'], path)
  git(['commit', '-qm', 'init'], path)
  return path
}

/** A worktree of `repoPath` at `path` on a new branch. */
function worktree(repoPath: string, path: string, branch: string): string {
  git(['worktree', 'add', '-q', '-b', branch, path], repoPath)
  return path
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'scope-roots-')))
  root = join(dir, 'work')
  stateDir = join(dir, 'state')
  mkdirSync(stateDir, { recursive: true })
  app = repo(join(root, 'app'))
  other = repo(join(root, 'other'))
  backend = join(root, 'backend')
  mkdirSync(backend, { recursive: true })
  setProtectedPaths([join(stateDir, 'computer.config.json')])
  const config: ComputerConfig = {
    hubUrl: 'wss://hub.example.com/computers',
    name: 'pc',
    allowedRoots: [root, stateDir],
    capabilities: ['pty', 'git', 'fs', 'proc']
  }
  dispatch = createHubRequestHandler({
    shutdown: () => {},
    dialer,
    config,
    hubHost: 'hub.example.com',
    ...projectScopedDeps({ p1: app, p2: other })
  })
})

afterEach(async () => {
  await dispatch.dispose()
  setProtectedPaths([])
  rmSync(dir, { recursive: true, force: true })
})

const actor = (pathScope?: WirePathScope) => ({
  userId: null,
  route: 'trpc worktrees.isDirty',
  ...(pathScope ? { pathScope } : {})
})
const project = (projectId: string, worktreeBase?: string): WirePathScope => ({
  kind: 'project',
  projectId,
  ...(worktreeBase ? { worktreeBase } : {})
})
const task = (taskId: string, projectId: string | null): WirePathScope => ({
  kind: 'task',
  taskId,
  projectId
})

/** The hub's task-path write (`task.update` → the holder computer). */
const setPaths = (
  taskId: string,
  projectId: string | null,
  paths: { worktreePath?: string | null; baseDir?: string | null }
) =>
  dispatch.handle(
    HubToComputerMethods.chatRequest,
    { kind: 'taskPaths', value: { op: 'set', taskId, projectId, ...paths, at: Date.now() } },
    actor()
  )

const gitOp = (scope: WirePathScope, op: string, input: unknown, mutates = false) =>
  dispatch.handle(HubToComputerMethods.gitOp, { op, input, mutates }, actor(scope))

async function refusal(p: Promise<unknown>): Promise<RpcError> {
  const err = await p.then(
    () => {
      throw new Error('expected a refusal')
    },
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(RpcError)
  expect((err as RpcError).code).toBe(ComputerTransportErrorCodes.refusedByComputer)
  return err as RpcError
}

describe('B1: a project scope covers its worktrees', () => {
  it("polls and removes a task's worktree and an orphan in the default base", async () => {
    const feat = worktree(app, join(root, 'app-workspaces', 'feat'), 'feat')
    const orphan = worktree(app, join(root, 'app-workspaces', 'orphan'), 'orphan')
    await setPaths('t1', 'p1', { worktreePath: feat })
    writeFileSync(join(feat, 'dirty.txt'), 'x')
    expect(await gitOp(project('p1'), 'isDirty', { path: feat })).toEqual({ result: true })
    expect(await gitOp(project('p1'), 'isDirty', { path: orphan })).toEqual({ result: false })
    await gitOp(project('p1'), 'removeWorktree', { repoPath: app, worktreePath: orphan }, true)
    expect(existsSync(orphan)).toBe(false)
  })

  it("covers a task's worktree outside every base, and the hub's configured base", async () => {
    const elsewhere = worktree(app, join(root, 'trees', 'fix'), 'fix')
    await setPaths('t2', 'p1', { worktreePath: elsewhere })
    expect(await gitOp(project('p1'), 'isDirty', { path: elsewhere })).toEqual({ result: false })
    // An orphan in the configured base (`../wt-{project-folder-name}`).
    const configured = worktree(app, join(root, 'wt-app', 'spike'), 'spike')
    await refusal(gitOp(project('p1'), 'isDirty', { path: configured }))
    expect(
      await gitOp(project('p1', '../wt-{project-folder-name}'), 'isDirty', { path: configured })
    ).toEqual({ result: false })
  })

  it('still refuses what is not the project: outside every root, another project and its tasks', async () => {
    const feat = worktree(app, join(root, 'app-workspaces', 'feat'), 'feat')
    await setPaths('t1', 'p1', { worktreePath: feat })
    // Another project's task whose worktree landed in app's base.
    const theirs = worktree(other, join(root, 'app-workspaces', 'theirs'), 'theirs')
    await setPaths('o1', 'p2', { worktreePath: theirs })
    expect((await refusal(gitOp(project('p1'), 'isDirty', { path: backend }))).message).toMatch(
      /outside the folders of project p1/
    )
    expect((await refusal(gitOp(project('p1'), 'isDirty', { path: theirs }))).message).toMatch(
      /another task's folder/
    )
    // p2 never reaches p1's folder or worktrees.
    await refusal(gitOp(project('p2'), 'isDirty', { path: app }))
    await refusal(gitOp(project('p2'), 'isDirty', { path: feat }))
    // Nor `..` out of a base.
    await refusal(
      gitOp(project('p1'), 'isDirty', { path: join(root, 'app-workspaces', '..', 'backend') })
    )
  })

  it("a task scope still never reaches another task's worktree (the panel goes project-wide)", async () => {
    const feat = worktree(app, join(root, 'app-workspaces', 'feat'), 'feat')
    const fix = worktree(app, join(root, 'app-workspaces', 'fix'), 'fix')
    await setPaths('t1', 'p1', { worktreePath: feat })
    await setPaths('t2', 'p1', { worktreePath: fix })
    await refusal(gitOp(task('t1', 'p1'), 'isDirty', { path: fix }))
    // The Worktrees tab's `projectWide` runs it in the project's scope (hub side).
    expect(await gitOp(project('p1'), 'isDirty', { path: fix })).toEqual({ result: false })
  })
})

describe('B3: a folder the user chose is a declared root', () => {
  it('two tasks share one custom folder; one lies inside another project', async () => {
    const shared = join(root, 'shared')
    mkdirSync(shared)
    await setPaths('t1', 'p1', { baseDir: shared })
    // (b) The second task's set is not refused for the folder being someone else's.
    await setPaths('t2', 'p1', { baseDir: shared })
    // (c) A custom folder inside project p2's folder, for a task of p1.
    const inOther = join(other, 'sub')
    mkdirSync(inOther)
    await setPaths('t3', 'p1', { baseDir: inOther })
    const listed = (await dispatch.handle(
      HubToComputerMethods.chatRequest,
      { kind: 'taskPaths', value: { op: 'get', taskIds: ['t2', 't3'] } },
      actor()
    )) as Array<{ taskId: string; baseDir: string }>
    expect(Object.fromEntries(listed.map((r) => [r.taskId, r.baseDir]))).toEqual({
      t2: shared,
      t3: inOther
    })
    // Each works in its declared folder from its own scope.
    const isRepo = (scope: WirePathScope, path: string) =>
      dispatch.handle(HubToComputerMethods.gitIsGitRepo, { path }, actor(scope))
    expect(await isRepo(task('t2', 'p1'), shared)).toEqual({ isGitRepo: false })
    expect(await isRepo(task('t3', 'p1'), inOther)).toEqual({ isGitRepo: true })
    // The rest of the other project is still not t3's.
    await refusal(isRepo(task('t3', 'p1'), other))
  })

  it('(d) a worktree another task holds can be assigned; reaching it undeclared stays refused', async () => {
    const feat = worktree(app, join(root, 'app-workspaces', 'feat'), 'feat')
    await setPaths('t1', 'p1', { worktreePath: feat })
    await refusal(gitOp(task('t4', 'p1'), 'isDirty', { path: feat }))
    await setPaths('t4', 'p1', { worktreePath: feat })
    expect(await gitOp(task('t4', 'p1'), 'isDirty', { path: feat })).toEqual({ result: false })
  })

  it('a declared folder is still judged by the machine bound: outside it, a link out, own state', async () => {
    await refusal(setPaths('t1', 'p1', { baseDir: '/etc' }))
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'scope-roots-out-')))
    try {
      symlinkSync(outside, join(root, 'to-out'))
      await refusal(setPaths('t1', 'p1', { baseDir: join(root, 'to-out') }))
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
    await refusal(setPaths('t1', 'p1', { baseDir: join(stateDir, 'computer.config.json') }))
  })

  it("(a) a task's background process starts in its own folder outside the project", async () => {
    const out = join(backend, 'where.txt')
    const res = (await dispatch.handle(
      HubToComputerMethods.procSpawn,
      {
        sessionId: 'b3-a',
        taskId: 't1',
        command: `pwd > ${out}`,
        shell: true,
        cwd: backend,
        declaredCwd: true
      },
      actor(task('t1', 'p1'))
    )) as { pid: number | null }
    expect(res.pid).not.toBeNull()
    await vi.waitFor(() => expect(readFileSync(out, 'utf8').trim()).toBe(backend))
  })

  it('(a) a spawn cwd the user did not declare stays confined; a declared one stays in the machine bound', async () => {
    const spawn = (cwd: string, declaredCwd?: boolean) =>
      dispatch.handle(
        HubToComputerMethods.procSpawn,
        {
          sessionId: `b3-${Math.random()}`,
          taskId: 't1',
          command: 'true',
          shell: true,
          cwd,
          ...(declaredCwd ? { declaredCwd } : {})
        },
        actor(task('t1', 'p1'))
      )
    expect((await refusal(spawn(backend))).message).toMatch(/outside the folders of task t1/)
    await refusal(spawn('/etc', true))
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'scope-roots-out-')))
    try {
      symlinkSync(outside, join(root, 'link-out'))
      await refusal(spawn(join(root, 'link-out'), true))
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
    await refusal(spawn(join(stateDir, 'computer.config.json'), true))
    // A pty spawn never takes the marker: only a background process's own folder.
    await refusal(
      dispatch.handle(
        HubToComputerMethods.ptySpawn,
        { sessionId: 'b3-pty', taskId: 't1', command: '/bin/sh', cwd: backend, declaredCwd: true },
        actor(task('t1', 'p1'))
      )
    )
  })
})
