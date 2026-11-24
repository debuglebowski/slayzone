/**
 * The panel's batched reads as the computer runs them (`gitOpImpls`), on real repos:
 * the answer each chain of single reads gave, in one op.
 */
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { gitOpImpls } from './git-ops'

let root: string
let repo: string
let plain: string
const sh = (cmd: string, cwd = repo) => execSync(cmd, { cwd, stdio: 'pipe' }).toString()

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'panel-reads-'))
  repo = join(root, 'repo')
  plain = join(root, 'plain')
  mkdirSync(repo)
  mkdirSync(plain)
  sh('git init -q -b main')
  sh('git config user.email t@t && git config user.name T && git config commit.gpgsign false')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  sh('git add a.txt && git commit -qm first')
  sh('git branch feat')
  sh('git checkout -q feat')
  writeFileSync(join(repo, 'b.txt'), 'b\n')
  sh('git add b.txt && git commit -qm second')
  sh('git checkout -q main')
  writeFileSync(join(repo, 'new.txt'), 'untracked\n')
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('getGitSummary', () => {
  test('a repo: branch, status and no upstream / remote', async () => {
    expect(await gitOpImpls.getGitSummary({ path: repo, statusPath: repo })).toEqual({
      kind: 'repo',
      branch: 'main',
      remoteUrl: null,
      checkoutBranch: null,
      status: { staged: 0, unstaged: 0, untracked: 1 },
      upstream: null
    })
  })

  test('a folder that is no repo', async () => {
    expect(await gitOpImpls.getGitSummary({ path: plain, statusPath: plain })).toEqual({
      kind: 'notRepo'
    })
  })
})

describe('getBranchGraph', () => {
  test('the checked-out branch and the graph of it and its children', async () => {
    const read = await gitOpImpls.getBranchGraph({ path: repo, limit: 50, showBranches: true })
    expect(read.branch).toBe('main')
    expect(read.graph.baseBranch).toBe('main')
    expect(read.graph.branches).toEqual(expect.arrayContaining(['main', 'feat']))
    expect(read.graph.commits.map((c) => c.message).sort()).toEqual(['first', 'second'])
  })

  test('without showBranches: the base branch only', async () => {
    const read = await gitOpImpls.getBranchGraph({ path: repo, limit: 50, showBranches: false })
    expect(read.graph.commits.map((c) => c.message)).toEqual(['first'])
  })
})
