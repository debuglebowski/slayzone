/**
 * Tests for resolveRepoPath
 * Run with: npx tsx packages/domains/projects/src/shared/resolve-repo.test.ts
 */
import { resolveRepoPath } from './resolve-repo'

let passed = 0
let failed = 0

function assert(condition: boolean, msg: string) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`) }
  else { failed++; console.error(`  ❌ ${msg}`) }
}

console.log('resolveRepoPath:')

// No detected repos → single-repo mode
const r1 = resolveRepoPath('/code/myproject', [], null)
assert(r1.path === '/code/myproject', 'no child repos → returns projectPath')
assert(!r1.stale, 'no child repos → not stale')

// repoName matches a detected repo
const repos = [
  { name: 'browser-manage', path: '/code/sandbox/browser-manage' },
  { name: 'memory-system', path: '/code/sandbox/memory-system' },
]
const r2 = resolveRepoPath('/code/sandbox', repos, 'memory-system')
assert(r2.path === '/code/sandbox/memory-system', 'repoName match → returns matched repo path')
assert(!r2.stale, 'repoName match → not stale')

// repoName set but no match (stale)
const r3 = resolveRepoPath('/code/sandbox', repos, 'deleted-repo')
assert(r3.path === '/code/sandbox/browser-manage', 'stale repoName → falls back to first repo')
assert(r3.stale, 'stale repoName → flagged stale')

// BUG FIX: repoName null with child repos → should return projectPath, NOT first child repo
const r4 = resolveRepoPath('/code/sandbox', repos, null)
assert(r4.path === '/code/sandbox', 'repoName null + child repos → returns projectPath (not first child)')
assert(!r4.stale, 'repoName null + child repos → not stale')

// Edge: projectPath null
const r5 = resolveRepoPath(null, [], null)
assert(r5.path === null, 'null projectPath, no repos → returns null')

const r6 = resolveRepoPath(null, repos, null)
assert(r6.path === null, 'null projectPath, child repos, no repoName → returns null')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
