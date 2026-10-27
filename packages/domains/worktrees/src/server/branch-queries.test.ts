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
// git < 2.41 (e.g. Ubuntu 22.04's 2.34) has no `%(ahead-behind:)` atom: for-each-ref
// fails with "unknown field name". Simulated here, since CI's git is newer.
const sim = vi.hoisted(() => ({ oldGit: false }))
vi.mock('./exec-async', async (importOriginal) => {
  const real = await importOriginal<typeof import('./exec-async')>()
  return {
    ...real,
    execGit: (args: string[], options: { cwd: string }) =>
      sim.oldGit && args.some((a) => a.includes('%(ahead-behind:'))
        ? Promise.reject(new Error('fatal: unknown field name: ahead-behind:main'))
        : real.execGit(args, options)
  }
})

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
  sim.oldGit = false
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

  it('git without %(ahead-behind:) → per-branch counts for the 10 newest branches', async () => {
    sim.oldGit = true
    const { branches, defaultBranch } = await listBranchesDetailed(repo)
    expect(defaultBranch).toBe('main')
    expect(branches).toHaveLength(BRANCHES + 3) // + main, merged-one, pages
    // Newest-first, as before: the first 10 are computed, the rest are null.
    branches.forEach((b, i) => {
      if (b.isDefault || i >= 10) expect(b.aheadBehindDefault, b.name).toBeNull()
      else if (b.name.startsWith('feat-')) {
        expect(b.aheadBehindDefault, b.name).toEqual({ ahead: 2, behind: 1 })
      } else expect(b.aheadBehindDefault, b.name).not.toBeNull()
    })
    // Upstream counts don't need the new atom: still there, for every branch.
    const feat0 = branches.find((b) => b.name === 'feat-0')
    expect(feat0?.aheadBehindUpstream).toEqual({ ahead: 2, behind: 2 })
  })

  it('default branch with no local ref (origin/HEAD → develop) → zero counts, no failure', async () => {
    git('symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/develop')
    try {
      const { branches, defaultBranch } = await listBranchesDetailed(repo)
      expect(defaultBranch).toBe('develop')
      expect(branches).toHaveLength(BRANCHES + 3)
      branches.forEach((b, i) => {
        expect(b.aheadBehindDefault, b.name).toEqual(i < 10 ? { ahead: 0, behind: 0 } : null)
      })
    } finally {
      git('symbolic-ref --delete refs/remotes/origin/HEAD')
    }
  })
})
