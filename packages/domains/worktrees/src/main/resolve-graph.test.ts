/**
 * Tests for resolveCommitGraph + resolveForkGraph + computeDagLayout
 * Ensures correct translation from raw git data → ResolvedGraph → DagLayout
 *
 * Run with: npx tsx packages/domains/worktrees/src/main/resolve-graph.test.ts
 */
import type { DagCommit, CommitInfo, ResolvedGraph, ResolvedCommit } from '../shared/types'
import { resolveCommitGraph, resolveForkGraph } from './git-worktree'
import { computeDagLayout } from '../client/CommitGraph'
import type { DagLayout } from '../client/CommitGraph'

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
    dag({ hash: c1Hash, message: 'latest', refs: ['HEAD -> refs/heads/main'], parents: [c2Hash] }),
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

describe('resolveCommitGraph — origin/main shown as display ref when local main exists', () => {
  const c1Hash = makeHash()
  const c2Hash = makeHash()
  const commits: DagCommit[] = [
    dag({ hash: c1Hash, message: 'local tip', refs: ['HEAD -> refs/heads/main'], parents: [c2Hash] }),
    dag({ hash: c2Hash, message: 'shared', refs: ['refs/remotes/origin/main'], parents: [] }),
  ]

  const g = resolveCommitGraph(commits, 'main')

  test('origin/main appears in branchRefs as display ref', () => {
    expect(g.commits[1].branchRefs).toEqual(['origin/main'])
  })

  test('both commits owned by main (origin/ does not affect ownership)', () => {
    expect(g.commits[0].branch).toBe('main')
    expect(g.commits[1].branch).toBe('main')
  })
})

describe('resolveCommitGraph — origin/feat shown when no local feat exists', () => {
  const c1Hash = makeHash()
  const c2Hash = makeHash()
  const commits: DagCommit[] = [
    dag({ hash: c1Hash, message: 'main tip', refs: ['HEAD -> refs/heads/main'], parents: [c2Hash] }),
    dag({ hash: c2Hash, message: 'feat tip', refs: ['refs/remotes/origin/feat'], parents: [] }),
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
    dag({ hash: c1Hash, message: 'release', refs: ['HEAD -> refs/heads/main', 'tag: refs/tags/v1.0.0'], parents: [] }),
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
    dag({ hash: mainTip, message: 'main work', refs: ['HEAD -> refs/heads/main'], parents: [mergeBase] }),
    dag({ hash: featTip, message: 'feat work', refs: ['refs/heads/feature-x'], parents: [mergeBase] }),
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

describe('resolveCommitGraph — branch names with slashes (feature/x)', () => {
  const mainTip = makeHash()
  const featTip = makeHash()
  const featChild = makeHash()
  const mergeBase = makeHash()
  const commits: DagCommit[] = [
    dag({ hash: featTip, message: 'feat tip', refs: ['refs/heads/feature/api-v2'], parents: [featChild] }),
    dag({ hash: featChild, message: 'feat child', refs: [], parents: [mergeBase] }),
    dag({ hash: mainTip, message: 'main work', refs: ['HEAD -> refs/heads/main'], parents: [mergeBase] }),
    dag({ hash: mergeBase, message: 'shared base', refs: [], parents: [] }),
  ]

  const requested = ['main', 'feature/api-v2']
  const g = resolveCommitGraph(commits, 'main', requested)

  test('slash branch recognized as local — not treated as remote', () => {
    expect(g.commits[0].branchRefs).toContain('feature/api-v2')
    expect(g.commits[0].isBranchTip).toBe(true)
  })

  test('both commits on feature branch owned correctly', () => {
    expect(g.commits[0].branch).toBe('feature/api-v2')
    expect(g.commits[1].branch).toBe('feature/api-v2')
  })

  test('main commits unaffected', () => {
    expect(g.commits[2].branch).toBe('main')
    expect(g.commits[3].branch).toBe('main')
  })

  test('branches list has both', () => {
    expect(g.branches).toContain('main')
    expect(g.branches).toContain('feature/api-v2')
  })
})

describe('resolveCommitGraph — slash branch with remote tracking ref', () => {
  const mainTip = makeHash()
  const featTip = makeHash()
  const remotePos = makeHash()
  const mergeBase = makeHash()
  const commits: DagCommit[] = [
    dag({ hash: featTip, message: 'local ahead', refs: ['refs/heads/feature/api'], parents: [remotePos] }),
    dag({ hash: remotePos, message: 'pushed', refs: ['refs/remotes/origin/feature/api'], parents: [mergeBase] }),
    dag({ hash: mainTip, message: 'main work', refs: ['HEAD -> refs/heads/main'], parents: [mergeBase] }),
    dag({ hash: mergeBase, message: 'shared', refs: [], parents: [] }),
  ]

  const requested = ['main', 'feature/api']
  const g = resolveCommitGraph(commits, 'main', requested)

  test('local slash branch is a tip, remote shows as origin/ display ref', () => {
    expect(g.commits[0].branchRefs).toContain('feature/api')
    expect(g.commits[0].isBranchTip).toBe(true)
    expect(g.commits[1].branchRefs).toContain('origin/feature/api')
  })

  test('both feature commits owned by feature/api', () => {
    expect(g.commits[0].branch).toBe('feature/api')
    expect(g.commits[1].branch).toBe('feature/api')
  })
})

describe('resolveCommitGraph — deeply nested slash branch (user/name/feature)', () => {
  const mainTip = makeHash()
  const featTip = makeHash()
  const mergeBase = makeHash()
  const commits: DagCommit[] = [
    dag({ hash: featTip, message: 'deep branch', refs: ['refs/heads/user/kalle/my-feature'], parents: [mergeBase] }),
    dag({ hash: mainTip, message: 'main', refs: ['HEAD -> refs/heads/main'], parents: [mergeBase] }),
    dag({ hash: mergeBase, message: 'base', refs: [], parents: [] }),
  ]

  const requested = ['main', 'user/kalle/my-feature']
  const g = resolveCommitGraph(commits, 'main', requested)

  test('deeply nested slash branch recognized as local', () => {
    expect(g.commits[0].branchRefs).toContain('user/kalle/my-feature')
    expect(g.commits[0].isBranchTip).toBe(true)
    expect(g.commits[0].branch).toBe('user/kalle/my-feature')
  })
})

describe('resolveCommitGraph — slash branch without requestedBranches', () => {
  const mainTip = makeHash()
  const featTip = makeHash()
  const mergeBase = makeHash()
  const commits: DagCommit[] = [
    dag({ hash: featTip, message: 'feat', refs: ['refs/heads/feature/api'], parents: [mergeBase] }),
    dag({ hash: mainTip, message: 'main', refs: ['HEAD -> refs/heads/main'], parents: [mergeBase] }),
    dag({ hash: mergeBase, message: 'base', refs: [], parents: [] }),
  ]

  // With --decorate=full, refs are unambiguous even without requestedBranches
  const g = resolveCommitGraph(commits, 'main')

  test('slash branch recognized correctly without requestedBranches', () => {
    expect(g.commits[0].isBranchTip).toBe(true)
    expect(g.commits[0].branch).toBe('feature/api')
  })
})

describe('resolveCommitGraph — merge commit with synthetic branch name', () => {
  const mergeHash = makeHash()
  const parentMain = makeHash()
  const parentFeat = makeHash()
  const commits: DagCommit[] = [
    dag({ hash: mergeHash, message: "Merge branch 'hotfix'", refs: ['HEAD -> refs/heads/main'], parents: [parentMain, parentFeat] }),
    dag({ hash: parentMain, message: 'main parent', refs: [], parents: [] }),
    dag({ hash: parentFeat, message: 'hotfix work', refs: [], parents: [] }),
  ]

  const g = resolveCommitGraph(commits, 'main')

  test('second parent stays on main with mergedFrom set', () => {
    expect(g.commits[2].branch).toBe('main')
    expect(g.commits[2].mergedFrom).toBe('hotfix')
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
      refs: ['HEAD -> refs/heads/main', 'refs/remotes/origin/main', 'refs/remotes/origin/HEAD'],
      parents: [],
    }),
  ]

  const g = resolveCommitGraph(commits, 'main')

  test('local main and origin/main in branchRefs (origin/HEAD skipped)', () => {
    expect(g.commits[0].branchRefs).toEqual(['main', 'origin/main'])
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

describe('resolveCommitGraph — behind branch requested: visible in graph', () => {
  //   main tip → A → B → C → worktree-test tip → D → E
  // Both main and worktree-test requested (e.g. showMergedBranches on)
  const eHash = makeHash()
  const dHash = makeHash()
  const wtHash = makeHash()
  const cHash = makeHash()
  const bHash = makeHash()
  const aHash = makeHash()
  const mainHash = makeHash()

  const commits: DagCommit[] = [
    dag({ hash: mainHash, message: 'main latest', refs: ['HEAD -> refs/heads/main'], parents: [aHash] }),
    dag({ hash: aHash, message: 'A', refs: [], parents: [bHash] }),
    dag({ hash: bHash, message: 'B', refs: [], parents: [cHash] }),
    dag({ hash: cHash, message: 'C', refs: [], parents: [wtHash] }),
    dag({ hash: wtHash, message: 'worktree work', refs: ['refs/heads/worktree-test'], parents: [dHash] }),
    dag({ hash: dHash, message: 'D', refs: [], parents: [eHash] }),
    dag({ hash: eHash, message: 'E', refs: [], parents: [] }),
  ]

  const g = resolveCommitGraph(commits, 'main', ['main', 'worktree-test'])

  test('main tip through C owned by main', () => {
    expect(g.commits[0].branch).toBe('main')
    expect(g.commits[1].branch).toBe('main')
    expect(g.commits[2].branch).toBe('main')
    expect(g.commits[3].branch).toBe('main')
  })

  test('worktree-test tip owned by worktree-test', () => {
    expect(g.commits[4].branch).toBe('worktree-test')
  })

  test('commits below worktree-test tip owned by main (shared ancestry)', () => {
    expect(g.commits[5].branch).toBe('main')
    expect(g.commits[6].branch).toBe('main')
  })

  test('worktree-test commit is a branch tip', () => {
    expect(g.commits[4].isBranchTip).toBe(true)
    expect(g.commits[4].branchRefs).toContain('worktree-test')
  })

  test('only 2 branches', () => {
    expect(g.branches).toEqual(['main', 'worktree-test'])
  })
})

describe('resolveCommitGraph — behind branch NOT requested: invisible in graph', () => {
  //   Same topology, but only main requested (default — showMergedBranches off)
  const eHash = makeHash()
  const dHash = makeHash()
  const wtHash = makeHash()
  const cHash = makeHash()
  const bHash = makeHash()
  const aHash = makeHash()
  const mainHash = makeHash()

  const commits: DagCommit[] = [
    dag({ hash: mainHash, message: 'main latest', refs: ['HEAD -> refs/heads/main'], parents: [aHash] }),
    dag({ hash: aHash, message: 'A', refs: [], parents: [bHash] }),
    dag({ hash: bHash, message: 'B', refs: [], parents: [cHash] }),
    dag({ hash: cHash, message: 'C', refs: [], parents: [wtHash] }),
    dag({ hash: wtHash, message: 'worktree work', refs: ['refs/heads/worktree-test'], parents: [dHash] }),
    dag({ hash: dHash, message: 'D', refs: [], parents: [eHash] }),
    dag({ hash: eHash, message: 'E', refs: [], parents: [] }),
  ]

  const g = resolveCommitGraph(commits, 'main', ['main'])

  test('ALL commits owned by main — worktree-test ref filtered out', () => {
    for (const c of g.commits) {
      expect(c.branch).toBe('main')
    }
  })

  test('worktree-test commit has no branchRefs', () => {
    expect(g.commits[4].branchRefs).toHaveLength(0)
    expect(g.commits[4].isBranchTip).toBe(false)
  })

  test('only 1 branch', () => {
    expect(g.branches).toEqual(['main'])
  })
})

describe('resolveCommitGraph — merge + behind branch requested', () => {
  //   main tip → merge → [parent1, parent2] → ... → worktree-test tip → D
  const dHash = makeHash()
  const wtHash = makeHash()
  const parent1 = makeHash()
  const parent2 = makeHash()
  const mergeHash = makeHash()
  const mainHash = makeHash()

  const commits: DagCommit[] = [
    dag({ hash: mainHash, message: 'main latest', refs: ['HEAD -> refs/heads/main'], parents: [mergeHash] }),
    dag({ hash: mergeHash, message: "Merge branch 'hotfix'", refs: [], parents: [parent1, parent2] }),
    dag({ hash: parent1, message: 'pre-merge', refs: [], parents: [wtHash] }),
    dag({ hash: parent2, message: 'hotfix work', refs: [], parents: [wtHash] }),
    dag({ hash: wtHash, message: 'worktree base', refs: ['refs/heads/worktree-test'], parents: [dHash] }),
    dag({ hash: dHash, message: 'old', refs: [], parents: [] }),
  ]

  const g = resolveCommitGraph(commits, 'main', ['main', 'worktree-test'])

  test('no synthetic branch — hotfix is mergedFrom, not a branch', () => {
    expect(g.branches.length).toBe(2)
    expect(g.branches).toContain('main')
    expect(g.branches).toContain('worktree-test')
  })

  test('worktree-test still correctly owned', () => {
    expect(g.commits[4].branch).toBe('worktree-test')
    expect(g.commits[4].isBranchTip).toBe(true)
  })

  test('commit below worktree-test owned by main (shared ancestry)', () => {
    expect(g.commits[5].branch).toBe('main')
  })
})

describe('resolveCommitGraph — merge + behind branch NOT requested', () => {
  const dHash = makeHash()
  const wtHash = makeHash()
  const parent1 = makeHash()
  const parent2 = makeHash()
  const mergeHash = makeHash()
  const mainHash = makeHash()

  const commits: DagCommit[] = [
    dag({ hash: mainHash, message: 'main latest', refs: ['HEAD -> refs/heads/main'], parents: [mergeHash] }),
    dag({ hash: mergeHash, message: "Merge branch 'hotfix'", refs: [], parents: [parent1, parent2] }),
    dag({ hash: parent1, message: 'pre-merge', refs: [], parents: [wtHash] }),
    dag({ hash: parent2, message: 'hotfix work', refs: [], parents: [wtHash] }),
    dag({ hash: wtHash, message: 'worktree base', refs: ['refs/heads/worktree-test'], parents: [dHash] }),
    dag({ hash: dHash, message: 'old', refs: [], parents: [] }),
  ]

  const g = resolveCommitGraph(commits, 'main', ['main'])

  test('worktree-test ref filtered — commit owned by main', () => {
    expect(g.commits[4].branch).toBe('main')
    expect(g.commits[4].branchRefs).toHaveLength(0)
  })

  test('hotfix second parent stays on main with mergedFrom', () => {
    expect(g.branches).toEqual(['main'])
    expect(g.commits[3].branch).toBe('main')
    expect(g.commits[3].mergedFrom).toBe('hotfix')
  })
})

describe('resolveCommitGraph — merge synthetic name included when requested', () => {
  const dHash = makeHash()
  const parent1 = makeHash()
  const parent2 = makeHash()
  const mergeHash = makeHash()
  const mainHash = makeHash()

  const commits: DagCommit[] = [
    dag({ hash: mainHash, message: 'main latest', refs: ['HEAD -> refs/heads/main'], parents: [mergeHash] }),
    dag({ hash: mergeHash, message: "Merge branch 'hotfix'", refs: [], parents: [parent1, parent2] }),
    dag({ hash: parent1, message: 'pre-merge', refs: [], parents: [dHash] }),
    dag({ hash: parent2, message: 'hotfix work', refs: [], parents: [dHash] }),
    dag({ hash: dHash, message: 'old', refs: [], parents: [] }),
  ]

  const g = resolveCommitGraph(commits, 'main', ['main', 'hotfix'])

  test('hotfix second parent stays on main with mergedFrom even when hotfix requested', () => {
    expect(g.branches.length).toBe(1)
    expect(g.branches).toEqual(['main'])
    expect(g.commits[3].branch).toBe('main')
    expect(g.commits[3].mergedFrom).toBe('hotfix')
  })
})

describe('resolveCommitGraph — PR merge synthetic name preserved', () => {
  // Merge commit message gives the second parent a synthetic branch name
  // even when that branch is not in requestedBranches (it's from the merge message, not %D)
  const baseHash = makeHash()
  const parent1 = makeHash()
  const parent2 = makeHash()
  const mergeHash = makeHash()
  const mainHash = makeHash()

  const commits: DagCommit[] = [
    dag({ hash: mainHash, message: 'latest', refs: ['HEAD -> refs/heads/main'], parents: [mergeHash] }),
    dag({ hash: mergeHash, message: 'Merge pull request #30 from jimmystridh/fix/worktree-remove-missing-path', refs: [], parents: [parent1, parent2] }),
    dag({ hash: parent1, message: 'pre-merge', refs: [], parents: [baseHash] }),
    dag({ hash: parent2, message: 'fix worktree path', refs: [], parents: [baseHash] }),
    dag({ hash: baseHash, message: 'old', refs: [], parents: [] }),
  ]

  const g = resolveCommitGraph(commits, 'main', ['main'])

  test('PR merge second parent stays on main with mergedFrom', () => {
    expect(g.branches).toEqual(['main'])
    expect(g.commits[3].branch).toBe('main')
    expect(g.commits[3].mergedFrom).toBe('worktree-remove-missing-path')
  })

  test('all commits preserved (merge second parent kept)', () => {
    expect(g.commits).toHaveLength(5)
  })

  test('merge commit parents go through mergedFrom commit (no bypass)', () => {
    const mergeCommit = g.commits.find(c => c.hash === mergeHash)!
    expect(mergeCommit.parents).toEqual([parent2])
  })
})

describe('resolveCommitGraph — diverged feature with shared ancestry below fork', () => {
  // feature diverged from main at fork point, both have unique commits
  //   main tip → M1 → fork ← F1 ← feature tip
  //                     ↓
  //                   old1 → old2
  const old2Hash = makeHash()
  const old1Hash = makeHash()
  const forkHash = makeHash()
  const m1Hash = makeHash()
  const mainHash = makeHash()
  const f1Hash = makeHash()
  const featHash = makeHash()

  const commits: DagCommit[] = [
    dag({ hash: mainHash, message: 'main tip', refs: ['HEAD -> refs/heads/main'], parents: [m1Hash] }),
    dag({ hash: featHash, message: 'feat tip', refs: ['refs/heads/feature'], parents: [f1Hash] }),
    dag({ hash: m1Hash, message: 'main work', refs: [], parents: [forkHash] }),
    dag({ hash: f1Hash, message: 'feat work', refs: [], parents: [forkHash] }),
    dag({ hash: forkHash, message: 'fork point', refs: [], parents: [old1Hash] }),
    dag({ hash: old1Hash, message: 'old 1', refs: [], parents: [old2Hash] }),
    dag({ hash: old2Hash, message: 'old 2', refs: [], parents: [] }),
  ]

  const g = resolveCommitGraph(commits, 'main', ['main', 'feature'])

  test('main commits owned by main', () => {
    expect(g.commits[0].branch).toBe('main')
    expect(g.commits[2].branch).toBe('main')
  })

  test('feature commits owned by feature', () => {
    expect(g.commits[1].branch).toBe('feature')
    expect(g.commits[3].branch).toBe('feature')
  })

  test('fork point and ancestors owned by main (shared ancestry)', () => {
    expect(g.commits[4].branch).toBe('main')
    expect(g.commits[5].branch).toBe('main')
    expect(g.commits[6].branch).toBe('main')
  })
})

describe('resolveCommitGraph — two feature branches behind main (stacked tips)', () => {
  //   main tip → A → feat-a tip → B → feat-b tip → C
  const cHash = makeHash()
  const featBHash = makeHash()
  const bHash = makeHash()
  const featAHash = makeHash()
  const aHash = makeHash()
  const mainHash = makeHash()

  const commits: DagCommit[] = [
    dag({ hash: mainHash, message: 'main tip', refs: ['HEAD -> refs/heads/main'], parents: [aHash] }),
    dag({ hash: aHash, message: 'A', refs: [], parents: [featAHash] }),
    dag({ hash: featAHash, message: 'feat-a work', refs: ['refs/heads/feat-a'], parents: [bHash] }),
    dag({ hash: bHash, message: 'B', refs: [], parents: [featBHash] }),
    dag({ hash: featBHash, message: 'feat-b work', refs: ['refs/heads/feat-b'], parents: [cHash] }),
    dag({ hash: cHash, message: 'C initial', refs: [], parents: [] }),
  ]

  const g = resolveCommitGraph(commits, 'main', ['main', 'feat-a', 'feat-b'])

  test('main tip and A owned by main', () => {
    expect(g.commits[0].branch).toBe('main')
    expect(g.commits[1].branch).toBe('main')
  })

  test('feat-a tip owned by feat-a', () => {
    expect(g.commits[2].branch).toBe('feat-a')
  })

  test('B between feat-a and feat-b owned by main (shared ancestry)', () => {
    expect(g.commits[3].branch).toBe('main')
  })

  test('feat-b tip owned by feat-b', () => {
    expect(g.commits[4].branch).toBe('feat-b')
  })

  test('C (initial) owned by main', () => {
    expect(g.commits[5].branch).toBe('main')
  })

  test('branches list has all three', () => {
    expect(g.branches).toContain('main')
    expect(g.branches).toContain('feat-a')
    expect(g.branches).toContain('feat-b')
  })
})

describe('resolveCommitGraph — feature ahead of main (main is behind)', () => {
  //   feature tip → F1 → main tip → old
  const oldHash = makeHash()
  const mainHash = makeHash()
  const f1Hash = makeHash()
  const featHash = makeHash()

  const commits: DagCommit[] = [
    dag({ hash: featHash, message: 'feat tip', refs: ['refs/heads/feature'], parents: [f1Hash] }),
    dag({ hash: f1Hash, message: 'feat work', refs: [], parents: [mainHash] }),
    dag({ hash: mainHash, message: 'main tip', refs: ['HEAD -> refs/heads/main'], parents: [oldHash] }),
    dag({ hash: oldHash, message: 'old', refs: [], parents: [] }),
  ]

  const g = resolveCommitGraph(commits, 'main', ['main', 'feature'])

  test('feature tip and F1 owned by feature', () => {
    expect(g.commits[0].branch).toBe('feature')
    expect(g.commits[1].branch).toBe('feature')
  })

  test('main tip owned by main', () => {
    expect(g.commits[2].branch).toBe('main')
  })

  test('commits below main tip owned by main', () => {
    expect(g.commits[3].branch).toBe('main')
  })
})

// ─── computeDagLayout ──────────────────────────────────────────

// Helper: build ResolvedCommit for layout tests
function resolved(overrides: Partial<ResolvedCommit> & { hash: string; message: string; branch: string }): ResolvedCommit {
  return {
    shortHash: overrides.hash.slice(0, 7),
    author: 'test',
    relativeDate: '1 min ago',
    parents: [],
    branchRefs: [],
    tags: [],
    isBranchTip: false,
    isHead: false,
    ...overrides,
  }
}

/** Assert every commit has an edge to every parent in the graph */
function assertNoOrphans(layout: DagLayout, commits: ResolvedCommit[]) {
  const hashToRow = new Map<string, number>()
  for (const n of layout.nodes) hashToRow.set(n.commit.hash, n.row)

  for (const c of commits) {
    for (const parentHash of c.parents) {
      if (!hashToRow.has(parentHash)) continue // parent not in graph
      const row = hashToRow.get(c.hash)!
      const parentRow = hashToRow.get(parentHash)!
      const hasEdge = layout.edges.some(e =>
        (e.fromRow === row && e.toRow === parentRow) ||
        (e.fromRow === row && e.targetHash === parentHash)
      )
      if (!hasEdge) {
        throw new Error(`Missing edge: ${c.hash.slice(0, 7)} (row ${row}) → ${parentHash.slice(0, 7)} (row ${parentRow})`)
      }
    }
  }
}

/** Assert no edge connects two commits without a parent relationship */
function assertNoSpuriousEdges(layout: DagLayout, commits: ResolvedCommit[]) {
  const hashToRow = new Map<string, number>()
  for (const n of layout.nodes) hashToRow.set(n.commit.hash, n.row)
  const parentPairs = new Set<string>()
  for (const c of commits) {
    const row = hashToRow.get(c.hash)
    if (row === undefined) continue
    for (const parentHash of c.parents) {
      const parentRow = hashToRow.get(parentHash)
      if (parentRow === undefined) continue
      parentPairs.add(`${row}→${parentRow}`)
    }
  }
  for (const e of layout.edges) {
    if (e.toRow === -1) continue // unresolved deferred edge
    const key = `${e.fromRow}→${e.toRow}`
    if (!parentPairs.has(key)) {
      const from = layout.nodes.find(n => n.row === e.fromRow)
      const to = layout.nodes.find(n => n.row === e.toRow)
      throw new Error(`Spurious edge: row ${e.fromRow} (${from?.commit.hash.slice(0, 7)}) → row ${e.toRow} (${to?.commit.hash.slice(0, 7)}) — no parent link`)
    }
  }
}

describe('computeDagLayout — base branch always in column 0', () => {
  // Feature branch commits appear before main in topo order
  // Base branch should still occupy column 0
  const mainHash = makeHash()
  const featHash = makeHash()
  const baseHash = makeHash()

  const commits: ResolvedCommit[] = [
    resolved({ hash: featHash, message: 'feat work', branch: 'feature', parents: [baseHash], branchRefs: ['feature'], isBranchTip: true }),
    resolved({ hash: mainHash, message: 'main tip', branch: 'main', parents: [baseHash], branchRefs: ['main'], isBranchTip: true, isHead: true }),
    resolved({ hash: baseHash, message: 'shared', branch: 'main', parents: [] }),
  ]

  const layout = computeDagLayout(commits, 'main')

  test('main commits are in column 0', () => {
    for (const node of layout.nodes) {
      if (node.commit.branch === 'main') {
        expect(node.column).toBe(0)
      }
    }
  })

  test('feature commits are NOT in column 0', () => {
    for (const node of layout.nodes) {
      if (node.commit.branch === 'feature') {
        if (node.column === 0) throw new Error(`feature commit "${node.commit.message}" is in column 0`)
      }
    }
  })
})

describe('computeDagLayout — child branch always right of parent branch', () => {
  // Topology: api-v2 → api → dashboard, charts → dashboard, auth-2fa → auth
  // Each child branch should be in a higher column than its fork point
  const mainTip = makeHash()
  const dashTip = makeHash()
  const dashChild = makeHash()
  const chartsTip = makeHash()
  const chartsChild = makeHash()

  const commits: ResolvedCommit[] = [
    resolved({ hash: chartsTip, message: 'chart tip', branch: 'charts', parents: [chartsChild], branchRefs: ['charts'], isBranchTip: true }),
    resolved({ hash: chartsChild, message: 'chart work', branch: 'charts', parents: [dashTip] }),
    resolved({ hash: dashTip, message: 'dash tip', branch: 'dashboard', parents: [dashChild], branchRefs: ['dashboard'], isBranchTip: true }),
    resolved({ hash: dashChild, message: 'dash work', branch: 'dashboard', parents: [mainTip] }),
    resolved({ hash: mainTip, message: 'main', branch: 'main', parents: [], branchRefs: ['main'], isBranchTip: true, isHead: true }),
  ]

  const layout = computeDagLayout(commits, 'main')

  test('main in col 0, dashboard right of main, charts right of dashboard', () => {
    const colOf = (branch: string) => {
      const node = layout.nodes.find(n => n.commit.branch === branch && n.isBranchTip)
      if (!node) throw new Error(`branch ${branch} not found`)
      return node.column
    }
    const mainCol = colOf('main')
    const dashCol = colOf('dashboard')
    const chartsCol = colOf('charts')
    expect(mainCol).toBe(0)
    if (dashCol <= mainCol) throw new Error(`dashboard col ${dashCol} should be > main col ${mainCol}`)
    if (chartsCol <= dashCol) throw new Error(`charts col ${chartsCol} should be > dashboard col ${dashCol}`)
  })
})

describe('computeDagLayout — each branch gets a unique column', () => {
  // Two branch hierarchies competing for columns:
  //   main → dashboard → api, main → auth → auth-oauth
  // Even with column pressure from dashboard/api, auth must get its own
  // column and auth-oauth must be strictly to its right.
  const mainHash = makeHash()
  const dashTip = makeHash()
  const dashChild = makeHash()
  const apiTip = makeHash()
  const apiChild = makeHash()
  const authTip = makeHash()
  const authChild = makeHash()
  const oauthTip = makeHash()
  const oauthChild = makeHash()

  const commits: ResolvedCommit[] = [
    resolved({ hash: apiTip, message: 'api tip', branch: 'api', parents: [apiChild], branchRefs: ['api'], isBranchTip: true }),
    resolved({ hash: apiChild, message: 'api work', branch: 'api', parents: [dashTip] }),
    resolved({ hash: dashTip, message: 'dash tip', branch: 'dashboard', parents: [dashChild], branchRefs: ['dashboard'], isBranchTip: true }),
    resolved({ hash: dashChild, message: 'dash work', branch: 'dashboard', parents: [mainHash] }),
    resolved({ hash: oauthTip, message: 'oauth tip', branch: 'auth-oauth', parents: [oauthChild], branchRefs: ['auth-oauth'], isBranchTip: true }),
    resolved({ hash: oauthChild, message: 'oauth work', branch: 'auth-oauth', parents: [authTip] }),
    resolved({ hash: authTip, message: 'auth tip', branch: 'auth', parents: [authChild], branchRefs: ['auth'], isBranchTip: true }),
    resolved({ hash: authChild, message: 'auth work', branch: 'auth', parents: [mainHash] }),
    resolved({ hash: mainHash, message: 'main', branch: 'main', parents: [], branchRefs: ['main'], isBranchTip: true, isHead: true }),
  ]

  const layout = computeDagLayout(commits, 'main')

  test('no overlapping branches share a column', () => {
    // Branches CAN share a column if they don't overlap in rows
    const branchRanges = new Map<string, { col: number; minRow: number; maxRow: number }>()
    for (const node of layout.nodes) {
      const range = branchRanges.get(node.commit.branch)
      if (!range) {
        branchRanges.set(node.commit.branch, { col: node.column, minRow: node.row, maxRow: node.row })
      } else {
        range.maxRow = Math.max(range.maxRow, node.row)
        range.minRow = Math.min(range.minRow, node.row)
      }
    }
    // Check no two branches in same column overlap
    for (const [a, ra] of branchRanges) {
      for (const [b, rb] of branchRanges) {
        if (a >= b) continue
        if (ra.col === rb.col && ra.minRow <= rb.maxRow && ra.maxRow >= rb.minRow) {
          throw new Error(`branches ${a} and ${b} overlap in column ${ra.col}`)
        }
      }
    }
  })

  test('parent branches are left of child branches', () => {
    const colOf = (branch: string) => layout.nodes.find(n => n.commit.branch === branch)!.column
    const mainCol = colOf('main')
    const dashCol = colOf('dashboard')
    const apiCol = colOf('api')
    const authCol = colOf('auth')
    const oauthCol = colOf('auth-oauth')
    if (dashCol <= mainCol) throw new Error(`dashboard col ${dashCol} should be > main col ${mainCol}`)
    if (apiCol <= dashCol) throw new Error(`api col ${apiCol} should be > dashboard col ${dashCol}`)
    if (authCol <= mainCol) throw new Error(`auth col ${authCol} should be > main col ${mainCol}`)
    if (oauthCol <= authCol) throw new Error(`auth-oauth col ${oauthCol} should be > auth col ${authCol}`)
  })
})

describe('computeDagLayout — no spurious edges on column reuse', () => {
  // Topology: api-v2 → api → dashboard → main, charts → dashboard → main
  // When api-v2 finishes and frees its column, charts may reuse it.
  // No edge should connect api-v2's last commit to charts.
  const mainHash = makeHash()
  const dashHash = makeHash()
  const dashChild = makeHash()
  const apiHash = makeHash()
  const apiChild = makeHash()
  const v2Hash = makeHash()
  const v2Child = makeHash()
  const chartsHash = makeHash()
  const chartsChild = makeHash()

  const commits: ResolvedCommit[] = [
    resolved({ hash: v2Hash, message: 'v2 tip', branch: 'api-v2', parents: [v2Child], branchRefs: ['api-v2'], isBranchTip: true }),
    resolved({ hash: v2Child, message: 'v2 work', branch: 'api-v2', parents: [apiHash] }),
    resolved({ hash: apiHash, message: 'api tip', branch: 'api', parents: [apiChild], branchRefs: ['api'], isBranchTip: true }),
    resolved({ hash: apiChild, message: 'api work', branch: 'api', parents: [dashHash] }),
    resolved({ hash: chartsHash, message: 'charts tip', branch: 'charts', parents: [chartsChild], branchRefs: ['charts'], isBranchTip: true }),
    resolved({ hash: chartsChild, message: 'charts work', branch: 'charts', parents: [dashHash] }),
    resolved({ hash: dashHash, message: 'dash tip', branch: 'dashboard', parents: [dashChild], branchRefs: ['dashboard'], isBranchTip: true }),
    resolved({ hash: dashChild, message: 'dash work', branch: 'dashboard', parents: [mainHash] }),
    resolved({ hash: mainHash, message: 'main', branch: 'main', parents: [], branchRefs: ['main'], isBranchTip: true, isHead: true }),
  ]

  const layout = computeDagLayout(commits, 'main')

  test('no orphans and no spurious edges', () => {
    assertNoOrphans(layout, commits)
    assertNoSpuriousEdges(layout, commits)
  })
})

describe('computeDagLayout — no orphaned nodes (every parent link has an edge)', () => {
  // linear: main tip → A → worktree-test tip → B → C
  const cHash = makeHash()
  const bHash = makeHash()
  const wtHash = makeHash()
  const aHash = makeHash()
  const mainHash = makeHash()

  const commits: ResolvedCommit[] = [
    resolved({ hash: mainHash, message: 'main tip', branch: 'main', parents: [aHash], branchRefs: ['main'], isBranchTip: true, isHead: true }),
    resolved({ hash: aHash, message: 'A', branch: 'main', parents: [wtHash] }),
    resolved({ hash: wtHash, message: 'wt work', branch: 'worktree-test', parents: [bHash], branchRefs: ['worktree-test'], isBranchTip: true }),
    resolved({ hash: bHash, message: 'B', branch: 'main', parents: [cHash] }),
    resolved({ hash: cHash, message: 'C', branch: 'main', parents: [] }),
  ]

  const layout = computeDagLayout(commits, 'main')

  test('all commits present', () => {
    expect(layout.nodes).toHaveLength(5)
  })

  test('no orphans — every parent link has an edge', () => {
    assertNoOrphans(layout, commits)
    assertNoSpuriousEdges(layout, commits)
  })
})

describe('computeDagLayout — behind-branch tip stays in base column', () => {
  const bHash = makeHash()
  const wtHash = makeHash()
  const aHash = makeHash()
  const mainHash = makeHash()

  const commits: ResolvedCommit[] = [
    resolved({ hash: mainHash, message: 'main tip', branch: 'main', parents: [aHash], branchRefs: ['main'], isBranchTip: true, isHead: true }),
    resolved({ hash: aHash, message: 'A', branch: 'main', parents: [wtHash] }),
    resolved({ hash: wtHash, message: 'wt', branch: 'worktree-test', parents: [bHash], branchRefs: ['worktree-test'], isBranchTip: true }),
    resolved({ hash: bHash, message: 'B', branch: 'main', parents: [] }),
  ]

  const layout = computeDagLayout(commits, 'main')
  const nodeByHash = new Map(layout.nodes.map(n => [n.commit.hash, n]))

  test('worktree-test tip in same column as main (no gap)', () => {
    const mainCol = nodeByHash.get(mainHash)!.column
    const wtCol = nodeByHash.get(wtHash)!.column
    expect(wtCol).toBe(mainCol)
  })

  test('no orphans', () => {
    assertNoOrphans(layout, commits)
    assertNoSpuriousEdges(layout, commits)
  })
})

describe('computeDagLayout — merge second parent gets own column', () => {
  // main tip → merge → [first-parent, second-parent] → base
  const baseHash = makeHash()
  const p1Hash = makeHash()
  const p2Hash = makeHash()
  const mergeHash = makeHash()
  const mainHash = makeHash()

  const commits: ResolvedCommit[] = [
    resolved({ hash: mainHash, message: 'main tip', branch: 'main', parents: [mergeHash], branchRefs: ['main'], isBranchTip: true, isHead: true }),
    resolved({ hash: mergeHash, message: "Merge branch 'fix'", branch: 'main', parents: [p1Hash, p2Hash] }),
    resolved({ hash: p1Hash, message: 'pre-merge', branch: 'main', parents: [baseHash] }),
    resolved({ hash: p2Hash, message: 'fix work', branch: 'fix', parents: [baseHash], branchRefs: ['fix'], isBranchTip: true }),
    resolved({ hash: baseHash, message: 'base', branch: 'main', parents: [] }),
  ]

  const layout = computeDagLayout(commits, 'main')
  const nodeByHash = new Map(layout.nodes.map(n => [n.commit.hash, n]))

  test('second parent in different column from main', () => {
    const mainCol = nodeByHash.get(mainHash)!.column
    const p2Col = nodeByHash.get(p2Hash)!.column
    expect(p2Col).toBe(mainCol ? 0 : 1) // just not the same
    if (p2Col === mainCol) throw new Error('merge second parent should not be in main column')
  })

  test('no orphans', () => {
    assertNoOrphans(layout, commits)
    assertNoSpuriousEdges(layout, commits)
  })
})

describe('computeDagLayout — merge parent column not stolen by releasing base column', () => {
  // Regression: merge releases col 0 for first-parent, then second parent grabs col 0
  // merge → [first-parent (reserved elsewhere), second-parent]
  const baseHash = makeHash()
  const fpHash = makeHash()  // first parent, already in another column
  const spHash = makeHash()  // second parent
  const mergeHash = makeHash()
  const tipHash = makeHash()

  // Simulate: tip → merge, first parent was reserved in col 1 by a prior merge
  const commits: ResolvedCommit[] = [
    resolved({ hash: tipHash, message: 'tip', branch: 'main', parents: [mergeHash], branchRefs: ['main'], isBranchTip: true, isHead: true }),
    resolved({ hash: mergeHash, message: "Merge branch 'feat'", branch: 'main', parents: [fpHash, spHash] }),
    resolved({ hash: fpHash, message: 'first parent', branch: 'main', parents: [baseHash] }),
    resolved({ hash: spHash, message: 'feat work', branch: 'feat', parents: [baseHash], branchRefs: ['feat'], isBranchTip: true }),
    resolved({ hash: baseHash, message: 'base', branch: 'main', parents: [] }),
  ]

  const layout = computeDagLayout(commits, 'main')
  const nodeByHash = new Map(layout.nodes.map(n => [n.commit.hash, n]))

  test('second parent not in base column', () => {
    const mainCol = nodeByHash.get(tipHash)!.column
    const spCol = nodeByHash.get(spHash)!.column
    if (spCol === mainCol) throw new Error('second parent should not steal base column')
  })

  test('no orphans', () => {
    assertNoOrphans(layout, commits)
    assertNoSpuriousEdges(layout, commits)
  })
})

describe('computeDagLayout — two stacked behind-branch tips stay in base column', () => {
  // main tip → A → feat-a tip → B → feat-b tip → C
  const cHash = makeHash()
  const featBHash = makeHash()
  const bHash = makeHash()
  const featAHash = makeHash()
  const aHash = makeHash()
  const mainHash = makeHash()

  const commits: ResolvedCommit[] = [
    resolved({ hash: mainHash, message: 'main tip', branch: 'main', parents: [aHash], branchRefs: ['main'], isBranchTip: true, isHead: true }),
    resolved({ hash: aHash, message: 'A', branch: 'main', parents: [featAHash] }),
    resolved({ hash: featAHash, message: 'feat-a', branch: 'feat-a', parents: [bHash], branchRefs: ['feat-a'], isBranchTip: true }),
    resolved({ hash: bHash, message: 'B', branch: 'main', parents: [featBHash] }),
    resolved({ hash: featBHash, message: 'feat-b', branch: 'feat-b', parents: [cHash], branchRefs: ['feat-b'], isBranchTip: true }),
    resolved({ hash: cHash, message: 'C', branch: 'main', parents: [] }),
  ]

  const layout = computeDagLayout(commits, 'main')
  const nodeByHash = new Map(layout.nodes.map(n => [n.commit.hash, n]))

  test('both behind-branch tips in same column as main', () => {
    const mainCol = nodeByHash.get(mainHash)!.column
    expect(nodeByHash.get(featAHash)!.column).toBe(mainCol)
    expect(nodeByHash.get(featBHash)!.column).toBe(mainCol)
  })

  test('no orphans', () => {
    assertNoOrphans(layout, commits)
    assertNoSpuriousEdges(layout, commits)
  })
})

describe('end-to-end: unrequested branch refs are filtered out', () => {
  // git %D shows ALL refs, but only requested branches should affect ownership
  //   main tip → A → B → commit with [origin/main, origin/HEAD, worktree-test] → C → D
  // Only 'main' was requested — worktree-test should be invisible
  const dHash = makeHash()
  const cHash = makeHash()
  const wtHash = makeHash()
  const bHash = makeHash()
  const aHash = makeHash()
  const mainHash = makeHash()

  const rawCommits: DagCommit[] = [
    dag({ hash: mainHash, message: 'main tip', refs: ['HEAD -> refs/heads/main'], parents: [aHash] }),
    dag({ hash: aHash, message: 'A', refs: [], parents: [bHash] }),
    dag({ hash: bHash, message: 'B', refs: [], parents: [wtHash] }),
    dag({ hash: wtHash, message: 'wt', refs: ['refs/remotes/origin/main', 'refs/remotes/origin/HEAD', 'refs/heads/worktree-test'], parents: [cHash] }),
    dag({ hash: cHash, message: 'C', refs: [], parents: [dHash] }),
    dag({ hash: dHash, message: 'D', refs: [], parents: [] }),
  ]

  const graph = resolveCommitGraph(rawCommits, 'main', ['main'])

  test('commit with unrequested worktree-test ref is owned by main', () => {
    expect(graph.commits[3].branch).toBe('main')
    // origin/main passes through as display ref, worktree-test filtered out
    expect(graph.commits[3].branchRefs).toEqual(['origin/main'])
  })

  test('all commits owned by main', () => {
    for (const c of graph.commits) {
      expect(c.branch).toBe('main')
    }
  })

  test('only one branch in graph', () => {
    expect(graph.branches).toEqual(['main'])
  })
})

describe('end-to-end: requested branch refs are preserved', () => {
  // Same data, but worktree-test IS requested
  const dHash = makeHash()
  const cHash = makeHash()
  const wtHash = makeHash()
  const bHash = makeHash()
  const aHash = makeHash()
  const mainHash = makeHash()

  const rawCommits: DagCommit[] = [
    dag({ hash: mainHash, message: 'main tip', refs: ['HEAD -> refs/heads/main'], parents: [aHash] }),
    dag({ hash: aHash, message: 'A', refs: [], parents: [bHash] }),
    dag({ hash: bHash, message: 'B', refs: [], parents: [wtHash] }),
    dag({ hash: wtHash, message: 'wt', refs: ['refs/remotes/origin/main', 'refs/remotes/origin/HEAD', 'refs/heads/worktree-test'], parents: [cHash] }),
    dag({ hash: cHash, message: 'C', refs: [], parents: [dHash] }),
    dag({ hash: dHash, message: 'D', refs: [], parents: [] }),
  ]

  const graph = resolveCommitGraph(rawCommits, 'main', ['main', 'worktree-test'])

  test('worktree-test commit owned by worktree-test when requested', () => {
    expect(graph.commits[3].branch).toBe('worktree-test')
    expect(graph.commits[3].branchRefs).toContain('worktree-test')
    expect(graph.commits[3].branchRefs).toContain('origin/main')
  })

  test('commits below worktree-test owned by main (shared ancestry)', () => {
    expect(graph.commits[4].branch).toBe('main')
    expect(graph.commits[5].branch).toBe('main')
  })
})

// ─── Real-world repro: PR merge second parents appear as orphan dots ────────

describe('real-world: PR merge second parents get synthetic branch names', () => {
  // Exact topology from slayzone repo: 3 chained PR merges where git log
  // includes second-parent commits (935968d, 81eefa1, 7d1ff27).
  // These get synthetic branch names from merge commit messages.
  const commits: DagCommit[] = [
    dag({ hash: '512265a', message: 'feat: double git panel commit count', refs: ['HEAD -> refs/heads/main'], parents: ['a4be17b'] }),
    dag({ hash: 'a4be17b', message: 'Merge pull request #30 from jimmystridh/fix/worktree-remove-missing-path', refs: [], parents: ['caa4377', '935968d'] }),
    dag({ hash: '935968d', message: 'fix(worktrees): handle already-deleted worktree path', refs: [], parents: ['fd05813'] }),
    dag({ hash: 'caa4377', message: 'release: v0.2.6', refs: ['tag: refs/tags/v0.2.6'], parents: ['28ac5b8'] }),
    dag({ hash: '28ac5b8', message: 'chore(settings): rename theme labels', refs: [], parents: ['1eefed1'] }),
    dag({ hash: '1eefed1', message: 'fix(usage): add caching', refs: [], parents: ['b448b61'] }),
    dag({ hash: 'b448b61', message: 'feat(integrations): add repo selector', refs: [], parents: ['d7eab12'] }),
    dag({ hash: 'd7eab12', message: 'docs: add e2e test isolation notes', refs: [], parents: ['3037874'] }),
    dag({ hash: '3037874', message: 'Merge pull request #27 from jimmystridh/fix/postinstall-electron-rebuild', refs: [], parents: ['ad1c3b7', '81eefa1'] }),
    dag({ hash: '81eefa1', message: 'fix: use scoped electron-rebuild in postinstall', refs: [], parents: ['fd05813'] }),
    dag({ hash: 'ad1c3b7', message: 'Merge pull request #31 from zggf-zggf/fix/terminal-copy-paste-linux', refs: [], parents: ['783008c', '7d1ff27'] }),
    dag({ hash: '7d1ff27', message: 'fix(terminal): add Ctrl+Shift+C/V for copy/paste', refs: [], parents: ['363d1ea'] }),
    dag({ hash: '783008c', message: 'refactor(test-panel): stacked card layout', refs: [], parents: ['8078e51'] }),
    dag({ hash: '8078e51', message: 'feat(integrations): bidirectional sync', refs: [], parents: ['5c141ab'] }),
    dag({ hash: '5c141ab', message: 'feat(test-panel): add file notes', refs: [], parents: ['3d22d44'] }),
    dag({ hash: '3d22d44', message: 'feat(nix): add flake', refs: [], parents: ['363d1ea'] }),
    dag({ hash: '363d1ea', message: 'fix(ci): merge multi-arch manifests', refs: [], parents: ['f971f0e'] }),
    dag({ hash: 'f971f0e', message: 'some commit', refs: [], parents: ['996d4ee'] }),
    dag({ hash: '996d4ee', message: 'fix(ai-config): enforce frontmatter', refs: [], parents: ['fd05813'] }),
    dag({ hash: 'fd05813', message: 'refactor(ai-config): unify context sync', refs: [], parents: ['af40784'] }),
    dag({ hash: 'af40784', message: 'some old commit', refs: [], parents: [] }),
  ]

  const g = resolveCommitGraph(commits, 'main', ['main'])

  test('merge second-parent commits stay on main with mergedFrom', () => {
    const c935 = g.commits.find(c => c.hash === '935968d')!
    const c81e = g.commits.find(c => c.hash === '81eefa1')!
    const c7d1 = g.commits.find(c => c.hash === '7d1ff27')!
    expect(c935.branch).toBe('main')
    expect(c935.mergedFrom).toBe('worktree-remove-missing-path')
    expect(c81e.branch).toBe('main')
    expect(c81e.mergedFrom).toBe('postinstall-electron-rebuild')
    expect(c7d1.branch).toBe('main')
    expect(c7d1.mergedFrom).toBe('terminal-copy-paste-linux')
  })

  test('merge commits parents go through mergedFrom (no bypass)', () => {
    const merge30 = g.commits.find(c => c.hash === 'a4be17b')!
    const merge27 = g.commits.find(c => c.hash === '3037874')!
    const merge31 = g.commits.find(c => c.hash === 'ad1c3b7')!
    expect(merge30.parents).toEqual(['935968d'])
    expect(merge27.parents).toEqual(['81eefa1'])
    expect(merge31.parents).toEqual(['7d1ff27'])
  })

  test('worktree-test ref NOT in output (filtered by requestedBranches)', () => {
    // Even though worktree-test is not in this dataset, verify the filtering
    // principle: only %D refs in requestedBranches survive
    for (const c of g.commits) {
      expect(c.branchRefs.includes('worktree-test')).toBe(false)
    }
  })

  test('all 21 commits preserved', () => {
    expect(g.commits).toHaveLength(21)
  })
})

// ─── Real git history: PR merge second parents ─────────────────
// Exact topo-order from `git log --topo-order main` around the 3 PR merges.
// Rows 5-28 from the real log. requestedBranches=['main'].

describe('real git history: resolveCommitGraph + computeDagLayout', () => {
  // Trimmed to rows 5-28: covers 3 PR merges + their second parents + surrounding main commits
  const commits: DagCommit[] = [
    dag({ hash: '512265a', message: 'feat: double git panel commit count', refs: [], parents: ['a4be17b'] }),
    dag({ hash: 'a4be17b', message: 'Merge pull request #30 from jimmystridh/fix/worktree-remove-missing-path', refs: [], parents: ['caa4377', '935968d'] }),
    dag({ hash: '935968d', message: 'fix(worktrees): handle already-deleted worktree path', refs: [], parents: ['fd05813'] }),
    dag({ hash: 'caa4377', message: 'release: v0.2.6', refs: ['tag: refs/tags/v0.2.6'], parents: ['28ac5b8'] }),
    dag({ hash: '28ac5b8', message: 'chore(settings): rename theme labels', refs: [], parents: ['1eefed1'] }),
    dag({ hash: '1eefed1', message: 'fix(usage): add caching', refs: [], parents: ['b448b61'] }),
    dag({ hash: 'b448b61', message: 'feat(integrations): add repo selector', refs: [], parents: ['d7eab12'] }),
    dag({ hash: 'd7eab12', message: 'docs: add e2e test isolation notes', refs: [], parents: ['3037874'] }),
    dag({ hash: '3037874', message: 'Merge pull request #27 from jimmystridh/fix/postinstall-electron-rebuild', refs: [], parents: ['ad1c3b7', '81eefa1'] }),
    dag({ hash: '81eefa1', message: 'fix: use scoped electron-rebuild in postinstall', refs: [], parents: ['fd05813'] }),
    dag({ hash: 'ad1c3b7', message: 'Merge pull request #31 from zggf-zggf/fix/terminal-copy-paste-linux', refs: [], parents: ['783008c', '7d1ff27'] }),
    dag({ hash: '7d1ff27', message: 'fix(terminal): add Ctrl+Shift+C/V', refs: [], parents: ['363d1ea'] }),
    dag({ hash: '783008c', message: 'refactor(test-panel): stacked card layout', refs: [], parents: ['8078e51'] }),
    dag({ hash: '8078e51', message: 'feat(integrations): bidirectional sync', refs: [], parents: ['5c141ab'] }),
    dag({ hash: '5c141ab', message: 'feat(test-panel): add file notes', refs: [], parents: ['847ffc2'] }),
    dag({ hash: '847ffc2', message: 'refactor(test-panel): merge label mgmt', refs: [], parents: ['04fa80d'] }),
    dag({ hash: '04fa80d', message: 'feat(test-panel): multi-label support', refs: [], parents: ['977c091'] }),
    dag({ hash: '977c091', message: 'feat(terminal): theme picker', refs: [], parents: ['573dc08'] }),
    dag({ hash: '573dc08', message: 'feat: SQLite database backup', refs: [], parents: ['70686d2'] }),
    dag({ hash: '70686d2', message: 'feat(test-panel): test file discovery', refs: [], parents: ['51bb2e1'] }),
    dag({ hash: '51bb2e1', message: 'docs: update install instructions', refs: [], parents: ['972131e'] }),
    dag({ hash: '972131e', message: 'fix(terminal): sync query responses', refs: [], parents: ['3d22d44'] }),
    dag({ hash: '3d22d44', message: 'feat(nix): add flake', refs: [], parents: ['363d1ea'] }),
    dag({ hash: '363d1ea', message: 'fix(ci): merge multi-arch manifests', refs: [], parents: ['f971f0e'] }),
    dag({ hash: 'f971f0e', message: 'fix(ci): only include installer exe', refs: [], parents: ['fd05813'] }),
    dag({ hash: 'fd05813', message: 'refactor(ai-config): unify context sync', refs: [], parents: [] }),
  ]

  // Add HEAD -> main to first commit in the full set (512265a is not the actual HEAD,
  // but for this slice it's the topmost commit visible)
  commits[0].refs = ['HEAD -> refs/heads/main']

  const g = resolveCommitGraph(commits, 'main', ['main'])
  const layout = computeDagLayout(g.commits, g.baseBranch)

  test('935968d stays on main with mergedFrom from merge #30', () => {
    const c = g.commits.find(c => c.hash === '935968d')!
    expect(c.branch).toBe('main')
    expect(c.mergedFrom).toBe('worktree-remove-missing-path')
    // Parents overridden to merge's first parent (stays on main track)
    expect(c.parents).toEqual(['caa4377'])
  })

  test('81eefa1 stays on main with mergedFrom from merge #27', () => {
    const c = g.commits.find(c => c.hash === '81eefa1')!
    expect(c.branch).toBe('main')
    expect(c.mergedFrom).toBe('postinstall-electron-rebuild')
  })

  test('7d1ff27 stays on main with mergedFrom from merge #31', () => {
    const c = g.commits.find(c => c.hash === '7d1ff27')!
    expect(c.branch).toBe('main')
    expect(c.mergedFrom).toBe('terminal-copy-paste-linux')
  })

  test('merge commits are on main', () => {
    const m30 = g.commits.find(c => c.hash === 'a4be17b')!
    const m27 = g.commits.find(c => c.hash === '3037874')!
    const m31 = g.commits.find(c => c.hash === 'ad1c3b7')!
    expect(m30.branch).toBe('main')
    expect(m27.branch).toBe('main')
    expect(m31.branch).toBe('main')
  })

  test('935968d is on col 0 (main track) with synthetic branch dot', () => {
    const node = layout.nodes.find(n => n.commit.hash === '935968d')!
    expect(node.column).toBe(0)
    expect(node.syntheticBranch !== undefined).toBe(true)
    expect(node.syntheticBranch!.branchName).toBe('worktree-remove-missing-path')
    expect(node.syntheticBranch!.column > 0).toBe(true)
  })

  test('7d1ff27 is on col 0 (main track) with synthetic branch dot', () => {
    const node = layout.nodes.find(n => n.commit.hash === '7d1ff27')!
    expect(node.column).toBe(0)
    expect(node.syntheticBranch !== undefined).toBe(true)
    expect(node.syntheticBranch!.branchName).toBe('terminal-copy-paste-linux')
  })

  test('synthetic branch is decorative only — no layout edges to/from side dot', () => {
    const synthNode = layout.nodes.find(n => n.commit.hash === '935968d')!
    const synthCol = synthNode.syntheticBranch!.column
    const synthEdges = layout.edges.filter(e =>
      e.fromCol === synthCol || e.toCol === synthCol
    )
    expect(synthEdges.length).toBe(0)
  })

  test('935968d has main branch colorIndex (on main track)', () => {
    const mainNode = layout.nodes.find(n => n.commit.hash === '512265a')!
    const prNode = layout.nodes.find(n => n.commit.hash === '935968d')!
    expect(prNode.colorIndex).toBe(mainNode.colorIndex)
  })

  test('no commit has empty/undefined branch', () => {
    for (const c of g.commits) {
      expect(c.branch !== '' && c.branch !== undefined).toBe(true)
    }
  })

  // Print layout for visual inspection
  console.log('  [layout debug]')
  for (const node of layout.nodes) {
    const pad = '  '.repeat(node.column)
    const marker = node.isMerge ? 'M' : node.isBranchTip ? 'T' : '·'
    console.log(`    col=${node.column} ${pad}${marker} ${node.commit.hash.slice(0,7)} [${node.commit.branch}] ${node.commit.message.slice(0,50)}`)
  }
})

// ─── Summary ───────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
