/**
 * The computer side of the copy dialog's lazy tree: `openIgnoredTree` scans a repo's
 * ignored files once (streamed, never one giant string) into an index held under a
 * random id; `listIgnoredTree` / `matchIgnoredTree` answer pages of it. An index is
 * tied to the repo that opened it and expires when idle — an unknown or expired id
 * fails with IGNORED_TREE_EXPIRED, and the dialog reopens.
 *
 * Its pages carry the same entries the whole-tree op (`getIgnoredFileTree`, kept
 * for older callers) gives for the same repo.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { collectPages } from '@slayzone/platform/bounded-reads'
import { getIgnoredFileTree } from './git-worktree'
import { scanIgnoredIndex } from './ignored-scan'
import { IGNORED_TREE_EXPIRED, IgnoredTreeStore, isIgnoredTreeExpired } from './ignored-trees'
import type { IgnoredFileNode } from '../shared/types'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-ignored-trees-'))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'commit.gpgsign',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@t'
    }
  })

function makeRepo(name: string): string {
  const repo = path.join(root, name)
  fs.mkdirSync(repo)
  git(repo, 'init', '-q')
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.env*\ndist/\n*.log\n')
  fs.writeFileSync(path.join(repo, 'README.md'), '#')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  return repo
}

const repo = makeRepo('big')
// A node_modules wider than one page, plus nested and root-level ignored files.
for (let n = 0; n < 1500; n++) {
  const dir = path.join(repo, 'node_modules', `pkg${n}`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'index.js'), 'x')
}
fs.writeFileSync(path.join(repo, 'node_modules', 'pkg7', '.env'), 'x')
fs.mkdirSync(path.join(repo, 'dist', 'nested'), { recursive: true })
fs.writeFileSync(path.join(repo, 'dist', 'nested', 'deep.js'), 'deep')
fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1')
fs.writeFileSync(path.join(repo, 'app.log'), 'line')
fs.writeFileSync(path.join(repo, '.DS_Store'), 'x') // always excluded

const strip = ({ children: _c, ...entry }: IgnoredFileNode) => entry

describe('openIgnoredTree / listIgnoredTree', () => {
  it('opens with the root page and the total; pages equal the whole-tree op', async () => {
    const store = new IgnoredTreeStore()
    const opened = await store.open(repo, scanIgnoredIndex)
    expect(opened.totalFiles).toBe(1500 + 1 + 1 + 2)
    const whole = await getIgnoredFileTree(repo)
    expect(opened.root.items).toEqual(whole.map(strip))
    expect(opened.root.nextCursor).toBeNull()

    const nm = whole.find((n) => n.name === 'node_modules')!
    const page = store.list({
      repoPath: repo,
      treeId: opened.treeId,
      dir: 'node_modules',
      cursor: null
    })
    expect(page.nextCursor).not.toBeNull() // 1500 children > one page
    const all = await collectPages(async (cursor) =>
      store.list({ repoPath: repo, treeId: opened.treeId, dir: 'node_modules', cursor })
    )
    expect(all).toEqual(nm.children.map(strip))
    const dist = whole.find((n) => n.name === 'dist')!
    expect(
      store.list({ repoPath: repo, treeId: opened.treeId, dir: 'dist/nested', cursor: null }).items
    ).toEqual(dist.children[0].children.map(strip))
  })

  it('matchIgnoredTree applies a preset over every ignored file', async () => {
    const store = new IgnoredTreeStore()
    const { treeId } = await store.open(repo, scanIgnoredIndex)
    const sel = await collectPages(async (cursor) =>
      store.match({ repoPath: repo, treeId, globs: ['.env*', 'dist/**'], cursor })
    )
    expect(sel.map((s) => s.path).sort()).toEqual(['.env', 'dist', 'node_modules/pkg7/.env'])
  })

  it('a repo with nothing ignored opens empty', async () => {
    const clean = makeRepo('clean')
    const opened = await new IgnoredTreeStore().open(clean, scanIgnoredIndex)
    expect(opened.totalFiles).toBe(0)
    expect(opened.root).toEqual({ items: [], nextCursor: null })
  })
})

describe('expiry and binding', () => {
  it('an unknown id, another repo, or an idle index fails with IGNORED_TREE_EXPIRED', async () => {
    let now = 1_000
    const store = new IgnoredTreeStore({ now: () => now, idleMs: 60_000 })
    const { treeId } = await store.open(repo, scanIgnoredIndex)
    const ask = (repoPath: string, id: string) =>
      store.list({ repoPath, treeId: id, dir: '', cursor: null })
    expect(() => ask(repo, 'nope')).toThrow(IGNORED_TREE_EXPIRED)
    expect(() => ask(path.join(root, 'clean'), treeId)).toThrow(IGNORED_TREE_EXPIRED)
    now += 30_000
    expect(ask(repo, treeId).items.length).toBeGreaterThan(0) // use refreshes the idle clock
    now += 59_000
    expect(ask(repo, treeId).items.length).toBeGreaterThan(0)
    now += 60_001
    let err: unknown
    try {
      ask(repo, treeId)
    } catch (e) {
      err = e
    }
    expect(isIgnoredTreeExpired(err)).toBe(true)
  })

  it('keeps at most `max` indexes, dropping the least recently used', async () => {
    const store = new IgnoredTreeStore({ max: 2 })
    const a = await store.open(repo, scanIgnoredIndex)
    const b = await store.open(repo, scanIgnoredIndex)
    store.list({ repoPath: repo, treeId: a.treeId, dir: '', cursor: null }) // a is now newer
    const c = await store.open(repo, scanIgnoredIndex)
    expect(() => store.list({ repoPath: repo, treeId: b.treeId, dir: '', cursor: null })).toThrow(
      IGNORED_TREE_EXPIRED
    )
    for (const t of [a, c])
      expect(
        store.list({ repoPath: repo, treeId: t.treeId, dir: '', cursor: null }).items.length
      ).toBe(a.root.items.length)
  })

  it('isIgnoredTreeExpired recognises the message across a transport (no class identity)', () => {
    expect(isIgnoredTreeExpired(new Error(`x ${IGNORED_TREE_EXPIRED}: gone`))).toBe(true)
    expect(isIgnoredTreeExpired(new Error('other'))).toBe(false)
  })
})

describe('IgnoredTreeStore lifetimes', () => {
  it('an idle index is dropped by its own timer, not only by the next call', async () => {
    vi.useFakeTimers()
    try {
      const store = new IgnoredTreeStore({ idleMs: 60_000 })
      const { IgnoredIndex } = await import('./ignored-index')
      store.adopt('/repo', IgnoredIndex.build(['a', 'b']))
      expect(store.size).toBe(1)
      await vi.advanceTimersByTimeAsync(3 * 60_000)
      expect(store.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
