/**
 * The copy dialog's selection over a LAZY tree: the selection is a set of roots
 * (a file, or a directory = its whole subtree) each with its file count, so any
 * loaded row's checkbox state and counts follow from the roots alone — no whole
 * tree on the client. Same states as before: a root or anything under one is
 * checked; a directory with roots below it is indeterminate, or checked once they
 * cover all of its files.
 */
import { expect, test } from 'vitest'
import type { IgnoredEntry } from '../shared/types'
import {
  ancestorRootOf,
  chainDirs,
  indexSelection,
  removeSubtree,
  selectedCountOf,
  stateOf,
  toggleSelection
} from './CopyFilesDialog.utils'

const f = (path: string): IgnoredEntry => ({
  name: path.split('/').pop()!,
  path,
  isDirectory: false,
  size: 0,
  fileCount: 1
})
const d = (path: string, fileCount: number): IgnoredEntry => ({
  name: path.split('/').pop()!,
  path,
  isDirectory: true,
  size: 0,
  fileCount
})
const sel = (...roots: Array<[string, number]>) => new Map(roots)

// Tree:  docs/ (a.md, b.md)   a/ (b/ (x, y))   .env
const DOCS = d('docs', 2)
const A = d('a', 2)
const AB = d('a/b', 2)
const CHILDREN: Record<string, IgnoredEntry[]> = {
  '': [DOCS, A, f('.env')],
  docs: [f('docs/a.md'), f('docs/b.md')],
  a: [AB],
  'a/b': [f('a/b/x'), f('a/b/y')]
}
const childrenOf = (dir: string) => CHILDREN[dir] ?? []

test('a root selects its whole subtree', () => {
  const idx = indexSelection(sel(['docs', 2]))
  expect(stateOf(idx, DOCS)).toBe('checked')
  expect(stateOf(idx, f('docs/a.md'))).toBe('checked')
  expect(selectedCountOf(idx, DOCS)).toBe(2)
  expect(idx.total).toBe(2)
})

test('roots below a directory make it indeterminate, with their count', () => {
  const idx = indexSelection(sel(['docs/a.md', 1]))
  expect(stateOf(idx, DOCS)).toBe('indeterminate')
  expect(stateOf(idx, f('docs/a.md'))).toBe('checked')
  expect(stateOf(idx, f('docs/b.md'))).toBe('unchecked')
  expect(selectedCountOf(idx, DOCS)).toBe(1)
  expect(idx.total).toBe(1)
})

test('roots covering all of a directory’s files check it', () => {
  const idx = indexSelection(sel(['docs/a.md', 1], ['docs/b.md', 1]))
  expect(stateOf(idx, DOCS)).toBe('checked')
})

test('an empty selection: all unchecked, total 0', () => {
  const idx = indexSelection(sel())
  expect(stateOf(idx, DOCS)).toBe('unchecked')
  expect(idx.total).toBe(0)
})

test('indeterminate propagates up through nested directories', () => {
  const idx = indexSelection(sel(['a/b/x', 1]))
  expect(stateOf(idx, AB)).toBe('indeterminate')
  expect(stateOf(idx, A)).toBe('indeterminate')
  expect(selectedCountOf(idx, A)).toBe(1)
})

test('a prefix sibling is never counted under a directory (`a` vs `a-b`)', () => {
  const idx = indexSelection(sel(['a-b/z', 1], ['ab', 1]))
  expect(stateOf(idx, A)).toBe('unchecked')
  expect(selectedCountOf(idx, A)).toBe(0)
})

test('ancestorRootOf finds the root holding a path (itself or an ancestor)', () => {
  const s = sel(['a', 2])
  expect(ancestorRootOf(s, 'a/b/x')).toBe('a')
  expect(ancestorRootOf(s, 'a')).toBe('a')
  expect(ancestorRootOf(s, 'docs')).toBeNull()
})

test('chainDirs: the directories from a root down to the target’s parent', () => {
  expect(chainDirs('a', 'a/b/x')).toEqual(['a', 'a/b'])
  expect(chainDirs('a/b', 'a/b/x')).toEqual(['a/b'])
})

test('removeSubtree removes a path and every root below it, nothing else', () => {
  const s = sel(['docs', 2], ['docs/a.md', 1], ['docs/sub/z', 1], ['docs-x', 1], ['other', 1])
  removeSubtree(s, 'docs')
  expect([...s.keys()].sort()).toEqual(['docs-x', 'other'])
})

test('checking an unchecked or indeterminate row makes it the one root of its subtree', () => {
  const next = toggleSelection(sel(['docs/a.md', 1]), DOCS, 'indeterminate', childrenOf)
  expect([...next]).toEqual([['docs', 2]])
  expect([...toggleSelection(sel(), f('.env'), 'unchecked', childrenOf)]).toEqual([['.env', 1]])
})

test('unchecking inside a selected directory keeps every sibling along the way', () => {
  const next = toggleSelection(sel(['a', 2]), f('a/b/x'), 'checked', childrenOf)
  expect([...next].sort()).toEqual([['a/b/y', 1]])
  // Other roots are untouched.
  const other = toggleSelection(
    sel(['docs', 2], ['.env', 1]),
    f('docs/a.md'),
    'checked',
    childrenOf
  )
  expect([...other].sort()).toEqual([
    ['.env', 1],
    ['docs/b.md', 1]
  ])
})

test('unchecking a root removes it and its subtree', () => {
  expect([...toggleSelection(sel(['docs', 2], ['.env', 1]), DOCS, 'checked', childrenOf)]).toEqual([
    ['.env', 1]
  ])
})

test('unchecking a directory checked only by covering roots removes them', () => {
  const s = sel(['docs/a.md', 1], ['docs/b.md', 1])
  expect([...toggleSelection(s, DOCS, 'checked', childrenOf)]).toEqual([])
})
