/**
 * `git.op`: the git panel's ops run here through the SAME table the hub declares
 * (`@slayzone/worktrees/git-ops`) — validated against the shared contract, every
 * path it names inside the jail, every repo-relative path inside its repo.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HubToComputerMethods } from '@slayzone/computer-transport/shared'
import type { ComputerConfig } from '../config'
import { createGitOpHandlers } from './git-op'

function ctxWithRoots(roots: string[]) {
  const config: ComputerConfig = {
    hubUrl: 'ws://localhost:0/computers',
    name: 'test',
    allowedRoots: roots,
    capabilities: ['git']
  }
  return { dialer: { notify: () => true }, config, log: () => {} }
}

const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, stdio: 'ignore' })

let dir: string
let call: (params: unknown) => Promise<unknown>

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'computer-git-op-')))
  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.email', 't@t'], dir)
  git(['config', 'user.name', 't'], dir)
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  git(['add', '.'], dir)
  git(['commit', '-qm', 'first'], dir)
  const handlers = createGitOpHandlers(ctxWithRoots([realpathSync(tmpdir())]))
  call = (params) =>
    Promise.resolve((handlers[HubToComputerMethods.gitOp] as (p: unknown) => unknown)(params))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('git.op', () => {
  it('runs a read op and answers its result', async () => {
    expect(await call({ op: 'getCurrentBranch', input: { path: dir } })).toEqual({ result: 'main' })
  })

  it('runs a write op on this disk', async () => {
    writeFileSync(join(dir, 'a.txt'), 'two\n')
    await call({ op: 'stageFile', input: { path: dir, filePath: 'a.txt' }, mutates: true })
    await call({ op: 'commitFiles', input: { repoPath: dir, message: 'second' }, mutates: true })
    const log = (await call({ op: 'getRecentCommits', input: { repoPath: dir, count: 1 } })) as {
      result: Array<{ message: string }>
    }
    expect(log.result[0]?.message).toBe('second')
  })

  it('a void op answers null', async () => {
    expect(await call({ op: 'stageAll', input: { path: dir } })).toEqual({ result: null })
  })

  it('the copy dialog’s lazy tree: open, then pages by id, bound to the judged repo', async () => {
    writeFileSync(join(dir, '.gitignore'), 'cache/\n')
    execFileSync('mkdir', ['-p', join(dir, 'cache', 'sub')])
    writeFileSync(join(dir, 'cache', 'sub', 'x.bin'), 'x')
    const opened = (await call({ op: 'openIgnoredTree', input: { repoPath: dir } })) as {
      result: { treeId: string; totalFiles: number; root: { items: Array<{ path: string }> } }
    }
    expect(opened.result.totalFiles).toBe(1)
    expect(opened.result.root.items.map((e) => e.path)).toEqual(['cache'])
    const page = (await call({
      op: 'listIgnoredTree',
      input: { repoPath: dir, treeId: opened.result.treeId, dir: 'cache/sub', cursor: null }
    })) as { result: { items: Array<{ path: string }>; nextCursor: string | null } }
    expect(page.result).toMatchObject({ items: [{ path: 'cache/sub/x.bin' }], nextCursor: null })
    await expect(
      call({
        op: 'listIgnoredTree',
        input: { repoPath: '/etc', treeId: opened.result.treeId, dir: '', cursor: null }
      })
    ).rejects.toThrow(/outside/)
  })

  it('bounded diffs: a paged text and a file batch, repo-relative paths kept inside the repo', async () => {
    writeFileSync(join(dir, 'a.txt'), 'two\n')
    const page = (await call({
      op: 'readGitText',
      input: { repoPath: dir, kind: 'fileDiff', filePath: 'a.txt', staged: false, cursor: null }
    })) as { result: { text: string; cursor: string | null } }
    expect(page.result.text).toContain('+two')
    expect(page.result.cursor).toBeNull()
    const batch = (await call({
      op: 'getFileDiffsPage',
      input: { repoPath: dir, kind: 'unstaged', filePaths: ['a.txt'] }
    })) as { result: { diffs: Record<string, string> } }
    expect(batch.result.diffs['a.txt']).toContain('+two')
    await expect(
      call({
        op: 'readGitText',
        input: { repoPath: dir, kind: 'fileDiff', filePath: '../x', staged: false, cursor: null }
      })
    ).rejects.toThrow(/inside the repository/)
  })

  it('refuses a path outside its folders', async () => {
    await expect(call({ op: 'getCurrentBranch', input: { path: '/etc' } })).rejects.toThrow(
      /outside/
    )
  })

  it('refuses a repo-relative path that leaves the repo, writing nothing', async () => {
    const escape = join(dir, '..', `escaped-${Date.now()}.txt`)
    await expect(
      call({
        op: 'writeResolvedFile',
        input: { repoPath: dir, filePath: `../${escape.split('/').pop()}`, content: 'x' },
        mutates: true
      })
    ).rejects.toThrow(/inside the repository/)
    expect(existsSync(escape)).toBe(false)
    await expect(
      call({ op: 'stageFile', input: { path: dir, filePath: '/etc/passwd' } })
    ).rejects.toThrow(/inside the repository/)
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('one\n')
  })

  // The jail normalizes a repo-relative path before git sees it; one naming the repo
  // itself must stay as sent — an empty `filePath` turned into `.` would stage
  // everything.
  it('a file op naming the repo itself is not widened to `.`', async () => {
    writeFileSync(join(dir, 'b.txt'), 'new\n')
    await call({ op: 'stageFile', input: { path: dir, filePath: '' } }).catch(() => undefined)
    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: dir })
      .toString()
      .trim()
    expect(staged).toBe('')
  })

  it('refuses an unknown op and an input the contract rejects', async () => {
    await expect(call({ op: 'rmRf', input: { path: dir } })).rejects.toThrow(/unknown git op/)
    await expect(call({ op: 'getCurrentBranch', input: { path: 3 } })).rejects.toThrow()
  })
})
