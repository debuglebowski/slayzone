/**
 * Branch-tab reads must cost a constant number of git processes, whatever the branch
 * count. `resolveChildBranches` used to spawn 3 sequential gits PER unmerged branch, all
 * branches at once — ~220 processes every 10s poll on a 55-branch repo, which starved
 * every other git call on the machine (status/diff p100 1.8s → 6.9s).
 *
 * Run with: pnpm exec vitest run --config packages/apps/app/vitest.config.ts \
 *   packages/domains/worktrees/src/server/branch-queries.test.ts
 */
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const commands = vi.hoisted(() => [] as string[])
vi.mock('@slayzone/diagnostics/server', () => ({
  recordDiagnosticEvent: (e: { payload?: { command?: string } }) => {
    if (e.payload?.command) commands.push(e.payload.command)
  }
}))

const { resolveChildBranches, listBranchesDetailed } = await import('./git-worktree')

const BRANCHES = 12
let root: string
let repo: string

function git(cmd: string, cwd = repo): string {
  return execSync(`git ${cmd}`, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@t'
    }
  }).trim()
}

function commit(file: string): void {
  writeFileSync(join(repo, file), file)
  git(`add ${file}`)
  git(`-c commit.gpgsign=false commit -qm ${file}`)
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'branch-queries-'))
  repo = join(root, 'repo')
  git(`init -q -b main ${repo}`, root)
  commit('base')
  // Unmerged feature branches, each 2 ahead / 1 behind main.
  for (let i = 0; i < BRANCHES; i++) {
    git(`checkout -q -b feat-${i} main`)
    commit(`f${i}a`)
    commit(`f${i}b`)
  }
  git('checkout -q main')
  // Merged branch (points at main's current tip, then main moves on).
  git('branch merged-one')
  commit('main2')
  // Orphan branch: no history shared with main — never a child.
  git('checkout -q --orphan pages')
  git('rm -rq --cached .')
  commit('pages')
  git('checkout -q -f main')
  // Upstream tracking: feat-0 tracks feat-1 (feat-0 is 2 ahead, 2 behind feat-1).
  git('branch -q --set-upstream-to=feat-1 feat-0')
})
afterAll(() => rmSync(root, { recursive: true, force: true }))
beforeEach(() => {
  commands.length = 0
})

describe('resolveChildBranches', () => {
  it('returns unmerged branches sharing history as children, merged separately', async () => {
    const result = await resolveChildBranches(repo, 'main')
    expect(result.children.sort()).toEqual(
      Array.from({ length: BRANCHES }, (_, i) => `feat-${i}`).sort()
    )
    expect(result.merged).toEqual(['merged-one'])
  })

  it('spawns a constant number of git processes, not one batch per branch', async () => {
    await resolveChildBranches(repo, 'main')
    expect(commands.length).toBeLessThanOrEqual(3)
  })

  it('unknown base branch → empty result', async () => {
    expect(await resolveChildBranches(repo, 'nope')).toEqual({ children: [], merged: [] })
  })
})

describe('listBranchesDetailed', () => {
  it('computes ahead/behind vs default and vs upstream for every branch', async () => {
    const { branches, defaultBranch } = await listBranchesDetailed(repo)
    expect(defaultBranch).toBe('main')
    const byName = new Map(branches.map((b) => [b.name, b]))
    for (let i = 0; i < BRANCHES; i++) {
      // Beyond the old 10-branch cap too.
      expect(byName.get(`feat-${i}`)?.aheadBehindDefault).toEqual({ ahead: 2, behind: 1 })
    }
    expect(byName.get('main')?.aheadBehindDefault).toBeNull()
    expect(byName.get('main')?.isCurrent).toBe(true)
    expect(byName.get('main')?.isDefault).toBe(true)
    expect(byName.get('feat-0')?.upstream).toBe('feat-1')
    expect(byName.get('feat-0')?.aheadBehindUpstream).toEqual({ ahead: 2, behind: 2 })
    expect(byName.get('feat-2')?.aheadBehindUpstream).toBeNull()
  })

  it('spawns a constant number of git processes', async () => {
    await listBranchesDetailed(repo)
    expect(commands.length).toBeLessThanOrEqual(4)
  })
})
