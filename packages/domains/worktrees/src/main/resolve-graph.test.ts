/**
 * Tests for resolveCommitGraph + resolveForkGraph
 * Ensures correct translation from raw git data → ResolvedGraph
 *
 * Run with: npx tsx packages/domains/worktrees/src/main/resolve-graph.test.ts
 */
import type { DagCommit, CommitInfo, ResolvedGraph } from '../shared/types'
import { resolveCommitGraph, resolveForkGraph } from './git-worktree'

let passed = 0
let failed = 0
let currentDescribe = ''

function describe(name: string, fn: () => void) {
  currentDescribe = name
  console.log(`\n${name}`)
  fn()
  currentDescribe = ''
}

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.error(`    ${e}`)
    failed++
  }
}

function expect<T>(actual: T) {
  return {
    toBe(expected: T) {
      if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    },
    toEqual(expected: T) {
      const a = JSON.stringify(actual), b = JSON.stringify(expected)
      if (a !== b) throw new Error(`Expected ${b}, got ${a}`)
    },
    toHaveLength(n: number) {
      if (!Array.isArray(actual)) throw new Error(`Expected array, got ${typeof actual}`)
      if (actual.length !== n) throw new Error(`Expected length ${n}, got ${actual.length}`)
    },
    toContain(item: unknown) {
      if (!Array.isArray(actual)) throw new Error(`Expected array, got ${typeof actual}`)
      if (!actual.includes(item)) throw new Error(`Expected array to contain ${JSON.stringify(item)}, got ${JSON.stringify(actual)}`)
    },
    toBeTruthy() {
      if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`)
    },
    toBeFalsy() {
      if (actual) throw new Error(`Expected falsy, got ${JSON.stringify(actual)}`)
    }
  }
}

// --- Helpers to build test data ---

let counter = 0
function makeHash(): string {
  return (++counter).toString(16).padStart(40, '0')
}

function dag(overrides: Partial<DagCommit> & { message: string }): DagCommit {
  const hash = overrides.hash ?? makeHash()
  return {
    hash,
    shortHash: hash.slice(0, 7),
    author: 'test',
    relativeDate: '1 min ago',
    parents: [],
    refs: [],
    ...overrides,
  }
}

function commit(overrides: Partial<CommitInfo> & { message: string }): CommitInfo {
  const hash = overrides.hash ?? makeHash()
  return {
    hash,
    shortHash: hash.slice(0, 7),
    author: 'test',
    relativeDate: '1 min ago',
    ...overrides,
  }
}

// ─── resolveCommitGraph ────────────────────────────────────────

describe('resolveCommitGraph — empty input', () => {
  test('returns empty graph', () => {
    const g = resolveCommitGraph([], 'main')
    expect(g.commits).toHaveLength(0)
    expect(g.branches).toHaveLength(0)
    expect(g.baseBranch).toBe('main')
  })
})

describe('resolveCommitGraph — single branch, linear history', () => {
  const c1Hash = makeHash()
  const c2Hash = makeHash()
  const commits: DagCommit[] = [
    dag({ hash: c1Hash, message: 'latest', refs: ['HEAD -> main'], parents: [c2Hash] }),
    dag({ hash: c2Hash, message: 'older', refs: [], parents: [] }),
  ]

  const g = resolveCommitGraph(commits, 'main')

  test('both commits belong to main', () => {
    expect(g.commits[0].branch).toBe('main')
    expect(g.commits[1].branch).toBe('main')
  })

  test('first commit is HEAD and branch tip', () => {
    expect(g.commits[0].isHead).toBe(true)
    expect(g.commits[0].isBranchTip).toBe(true)
    expect(g.commits[0].branchRefs).toContain('main')
  })

  test('second commit is not a tip', () => {
    expect(g.commits[1].isBranchTip).toBe(false)
    expect(g.commits[1].branchRefs).toHaveLength(0)
  })

  test('branches list contains only main', () => {
    expect(g.branches).toEqual(['main'])
  })

  test('parents preserved', () => {
    expect(g.commits[0].parents).toEqual([c2Hash])
    expect(g.commits[1].parents).toEqual([])
  })
})

describe('resolveCommitGraph — origin/main collapsed when local main exists', () => {
  const c1Hash = makeHash()
  const c2Hash = makeHash()
  const commits: DagCommit[] = [
    dag({ hash: c1Hash, message: 'local tip', refs: ['HEAD -> main'], parents: [c2Hash] }),
    dag({ hash: c2Hash, message: 'shared', refs: ['origin/main'], parents: [] }),
  ]

  const g = resolveCommitGraph(commits, 'main')

  test('origin/main ref is collapsed — not in branchRefs', () => {
    // origin/main should be dropped since local "main" exists
    expect(g.commits[1].branchRefs).toHaveLength(0)
  })

  test('both commits owned by main', () => {
    expect(g.commits[0].branch).toBe('main')
    expect(g.commits[1].branch).toBe('main')
  })
})

describe('resolveCommitGraph — origin/feat shown when no local feat exists', () => {
  const c1Hash = makeHash()
  const c2Hash = makeHash()
  const commits: DagCommit[] = [
    dag({ hash: c1Hash, message: 'main tip', refs: ['HEAD -> main'], parents: [c2Hash] }),
    dag({ hash: c2Hash, message: 'feat tip', refs: ['origin/feat'], parents: [] }),
  ]

  const g = resolveCommitGraph(commits, 'main')

  test('origin/feat collapsed to "feat" in branchRefs since no local feat', () => {
    expect(g.commits[1].branchRefs).toContain('feat')
  })

  test('feat commit owned by feat branch', () => {
    expect(g.commits[1].branch).toBe('feat')
  })
})

describe('resolveCommitGraph — tags parsed', () => {
  const c1Hash = makeHash()
  const commits: DagCommit[] = [
    dag({ hash: c1Hash, message: 'release', refs: ['HEAD -> main', 'tag: v1.0.0'], parents: [] }),
  ]

  const g = resolveCommitGraph(commits, 'main')

  test('tag in tags array', () => {
    expect(g.commits[0].tags).toContain('v1.0.0')
  })

  test('tag not in branchRefs', () => {
    expect(g.commits[0].branchRefs.includes('v1.0.0')).toBe(false)
  })
})

describe('resolveCommitGraph — two branches diverged', () => {
  const mainTip = makeHash()
  const featTip = makeHash()
  const mergeBase = makeHash()
  const commits: DagCommit[] = [
    dag({ hash: mainTip, message: 'main work', refs: ['HEAD -> main'], parents: [mergeBase] }),
    dag({ hash: featTip, message: 'feat work', refs: ['feature-x'], parents: [mergeBase] }),
    dag({ hash: mergeBase, message: 'shared base', refs: [], parents: [] }),
  ]

  const g = resolveCommitGraph(commits, 'main')

  test('branches list has both, base first', () => {
    expect(g.branches[0]).toBe('main')
    expect(g.branches).toContain('feature-x')
  })

  test('each commit owned by correct branch', () => {
    expect(g.commits[0].branch).toBe('main')
    expect(g.commits[1].branch).toBe('feature-x')
  })

  test('merge base propagated to base branch', () => {
    expect(g.commits[2].branch).toBe('main')
  })
})

describe('resolveCommitGraph — merge commit with synthetic branch name', () => {
  const mergeHash = makeHash()
  const parentMain = makeHash()
  const parentFeat = makeHash()
  const commits: DagCommit[] = [
    dag({ hash: mergeHash, message: "Merge branch 'hotfix'", refs: ['HEAD -> main'], parents: [parentMain, parentFeat] }),
    dag({ hash: parentMain, message: 'main parent', refs: [], parents: [] }),
    dag({ hash: parentFeat, message: 'hotfix work', refs: [], parents: [] }),
  ]

  const g = resolveCommitGraph(commits, 'main')

  test('second parent gets synthetic branch name from merge message', () => {
    expect(g.commits[2].branch).toBe('hotfix')
  })

  test('first parent inherits main', () => {
    expect(g.commits[1].branch).toBe('main')
  })
})

describe('resolveCommitGraph — HEAD ref without branch (detached HEAD)', () => {
  const c1Hash = makeHash()
  const commits: DagCommit[] = [
    dag({ hash: c1Hash, message: 'detached', refs: ['HEAD'], parents: [] }),
  ]

  const g = resolveCommitGraph(commits, 'main')

  test('isHead is true', () => {
    expect(g.commits[0].isHead).toBe(true)
  })

  test('no branchRefs (HEAD alone is not a branch)', () => {
    expect(g.commits[0].branchRefs).toHaveLength(0)
  })

  test('falls back to baseBranch ownership', () => {
    expect(g.commits[0].branch).toBe('main')
  })
})

describe('resolveCommitGraph — multiple remote refs collapsed correctly', () => {
  const c1Hash = makeHash()
  const commits: DagCommit[] = [
    dag({
      hash: c1Hash,
      message: 'tip',
      refs: ['HEAD -> main', 'origin/main', 'origin/HEAD'],
      parents: [],
    }),
  ]

  const g = resolveCommitGraph(commits, 'main')

  test('only local main in branchRefs (remotes collapsed)', () => {
    expect(g.commits[0].branchRefs).toEqual(['main'])
  })
})

// ─── resolveForkGraph ──────────────────────────────────────────

describe('resolveForkGraph — basic fork with commits on both sides', () => {
  const forkHash = makeHash()
  const base = [
    commit({ message: 'base ahead 1' }),
    commit({ message: 'base ahead 2' }),
  ]
  const feature = [
    commit({ message: 'feat 1' }),
    commit({ message: 'feat 2' }),
    commit({ message: 'feat 3' }),
  ]
  const preFork = [commit({ message: 'shared old' })]

  const g = resolveForkGraph({
    baseBranchCommits: base,
    baseBranchName: 'main',
    featureBranchCommits: feature,
    featureBranchName: 'my-feature',
    forkPoint: forkHash,
    preForkCommits: preFork,
  })

  test('total commits = base + feature + fork + prefork', () => {
    expect(g.commits).toHaveLength(2 + 3 + 1 + 1)
  })

  test('base commits owned by main', () => {
    expect(g.commits[0].branch).toBe('main')
    expect(g.commits[1].branch).toBe('main')
  })

  test('feature commits owned by my-feature', () => {
    expect(g.commits[2].branch).toBe('my-feature')
    expect(g.commits[3].branch).toBe('my-feature')
    expect(g.commits[4].branch).toBe('my-feature')
  })

  test('fork point owned by base', () => {
    expect(g.commits[5].branch).toBe('main')
    expect(g.commits[5].hash).toBe(forkHash)
  })

  test('pre-fork commits owned by base', () => {
    expect(g.commits[6].branch).toBe('main')
  })

  test('branch tips have branchRefs', () => {
    expect(g.commits[0].branchRefs).toEqual(['main'])
    expect(g.commits[0].isBranchTip).toBe(true)
    expect(g.commits[2].branchRefs).toEqual(['my-feature'])
    expect(g.commits[2].isBranchTip).toBe(true)
  })

  test('non-tip commits have empty branchRefs', () => {
    expect(g.commits[1].branchRefs).toHaveLength(0)
    expect(g.commits[3].branchRefs).toHaveLength(0)
  })

  test('parents are empty (fork layout has no parent chasing)', () => {
    for (const c of g.commits) {
      expect(c.parents).toEqual([])
    }
  })

  test('branches list has both', () => {
    expect(g.branches).toEqual(['main', 'my-feature'])
  })

  test('baseBranch is main', () => {
    expect(g.baseBranch).toBe('main')
  })
})

describe('resolveForkGraph — no base commits (feature ahead, base unchanged)', () => {
  const forkHash = makeHash()
  const feature = [
    commit({ message: 'feat 1' }),
  ]

  const g = resolveForkGraph({
    baseBranchCommits: [],
    baseBranchName: 'main',
    featureBranchCommits: feature,
    featureBranchName: 'my-feature',
    forkPoint: forkHash,
    preForkCommits: [],
  })

  test('total = feature + fork', () => {
    expect(g.commits).toHaveLength(2)
  })

  test('feature commit owned by my-feature', () => {
    expect(g.commits[0].branch).toBe('my-feature')
    expect(g.commits[0].isBranchTip).toBe(true)
  })

  test('fork point owned by main', () => {
    expect(g.commits[1].branch).toBe('main')
  })

  test('branches still lists both', () => {
    expect(g.branches).toEqual(['main', 'my-feature'])
  })
})

describe('resolveForkGraph — no feature commits (base ahead, feature unchanged)', () => {
  const forkHash = makeHash()
  const base = [
    commit({ message: 'base 1' }),
  ]

  const g = resolveForkGraph({
    baseBranchCommits: base,
    baseBranchName: 'main',
    featureBranchCommits: [],
    featureBranchName: 'my-feature',
    forkPoint: forkHash,
    preForkCommits: [],
  })

  test('branches only lists base (no feature commits)', () => {
    expect(g.branches).toEqual(['main'])
  })

  test('base commit is tip', () => {
    expect(g.commits[0].isBranchTip).toBe(true)
    expect(g.commits[0].branchRefs).toEqual(['main'])
  })
})

describe('resolveForkGraph — empty on both sides', () => {
  const forkHash = makeHash()

  const g = resolveForkGraph({
    baseBranchCommits: [],
    baseBranchName: 'main',
    featureBranchCommits: [],
    featureBranchName: 'feat',
    forkPoint: forkHash,
    preForkCommits: [],
  })

  test('only fork point commit', () => {
    expect(g.commits).toHaveLength(1)
    expect(g.commits[0].hash).toBe(forkHash)
  })
})

// ─── resolveCommitGraph — branch behind main (linear, no divergence) ──

describe('resolveCommitGraph — feature branch behind main on linear history', () => {
  // main is 4 commits ahead of worktree-test, all linear (no divergence)
  //   main tip → A → B → C → worktree-test tip → D → E
  const eHash = makeHash()
  const dHash = makeHash()
  const wtHash = makeHash()
  const cHash = makeHash()
  const bHash = makeHash()
  const aHash = makeHash()
  const mainHash = makeHash()

  const commits: DagCommit[] = [
    dag({ hash: mainHash, message: 'main latest', refs: ['HEAD -> main'], parents: [aHash] }),
    dag({ hash: aHash, message: 'A', refs: [], parents: [bHash] }),
    dag({ hash: bHash, message: 'B', refs: [], parents: [cHash] }),
    dag({ hash: cHash, message: 'C', refs: [], parents: [wtHash] }),
    dag({ hash: wtHash, message: 'worktree work', refs: ['worktree-test'], parents: [dHash] }),
    dag({ hash: dHash, message: 'D', refs: [], parents: [eHash] }),
    dag({ hash: eHash, message: 'E', refs: [], parents: [] }),
  ]

  const g = resolveCommitGraph(commits, 'main')

  test('main tip through C owned by main', () => {
    expect(g.commits[0].branch).toBe('main')
    expect(g.commits[1].branch).toBe('main')
    expect(g.commits[2].branch).toBe('main')
    expect(g.commits[3].branch).toBe('main')
  })

  test('worktree-test tip and below owned by worktree-test', () => {
    expect(g.commits[4].branch).toBe('worktree-test')
    expect(g.commits[5].branch).toBe('worktree-test')
    expect(g.commits[6].branch).toBe('worktree-test')
  })

  test('worktree-test commit is a branch tip', () => {
    expect(g.commits[4].isBranchTip).toBe(true)
    expect(g.commits[4].branchRefs).toContain('worktree-test')
  })

  test('only 2 branches — no synthetic names', () => {
    expect(g.branches).toEqual(['main', 'worktree-test'])
  })
})

describe('resolveCommitGraph — feature behind main + merge commits inflating branches', () => {
  // main has a merge commit in history, creating a synthetic branch name
  //   main tip → merge → [parent1, parent2] → ... → worktree-test tip → D
  const dHash = makeHash()
  const wtHash = makeHash()
  const parent1 = makeHash()
  const parent2 = makeHash()
  const mergeHash = makeHash()
  const mainHash = makeHash()

  const commits: DagCommit[] = [
    dag({ hash: mainHash, message: 'main latest', refs: ['HEAD -> main'], parents: [mergeHash] }),
    dag({ hash: mergeHash, message: "Merge branch 'hotfix'", refs: [], parents: [parent1, parent2] }),
    dag({ hash: parent1, message: 'pre-merge', refs: [], parents: [wtHash] }),
    dag({ hash: parent2, message: 'hotfix work', refs: [], parents: [wtHash] }),
    dag({ hash: wtHash, message: 'worktree base', refs: ['worktree-test'], parents: [dHash] }),
    dag({ hash: dHash, message: 'old', refs: [], parents: [] }),
  ]

  const g = resolveCommitGraph(commits, 'main')

  test('synthetic branch name from merge inflates branches beyond 2', () => {
    // This is the bug: merge creates "hotfix" synthetic → branches.length > 2
    // which causes computeDagLayout (topology-only columns) instead of computeTipsLayout
    expect(g.branches.length).toBe(3)
    expect(g.branches).toContain('hotfix')
  })

  test('worktree-test still correctly owned', () => {
    expect(g.commits[4].branch).toBe('worktree-test')
    expect(g.commits[4].isBranchTip).toBe(true)
  })
})

// ─── Summary ───────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
