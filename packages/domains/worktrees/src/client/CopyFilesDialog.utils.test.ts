/**
 * Tests for CopyFilesDialog.utils.ts
 * Run with: npx tsx packages/domains/worktrees/src/client/CopyFilesDialog.utils.test.ts
 */
import type { IgnoredFileNode } from '../shared/types'
import {
  filterTreeByGlobs,
  computeStates,
  findChain,
  removeSubtree,
  globToRegex,
} from './CopyFilesDialog.utils'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`✗ ${name}`)
    console.error(`  ${e instanceof Error ? e.stack ?? e.message : e}`)
    failed++
  }
}

function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    },
    toEqual(expected: unknown) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
      }
    },
  }
}

function file(name: string, parent: string, size = 10): IgnoredFileNode {
  return { name, path: parent ? `${parent}/${name}` : name, isDirectory: false, size, fileCount: 1, children: [] }
}
function dir(name: string, parent: string, children: IgnoredFileNode[]): IgnoredFileNode {
  const fileCount = children.reduce((acc, c) => acc + c.fileCount, 0)
  return { name, path: parent ? `${parent}/${name}` : name, isDirectory: true, size: 0, fileCount, children }
}
function sortedSet(s: Set<string>): string[] {
  return [...s].sort()
}

// --- globToRegex -----------------------------------------------------------

test('globToRegex — literal matches', () => {
  expect(globToRegex('.env').test('.env')).toBe(true)
  expect(globToRegex('.env').test('.env.local')).toBe(false)
})

test('globToRegex — single-star matches non-slash', () => {
  expect(globToRegex('.env*').test('.env')).toBe(true)
  expect(globToRegex('.env*').test('.env.local')).toBe(true)
  expect(globToRegex('*.md').test('README.md')).toBe(true)
  expect(globToRegex('*.md').test('docs/README.md')).toBe(false)
})

test('globToRegex — double-star matches across slashes', () => {
  expect(globToRegex('docs/**').test('docs/a/b')).toBe(true)
})

// --- filterTreeByGlobs -----------------------------------------------------

test('filterTreeByGlobs — empty globs returns top-level paths', () => {
  const tree = [dir('docs', '', [file('a.md', 'docs')]), file('.env', '')]
  expect(sortedSet(filterTreeByGlobs(tree, []))).toEqual(['.env', 'docs'])
})

test('filterTreeByGlobs — basename glob matches at any depth', () => {
  const tree = [
    file('.env', ''),
    dir('apps', '', [
      dir('web', 'apps', [file('.env', 'apps/web')]),
    ]),
  ]
  expect(sortedSet(filterTreeByGlobs(tree, ['.env*']))).toEqual(['.env', 'apps/web/.env'])
})

test('filterTreeByGlobs — dir glob matches top-level only', () => {
  const tree = [
    dir('docs', '', [file('a.md', 'docs')]),
    dir('apps', '', [dir('docs', 'apps', [file('b.md', 'apps/docs')])]),
  ]
  expect(sortedSet(filterTreeByGlobs(tree, ['docs/**']))).toEqual(['docs'])
})

test('filterTreeByGlobs — invariant: ancestor selection collapses descendant basename matches', () => {
  // Regression: previously {docs, docs/.env} both ended up in selected.
  const tree = [
    dir('docs', '', [file('.env', 'docs'), file('README.md', 'docs')]),
    file('.env', ''),
  ]
  expect(sortedSet(filterTreeByGlobs(tree, ['docs/**', '.env*', '*.md']))).toEqual(['.env', 'docs'])
})

test('filterTreeByGlobs — basename matches when no ancestor matched', () => {
  const tree = [
    dir('apps', '', [file('.env', 'apps'), file('readme.md', 'apps')]),
    file('.env', ''),
  ]
  expect(sortedSet(filterTreeByGlobs(tree, ['docs/**', '.env*']))).toEqual(['.env', 'apps/.env'])
})

// --- computeStates ---------------------------------------------------------

test('computeStates — ancestor selected propagates to descendants', () => {
  const tree = [dir('docs', '', [file('a.md', 'docs'), file('b.md', 'docs')])]
  const { states, selectedFileCount } = computeStates(tree, new Set(['docs']))
  expect(states.get('docs')).toBe('checked')
  expect(states.get('docs/a.md')).toBe('checked')
  expect(states.get('docs/b.md')).toBe('checked')
  expect(selectedFileCount).toBe(2)
})

test('computeStates — partial child selection → parent indeterminate', () => {
  const tree = [dir('docs', '', [file('a.md', 'docs'), file('b.md', 'docs')])]
  const { states, selectedCounts, selectedFileCount } = computeStates(tree, new Set(['docs/a.md']))
  expect(states.get('docs')).toBe('indeterminate')
  expect(states.get('docs/a.md')).toBe('checked')
  expect(states.get('docs/b.md')).toBe('unchecked')
  expect(selectedCounts.get('docs')).toBe(1)
  expect(selectedFileCount).toBe(1)
})

test('computeStates — all children checked individually → parent checked', () => {
  const tree = [dir('docs', '', [file('a.md', 'docs'), file('b.md', 'docs')])]
  const { states } = computeStates(tree, new Set(['docs/a.md', 'docs/b.md']))
  expect(states.get('docs')).toBe('checked')
})

test('computeStates — empty selection → all unchecked, count 0', () => {
  const tree = [dir('docs', '', [file('a.md', 'docs')])]
  const { states, selectedFileCount } = computeStates(tree, new Set())
  expect(states.get('docs')).toBe('unchecked')
  expect(selectedFileCount).toBe(0)
})

test('computeStates — mixed indeterminate child propagates upward', () => {
  const tree = [
    dir('a', '', [
      dir('b', 'a', [file('x', 'a/b'), file('y', 'a/b')]),
    ]),
  ]
  const { states } = computeStates(tree, new Set(['a/b/x']))
  expect(states.get('a/b')).toBe('indeterminate')
  expect(states.get('a')).toBe('indeterminate')
})

// --- findChain -------------------------------------------------------------

test('findChain — top-level node returns single-element chain', () => {
  const tree = [dir('docs', '', [file('a.md', 'docs')])]
  const chain = findChain(tree, 'docs')
  expect(chain?.length).toBe(1)
  expect(chain?.[0].path).toBe('docs')
})

test('findChain — nested target returns full chain', () => {
  const tree = [dir('a', '', [dir('b', 'a', [file('c', 'a/b')])])]
  const chain = findChain(tree, 'a/b/c')
  expect(chain?.map(n => n.path).join(',')).toBe('a,a/b,a/b/c')
})

test('findChain — missing target returns null', () => {
  const tree = [file('.env', '')]
  expect(findChain(tree, 'nope')).toBe(null)
})

// --- removeSubtree ---------------------------------------------------------

test('removeSubtree — removes node and all descendants from set', () => {
  const docs = dir('docs', '', [file('a.md', 'docs'), dir('sub', 'docs', [file('z', 'docs/sub')])])
  const set = new Set(['docs', 'docs/a.md', 'docs/sub', 'docs/sub/z', 'other'])
  removeSubtree(docs, set)
  expect(sortedSet(set)).toEqual(['other'])
})

// --- summary ---------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
