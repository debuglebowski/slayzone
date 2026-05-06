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

describe('resolveCommitGraph — "merge main into feature" does not reparent main commit', () => {
  // Simulates: feature branch merges main INTO itself. The second parent is a main commit.
  // The mergedFrom logic must NOT reparent that main commit or set mergedFrom on it.
  const hFeatureTip = makeHash()
  const hMerge = makeHash()      // "Merge branch 'main' into feature/x"
  const hFeatureWork = makeHash()
  const hMainCommit = makeHash()  // second parent of hMerge — should stay on main chain
  const hMainParent = makeHash()

  const commits: DagCommit[] = [
    dag({ hash: hFeatureTip, message: 'feature work 2', refs: ['HEAD -> refs/heads/feature/x'], parents: [hMerge] }),
    dag({ hash: hMerge, message: "Merge branch 'main' into feature/x", refs: [], parents: [hFeatureWork, hMainCommit] }),
    dag({ hash: hFeatureWork, message: 'feature work 1', refs: [], parents: [hMainParent] }),
    dag({ hash: hMainCommit, message: 'main commit', refs: ['refs/heads/main'], parents: [hMainParent] }),
    dag({ hash: hMainParent, message: 'initial', refs: [], parents: [] }),
  ]

  const g = resolveCommitGraph(commits, 'main')

  test('main commit has no mergedFrom', () => {
    const mainCommit = g.commits.find(c => c.hash === hMainCommit)!
    expect(mainCommit.mergedFrom).toBe(undefined)
  })

  test('main commit parent chain is preserved', () => {
    const mainCommit = g.commits.find(c => c.hash === hMainCommit)!
    expect(mainCommit.parents[0]).toBe(hMainParent)
  })
})

describe('resolveCommitGraph — GitHub-style "from org/main" merge does not reparent main commit', () => {
  // Same bug via the first regex: /from\s+\S+\/(.+)$/
  // e.g. "Merge pull request #123 from myorg/main"
  const hChild = makeHash()
  const hMerge = makeHash()
  const hFeatureWork = makeHash()
  const hMainCommit = makeHash()
  const hMainParent = makeHash()

  const commits: DagCommit[] = [
    dag({ hash: hChild, message: 'next commit', refs: ['HEAD -> refs/heads/feature/x'], parents: [hMerge] }),
    dag({ hash: hMerge, message: 'Merge pull request #99 from myorg/main', refs: [], parents: [hFeatureWork, hMainCommit] }),
    dag({ hash: hFeatureWork, message: 'feature work', refs: [], parents: [hMainParent] }),
    dag({ hash: hMainCommit, message: 'main commit', refs: ['refs/heads/main'], parents: [hMainParent] }),
    dag({ hash: hMainParent, message: 'initial', refs: [], parents: [] }),
  ]

  const g = resolveCommitGraph(commits, 'main')

  test('main commit has no mergedFrom', () => {
    const mainCommit = g.commits.find(c => c.hash === hMainCommit)!
    expect(mainCommit.mergedFrom).toBe(undefined)
  })

  test('main commit parent chain is preserved', () => {
    const mainCommit = g.commits.find(c => c.hash === hMainCommit)!
    expect(mainCommit.parents[0]).toBe(hMainParent)
  })
})

describe('resolveCommitGraph + computeDagLayout — merge-main-into-feature preserves edge in collapsed view', () => {
  // End-to-end: the actual symptom was a missing line in collapsed mode.
  // main: hMainTip → hMainMid → hMainBase
  // feature: hFeatTip → hMerge(main into feat) → hFeatWork → hMainBase
  // hMerge has second parent hMainMid (a main commit).
  // In collapsed view, hMainTip and hMainBase should be connected through hMainMid.
  const hMainTip = makeHash()
  const hMainMid = makeHash()
  const hMainBase = makeHash()
  const hFeatTip = makeHash()
  const hMerge = makeHash()
  const hFeatWork = makeHash()

  const commits: DagCommit[] = [
    dag({ hash: hFeatTip, message: 'feature done', refs: ['HEAD -> refs/heads/feature/x'], parents: [hMerge] }),
    dag({ hash: hMerge, message: "Merge branch 'main' into feature/x", refs: [], parents: [hFeatWork, hMainMid] }),
    dag({ hash: hFeatWork, message: 'feature work', refs: [], parents: [hMainBase] }),
    dag({ hash: hMainTip, message: 'main tip', refs: ['refs/heads/main', 'refs/remotes/origin/main'], parents: [hMainMid] }),
    dag({ hash: hMainMid, message: 'main mid', refs: [], parents: [hMainBase] }),
    dag({ hash: hMainBase, message: 'main base', refs: [], parents: [] }),
  ]

  const g = resolveCommitGraph(commits, 'main')
  const layout = computeDagLayout(g.commits, 'main')
  const collapsed = computeCollapsedDag(layout, 'main')

  test('hMainMid parent is hMainBase, not reparented to feature', () => {
    const mid = g.commits.find(c => c.hash === hMainMid)!
    expect(mid.parents[0]).toBe(hMainBase)
  })

  test('collapsed view has edge connecting main commits across the gap', () => {
    const tipRow = collapsed.nodes.find(n => n.commit.hash === hMainTip)?.row
    const baseRow = collapsed.nodes.find(n => n.commit.hash === hMainBase)?.row
    if (tipRow === undefined || baseRow === undefined) throw new Error('main tip or base missing from collapsed view')
    // There must be a path of edges from tipRow to baseRow on the same column
    const mainCol = collapsed.nodes.find(n => n.commit.hash === hMainTip)!.column
    const bridgeEdge = collapsed.edges.some(e =>
      e.fromCol === mainCol && e.toCol === mainCol &&
      e.fromRow >= tipRow && e.toRow <= baseRow
    )
    if (!bridgeEdge) throw new Error('No edge on main column between tip and base — the original bug')
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

// ─── computeCollapsedDag ───────────────────────────────────────

import { computeCollapsedDag } from '../client/CommitGraph'
import type { CollapsedDag } from '../client/CommitGraph'

describe('computeCollapsedDag — fork points are preserved as head rows', () => {
  // main: A → B → C → D → E (all col 0)
  // feature: F → G (col 1), forking from C
  const hA = makeHash(), hB = makeHash(), hC = makeHash(), hD = makeHash(), hE = makeHash()
  const hF = makeHash(), hG = makeHash()

  const commits: ResolvedCommit[] = [
    resolved({ hash: hF, message: 'feat tip', branch: 'feature', parents: [hG], branchRefs: ['feature'], isBranchTip: true }),
    resolved({ hash: hG, message: 'feat work', branch: 'feature', parents: [hC] }),
    resolved({ hash: hA, message: 'main tip', branch: 'main', parents: [hB], branchRefs: ['main'], isBranchTip: true }),
    resolved({ hash: hB, message: 'main b', branch: 'main', parents: [hC] }),
    resolved({ hash: hC, message: 'fork point', branch: 'main', parents: [hD] }),
    resolved({ hash: hD, message: 'main d', branch: 'main', parents: [hE] }),
    resolved({ hash: hE, message: 'main e', branch: 'main', parents: [] }),
  ]

  const fullLayout = computeDagLayout(commits, 'main')
  const collapsed = computeCollapsedDag(fullLayout, 'main')

  test('fork point commit is a visible node, not collapsed into a group', () => {
    const forkNode = collapsed.nodes.find(n => n.commit.hash === hC)
    if (!forkNode) throw new Error('Fork point commit (C) was collapsed — should be preserved')
    expect(forkNode.commit.hash).toBe(hC)
  })

  test('branch tip is a visible node', () => {
    const tipNode = collapsed.nodes.find(n => n.commit.hash === hF)
    if (!tipNode) throw new Error('Branch tip (F) was collapsed — should be preserved')
    expect(tipNode.commit.hash).toBe(hF)
  })

  test('cross-column edge from branch to fork point has distinct rows', () => {
    const forkRow = collapsed.nodes.find(n => n.commit.hash === hC)!.row
    const tipRow = collapsed.nodes.find(n => n.commit.hash === hF)!.row
    // There should be an edge (possibly indirect) from the branch to the fork point
    // and they should be on different collapsed rows
    expect(tipRow !== forkRow).toBe(true)
  })
})

describe('computeCollapsedDag — linear history collapses non-head commits', () => {
  const hA = makeHash(), hB = makeHash(), hC = makeHash(), hD = makeHash()

  const commits: ResolvedCommit[] = [
    resolved({ hash: hA, message: 'tip', branch: 'main', parents: [hB], branchRefs: ['main'], isBranchTip: true }),
    resolved({ hash: hB, message: 'mid 1', branch: 'main', parents: [hC] }),
    resolved({ hash: hC, message: 'mid 2', branch: 'main', parents: [hD] }),
    resolved({ hash: hD, message: 'root', branch: 'main', parents: [] }),
  ]

  const fullLayout = computeDagLayout(commits, 'main')
  const collapsed = computeCollapsedDag(fullLayout, 'main', false, false)

  test('tip and root are preserved, middle commits are grouped', () => {
    // Tip has branchRef → head. Root is last base branch commit → head.
    // Middle commits (B, C) should be collapsed.
    const visibleHashes = new Set(collapsed.nodes.map(n => n.commit.hash))
    expect(visibleHashes.has(hA)).toBe(true)
    expect(visibleHashes.has(hD)).toBe(true)
    expect(visibleHashes.has(hB)).toBe(false)
    expect(visibleHashes.has(hC)).toBe(false)
  })

  test('edge between preserved nodes carries collapsedCount', () => {
    const collapsedEdge = collapsed.edges.find(e => e.collapsedCount)
    if (!collapsedEdge) throw new Error('Expected an edge with collapsedCount for the 2 collapsed commits')
    expect(collapsedEdge.collapsedCount).toBe(2)
  })
})

describe('computeCollapsedDag — merge commit source preserved', () => {
  // Simulates a merged PR: main has merge commit with syntheticBranch,
  // second parent is the merged commit. Both should be head rows.
  const hMerge = makeHash(), hPR = makeHash(), hBase = makeHash()

  const commits: ResolvedCommit[] = [
    resolved({ hash: hMerge, message: 'Merge PR #1', branch: 'main', parents: [hBase], branchRefs: ['main'], isBranchTip: true }),
    resolved({ hash: hPR, message: 'PR work', branch: 'main', parents: [hBase], mergedFrom: 'feature/foo' }),
    resolved({ hash: hBase, message: 'base', branch: 'main', parents: [] }),
  ]

  const fullLayout = computeDagLayout(commits, 'main')
  const collapsed = computeCollapsedDag(fullLayout, 'main', false, true)

  test('merge commit with syntheticBranch is preserved', () => {
    const mergeNode = collapsed.nodes.find(n => n.commit.hash === hMerge)
    if (!mergeNode) throw new Error('Merge commit collapsed — should be preserved (syntheticBranch)')
  })
})

describe('computeCollapsedDag — maxColumn reflects actual columns, not synthetic', () => {
  const hA = makeHash(), hB = makeHash()

  const commits: ResolvedCommit[] = [
    resolved({ hash: hA, message: 'merge', branch: 'main', parents: [hB], branchRefs: ['main'], isBranchTip: true, mergedFrom: 'feature/x' }),
    resolved({ hash: hB, message: 'base', branch: 'main', parents: [] }),
  ]

  const fullLayout = computeDagLayout(commits, 'main')

  test('maxColumn is 0 (only col 0 used), not inflated by syntheticBranch.column', () => {
    expect(fullLayout.maxColumn).toBe(0)
  })
})

describe('computeCollapsedDag — edges survive collapsing across fork points', () => {
  const hTip = makeHash(), hFeat = makeHash(), hFork = makeHash(), hBelow = makeHash()

  const commits: ResolvedCommit[] = [
    resolved({ hash: hTip, message: 'feat tip', branch: 'feature', parents: [hFeat], branchRefs: ['feature'], isBranchTip: true }),
    resolved({ hash: hFeat, message: 'feat mid', branch: 'feature', parents: [hFork] }),
    resolved({ hash: hFork, message: 'fork', branch: 'main', parents: [hBelow], branchRefs: ['main'], isBranchTip: true }),
    resolved({ hash: hBelow, message: 'below', branch: 'main', parents: [] }),
  ]

  const fullLayout = computeDagLayout(commits, 'main')
  const collapsed = computeCollapsedDag(fullLayout, 'main')

  test('cross-column edge exists in collapsed layout', () => {
    const forkCol = collapsed.nodes.find(n => n.commit.hash === hFork)?.column
    const tipCol = collapsed.nodes.find(n => n.commit.hash === hTip)?.column
    if (forkCol === undefined || tipCol === undefined) throw new Error('Missing nodes')
    // There should be at least one edge crossing columns
    const crossEdge = collapsed.edges.some(e => e.fromCol !== e.toCol)
    expect(crossEdge).toBe(true)
  })
})

describe('computeCollapsedDag — recentRowThreshold hides old branch tips', () => {
  // 10 main commits, then a stale branch forking from row 8
  const hashes = Array.from({ length: 12 }, () => makeHash())
  // hashes[0..9] = main commits, hashes[10..11] = stale branch
  const commits: ResolvedCommit[] = [
    // Main: rows 0-9
    resolved({ hash: hashes[0], message: 'main tip', branch: 'main', parents: [hashes[1]], branchRefs: ['main'], isBranchTip: true }),
    ...Array.from({ length: 8 }, (_, i) =>
      resolved({ hash: hashes[i + 1], message: `main ${i + 1}`, branch: 'main', parents: [hashes[i + 2]] })
    ),
    resolved({ hash: hashes[9], message: 'main root', branch: 'main', parents: [] }),
    // Stale branch: rows 10-11, forking from hashes[8] (row 8)
    resolved({ hash: hashes[10], message: 'stale tip', branch: 'stale-feat', parents: [hashes[11]], branchRefs: ['stale-feat'], isBranchTip: true }),
    resolved({ hash: hashes[11], message: 'stale work', branch: 'stale-feat', parents: [hashes[8]] }),
  ]

  const fullLayout = computeDagLayout(commits, 'main')

  test('without threshold: stale branch tip is shown', () => {
    const collapsed = computeCollapsedDag(fullLayout, 'main', false, false)
    const staleTip = collapsed.nodes.find(n => n.commit.hash === hashes[10])
    if (!staleTip) throw new Error('Stale branch tip should be visible without threshold')
  })

  test('with threshold=5: stale branch tip is collapsed away', () => {
    const collapsed = computeCollapsedDag(fullLayout, 'main', false, false, 5)
    const staleTip = collapsed.nodes.find(n => n.commit.hash === hashes[10])
    if (staleTip) throw new Error('Stale branch tip should be hidden — all its commits are beyond row 5')
  })

  test('with threshold=12: stale branch tip is shown (within range)', () => {
    const collapsed = computeCollapsedDag(fullLayout, 'main', false, false, 12)
    const staleTip = collapsed.nodes.find(n => n.commit.hash === hashes[10])
    if (!staleTip) throw new Error('Stale branch tip should be visible — its commits are within threshold')
  })
})

describe('computeCollapsedDag — visible branch tip always has visible fork point', () => {
  // Main: 20 commits (rows 0-19)
  // Branch: tip at row 20, 3 intermediates, forks from main at row 5
  // The branch tip is beyond a threshold of 15, but without threshold it's visible.
  // When visible: both the tip AND the fork point (row 5 on main) must be head rows.
  const mainHashes = Array.from({ length: 20 }, () => makeHash())
  const branchHashes = Array.from({ length: 4 }, () => makeHash()) // tip + 3 intermediates

  const commits: ResolvedCommit[] = [
    // Main: rows 0-19
    resolved({ hash: mainHashes[0], message: 'main tip', branch: 'main', parents: [mainHashes[1]], branchRefs: ['main'], isBranchTip: true }),
    ...Array.from({ length: 18 }, (_, i) =>
      resolved({ hash: mainHashes[i + 1], message: `main ${i + 1}`, branch: 'main', parents: [mainHashes[i + 2]] })
    ),
    resolved({ hash: mainHashes[19], message: 'main root', branch: 'main', parents: [] }),
    // Branch: rows 20-23, forks from mainHashes[5] (row 5)
    resolved({ hash: branchHashes[0], message: 'branch tip', branch: 'my-feature', parents: [branchHashes[1]], branchRefs: ['my-feature'], isBranchTip: true }),
    resolved({ hash: branchHashes[1], message: 'branch mid 1', branch: 'my-feature', parents: [branchHashes[2]] }),
    resolved({ hash: branchHashes[2], message: 'branch mid 2', branch: 'my-feature', parents: [branchHashes[3]] }),
    resolved({ hash: branchHashes[3], message: 'branch base', branch: 'my-feature', parents: [mainHashes[5]] }),
  ]

  const fullLayout = computeDagLayout(commits, 'main')

  test('branch tip is visible → fork point on main is also visible', () => {
    const collapsed = computeCollapsedDag(fullLayout, 'main', false, false)
    const tip = collapsed.nodes.find(n => n.commit.hash === branchHashes[0])
    if (!tip) throw new Error('Branch tip should be visible (has branchRef)')

    // The fork point is mainHashes[5]. It must be a visible node, not collapsed.
    const forkPoint = collapsed.nodes.find(n => n.commit.hash === mainHashes[5])
    if (!forkPoint) throw new Error('Fork point on main must be visible when branch tip is visible')
  })

  test('branch last commit before fork is also visible', () => {
    const collapsed = computeCollapsedDag(fullLayout, 'main', false, false)

    // branchHashes[3] is the last branch commit before crossing to main.
    // The edge from branchHashes[3] (branch col) → mainHashes[5] (main col) is cross-column.
    // Both endpoints must be preserved.
    const branchEnd = collapsed.nodes.find(n => n.commit.hash === branchHashes[3])
    if (!branchEnd) throw new Error('Branch last commit (before fork) must be visible')
  })

  test('intermediate branch commits are collapsed', () => {
    const collapsed = computeCollapsedDag(fullLayout, 'main', false, false)

    // branchHashes[1] and [2] are intermediates with no refs — should be in a group
    const mid1 = collapsed.nodes.find(n => n.commit.hash === branchHashes[1])
    const mid2 = collapsed.nodes.find(n => n.commit.hash === branchHashes[2])
    if (mid1) throw new Error('Branch intermediate 1 should be collapsed')
    if (mid2) throw new Error('Branch intermediate 2 should be collapsed')
  })
})

describe('computeCollapsedDag — no orphaned branch tips (tip shown without fork point)', () => {
  // Simulate the normain bug: branch tip is a head row, but its fork point
  // is NOT preserved → branch dot floats with no visible connection to main.
  // This can happen when the branch tip is shown (branchRef) but nothing
  // preserves the fork point because cross-column edges are filtered out.
  //
  // Setup: 10 main commits, 1-commit branch at row 10 forking from row 5.
  // Threshold = 8 → branch is "old" (tip at row 10 > 8).
  // The recency filter skips the branchRef head. But the cross-column edge
  // from the branch to main should still NOT create an orphaned tip.
  const mainHashes = Array.from({ length: 10 }, () => makeHash())
  const branchTip = makeHash()

  const commits: ResolvedCommit[] = [
    resolved({ hash: mainHashes[0], message: 'main tip', branch: 'main', parents: [mainHashes[1]], branchRefs: ['main'], isBranchTip: true }),
    ...Array.from({ length: 8 }, (_, i) =>
      resolved({ hash: mainHashes[i + 1], message: `main ${i + 1}`, branch: 'main', parents: [mainHashes[i + 2]] })
    ),
    resolved({ hash: mainHashes[9], message: 'main root', branch: 'main', parents: [] }),
    // Single-commit branch, forking from mainHashes[5]
    resolved({ hash: branchTip, message: 'old branch tip', branch: 'old-feat', parents: [mainHashes[5]], branchRefs: ['old-feat'], isBranchTip: true }),
  ]

  const fullLayout = computeDagLayout(commits, 'main')

  test('with recency threshold: branch tip must NOT appear without its fork point', () => {
    const collapsed = computeCollapsedDag(fullLayout, 'main', false, false, 8)

    const tip = collapsed.nodes.find(n => n.commit.hash === branchTip)
    const forkPoint = collapsed.nodes.find(n => n.commit.hash === mainHashes[5])

    // Either BOTH are visible, or NEITHER is visible. No orphans.
    const tipVisible = !!tip
    const forkVisible = !!forkPoint

    if (tipVisible && !forkVisible) {
      throw new Error('Orphaned branch tip: tip is visible but fork point is not')
    }
    // Recency said "hide this branch" — it should be fully hidden, not partially shown
    if (tipVisible) {
      throw new Error('Old branch tip should be fully hidden by recency threshold, not brought back by cross-column edge rule')
    }
  })
})

describe('computeCollapsedDag — plain commit correctly collapsed, syntheticBranch kept', () => {
  // After mergedFrom parent override, the merge commit has no special significance
  // (no refs, no syntheticBranch, single parent). It should be collapsed.
  // The mergedFrom commit (with syntheticBranch) IS significant and stays.
  const hTip = makeHash()
  const hMergeA = makeHash()
  const hFeatX = makeHash()
  const hMergedFromA = makeHash()
  const hBase = makeHash()

  const commits: ResolvedCommit[] = [
    resolved({ hash: hTip, message: 'main tip', branch: 'main', parents: [hMergeA], branchRefs: ['main'], isBranchTip: true }),
    resolved({ hash: hMergeA, message: 'Merge PR #191', branch: 'main', parents: [hMergedFromA] }),
    resolved({ hash: hFeatX, message: 'feat work', branch: 'featX', parents: [hBase], branchRefs: ['featX'], isBranchTip: true }),
    resolved({ hash: hMergedFromA, message: 'PR work', branch: 'main', parents: [hBase], mergedFrom: 'feature/foo' }),
    resolved({ hash: hBase, message: 'base', branch: 'main', parents: [] }),
  ]

  const fullLayout = computeDagLayout(commits, 'main')
  const collapsed = computeCollapsedDag(fullLayout, 'main', false, true)

  test('plain merge commit (no refs, no syntheticBranch) is correctly collapsed', () => {
    const mergeNode = collapsed.nodes.find(n => n.commit.hash === hMergeA)
    if (mergeNode) throw new Error('Plain commit should be collapsed — has no visual significance')
  })

  test('mergedFrom commit is visible (has syntheticBranch)', () => {
    const mfNode = collapsed.nodes.find(n => n.commit.hash === hMergedFromA)
    if (!mfNode) throw new Error('mergedFrom commit should be visible (has syntheticBranch)')
  })

  test('continuous edge path on col 0 from tip to mergedFrom', () => {
    const tipRow = collapsed.nodes.find(n => n.commit.hash === hTip)!.row
    const mfRow = collapsed.nodes.find(n => n.commit.hash === hMergedFromA)!.row
    // Edge path may go through intermediate collapsed rows (same as full layout)
    const col0Edges = collapsed.edges.filter(e => e.fromCol === 0 && e.toCol === 0)
    // Check there's a connected path from tipRow to mfRow on col 0
    const reachable = new Set([tipRow])
    for (const e of col0Edges) {
      if (reachable.has(e.fromRow)) reachable.add(e.toRow)
    }
    if (!reachable.has(mfRow)) throw new Error('No connected path on col 0 from tip to mergedFrom')
  })
})

// ─── Collapsed invariant tests (phantom edges, column reuse, connectivity) ──

/** Helper: check that every edge endpoint has a node at that (row, column) */
function assertNoPhantomEdges(collapsed: CollapsedDag) {
  const nodeAt = new Set<string>()
  for (const n of collapsed.nodes) nodeAt.add(`${n.row},${n.column}`)
  for (const e of collapsed.edges) {
    if (!nodeAt.has(`${e.fromRow},${e.fromCol}`))
      throw new Error(`Phantom edge: from row=${e.fromRow} col=${e.fromCol} has no node`)
    if (!nodeAt.has(`${e.toRow},${e.toCol}`))
      throw new Error(`Phantom edge: to row=${e.toRow} col=${e.toCol} has no node`)
  }
}

describe('computeCollapsedDag — no phantom edges with interleaved branches', () => {
  // 3 branches interleaving on topo sort: main (col 0), feat-A (col 1), feat-B (col 2).
  // Many non-kept rows on branch columns will map to kept rows on main.
  const h = Array.from({ length: 20 }, () => makeHash())

  const commits: ResolvedCommit[] = [
    // main tip
    resolved({ hash: h[0], message: 'main tip', branch: 'main', parents: [h[1]], branchRefs: ['main'], isBranchTip: true }),
    // feat-A tip (interleaves between main commits)
    resolved({ hash: h[1], message: 'main 1', branch: 'main', parents: [h[3]] }),
    resolved({ hash: h[2], message: 'feat-A tip', branch: 'feat-A', parents: [h[4]], branchRefs: ['feat-A'], isBranchTip: true }),
    resolved({ hash: h[3], message: 'main 2', branch: 'main', parents: [h[6]] }),
    resolved({ hash: h[4], message: 'feat-A mid', branch: 'feat-A', parents: [h[5]] }),
    resolved({ hash: h[5], message: 'feat-A base', branch: 'feat-A', parents: [h[6]] }),
    // feat-B tip (interleaves further)
    resolved({ hash: h[6], message: 'main 3', branch: 'main', parents: [h[8]] }),
    resolved({ hash: h[7], message: 'feat-B tip', branch: 'feat-B', parents: [h[9]], branchRefs: ['feat-B'], isBranchTip: true }),
    resolved({ hash: h[8], message: 'main 4', branch: 'main', parents: [h[11]] }),
    resolved({ hash: h[9], message: 'feat-B mid', branch: 'feat-B', parents: [h[10]] }),
    resolved({ hash: h[10], message: 'feat-B base', branch: 'feat-B', parents: [h[11]] }),
    resolved({ hash: h[11], message: 'main root', branch: 'main', parents: [] }),
  ]

  const fullLayout = computeDagLayout(commits, 'main')
  const collapsed = computeCollapsedDag(fullLayout, 'main')

  test('zero phantom edges', () => {
    assertNoPhantomEdges(collapsed)
  })
})

describe('computeCollapsedDag — column reuse does not create false connections', () => {
  // Two unrelated branches reuse the same column (col 1).
  // Branch A ends, then branch B starts later at the same column.
  // Collapsed view must NOT connect them.
  const h = Array.from({ length: 14 }, () => makeHash())

  const commits: ResolvedCommit[] = [
    // Branch A: tip at row 0, forks from main at h[3]
    resolved({ hash: h[0], message: 'A tip', branch: 'branch-A', parents: [h[1]], branchRefs: ['branch-A'], isBranchTip: true }),
    resolved({ hash: h[1], message: 'A mid', branch: 'branch-A', parents: [h[2]] }),
    resolved({ hash: h[2], message: 'A base', branch: 'branch-A', parents: [h[3]] }),
    // Main commits
    resolved({ hash: h[3], message: 'main 1', branch: 'main', parents: [h[4]], branchRefs: ['main'], isBranchTip: true }),
    resolved({ hash: h[4], message: 'main 2', branch: 'main', parents: [h[5]] }),
    resolved({ hash: h[5], message: 'main 3', branch: 'main', parents: [h[6]] }),
    resolved({ hash: h[6], message: 'main 4', branch: 'main', parents: [h[9]] }),
    // Branch B: tip at row 7, forks from main at h[9] — will reuse col 1 after A ends
    resolved({ hash: h[7], message: 'B tip', branch: 'branch-B', parents: [h[8]], branchRefs: ['branch-B'], isBranchTip: true }),
    resolved({ hash: h[8], message: 'B base', branch: 'branch-B', parents: [h[9]] }),
    resolved({ hash: h[9], message: 'main 5', branch: 'main', parents: [h[10]] }),
    resolved({ hash: h[10], message: 'main root', branch: 'main', parents: [] }),
  ]

  const fullLayout = computeDagLayout(commits, 'main')
  const collapsed = computeCollapsedDag(fullLayout, 'main')

  test('no phantom edges', () => {
    assertNoPhantomEdges(collapsed)
  })

  test('no edge between branch-A and branch-B nodes', () => {
    const aNodes = collapsed.nodes.filter(n => n.commit.branch === 'branch-A')
    const bNodes = collapsed.nodes.filter(n => n.commit.branch === 'branch-B')
    const aRows = new Set(aNodes.map(n => n.row))
    const bRows = new Set(bNodes.map(n => n.row))
    for (const e of collapsed.edges) {
      const fromA = aRows.has(e.fromRow), toB = bRows.has(e.toRow)
      const fromB = bRows.has(e.fromRow), toA = aRows.has(e.toRow)
      if ((fromA && toB) || (fromB && toA)) {
        throw new Error(`False edge between branch-A (row ${e.fromRow}) and branch-B (row ${e.toRow})`)
      }
    }
  })
})

describe('computeCollapsedDag — every branch connects to main', () => {
  // Two branches fork from main at different points.
  // In collapsed view, both must have a cross-column edge to main.
  const h = Array.from({ length: 10 }, () => makeHash())

  const commits: ResolvedCommit[] = [
    resolved({ hash: h[0], message: 'feat tip', branch: 'feat', parents: [h[1]], branchRefs: ['feat'], isBranchTip: true }),
    resolved({ hash: h[1], message: 'feat base', branch: 'feat', parents: [h[3]] }),
    resolved({ hash: h[2], message: 'main tip', branch: 'main', parents: [h[3]], branchRefs: ['main'], isBranchTip: true }),
    resolved({ hash: h[3], message: 'fork point', branch: 'main', parents: [h[4]] }),
    resolved({ hash: h[4], message: 'main mid', branch: 'main', parents: [h[5]] }),
    resolved({ hash: h[5], message: 'main root', branch: 'main', parents: [] }),
  ]

  const fullLayout = computeDagLayout(commits, 'main')
  const collapsed = computeCollapsedDag(fullLayout, 'main')

  test('no phantom edges', () => {
    assertNoPhantomEdges(collapsed)
  })

  test('branch has cross-column edge to main', () => {
    const crossCol = collapsed.edges.some(e => e.fromCol !== e.toCol)
    if (!crossCol) throw new Error('No cross-column edge — branch is disconnected from main')
  })
})

describe('computeCollapsedDag — same-column chain preserved across collapsed rows', () => {
  // Main has 10 commits, only tip and root are kept.
  // The edge between them must survive with correct collapsedCount.
  const h = Array.from({ length: 10 }, () => makeHash())

  const commits: ResolvedCommit[] = [
    resolved({ hash: h[0], message: 'tip', branch: 'main', parents: [h[1]], branchRefs: ['main'], isBranchTip: true }),
    ...Array.from({ length: 8 }, (_, i) =>
      resolved({ hash: h[i + 1], message: `mid ${i}`, branch: 'main', parents: [h[i + 2]] })
    ),
    resolved({ hash: h[9], message: 'root', branch: 'main', parents: [] }),
  ]

  const fullLayout = computeDagLayout(commits, 'main')
  const collapsed = computeCollapsedDag(fullLayout, 'main', false, false)

  test('only 2 nodes visible (tip + root)', () => {
    expect(collapsed.nodes.length).toBe(2)
  })

  test('edge connects them with collapsedCount = 8', () => {
    expect(collapsed.edges.length).toBe(1)
    expect(collapsed.edges[0].collapsedCount).toBe(8)
  })

  test('no phantom edges', () => {
    assertNoPhantomEdges(collapsed)
  })
})

describe('computeCollapsedDag — many branches interleaving, zero phantoms', () => {
  // Stress test: 5 branches forking from main at different points,
  // each with 3 commits. Total 20 commits.
  const main = Array.from({ length: 5 }, () => makeHash())
  const branches = Array.from({ length: 5 }, () =>
    Array.from({ length: 3 }, () => makeHash())
  )
  const branchNames = ['b1', 'b2', 'b3', 'b4', 'b5']

  // Interleave: main tip, b1 tip, main 1, b2 tip, main 2, b3 tip, ...
  const commits: ResolvedCommit[] = []

  // Branch tips
  for (let i = 0; i < 5; i++) {
    commits.push(resolved({
      hash: branches[i][0], message: `${branchNames[i]} tip`, branch: branchNames[i],
      parents: [branches[i][1]], branchRefs: [branchNames[i]], isBranchTip: true
    }))
  }
  // Branch mids
  for (let i = 0; i < 5; i++) {
    commits.push(resolved({
      hash: branches[i][1], message: `${branchNames[i]} mid`, branch: branchNames[i],
      parents: [branches[i][2]]
    }))
  }
  // Main commits
  commits.push(resolved({
    hash: main[0], message: 'main tip', branch: 'main',
    parents: [main[1]], branchRefs: ['main'], isBranchTip: true
  }))
  for (let i = 1; i < 4; i++) {
    commits.push(resolved({
      hash: main[i], message: `main ${i}`, branch: 'main', parents: [main[i + 1]]
    }))
  }
  commits.push(resolved({ hash: main[4], message: 'main root', branch: 'main', parents: [] }))

  // Branch bases fork from main
  for (let i = 0; i < 5; i++) {
    commits.push(resolved({
      hash: branches[i][2], message: `${branchNames[i]} base`, branch: branchNames[i],
      parents: [main[i]]
    }))
  }

  const fullLayout = computeDagLayout(commits, 'main')
  const collapsed = computeCollapsedDag(fullLayout, 'main')

  test('zero phantom edges with 5 interleaved branches', () => {
    assertNoPhantomEdges(collapsed)
  })

  test('all 5 branch tips are visible', () => {
    for (const name of branchNames) {
      const tip = collapsed.nodes.find(n => n.commit.branch === name && n.isBranchTip)
      if (!tip) throw new Error(`Branch ${name} tip missing from collapsed view`)
    }
  })

  test('every branch has at least one cross-column edge', () => {
    for (const name of branchNames) {
      const branchNodes = collapsed.nodes.filter(n => n.commit.branch === name)
      const branchRows = new Set(branchNodes.map(n => n.row))
      const hasCross = collapsed.edges.some(e =>
        e.fromCol !== e.toCol && (branchRows.has(e.fromRow) || branchRows.has(e.toRow))
      )
      if (!hasCross) throw new Error(`Branch ${name} has no cross-column edge — disconnected from main`)
    }
  })
})

// ─── Local/remote divergence: origin/X as separate branch ──────

describe('resolveCommitGraph — diverged local/remote → origin/ becomes separate branch', () => {
  // Topology:
  //   local main:  L1 → L2 → base
  //   origin/main: R1 → R2 → base
  // Both diverged from base — origin/main should become its own branch
  const baseHash = makeHash()
  const l2Hash = makeHash()
  const l1Hash = makeHash()
  const r2Hash = makeHash()
  const r1Hash = makeHash()

  const commits: DagCommit[] = [
    dag({ hash: l1Hash, message: 'local work 1', refs: ['HEAD -> refs/heads/main'], parents: [l2Hash] }),
    dag({ hash: l2Hash, message: 'local work 2', refs: [], parents: [baseHash] }),
    dag({ hash: r1Hash, message: 'remote work 1', refs: ['refs/remotes/origin/main'], parents: [r2Hash] }),
    dag({ hash: r2Hash, message: 'remote work 2', refs: [], parents: [baseHash] }),
    dag({ hash: baseHash, message: 'shared base', refs: [], parents: [] }),
  ]

  const g = resolveCommitGraph(commits, 'main')

  test('origin/main is a separate branch (not just a display ref)', () => {
    expect(g.branches).toContain('origin/main')
  })

  test('local main commits owned by main', () => {
    expect(g.commits[0].branch).toBe('main')
    expect(g.commits[1].branch).toBe('main')
  })

  test('remote-only commits owned by origin/main', () => {
    const r1 = g.commits.find(c => c.hash === r1Hash)!
    const r2 = g.commits.find(c => c.hash === r2Hash)!
    expect(r1.branch).toBe('origin/main')
    expect(r2.branch).toBe('origin/main')
  })

  test('origin/main is a branch tip', () => {
    const r1 = g.commits.find(c => c.hash === r1Hash)!
    expect(r1.isBranchTip).toBe(true)
  })

  test('base commit owned by origin/main (canonical trunk when diverged)', () => {
    const base = g.commits.find(c => c.hash === baseHash)!
    expect(base.branch).toBe('origin/main')
  })
})

describe('computeDagLayout — diverged local/remote get separate columns', () => {
  const baseHash = makeHash()
  const l1Hash = makeHash()
  const r1Hash = makeHash()
  const r2Hash = makeHash()

  const commits: ResolvedCommit[] = [
    resolved({ hash: l1Hash, message: 'local', branch: 'main', parents: [baseHash], branchRefs: ['main'], isBranchTip: true, isHead: true }),
    resolved({ hash: r1Hash, message: 'remote 1', branch: 'origin/main', parents: [r2Hash], branchRefs: ['origin/main'], isBranchTip: true }),
    resolved({ hash: r2Hash, message: 'remote 2', branch: 'origin/main', parents: [baseHash] }),
    resolved({ hash: baseHash, message: 'shared', branch: 'origin/main', parents: [] }),
  ]

  const layout = computeDagLayout(commits, 'main')

  test('origin/main on col 0 (canonical trunk)', () => {
    const node = layout.nodes.find(n => n.commit.hash === r1Hash)!
    expect(node.column).toBe(0)
  })

  test('local main on separate column (> 0)', () => {
    const node = layout.nodes.find(n => n.commit.hash === l1Hash)!
    expect(node.column > 0).toBe(true)
  })

  test('both origin/main commits on same column', () => {
    const n1 = layout.nodes.find(n => n.commit.hash === r1Hash)!
    const n2 = layout.nodes.find(n => n.commit.hash === r2Hash)!
    expect(n1.column).toBe(n2.column)
  })

  test('shared base on col 0 (same as origin/main)', () => {
    const baseNode = layout.nodes.find(n => n.commit.hash === baseHash)!
    expect(baseNode.column).toBe(0)
  })
})

describe('resolveCommitGraph — remote-only ahead (no local divergence) stays same branch', () => {
  // Topology: origin/main → R1 → R2 → local main tip → base
  // origin is ahead, local has no unique commits — should NOT split
  const baseHash = makeHash()
  const localTip = makeHash()
  const r2Hash = makeHash()
  const r1Hash = makeHash()

  const commits: DagCommit[] = [
    dag({ hash: r1Hash, message: 'remote 1', refs: ['refs/remotes/origin/main'], parents: [r2Hash] }),
    dag({ hash: r2Hash, message: 'remote 2', refs: [], parents: [localTip] }),
    dag({ hash: localTip, message: 'local tip', refs: ['HEAD -> refs/heads/main'], parents: [baseHash] }),
    dag({ hash: baseHash, message: 'base', refs: [], parents: [] }),
  ]

  const g = resolveCommitGraph(commits, 'main')

  test('origin/main is NOT a separate branch (just a display ref)', () => {
    expect(g.branches.includes('origin/main')).toBe(false)
  })

  test('all commits owned by main', () => {
    for (const c of g.commits) {
      expect(c.branch).toBe('main')
    }
  })

  test('origin/main appears as display ref on its commit', () => {
    const r1 = g.commits.find(c => c.hash === r1Hash)!
    expect(r1.branchRefs).toContain('origin/main')
  })
})

describe('computeDagLayout — local-only ahead edges are dashed (existing behavior)', () => {
  const baseHash = makeHash()
  const localHash = makeHash()

  const commits: ResolvedCommit[] = [
    resolved({ hash: localHash, message: 'local unpushed', branch: 'main', parents: [baseHash], branchRefs: ['main'], isBranchTip: true, isHead: true }),
    resolved({ hash: baseHash, message: 'pushed', branch: 'main', parents: [], branchRefs: ['origin/main'] }),
  ]

  const layout = computeDagLayout(commits, 'main')

  test('edge from unpushed commit is dashed', () => {
    const localNode = layout.nodes.find(n => n.commit.hash === localHash)!
    const dashedEdge = layout.edges.find(e => e.fromRow === localNode.row)
    expect(dashedEdge !== undefined).toBe(true)
    expect(dashedEdge!.dashed).toBe(true)
  })
})

// ─── Feature branch diverged from origin ────────────────────────

describe('resolveCommitGraph — diverged feature branch + origin/feature', () => {
  // main: M1 → base
  // feature: F1 → base  (local)
  // origin/feature: R1 → base  (remote, diverged)
  const baseHash = makeHash()
  const m1Hash = makeHash()
  const f1Hash = makeHash()
  const r1Hash = makeHash()

  const commits: DagCommit[] = [
    dag({ hash: m1Hash, message: 'main tip', refs: ['HEAD -> refs/heads/main'], parents: [baseHash] }),
    dag({ hash: f1Hash, message: 'local feat', refs: ['refs/heads/feature'], parents: [baseHash] }),
    dag({ hash: r1Hash, message: 'remote feat', refs: ['refs/remotes/origin/feature'], parents: [baseHash] }),
    dag({ hash: baseHash, message: 'shared base', refs: [], parents: [] }),
  ]

  const g = resolveCommitGraph(commits, 'main')

  test('origin/feature becomes a separate branch', () => {
    expect(g.branches).toContain('origin/feature')
  })

  test('local feature commits owned by feature', () => {
    const f1 = g.commits.find(c => c.hash === f1Hash)!
    expect(f1.branch).toBe('feature')
  })

  test('remote-only commit owned by origin/feature', () => {
    const r1 = g.commits.find(c => c.hash === r1Hash)!
    expect(r1.branch).toBe('origin/feature')
  })

  test('origin/feature is a branch tip', () => {
    const r1 = g.commits.find(c => c.hash === r1Hash)!
    expect(r1.isBranchTip).toBe(true)
  })
})

// ─── Mixed state: diverged + ahead + behind in same graph ───────

describe('resolveCommitGraph — mixed: main diverged, feature ahead-only', () => {
  // main diverged: local L1 → base, origin R1 → base
  // feature ahead-only: origin/feature → F2 → F1 (F1 = local tip)
  const baseHash = makeHash()
  const l1Hash = makeHash()
  const r1Hash = makeHash()
  const f1Hash = makeHash()
  const f2Hash = makeHash()
  const rf1Hash = makeHash()

  const commits: DagCommit[] = [
    dag({ hash: l1Hash, message: 'local main', refs: ['HEAD -> refs/heads/main'], parents: [baseHash] }),
    dag({ hash: r1Hash, message: 'remote main', refs: ['refs/remotes/origin/main'], parents: [baseHash] }),
    dag({ hash: rf1Hash, message: 'remote feat ahead', refs: ['refs/remotes/origin/feature'], parents: [f2Hash] }),
    dag({ hash: f2Hash, message: 'feat shared 2', refs: [], parents: [f1Hash] }),
    dag({ hash: f1Hash, message: 'feat tip', refs: ['refs/heads/feature'], parents: [baseHash] }),
    dag({ hash: baseHash, message: 'shared base', refs: [], parents: [] }),
  ]

  const g = resolveCommitGraph(commits, 'main')

  test('main diverged → origin/main is separate branch', () => {
    expect(g.branches).toContain('origin/main')
    const r1 = g.commits.find(c => c.hash === r1Hash)!
    expect(r1.branch).toBe('origin/main')
  })

  test('feature not diverged → origin/feature NOT a separate branch', () => {
    expect(g.branches.includes('origin/feature')).toBe(false)
  })

  test('feature remote-ahead commits stay owned by feature', () => {
    const rf = g.commits.find(c => c.hash === rf1Hash)!
    expect(rf.branch).toBe('feature')
  })
})

// ─── Divergence propagation: intermediate commits get origin/ ───

describe('resolveCommitGraph — origin/ branch propagates to intermediate commits', () => {
  // local main: L1 → base
  // origin/main: R1 → R2 → R3 → base
  const baseHash = makeHash()
  const l1Hash = makeHash()
  const r3Hash = makeHash()
  const r2Hash = makeHash()
  const r1Hash = makeHash()

  const commits: DagCommit[] = [
    dag({ hash: l1Hash, message: 'local', refs: ['HEAD -> refs/heads/main'], parents: [baseHash] }),
    dag({ hash: r1Hash, message: 'remote 1', refs: ['refs/remotes/origin/main'], parents: [r2Hash] }),
    dag({ hash: r2Hash, message: 'remote 2', refs: [], parents: [r3Hash] }),
    dag({ hash: r3Hash, message: 'remote 3', refs: [], parents: [baseHash] }),
    dag({ hash: baseHash, message: 'shared base', refs: [], parents: [] }),
  ]

  const g = resolveCommitGraph(commits, 'main')

  test('all three remote commits owned by origin/main', () => {
    expect(g.commits.find(c => c.hash === r1Hash)!.branch).toBe('origin/main')
    expect(g.commits.find(c => c.hash === r2Hash)!.branch).toBe('origin/main')
    expect(g.commits.find(c => c.hash === r3Hash)!.branch).toBe('origin/main')
  })

  test('base commit owned by origin/main (canonical trunk when diverged)', () => {
    expect(g.commits.find(c => c.hash === baseHash)!.branch).toBe('origin/main')
  })
})

// ─── Local and origin at same commit (not diverged) ─────────────

describe('resolveCommitGraph — local and origin at same commit', () => {
  const tipHash = makeHash()
  const parentHash = makeHash()

  const commits: DagCommit[] = [
    dag({ hash: tipHash, message: 'synced tip', refs: ['HEAD -> refs/heads/main', 'refs/remotes/origin/main'], parents: [parentHash] }),
    dag({ hash: parentHash, message: 'parent', refs: [], parents: [] }),
  ]

  const g = resolveCommitGraph(commits, 'main')

  test('origin/main is NOT a separate branch', () => {
    expect(g.branches.includes('origin/main')).toBe(false)
  })

  test('all commits owned by main', () => {
    for (const c of g.commits) {
      expect(c.branch).toBe('main')
    }
  })

  test('origin/main appears as display ref', () => {
    expect(g.commits[0].branchRefs).toContain('origin/main')
  })

  test('no edges are dashed', () => {
    const layout = computeDagLayout(g.commits, g.baseBranch)
    for (const e of layout.edges) {
      expect(e.dashed ?? false).toBe(false)
    }
  })
})

// ─── Dashed edges with multi-branch layout ──────────────────────

describe('computeDagLayout — dashed edges on main with feature branch present', () => {
  const baseHash = makeHash()
  const m2Hash = makeHash()
  const m1Hash = makeHash()
  const f1Hash = makeHash()

  const commits: ResolvedCommit[] = [
    resolved({ hash: m1Hash, message: 'main unpushed', branch: 'main', parents: [m2Hash], branchRefs: ['main'], isBranchTip: true, isHead: true }),
    resolved({ hash: m2Hash, message: 'main pushed', branch: 'main', parents: [baseHash], branchRefs: ['origin/main'] }),
    resolved({ hash: f1Hash, message: 'feat local', branch: 'feature', parents: [baseHash], branchRefs: ['feature'], isBranchTip: true }),
    resolved({ hash: baseHash, message: 'base', branch: 'main', parents: [] }),
  ]

  const layout = computeDagLayout(commits, 'main')

  test('main column has dashed edge (unpushed M1)', () => {
    const m1Node = layout.nodes.find(n => n.commit.hash === m1Hash)!
    const dashedEdge = layout.edges.find(e => e.fromRow === m1Node.row && e.fromCol === m1Node.column)
    expect(dashedEdge !== undefined).toBe(true)
    expect(dashedEdge!.dashed).toBe(true)
  })

  test('feature local tip edge is NOT dashed', () => {
    const f1Node = layout.nodes.find(n => n.commit.hash === f1Hash)!
    const f1Edge = layout.edges.find(e => e.fromRow === f1Node.row && e.fromCol === f1Node.column)
    if (f1Edge) expect(f1Edge.dashed ?? false).toBe(false)
  })
})

// ─── Diverged layout: separate columns + fork edge ──────────────

describe('computeDagLayout — diverged branches connect at fork point', () => {
  const baseHash = makeHash()
  const l1Hash = makeHash()
  const l2Hash = makeHash()
  const r1Hash = makeHash()
  const r2Hash = makeHash()

  const commits: ResolvedCommit[] = [
    resolved({ hash: l1Hash, message: 'local 1', branch: 'main', parents: [l2Hash], branchRefs: ['main'], isBranchTip: true, isHead: true }),
    resolved({ hash: l2Hash, message: 'local 2', branch: 'main', parents: [baseHash] }),
    resolved({ hash: r1Hash, message: 'remote 1', branch: 'origin/main', parents: [r2Hash], branchRefs: ['origin/main'], isBranchTip: true }),
    resolved({ hash: r2Hash, message: 'remote 2', branch: 'origin/main', parents: [baseHash] }),
    resolved({ hash: baseHash, message: 'shared', branch: 'origin/main', parents: [] }),
  ]

  const layout = computeDagLayout(commits, 'main')

  test('edge exists from local main to shared base', () => {
    const l2Node = layout.nodes.find(n => n.commit.hash === l2Hash)!
    const baseNode = layout.nodes.find(n => n.commit.hash === baseHash)!
    const crossEdge = layout.edges.find(e =>
      e.fromCol === l2Node.column && e.toCol === baseNode.column &&
      e.toRow === baseNode.row
    )
    expect(crossEdge !== undefined).toBe(true)
  })

  test('no orphan nodes (every node reachable via edges)', () => {
    assertNoOrphans(layout, commits)
  })

  test('local diverged main edges are dashed', () => {
    const l1Node = layout.nodes.find(n => n.commit.hash === l1Hash)!
    const localEdges = layout.edges.filter(e => e.fromCol === l1Node.column)
    expect(localEdges.length > 0).toBe(true)
    for (const e of localEdges) {
      expect(e.dashed).toBe(true)
    }
  })

  test('origin/main edges are NOT dashed', () => {
    const r1Node = layout.nodes.find(n => n.commit.hash === r1Hash)!
    const originEdges = layout.edges.filter(e => e.fromCol === r1Node.column && e.toCol === r1Node.column)
    for (const e of originEdges) {
      expect(e.dashed ?? false).toBe(false)
    }
  })
})

// ─── Behind branch on diverged local chain stays on local column ──

describe('computeDagLayout — behind branch on diverged local main stays on main column', () => {
  // Topology (matches real repo):
  //   local main: L1 → L2(change-title tip) → L3 → fork
  //   origin/main: R1 → fork
  //   change-title-of-select-copy-files-stuff: behind branch, tip = L2
  // L2 is owned by change-title (via Pass 1 branchRefs) but is on local main's chain.
  // When diverged, it should stay on main's column (col 1+), NOT jump to col 0.
  const forkHash = makeHash()
  const l3Hash = makeHash()
  const l2Hash = makeHash()
  const l1Hash = makeHash()
  const r1Hash = makeHash()

  const commits: ResolvedCommit[] = [
    resolved({ hash: l1Hash, message: 'local work', branch: 'main', parents: [l2Hash], branchRefs: ['main'], isBranchTip: true, isHead: true }),
    resolved({ hash: l2Hash, message: 'also local', branch: 'change-title', parents: [l3Hash], branchRefs: ['change-title'], isBranchTip: true }),
    resolved({ hash: l3Hash, message: 'more local', branch: 'main', parents: [forkHash] }),
    resolved({ hash: r1Hash, message: 'remote only', branch: 'origin/main', parents: [forkHash], branchRefs: ['origin/main'], isBranchTip: true }),
    resolved({ hash: forkHash, message: 'fork point', branch: 'origin/main', parents: [] }),
  ]

  const layout = computeDagLayout(commits, 'main')

  test('local main on col 1+', () => {
    const l1 = layout.nodes.find(n => n.commit.hash === l1Hash)!
    expect(l1.column > 0).toBe(true)
  })

  test('behind branch commit (change-title) on same column as local main', () => {
    const l1 = layout.nodes.find(n => n.commit.hash === l1Hash)!
    const l2 = layout.nodes.find(n => n.commit.hash === l2Hash)!
    expect(l2.column).toBe(l1.column)
  })

  test('origin/main on col 0', () => {
    const r1 = layout.nodes.find(n => n.commit.hash === r1Hash)!
    expect(r1.column).toBe(0)
  })

  test('behind branch commit has behindBranch indicator', () => {
    const l2 = layout.nodes.find(n => n.commit.hash === l2Hash)!
    expect(l2.behindBranch !== undefined).toBe(true)
    expect(l2.behindBranch!.branchName).toBe('change-title')
  })
})

// ─── Pass 4: localOnlyHashes reclaims shared commits for trunk ──

describe('resolveCommitGraph — localOnlyHashes reclaims shared commits', () => {
  // Real-world topology: local1 is local-only, everything below was pushed.
  // mergedFrom commit 935968d has parent on shared history.
  const commits: DagCommit[] = [
    dag({ hash: 'local1', message: 'local work', refs: ['HEAD -> refs/heads/main'], parents: ['512265a'] }),
    dag({ hash: '512265a', message: 'feat: double', parents: ['a4be17b'] }),
    dag({ hash: 'a4be17b', message: 'Merge #30 from user/fix/worktree-remove', parents: ['caa4377', '935968d'] }),
    dag({ hash: '935968d', message: 'fix handle', parents: ['caa4377'] }),
    dag({ hash: 'caa4377', message: 'release', parents: ['548abbc'] }),
    dag({ hash: '548abbc', message: 'chore', parents: ['61fb34c'] }),
    dag({ hash: '4327416', message: 'origin only', refs: ['refs/remotes/origin/main'], parents: ['61fb34c'] }),
    dag({ hash: '61fb34c', message: 'fork', parents: [] }),
  ]

  // Only local1 is truly local (not on origin/main)
  const localOnly = new Set(['local1'])
  const g = resolveCommitGraph(commits, 'main', ['main'], localOnly)

  test('local1 stays on main', () => {
    expect(g.commits.find(c => c.hash === 'local1')!.branch).toBe('main')
  })

  test('shared commits reclaimed to origin/main', () => {
    expect(g.commits.find(c => c.hash === '512265a')!.branch).toBe('origin/main')
    expect(g.commits.find(c => c.hash === 'a4be17b')!.branch).toBe('origin/main')
    expect(g.commits.find(c => c.hash === 'caa4377')!.branch).toBe('origin/main')
    expect(g.commits.find(c => c.hash === '548abbc')!.branch).toBe('origin/main')
  })

  test('mergedFrom commit also reclaimed', () => {
    expect(g.commits.find(c => c.hash === '935968d')!.branch).toBe('origin/main')
  })

  test('layout: local1 on col 1, shared on col 0', () => {
    const layout = computeDagLayout(g.commits, g.baseBranch)
    const local1 = layout.nodes.find(n => n.commit.hash === 'local1')!
    const shared = layout.nodes.find(n => n.commit.hash === 'caa4377')!
    expect(local1.column > 0).toBe(true)
    expect(shared.column).toBe(0)
  })

  test('layout: local1 edge is dashed', () => {
    const layout = computeDagLayout(g.commits, g.baseBranch)
    const local1 = layout.nodes.find(n => n.commit.hash === 'local1')!
    const localEdge = layout.edges.find(e => e.fromRow === local1.row)
    expect(localEdge!.dashed).toBe(true)
  })

  test('layout: origin/main col 0 edges below origin ref are not dashed', () => {
    const layout = computeDagLayout(g.commits, g.baseBranch)
    const originNode = layout.nodes.find(n => n.commit.hash === '4327416')!
    const belowEdges = layout.edges.filter(e =>
      e.fromCol === 0 && e.toCol === 0 && e.fromRow > originNode.row
    )
    for (const e of belowEdges) {
      expect(e.dashed ?? false).toBe(false)
    }
  })
})

// ─── Real-world: merge commit with worktree branch (add-funny-stuff repo) ──

describe('real-world: merge + worktree branches use col 0 for base branch', () => {
  // Real topology from add-funny-stuff repo:
  //   5343284 = merge "Merge branch 'move-to-convex'" (parents: 0e3335b, bc87769)
  //   refs: add-funny-stuff + main → 5343284, move-to-convex → bc87769
  //   bc87769 = move-to-convex tip, parent 0e3335b
  //   0e3335b → 3cb615f → cece7da → 4ab3c3a → 5016e6f (linear)
  const commits: DagCommit[] = [
    dag({ hash: '5343284', message: "Merge branch 'move-to-convex'", refs: ['HEAD -> refs/heads/add-funny-stuff', 'refs/heads/main'], parents: ['0e3335b', 'bc87769'] }),
    dag({ hash: 'bc87769', message: 'migrate from Supabase to Convex', refs: ['refs/heads/move-to-convex'], parents: ['0e3335b'] }),
    dag({ hash: '0e3335b', message: 'switch to non-streaming Haiku 4.5', refs: [], parents: ['3cb615f'] }),
    dag({ hash: '3cb615f', message: 'feat: unified chat+preview builder', refs: [], parents: ['cece7da'] }),
    dag({ hash: 'cece7da', message: 'feat: add placeholder pages', refs: [], parents: ['4ab3c3a'] }),
    dag({ hash: '4ab3c3a', message: 'fix: remove footer flame effect', refs: [], parents: ['5016e6f'] }),
    dag({ hash: '5016e6f', message: 'init: Hatable', refs: [], parents: [] }),
  ]

  const g = resolveCommitGraph(commits, 'add-funny-stuff', ['add-funny-stuff', 'move-to-convex'])
  const layout = computeDagLayout(g.commits, g.baseBranch)

  test('base branch (add-funny-stuff) commits on col 0', () => {
    const merge = layout.nodes.find(n => n.commit.hash === '5343284')!
    const c1 = layout.nodes.find(n => n.commit.hash === '0e3335b')!
    const root = layout.nodes.find(n => n.commit.hash === '5016e6f')!
    expect(merge.column).toBe(0)
    expect(c1.column).toBe(0)
    expect(root.column).toBe(0)
  })

  test('move-to-convex commit on col > 0 or synthetic', () => {
    const mtc = layout.nodes.find(n => n.commit.hash === 'bc87769')!
    // Either on a side column or rendered as synthetic branch dot on col 0
    const onSideCol = mtc.column > 0
    const isSynthetic = mtc.syntheticBranch !== undefined
    expect(onSideCol || isSynthetic).toBe(true)
  })

  test('no commit uses col > 1 (no zigzag)', () => {
    const maxCol = Math.max(...layout.nodes.map(n => n.column))
    expect(maxCol <= 1).toBe(true)
  })

})

describe('real-world: worktree branch as baseBranch with shared main ref — no zigzag', () => {
  // Same repo but baseBranch='main' (the app's defaultBaseBranch).
  // main and add-funny-stuff both point at 5343284 (merge commit).
  // main has no unique commits — it's just a ref on the merge.
  // All commits should still render on col 0, not zigzag between 1 and 2.
  const commits: DagCommit[] = [
    dag({ hash: '5343284', message: "Merge branch 'move-to-convex'", refs: ['HEAD -> refs/heads/add-funny-stuff', 'refs/heads/main'], parents: ['0e3335b', 'bc87769'] }),
    dag({ hash: 'bc87769', message: 'migrate from Supabase to Convex', refs: ['refs/heads/move-to-convex'], parents: ['0e3335b'] }),
    dag({ hash: '0e3335b', message: 'switch to non-streaming Haiku 4.5', refs: [], parents: ['3cb615f'] }),
    dag({ hash: '3cb615f', message: 'feat: unified chat+preview builder', refs: [], parents: ['cece7da'] }),
    dag({ hash: 'cece7da', message: 'feat: add placeholder pages', refs: [], parents: ['4ab3c3a'] }),
    dag({ hash: '4ab3c3a', message: 'fix: remove footer flame effect', refs: [], parents: ['5016e6f'] }),
    dag({ hash: '5016e6f', message: 'init: Hatable', refs: [], parents: [] }),
  ]

  const g = resolveCommitGraph(commits, 'main', ['main', 'add-funny-stuff', 'move-to-convex'])
  const layout = computeDagLayout(g.commits, g.baseBranch)

  test('all base branch commits on col 0', () => {
    const merge = layout.nodes.find(n => n.commit.hash === '5343284')!
    const c1 = layout.nodes.find(n => n.commit.hash === '0e3335b')!
    const root = layout.nodes.find(n => n.commit.hash === '5016e6f')!
    expect(merge.column).toBe(0)
    expect(c1.column).toBe(0)
    expect(root.column).toBe(0)
  })

  test('no commit uses col > 1', () => {
    const maxCol = Math.max(...layout.nodes.map(n => n.column))
    expect(maxCol <= 1).toBe(true)
  })

  test('cross-column edge from merge to move-to-convex uses move-to-convex color', () => {
    const mergeNode = layout.nodes.find(n => n.commit.hash === '5343284')!
    const mtcNode = layout.nodes.find(n => n.commit.hash === 'bc87769')!
    const crossEdge = layout.edges.find(e =>
      e.fromRow === mergeNode.row && e.toRow === mtcNode.row &&
      e.fromCol !== e.toCol
    )
    expect(crossEdge !== undefined).toBe(true)
    // Edge color should match target branch (move-to-convex), not source (main)
    const mainColor = layout.edges.find(e => e.fromCol === 0 && e.toCol === 0)?.color
    expect(crossEdge!.color !== mainColor).toBe(true)
  })
})

// ─── Cross-column edge color uses target branch ─────────────────

describe('computeDagLayout — cross-column edge color matches target branch', () => {
  const base = makeHash(), m1 = makeHash(), f1 = makeHash()

  const commits: ResolvedCommit[] = [
    resolved({ hash: m1, message: 'merge', branch: 'main', parents: [base, f1], branchRefs: ['main'], isBranchTip: true, isHead: true }),
    resolved({ hash: f1, message: 'feature work', branch: 'feature', parents: [base], branchRefs: ['feature'], isBranchTip: true }),
    resolved({ hash: base, message: 'shared', branch: 'main', parents: [] }),
  ]

  const layout = computeDagLayout(commits, 'main')

  test('same-column edge uses source branch color', () => {
    const straightEdge = layout.edges.find(e => e.fromCol === e.toCol)
    expect(straightEdge !== undefined).toBe(true)
    // main color (base branch = white #e2e2e2)
    expect(straightEdge!.color).toBe('#e2e2e2')
  })

  test('cross-column edge uses target branch color, not source', () => {
    const crossEdge = layout.edges.find(e => e.fromCol !== e.toCol)
    expect(crossEdge !== undefined).toBe(true)
    // Should NOT be main's white color
    expect(crossEdge!.color).toBe(crossEdge!.color) // exists
    expect(crossEdge!.color !== '#e2e2e2').toBe(true)
  })
})

// ─── Summary ───────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
