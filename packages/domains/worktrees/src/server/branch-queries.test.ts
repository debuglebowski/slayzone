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
import { mkdtempSync, rmSync } from 'node:fs'
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

function git(cmd: string, cwd = repo, input?: string): string {
  return execSync(`git ${cmd}`, {
    cwd,
    encoding: 'utf-8',
    input,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@t'
    }
  }).trim()
}

/**
 * The fixture's history, as ONE `git fast-import` stream. Built commit by commit with
 * porcelain it took 73 sequential git processes: 1.7s on a quiet box, past the 10s
 * hook timeout on a saturated one, where every process start is slow. Its cost was
 * process count × spawn latency, which says nothing about the code under test — so
 * the whole history is now one process. Each commit adds a file named and filled
 * after itself; committer times strictly increase, so `--sort=-committerdate` (newest
 * first) has one answer, not a same-second tie.
 */
function historyStream(): string {
  const out: string[] = []
  const data = (s: string): string => `data ${Buffer.byteLength(s)}\n${s}\n`
  let mark = 0
  let time = 1_700_000_000
  /** Commits `file` onto `branch` (from `from`, else the branch's own tip) → its mark. */
  const commit = (branch: string, file: string, from?: number): number => {
    out.push(
      `commit refs/heads/${branch}\nmark :${++mark}\ncommitter T <t@t> ${time++} +0000\n` +
        data(`${file}\n`) +
        (from ? `from :${from}\n` : '') +
        `M 100644 inline ${file}\n` +
        data(file)
    )
    return mark
  }
  const base = commit('main', 'base')
  // Unmerged feature branches, each 2 ahead / 1 behind main.
  for (let i = 0; i < BRANCHES; i++) {
    commit(`feat-${i}`, `f${i}a`, base)
    commit(`feat-${i}`, `f${i}b`)
  }
  // Merged branch (points at main's current tip, then main moves on).
  out.push(`reset refs/heads/merged-one\nfrom :${base}\n`)
  commit('main', 'main2')
  // Orphan branch: no history shared with main — never a child.
  commit('pages', 'pages')
  return out.join('\n')
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'branch-queries-'))
  repo = join(root, 'repo')
  git(`init -q -b main ${repo}`, root)
  git('fast-import --quiet', repo, historyStream())
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
