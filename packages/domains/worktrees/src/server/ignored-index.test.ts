/**
 * The ignored-file index behind the copy dialog: built once from the flat list of
 * ignored files, it answers any directory's children (with exact descendant file
 * counts) and the presets' glob selection in bounded pages, so a repo with a huge
 * `node_modules` never sends one giant tree.
 *
 * Its answers equal what the dialog derived from the whole tree before: the same
 * children in the same order (dirs first, then by name), the same counts, the same
 * preset selection (basename globs at any depth, `dir/**` on top-level dirs).
 */
import { describe, expect, it } from 'vitest'
import { PAGE_MAX_BYTES, collectPages, jsonByteLength } from '@slayzone/platform/bounded-reads'
import type { IgnoredFileNode } from '../shared/types'
import { globToRegex } from '../shared/ignored-tree'
import { IGNORED_TREE_PAGE_ITEMS, IgnoredIndex, ignoredIndexFromTree } from './ignored-index'

const PATHS = [
  '.env',
  '.env.local',
  'cache.bin',
  'docs/a.md',
  'docs/b.md',
  'docs/deep/c.md',
  'dir-x/z.md',
  'node_modules/a/index.js',
  'node_modules/a/package.json',
  'node_modules/b/.env',
  'packages/p/.env.local',
  'packages/p/dist/out.js',
  'notes.local'
]
const SIZES = new Map([
  ['.env', 10],
  ['.env.local', 20],
  ['cache.bin', 30],
  ['notes.local', 40]
])

const idx = () => IgnoredIndex.build(PATHS, SIZES)
const names = (dir: string) =>
  idx()
    .children(dir)
    .map((e) => e.name)

describe('children', () => {
  it('lists one level, dirs first then by name, with exact file counts', () => {
    expect(idx().children('')).toEqual([
      { name: 'dir-x', path: 'dir-x', isDirectory: true, size: 0, fileCount: 1 },
      { name: 'docs', path: 'docs', isDirectory: true, size: 0, fileCount: 3 },
      { name: 'node_modules', path: 'node_modules', isDirectory: true, size: 0, fileCount: 3 },
      { name: 'packages', path: 'packages', isDirectory: true, size: 0, fileCount: 2 },
      { name: '.env', path: '.env', isDirectory: false, size: 10, fileCount: 1 },
      { name: '.env.local', path: '.env.local', isDirectory: false, size: 20, fileCount: 1 },
      { name: 'cache.bin', path: 'cache.bin', isDirectory: false, size: 30, fileCount: 1 },
      { name: 'notes.local', path: 'notes.local', isDirectory: false, size: 40, fileCount: 1 }
    ])
    expect(names('docs')).toEqual(['deep', 'a.md', 'b.md'])
    expect(idx().children('docs')[0]).toMatchObject({ path: 'docs/deep', fileCount: 1 })
    expect(names('node_modules/a')).toEqual(['index.js', 'package.json'])
  })

  it('a prefix sibling (`dir-x` vs `dir/`) never leaks into a range', () => {
    const i = IgnoredIndex.build(['dir/a', 'dir-x/b', 'dir.y', 'dir/sub/c', 'dirz'])
    expect(i.children('dir').map((e) => e.path)).toEqual(['dir/sub', 'dir/a'])
    expect(i.fileCount('dir')).toBe(2)
    expect(i.fileCount('dir-x')).toBe(1)
  })

  it('takes input in any order; totals and an unknown dir', () => {
    const shuffled = IgnoredIndex.build([...PATHS].reverse(), SIZES)
    expect(shuffled.children('')).toEqual(idx().children(''))
    expect(idx().totalFiles).toBe(PATHS.length)
    expect(idx().children('nope')).toEqual([])
    expect(idx().fileCount('nope')).toBe(0)
  })
})

describe('pages', () => {
  it('pages a wide directory; the pages concatenate to all children', async () => {
    const wide = Array.from({ length: IGNORED_TREE_PAGE_ITEMS * 2 + 7 }, (_, n) => `w/f${n}`)
    const i = IgnoredIndex.build(wide)
    const first = i.page('w', null)
    expect(first.items.length).toBe(IGNORED_TREE_PAGE_ITEMS)
    expect(first.nextCursor).not.toBeNull()
    const all = await collectPages(async (cursor) => i.page('w', cursor))
    expect(all).toEqual(i.children('w'))
  })

  it('every page fits the byte budget (long names)', () => {
    const long = Array.from({ length: 3000 }, (_, n) => `l/${'x'.repeat(4000)}${n}`)
    const i = IgnoredIndex.build(long)
    for (let cursor: string | null = null, guard = 0; guard < 100; guard++) {
      const page = i.page('l', cursor)
      expect(jsonByteLength(page)).toBeLessThan(PAGE_MAX_BYTES + 8192)
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
  })

  it('refuses a malformed cursor', () => {
    expect(() => idx().page('', 'x')).toThrow(/cursor/)
  })
})

describe('preset match (same rules as the dialog had)', () => {
  const match = (globs: string[]) =>
    idx()
      .match(globs)
      .map((m) => m.path)
      .sort()

  it('no globs = every top-level entry', () => {
    expect(match([])).toEqual(
      idx()
        .children('')
        .map((e) => e.path)
        .sort()
    )
  })

  it('basename globs match files at any depth (also inside node_modules)', () => {
    expect(match(['.env*'])).toEqual(
      ['.env', '.env.local', 'node_modules/b/.env', 'packages/p/.env.local'].sort()
    )
    expect(match(['*.local'])).toEqual(['.env.local', 'notes.local', 'packages/p/.env.local'])
  })

  it('a `dir/**` glob selects the top-level dir by its first segment, never a nested one', () => {
    expect(match(['docs/**'])).toEqual(['docs'])
    expect(match(['dist/**'])).toEqual([])
  })

  it('no ancestor + descendant pair: inside a matched dir, basename matches collapse', () => {
    const m = match(['docs/**', '*.md', '.env*'])
    expect(m).toContain('docs')
    expect(m).not.toContain('docs/a.md')
    expect(m).toContain('dir-x/z.md')
  })

  it('carries each root its file count', () => {
    const m = idx().match(['docs/**', '.env'])
    expect(m.find((x) => x.path === 'docs')).toEqual({
      path: 'docs',
      isDirectory: true,
      fileCount: 3
    })
    expect(m.find((x) => x.path === '.env')).toEqual({
      path: '.env',
      isDirectory: false,
      fileCount: 1
    })
  })

  it('a `dir/**` glob never selects a nested directory of that name', () => {
    const i = IgnoredIndex.build(['docs/a.md', 'apps/docs/b.md'])
    expect(i.match(['docs/**']).map((m) => m.path)).toEqual(['docs'])
  })

  it('basename matches still apply where no ancestor matched', () => {
    const i = IgnoredIndex.build(['apps/.env', 'apps/readme.md', '.env'])
    expect(
      i
        .match(['docs/**', '.env*'])
        .map((m) => m.path)
        .sort()
    ).toEqual(['.env', 'apps/.env'])
  })

  it('pages the selection', async () => {
    const many = Array.from({ length: 2500 }, (_, n) => `d${n}/.env`)
    const i = IgnoredIndex.build(many)
    const all = await collectPages(async (cursor) => i.matchPage(['.env'], cursor))
    expect(all.length).toBe(2500)
    expect(i.matchPage(['.env'], null).nextCursor).not.toBeNull()
  })
})

describe('built from an older computer’s whole tree (hub fallback)', () => {
  const file = (path: string, size = 0): IgnoredFileNode => ({
    name: path.split('/').pop()!,
    path,
    isDirectory: false,
    size,
    fileCount: 1,
    children: []
  })
  const tree: IgnoredFileNode[] = [
    {
      name: 'docs',
      path: 'docs',
      isDirectory: true,
      size: 0,
      fileCount: 2,
      children: [file('docs/a.md'), file('docs/b.md')]
    },
    file('.env', 12)
  ]

  it('answers the same as an index of the same files, root sizes kept', () => {
    const i = ignoredIndexFromTree(tree)
    expect(i.totalFiles).toBe(3)
    expect(i.children('')).toEqual([
      { name: 'docs', path: 'docs', isDirectory: true, size: 0, fileCount: 2 },
      { name: '.env', path: '.env', isDirectory: false, size: 12, fileCount: 1 }
    ])
    expect(i.children('docs').map((e) => e.path)).toEqual(['docs/a.md', 'docs/b.md'])
  })
})

describe('globToRegex (the presets’ glob syntax)', () => {
  it('literal, single-star within a segment, double-star across segments', () => {
    expect(globToRegex('.env').test('.env')).toBe(true)
    expect(globToRegex('.env').test('.env.local')).toBe(false)
    expect(globToRegex('.env*').test('.env.local')).toBe(true)
    expect(globToRegex('*.md').test('README.md')).toBe(true)
    expect(globToRegex('*.md').test('docs/README.md')).toBe(false)
    expect(globToRegex('docs/**').test('docs/a/b')).toBe(true)
  })
})
