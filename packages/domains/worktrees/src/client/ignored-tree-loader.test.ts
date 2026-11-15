/**
 * The copy dialog's lazy tree on the client: it opens an index, loads a directory's
 * children page by page on demand, can load ALL of a directory (an uncheck inside a
 * selected folder, "Select all"), runs a preset's match over all its pages, and —
 * when the index expired on its host — reopens once and carries on.
 */
import { describe, expect, it } from 'vitest'
import type { Page } from '@slayzone/platform/bounded-reads'
import { IGNORED_TREE_EXPIRED } from '../shared/ignored-tree'
import type { IgnoredEntry, IgnoredMatch, IgnoredTreeOpen } from '../shared/types'
import { IgnoredIndex, IGNORED_TREE_PAGE_ITEMS } from '../server/ignored-index'
import { IgnoredTreeLoader, type IgnoredTreeSource } from './ignored-tree-loader'

const PATHS = [
  '.env',
  'docs/a.md',
  'docs/b.md',
  ...Array.from({ length: IGNORED_TREE_PAGE_ITEMS + 5 }, (_, n) => `node_modules/p${n}/i.js`)
]

/** A host holding indexes by id, like the computer's store; `expire()` drops them all. */
function host() {
  const held = new Map<string, IgnoredIndex>()
  let n = 0
  const calls: string[] = []
  const get = (id: string) => {
    const i = held.get(id)
    if (!i) throw new Error(`${IGNORED_TREE_EXPIRED}: gone`)
    return i
  }
  const source: IgnoredTreeSource = {
    async open(): Promise<IgnoredTreeOpen> {
      calls.push('open')
      const index = IgnoredIndex.build([...PATHS])
      const treeId = `t${++n}`
      held.set(treeId, index)
      return { treeId, totalFiles: index.totalFiles, root: index.page('', null) }
    },
    async list(treeId, dir, cursor): Promise<Page<IgnoredEntry>> {
      calls.push(`list ${dir} ${cursor}`)
      return get(treeId).page(dir, cursor)
    },
    async match(treeId, globs, cursor): Promise<Page<IgnoredMatch>> {
      calls.push(`match ${cursor}`)
      return get(treeId).matchPage(globs, cursor)
    }
  }
  return { source, calls, expire: () => held.clear() }
}

describe('IgnoredTreeLoader', () => {
  it('opens with the root page and the total', async () => {
    const h = host()
    const loader = new IgnoredTreeLoader(h.source)
    expect(loader.getSnapshot().status).toBe('loading')
    await loader.start()
    const snap = loader.getSnapshot()
    expect(snap.status).toBe('ready')
    expect(snap.totalFiles).toBe(PATHS.length)
    expect(snap.dirs.get('')?.items.map((e) => e.path)).toEqual(['docs', 'node_modules', '.env'])
  })

  it('loads a directory page by page; loadAll completes it; subscribers hear each change', async () => {
    const h = host()
    const loader = new IgnoredTreeLoader(h.source)
    let heard = 0
    loader.subscribe(() => heard++)
    await loader.start()
    await loader.loadMore('node_modules')
    let nm = loader.getSnapshot().dirs.get('node_modules')!
    expect(nm.items.length).toBe(IGNORED_TREE_PAGE_ITEMS)
    expect(nm.nextCursor).not.toBeNull()
    expect(loader.isComplete('node_modules')).toBe(false)
    const all = await loader.loadAll('node_modules')
    expect(all.length).toBe(IGNORED_TREE_PAGE_ITEMS + 5)
    nm = loader.getSnapshot().dirs.get('node_modules')!
    expect(nm.nextCursor).toBeNull()
    expect(loader.isComplete('node_modules')).toBe(true)
    expect(heard).toBeGreaterThan(2)
  })

  it('concurrent loads of one directory share one request', async () => {
    const h = host()
    const loader = new IgnoredTreeLoader(h.source)
    await loader.start()
    await Promise.all([loader.loadMore('docs'), loader.loadMore('docs')])
    expect(h.calls.filter((c) => c.startsWith('list docs')).length).toBe(1)
  })

  it('match collects every page of a preset', async () => {
    const h = host()
    const loader = new IgnoredTreeLoader(h.source)
    await loader.start()
    const m = await loader.match(['*.js'])
    expect(m.length).toBe(IGNORED_TREE_PAGE_ITEMS + 5)
  })

  it('an expired index is reopened once, and the load carries on', async () => {
    const h = host()
    const loader = new IgnoredTreeLoader(h.source)
    await loader.start()
    h.expire()
    await loader.loadMore('docs')
    expect(
      loader
        .getSnapshot()
        .dirs.get('docs')
        ?.items.map((e) => e.path)
    ).toEqual(['docs/a.md', 'docs/b.md'])
    expect(h.calls.filter((c) => c === 'open').length).toBe(2)
    h.expire()
    expect((await loader.match(['.env'])).map((m) => m.path)).toEqual(['.env'])
  })

  it('a failed open is an error state; a failed page marks the directory failed', async () => {
    const bad = new IgnoredTreeLoader({
      open: async () => {
        throw new Error('not a repo')
      },
      list: async () => ({ items: [], nextCursor: null }),
      match: async () => ({ items: [], nextCursor: null })
    })
    await bad.start()
    expect(bad.getSnapshot().status).toBe('error')

    const h = host()
    const loader = new IgnoredTreeLoader({
      ...h.source,
      list: async () => {
        throw new Error('computer offline')
      }
    })
    await loader.start()
    await loader.loadMore('docs')
    expect(loader.getSnapshot().dirs.get('docs')).toMatchObject({ failed: true, loading: false })
  })

  it('a disposed loader ignores late answers', async () => {
    const h = host()
    const loader = new IgnoredTreeLoader(h.source)
    const started = loader.start()
    loader.dispose()
    await started
    expect(loader.getSnapshot().status).toBe('loading')
  })
})
