/**
 * The git panel's per-file patches that a paged snapshot left out (FU1 S5), client
 * side. The loader fetches them in budgeted batches, reads a file that is over the
 * budget by its first page only (the rest on "Load rest of diff"), refetches when
 * the snapshot's fingerprint says a deferred file changed, and keeps the untracked
 * files' eager preview (now in batches too; an older computer's whole record still
 * works).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  GIT_TEXT_EXPIRED,
  type GitFileDiffsPage,
  type GitTextPage,
  type GitTextSource
} from '../shared/git-text'
import type { GitDiffSnapshot } from '../shared/types'
import { DiffTextLoader, type DiffTextSource } from './diff-text-loader'

const patch = (path: string, body = 'x') =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${body}\n+${body}!\n`

const snap = (over: Partial<GitDiffSnapshot>): GitDiffSnapshot => ({
  targetPath: '/r',
  files: [],
  stagedFiles: [],
  unstagedFiles: [],
  untrackedFiles: [],
  unstagedPatch: '',
  stagedPatch: '',
  generatedAt: '',
  isGitRepo: true,
  ...over
})

/** A fake computer: batches of `batch` files; `big.txt` is large (3 pages). */
function source(opts: { batch?: number; untrackedWhole?: boolean } = {}) {
  const calls: string[] = []
  let version = 'v1'
  const bigPages = ['diff --git a/big.txt b/big.txt\n', '+line 1\n', '+line 2\n']
  const expired = new Set<string>()
  const s: DiffTextSource = {
    async filesPage(kind, filePaths, fromPaths): Promise<GitFileDiffsPage> {
      calls.push(
        `page ${kind} ${filePaths.join(',')}${fromPaths?.some(Boolean) ? ` from ${fromPaths.join(',')}` : ''}`
      )
      const n = opts.batch ?? 100
      const page: GitFileDiffsPage = { diffs: {}, deferred: [], large: [] }
      for (const f of filePaths) {
        if (f === 'big.txt') page.large.push(f)
        else if (Object.keys(page.diffs).length < n) page.diffs[f] = patch(f, version)
        else page.deferred.push(f)
      }
      return page
    },
    async untrackedPage(filePaths) {
      calls.push(`untracked ${filePaths.join(',')}`)
      if (opts.untrackedWhole) return Object.fromEntries(filePaths.map((f) => [f, patch(f)]))
      const page = await s.filesPage('untracked', filePaths)
      calls.pop()
      return { $paged: true as const, ...page }
    },
    async text(src: GitTextSource, cursor): Promise<GitTextPage> {
      calls.push(`text ${src.kind} ${'filePath' in src ? src.filePath : ''} ${cursor}`)
      if (cursor && expired.has(cursor)) throw new Error(`${GIT_TEXT_EXPIRED}: gone`)
      const i = cursor ? Number(cursor) : 0
      return {
        text: bigPages[i],
        cursor: i + 1 < bigPages.length ? String(i + 1) : null,
        totalBytes: bigPages.join('').length
      }
    }
  }
  return {
    s,
    calls,
    setVersion: (v: string) => {
      version = v
    },
    expire: (c: string) => expired.add(c),
    bigWhole: bigPages.join('')
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0))
async function idle(loader: DiffTextLoader) {
  for (let i = 0; i < 50 && loader.busy; i++) await settle()
  await settle()
}

describe('DiffTextLoader', () => {
  it.each(
    ['refresh', 'remove', 'untracked-remove', 'untracked-replace'].flatMap((change) =>
      ['success', 'failure'].map((outcome) => ({ change, outcome }))
    )
  )('discards old load-rest $outcome after $change', async ({ change, outcome }) => {
    let finish!: (page: GitTextPage) => void
    let fail!: (err: Error) => void
    const rest = new Promise<GitTextPage>((resolve, reject) => {
      finish = resolve
      fail = reject
    })
    let version = 'OLD'
    const text = vi.fn(async (_src: GitTextSource, cursor: string | null): Promise<GitTextPage> => {
      if (cursor === 'next') return rest
      return { text: version, cursor: cursor === null ? 'next' : null, totalBytes: 100 }
    })
    const loader = new DiffTextLoader(
      {
        filesPage: async () => ({ diffs: {}, deferred: [], large: ['big.txt'] }),
        untrackedPage: async () => ({ $paged: true, diffs: {}, deferred: [], large: ['big.txt'] }),
        text
      },
      { opts: {} }
    )
    const untracked = change.startsWith('untracked-')
    const key = `${untracked ? '?' : 'u'}:big.txt`
    const snapshot = (fingerprint: string) =>
      untracked
        ? snap({ untrackedFiles: ['big.txt'] })
        : snap({ deferred: { unstaged: ['big.txt'], staged: [], renamedFrom: {}, fingerprint } })
    loader.sync(snapshot('f1'))
    await idle(loader)
    const loading = loader.loadRest(key).then(
      () => null,
      (err: Error) => err
    )
    version = 'NEW'
    if (change === 'refresh') loader.sync(snapshot('f2'))
    else {
      loader.sync(snap({}))
      if (change === 'untracked-replace') loader.sync(snapshot('f1'))
    }
    await vi.waitFor(() => {
      if (change === 'refresh' || change === 'untracked-replace')
        expect(loader.getSnapshot().get(key)?.text).toBe('NEW')
      else expect(loader.getSnapshot().has(key)).toBe(false)
    })
    const current = loader.getSnapshot().get(key)
    if (outcome === 'failure') fail(new Error('old read failed'))
    else finish({ text: 'OLD-REST', cursor: 'old-last', totalBytes: 100 })
    expect(await loading).toBeNull()
    expect(loader.getSnapshot().get(key)).toBe(current)
    expect(text.mock.calls.some(([, cursor]) => cursor === 'old-last')).toBe(false)
    loader.dispose()
  })

  it('a current load-rest failure preserves its first page and retry control', async () => {
    const f = source()
    const read = f.s.text
    f.s.text = (src, cursor) =>
      cursor === null ? read(src, cursor) : Promise.reject(new Error('read failed'))
    const loader = new DiffTextLoader(f.s, { opts: {} })
    loader.sync(snap({ untrackedFiles: ['big.txt'] }))
    await idle(loader)
    const first = loader.getSnapshot().get('?:big.txt')!
    await expect(loader.loadRest('?:big.txt')).rejects.toThrow('read failed')
    expect(loader.getSnapshot().get('?:big.txt')).toEqual({
      ...first,
      loading: false,
      failed: true
    })
    loader.dispose()
  })

  it('an unrelated tracked fingerprint change keeps an untracked load-rest current', async () => {
    const f = source()
    const loader = new DiffTextLoader(f.s, { opts: {} })
    loader.sync(snap({ untrackedFiles: ['big.txt'] }))
    await idle(loader)
    const loading = loader.loadRest('?:big.txt')
    loader.sync(
      snap({
        untrackedFiles: ['big.txt'],
        deferred: { unstaged: [], staged: [], renamedFrom: {}, fingerprint: 'new' }
      })
    )
    await loading
    expect(loader.getSnapshot().get('?:big.txt')).toEqual({
      text: f.bigWhole,
      rest: null,
      loading: false,
      failed: false
    })
    loader.dispose()
  })

  it('fetches a paged snapshot’s deferred files in batches until all are in', async () => {
    const f = source({ batch: 2 })
    const loader = new DiffTextLoader(f.s, { opts: { contextLines: '3' } })
    loader.sync(
      snap({
        unstagedFiles: ['a', 'b', 'c'],
        deferred: { unstaged: ['a', 'b', 'c'], staged: [], renamedFrom: {}, fingerprint: 'f1' }
      })
    )
    await idle(loader)
    const t = loader.getSnapshot()
    expect([...t.keys()].sort()).toEqual(['u:a', 'u:b', 'u:c'])
    expect(t.get('u:c')?.text).toBe(patch('c', 'v1'))
    expect(f.calls).toEqual(['page unstaged a,b,c', 'page unstaged c'])
  })

  it('a rename travels with its old path; staged files use the staged side', async () => {
    const f = source()
    const loader = new DiffTextLoader(f.s, { opts: {} })
    loader.sync(
      snap({
        stagedFiles: ['new.txt'],
        deferred: {
          unstaged: [],
          staged: ['new.txt'],
          renamedFrom: { 'new.txt': 'old.txt' },
          fingerprint: 'f'
        }
      })
    )
    await idle(loader)
    expect(f.calls).toEqual(['page staged new.txt from old.txt'])
    expect(loader.getSnapshot().has('s:new.txt')).toBe(true)
  })

  it('a large file shows its first page; loadRest appends every remaining page', async () => {
    const f = source()
    const loader = new DiffTextLoader(f.s, { opts: {} })
    loader.sync(
      snap({
        unstagedFiles: ['big.txt'],
        deferred: { unstaged: ['big.txt'], staged: [], renamedFrom: {}, fingerprint: 'f' }
      })
    )
    await idle(loader)
    const first = loader.getSnapshot().get('u:big.txt')!
    expect(first.text).toBe('diff --git a/big.txt b/big.txt\n')
    expect(first.rest?.remainingBytes).toBe(f.bigWhole.length - first.text.length)
    await loader.loadRest('u:big.txt')
    const all = loader.getSnapshot().get('u:big.txt')!
    expect(all.text).toBe(f.bigWhole)
    expect(all.rest).toBeNull()
  })

  it('an expired cursor reads the text again from its first page', async () => {
    const f = source()
    const loader = new DiffTextLoader(f.s, { opts: {} })
    loader.sync(
      snap({
        unstagedFiles: ['big.txt'],
        deferred: { unstaged: ['big.txt'], staged: [], renamedFrom: {}, fingerprint: 'f' }
      })
    )
    await idle(loader)
    f.expire('1')
    await loader.loadRest('u:big.txt').catch(() => undefined)
    // Read again from the start (first page, then on): a whole text in the end.
    expect(f.calls.filter((c) => c.endsWith(' null')).length).toBe(2)
  })

  it('refetches only the deferred files whose own fingerprint changed, keeping their old text until the new one arrives; drops files no longer deferred', async () => {
    const f = source()
    let hold: Promise<void> | null = null
    const filesPage = f.s.filesPage
    f.s.filesPage = async (...args) => {
      if (hold) await hold
      return filesPage(...args)
    }
    const loader = new DiffTextLoader(f.s, { opts: {} })
    const deferred = (fps: Record<string, string>) =>
      snap({
        unstagedFiles: Object.keys(fps),
        deferred: {
          unstaged: Object.keys(fps),
          staged: [],
          renamedFrom: {},
          fingerprint: JSON.stringify(fps),
          fingerprints: { unstaged: fps, staged: {} }
        }
      })
    loader.sync(deferred({ a: '1', b: '1' }))
    await idle(loader)
    loader.sync(deferred({ a: '1', b: '1' }))
    await idle(loader)
    expect(f.calls).toEqual(['page unstaged a,b'])
    const b = loader.getSnapshot().get('u:b')
    f.setVersion('v2')
    let release!: () => void
    hold = new Promise<void>((resolve) => {
      release = resolve
    })
    loader.sync(deferred({ a: '2', b: '1' }))
    // While `a` is refetched, its old text stays on screen (no "Loading…" flash).
    expect(loader.getSnapshot().get('u:a')?.text).toBe(patch('a', 'v1'))
    release()
    await idle(loader)
    expect(f.calls.at(-1)).toBe('page unstaged a')
    expect(loader.getSnapshot().get('u:a')?.text).toBe(patch('a', 'v2'))
    expect(loader.getSnapshot().get('u:b')).toBe(b)
    loader.sync(deferred({ a: '2' }))
    expect(loader.getSnapshot().has('u:b')).toBe(false)
    loader.sync(snap({ unstagedFiles: ['a'], unstagedPatch: patch('a') }))
    expect(loader.getSnapshot().has('u:a')).toBe(false)
  })

  it('an older computer’s whole-set fingerprint change refetches all, old texts kept until then', async () => {
    const f = source()
    const loader = new DiffTextLoader(f.s, { opts: {} })
    const deferred = (fp: string) =>
      snap({ deferred: { unstaged: ['a', 'b'], staged: [], renamedFrom: {}, fingerprint: fp } })
    loader.sync(deferred('f1'))
    await idle(loader)
    f.setVersion('v2')
    loader.sync(deferred('f2'))
    expect(loader.getSnapshot().get('u:a')?.text).toBe(patch('a', 'v1'))
    await idle(loader)
    expect(f.calls).toEqual(['page unstaged a,b', 'page unstaged a,b'])
    expect(loader.getSnapshot().get('u:b')?.text).toBe(patch('b', 'v2'))
  })

  it('a loaded rest survives another deferred file’s change', async () => {
    const f = source()
    const loader = new DiffTextLoader(f.s, { opts: {} })
    const deferred = (aFp: string) =>
      snap({
        deferred: {
          unstaged: ['a', 'big.txt'],
          staged: [],
          renamedFrom: {},
          fingerprint: aFp,
          fingerprints: { unstaged: { a: aFp, 'big.txt': 'same' }, staged: {} }
        }
      })
    loader.sync(deferred('1'))
    await idle(loader)
    await loader.loadRest('u:big.txt')
    const whole = loader.getSnapshot().get('u:big.txt')
    expect(whole?.text).toBe(f.bigWhole)
    loader.sync(deferred('2'))
    await idle(loader)
    expect(loader.getSnapshot().get('u:big.txt')).toBe(whole)
  })

  it('a failed batch is retried (bounded); then marked failed with a retry, never left loading', async () => {
    const f = source()
    let failures = 1
    const filesPage = f.s.filesPage
    f.s.filesPage = async (...args) => {
      if (failures-- > 0) throw new Error('computer reconnecting')
      return filesPage(...args)
    }
    const deferred = snap({
      deferred: { unstaged: ['a'], staged: [], renamedFrom: {}, fingerprint: 'f' }
    })
    const loader = new DiffTextLoader(f.s, { opts: {} }, { retryDelaysMs: [0, 0] })
    loader.sync(deferred)
    await vi.waitFor(() => expect(loader.getSnapshot().get('u:a')?.text).toBe(patch('a', 'v1')))
    loader.dispose()

    failures = 99
    const failing = new DiffTextLoader(f.s, { opts: {} }, { retryDelaysMs: [0, 0] })
    failing.sync(deferred)
    await vi.waitFor(() =>
      expect(failing.getSnapshot().get('u:a')).toEqual({
        text: '',
        rest: null,
        loading: false,
        failed: true
      })
    )
    await idle(failing)
    expect(failing.busy).toBe(false)
    // A change of its content asks again too (not only the retry control).
    failures = 0
    failing.sync(
      snap({ deferred: { unstaged: ['a'], staged: [], renamedFrom: {}, fingerprint: 'g' } })
    )
    await vi.waitFor(() => expect(failing.getSnapshot().get('u:a')?.text).toBe(patch('a', 'v1')))
    failures = 99
    failing.sync(
      snap({ deferred: { unstaged: ['a'], staged: [], renamedFrom: {}, fingerprint: 'h' } })
    )
    await vi.waitFor(() => expect(failing.getSnapshot().get('u:a')?.failed).toBe(true))
    await idle(failing)
    failures = 0
    failing.retry('u:a')
    await vi.waitFor(() => expect(failing.getSnapshot().get('u:a')?.text).toBe(patch('a', 'v1')))
    failing.dispose()
  })

  it('files that failed past their retries are asked again on their own, without a content change', async () => {
    const f = source()
    let down = true
    const filesPage = f.s.filesPage
    f.s.filesPage = async (...args) => {
      if (down) throw new Error('computer offline')
      return filesPage(...args)
    }
    const untrackedPage = f.s.untrackedPage
    f.s.untrackedPage = async (...args) => {
      if (down) throw new Error('computer offline')
      return untrackedPage(...args)
    }
    const snapshot = () =>
      snap({
        untrackedFiles: ['u.txt'],
        deferred: { unstaged: ['d.txt'], staged: [], renamedFrom: {}, fingerprint: 'f' }
      })
    const loader = new DiffTextLoader(f.s, { opts: {} }, { retryDelaysMs: [0, 0], recoverMs: 30 })
    loader.sync(snapshot())
    await vi.waitFor(() => {
      expect(loader.getSnapshot().get('u:d.txt')?.failed).toBe(true)
      expect(loader.getSnapshot().get('?:u.txt')?.failed).toBe(true)
    })
    // The computer is back; the snapshot is unchanged (an equal one syncs, or none).
    down = false
    loader.sync(snapshot())
    await vi.waitFor(() => {
      expect(loader.getSnapshot().get('u:d.txt')?.text).toBe(patch('d.txt', 'v1'))
      expect(loader.getSnapshot().get('?:u.txt')?.text).toBe(patch('u.txt', 'v1'))
    })
    expect(loader.getSnapshot().get('u:d.txt')?.failed).toBe(false)
    loader.dispose()
  })

  it('retry-all asks for every failed file in batches, not one request per file', async () => {
    // A computer that answers up to 1000 files per page (BATCH_FILES).
    const f = source({ batch: 1000 })
    let down = true
    const pages: string[][] = []
    const filesPage = f.s.filesPage
    f.s.filesPage = async (kind, filePaths, fromPaths) => {
      pages.push(filePaths)
      if (down) throw new Error('computer offline')
      return filesPage(kind, filePaths, fromPaths)
    }
    const files = Array.from({ length: 2500 }, (_, i) => `f${i}.txt`)
    const loader = new DiffTextLoader(f.s, { opts: {} }, { retryDelaysMs: [], recoverMs: 60_000 })
    loader.sync(
      snap({ deferred: { unstaged: files, staged: [], renamedFrom: {}, fingerprint: 'f' } })
    )
    await vi.waitFor(() => expect(loader.getSnapshot().get('u:f2499.txt')?.failed).toBe(true))
    down = false
    pages.length = 0
    loader.retryFailed()
    await vi.waitFor(() => expect(loader.getSnapshot().get('u:f2499.txt')?.failed).toBe(false))
    expect(pages.length).toBeLessThanOrEqual(Math.ceil(2500 / 1000))
    loader.dispose()
  })

  it('recovery is one timer: every due failure (large first pages too) goes in one batch', async () => {
    const pages: string[][] = []
    let down = true
    const files = Array.from({ length: 50 }, (_, i) => `big${i}.txt`)
    const loader = new DiffTextLoader(
      {
        filesPage: async (_kind, filePaths) => {
          pages.push(filePaths)
          return { diffs: {}, deferred: [], large: filePaths }
        },
        untrackedPage: async () => ({ diffs: {} }) as never,
        text: async () => {
          if (down) throw new Error('computer offline')
          return { text: 'first page', cursor: null, totalBytes: 10 }
        }
      },
      { opts: {} },
      { retryDelaysMs: [], recoverMs: 20 }
    )
    loader.sync(
      snap({ deferred: { unstaged: files, staged: [], renamedFrom: {}, fingerprint: 'f' } })
    )
    await vi.waitFor(() => expect(loader.getSnapshot().get('u:big49.txt')?.failed).toBe(true))
    pages.length = 0
    down = false
    await vi.waitFor(() => expect(loader.getSnapshot().get('u:big49.txt')?.text).toBe('first page'))
    expect(pages).toHaveLength(1)
    expect(pages[0]).toHaveLength(50)
    loader.dispose()
  })

  it('recovery backs off per file (doubling, capped) and is not fooled by a wall-clock step', async () => {
    vi.useFakeTimers()
    try {
      const asked: number[] = []
      let clock = 0
      const loader = new DiffTextLoader(
        {
          filesPage: async () => {
            asked.push(clock)
            throw new Error('computer offline')
          },
          untrackedPage: async () => ({ diffs: {} }) as never,
          text: async () => ({ text: '', cursor: null, totalBytes: 0 })
        },
        { opts: {} },
        { retryDelaysMs: [], recoverMs: 100, maxRecoverMs: 400, now: () => clock }
      )
      loader.sync(
        snap({ deferred: { unstaged: ['a'], staged: [], renamedFrom: {}, fingerprint: 'f' } })
      )
      const advance = async (ms: number) => {
        for (let i = 0; i < ms; i += 10) {
          clock += 10
          await vi.advanceTimersByTimeAsync(10)
        }
      }
      // A wall-clock step backwards changes nothing (the monotonic clock is injected).
      vi.setSystemTime(Date.now() - 60 * 60_000)
      await advance(1600)
      const gaps = asked.slice(1).map((t, i) => t - asked[i])
      expect(gaps.slice(0, 5)).toEqual([100, 200, 400, 400, 400])
      loader.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a file the reply leaves out (gone) is answered empty, not left pending', async () => {
    const f = source()
    f.s.filesPage = async (_kind, filePaths) => ({
      diffs: Object.fromEntries(filePaths.filter((p) => p !== 'gone').map((p) => [p, patch(p)])),
      deferred: [],
      large: []
    })
    const loader = new DiffTextLoader(f.s, { opts: {} })
    loader.sync(
      snap({ deferred: { unstaged: ['a', 'gone'], staged: [], renamedFrom: {}, fingerprint: 'f' } })
    )
    await idle(loader)
    expect(loader.getSnapshot().get('u:gone')).toEqual({
      text: '',
      rest: null,
      loading: false,
      failed: false
    })
    loader.dispose()
  })

  it('untracked files: new ones fetched once (paged), removed ones dropped', async () => {
    const f = source({ batch: 1 })
    const loader = new DiffTextLoader(f.s, { opts: {} })
    loader.sync(snap({ untrackedFiles: ['n1', 'n2'] }))
    await idle(loader)
    expect(f.calls).toEqual(['untracked n1,n2', 'untracked n2'])
    expect([...loader.getSnapshot().keys()].sort()).toEqual(['?:n1', '?:n2'])
    loader.sync(snap({ untrackedFiles: ['n2', 'n3'] }))
    await idle(loader)
    expect(f.calls.at(-1)).toBe('untracked n3')
    expect([...loader.getSnapshot().keys()].sort()).toEqual(['?:n2', '?:n3'])
  })

  it('an older computer’s whole untracked record still works', async () => {
    const f = source({ untrackedWhole: true })
    const loader = new DiffTextLoader(f.s, { opts: {} })
    loader.sync(snap({ untrackedFiles: ['n1', 'n2'] }))
    await idle(loader)
    expect(loader.getSnapshot().get('?:n2')?.text).toBe(patch('n2'))
  })

  it('a large untracked file is read page by page too', async () => {
    const f = source()
    const loader = new DiffTextLoader(f.s, { opts: {} })
    loader.sync(snap({ untrackedFiles: ['big.txt'] }))
    await idle(loader)
    expect(f.calls).toContain('text untrackedDiff big.txt null')
    expect(loader.getSnapshot().get('?:big.txt')?.rest).not.toBeNull()
  })

  it('range mode reads deferred files of the range', async () => {
    const f = source()
    const loader = new DiffTextLoader(f.s, { opts: {}, fromSha: 'aaaa', toSha: 'bbbb' })
    loader.sync(
      snap({
        unstagedFiles: ['big.txt'],
        deferred: { unstaged: ['big.txt'], staged: [], renamedFrom: {}, fingerprint: '' }
      })
    )
    await idle(loader)
    expect(f.calls).toEqual(['page range big.txt', 'text rangeFileDiff big.txt null'])
  })
})

it('disposed batch completion cannot start a large-file read or another batch', async () => {
  let finish!: (page: GitFileDiffsPage) => void
  const answer = new Promise<GitFileDiffsPage>((resolve) => {
    finish = resolve
  })
  const text = vi.fn(async () => ({ text: 'late', cursor: null, totalBytes: 4 }))
  const filesPage = vi.fn(() => answer)
  const loader = new DiffTextLoader(
    { filesPage, untrackedPage: async () => ({ $paged: true, ...(await answer) }), text },
    { opts: {} }
  )
  loader.sync(
    snap({ deferred: { unstaged: ['a', 'b'], staged: [], renamedFrom: {}, fingerprint: 'old' } })
  )
  loader.dispose()
  finish({ diffs: {}, large: ['a'], deferred: ['b'] })
  await idle(loader)
  expect(text).not.toHaveBeenCalled()
  expect(filesPage).toHaveBeenCalledTimes(1)
})
