/**
 * A turn's checkout is the computer's to know (§9 Phase 7c: the hub keeps no task
 * path): the task's worktree here, else its project's folder here; a path the hub
 * still names is judged against that task's own folders, never another task's.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createChatRuntimeHandlers } from './chat-runtime'
import { projectScopedDeps } from '../project-scope.fixture'

let root: string
const closers: Array<() => Promise<void>> = []

function repo(dir: string): string {
  mkdirSync(dir, { recursive: true })
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['config', 'user.email', 't@t'],
    ['config', 'user.name', 't']
  ])
    spawnSync('git', args, { cwd: dir })
  writeFileSync(join(dir, 'seed.txt'), 'x')
  spawnSync('git', ['add', '.'], { cwd: dir })
  spawnSync('git', ['commit', '-qm', 'init'], { cwd: dir })
  return dir
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'turn-checkout-')))
})
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  rmSync(root, { recursive: true, force: true })
})

function computer(folders: Record<string, string>) {
  const deps = projectScopedDeps(folders)
  const pc = createChatRuntimeHandlers({
    stateDir: deps.stateDir,
    hubScope: 'hub',
    computerId: deps.getComputerId,
    getProjectPaths: deps.getProjectPaths,
    ctx: {
      config: { hubUrl: 'ws://hub/computers', name: 'pc', allowedRoots: [root], capabilities: [] },
      dialer: { notify: () => true },
      log: () => {}
    }
  } as never)
  closers.push(async () => {
    await pc.close()
    rmSync(deps.stateDir, { recursive: true, force: true })
  })
  return pc
}

const record = (taskId: string, projectId: string | null, repoPath?: string) => ({
  kind: 'turns',
  value: {
    op: 'record',
    taskId,
    tabId: taskId,
    projectId,
    promptPreview: 'go',
    ...(repoPath ? { repoPath } : {})
  }
})

describe("a turn's checkout, resolved on the computer", () => {
  it("is the task's worktree here, else its project's folder here", async () => {
    const wt = repo(join(root, 'wt-a'))
    const proj = repo(join(root, 'proj'))
    const pc = computer({ p1: proj })
    await pc.request({
      kind: 'taskPaths',
      value: { op: 'set', taskId: 'a', projectId: 'p1', worktreePath: wt, at: 1 }
    })
    writeFileSync(join(wt, 'w.txt'), 'change')
    writeFileSync(join(proj, 'p.txt'), 'change')
    expect(await pc.request(record('a', 'p1'))).toMatchObject({ recorded: true, worktreePath: wt })
    expect(await pc.request(record('b', 'p1'))).toMatchObject({
      recorded: true,
      worktreePath: proj
    })
  })

  it('no checkout here: nothing recorded', async () => {
    const pc = computer({})
    expect(await pc.request(record('c', null))).toEqual({ recorded: false })
  })

  it("refuses a named checkout in another task's folder", async () => {
    const wtA = repo(join(root, 'wt-a'))
    const wtB = repo(join(root, 'wt-b'))
    const pc = computer({})
    for (const [taskId, worktreePath] of [
      ['a', wtA],
      ['b', wtB]
    ])
      await pc.request({
        kind: 'taskPaths',
        value: { op: 'set', taskId, projectId: null, worktreePath, at: 1 }
      })
    await expect(pc.request(record('a', null, wtB))).rejects.toThrow(/folders of task a/)
  })
})
