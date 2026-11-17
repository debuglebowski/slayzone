/**
 * Bounded git diffs (FU1 S5). A diff of any size reaches the panel without one
 * reply ever carrying it whole:
 *  - the working-diff snapshot (`paged`) carries each side's patch up to a byte
 *    budget, cut between files; the files left out are listed (`deferred`) with a
 *    fingerprint that changes when any of them changes;
 *  - deferred files come in budgeted batches (`getFileDiffsPage`); a file whose own
 *    patch is over the budget is listed `large`;
 *  - a large file (or a stash) is read page by page (`readGitText`): git's output
 *    is spooled to disk once and served in line-cut pages.
 * Every piece, put back together, equals the whole answer of the old ops.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PAGE_MAX_BYTES, utf8ByteLength } from '@slayzone/platform/bounded-reads'
import {
  getFileDiff,
  getFileDiffsPage,
  getStashDiff,
  getUntrackedFileDiff,
  getUntrackedFileDiffs,
  getWorkingDiff
} from './git-worktree'
import {
  GIT_TEXT_EXPIRED,
  GitTextSpool,
  readGitText,
  sweepStaleGitTextDirs
} from './git-text-spool'

const KB = 1024
const env = {
  ...process.env,
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'commit.gpgsign',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@t'
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env }).toString()

/** `bytes` of text in lines tagged with `tag` (so every line changes when the tag does). */
const content = (tag: string, bytes: number) => {
  const line = `${tag} ${'x'.repeat(60)}\n`
  return line.repeat(Math.ceil(bytes / line.length))
}

/** A patch split at its file headers. */
const filesOf = (patch: string) => patch.split(/(?=^diff --git )/m).filter(Boolean)

let repo: string
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'paged-diffs-'))
  git(repo, 'init', '-q', '-b', 'main')
  for (const f of ['a.txt', 'b.txt', 'c.txt', 'big.txt', 'staged1.txt', 'staged2.txt'])
    writeFileSync(join(repo, f), content(`old-${f}`, 40 * KB))
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'base')
})
afterAll(() => rmSync(repo, { recursive: true, force: true }))

describe('the working-diff snapshot, paged', () => {
  const opts = { contextLines: '3', paged: true, maxPatchBytes: 100 * KB }

  it('carries whole files up to the budget; deferred lists the rest; pieces equal the whole', async () => {
    for (const f of ['a.txt', 'b.txt', 'c.txt'])
      writeFileSync(join(repo, f), content(`new-${f}`, 40 * KB))
    const whole = await getWorkingDiff(repo, { contextLines: '3' })
    const paged = await getWorkingDiff(repo, opts)
    expect(whole.deferred).toBeUndefined()
    expect(utf8ByteLength(paged.unstagedPatch)).toBeLessThanOrEqual(100 * KB)
    expect(filesOf(paged.unstagedPatch).length).toBeGreaterThanOrEqual(1)
    expect(paged.deferred?.unstaged.length).toBeGreaterThan(0)
    expect(paged.deferred?.staged).toEqual([])
    // Lists are whole either way.
    expect(paged.unstagedFiles).toEqual(whole.unstagedFiles)

    const rest = await getFileDiffsPage(repo, {
      kind: 'unstaged',
      filePaths: paged.deferred!.unstaged,
      opts: { contextLines: '3' }
    })
    expect(rest.deferred).toEqual([])
    const pieces = paged.unstagedPatch + paged.deferred!.unstaged.map((f) => rest.diffs[f]).join('')
    expect(pieces).toBe(whole.unstagedPatch)
  })

  it('a batch stops at the budget (≥ 1 file) and defers the rest', async () => {
    const page = await getFileDiffsPage(repo, {
      kind: 'unstaged',
      filePaths: ['a.txt', 'b.txt', 'c.txt'],
      opts: { contextLines: '3' },
      maxBytes: 100 * KB
    })
    expect(Object.keys(page.diffs).length).toBeGreaterThanOrEqual(1)
    expect(Object.keys(page.diffs).length + page.deferred.length).toBe(3)
    expect(page.diffs['a.txt']).toBe(await getFileDiff(repo, 'a.txt', false, { contextLines: '3' }))
  })

  it('a file over the budget alone is deferred by the snapshot and `large` in a batch', async () => {
    writeFileSync(join(repo, 'big.txt'), content('new-big', 300 * KB))
    const paged = await getWorkingDiff(repo, opts)
    expect(paged.deferred?.unstaged).toContain('big.txt')
    const page = await getFileDiffsPage(repo, {
      kind: 'unstaged',
      filePaths: ['big.txt', 'c.txt'],
      opts: { contextLines: '3' },
      maxBytes: 100 * KB
    })
    expect(page.large).toEqual(['big.txt'])
    expect(page.diffs['big.txt']).toBeUndefined()
  })

  it('the fingerprint changes when a deferred file changes, even with the same line counts', async () => {
    const before = await getWorkingDiff(repo, opts)
    // Same number of lines, other text: numstat would not see it.
    writeFileSync(join(repo, 'big.txt'), content('NEW-BIG', 300 * KB))
    const after = await getWorkingDiff(repo, opts)
    expect(after.deferred?.fingerprint).not.toBe(before.deferred?.fingerprint)
    const again = await getWorkingDiff(repo, opts)
    expect(again.deferred?.fingerprint).toBe(after.deferred?.fingerprint)
  })

  it('the staged side, and -w (names taken with the same flags as the patch)', async () => {
    for (const f of ['staged1.txt', 'staged2.txt']) {
      writeFileSync(join(repo, f), content(`staged-${f}`, 80 * KB))
      git(repo, 'add', f)
    }
    const whole = await getWorkingDiff(repo, { contextLines: '3', ignoreWhitespace: true })
    const paged = await getWorkingDiff(repo, {
      ...opts,
      ignoreWhitespace: true,
      maxPatchBytes: 90 * KB
    })
    expect(paged.deferred?.staged.length).toBeGreaterThan(0)
    const rest = await getFileDiffsPage(repo, {
      kind: 'staged',
      filePaths: paged.deferred!.staged,
      opts: { contextLines: '3', ignoreWhitespace: true }
    })
    expect(paged.stagedPatch + paged.deferred!.staged.map((f) => rest.diffs[f]).join('')).toBe(
      whole.stagedPatch
    )
    git(repo, 'reset', '-q')
  })

  it('a deferred rename stays a rename (its old path travels with it)', async () => {
    const r = mkdtempSync(join(tmpdir(), 'paged-diffs-rename-'))
    try {
      git(r, 'init', '-q', '-b', 'main')
      writeFileSync(join(r, 'a.txt'), content('a', 40 * KB))
      writeFileSync(join(r, 'b.txt'), content('b', 40 * KB))
      git(r, 'add', '-A')
      git(r, 'commit', '-qm', 'base')
      writeFileSync(join(r, 'a.txt'), content('a2', 40 * KB))
      git(r, 'mv', 'b.txt', 'zz-renamed.txt')
      git(r, 'add', '-A')
      const whole = await getWorkingDiff(r, { contextLines: '3' })
      const paged = await getWorkingDiff(r, { ...opts, maxPatchBytes: 10 * KB })
      expect(paged.deferred?.staged).toContain('zz-renamed.txt')
      expect(paged.deferred?.renamedFrom['zz-renamed.txt']).toBe('b.txt')
      const files = paged.deferred!.staged
      const rest = await getFileDiffsPage(r, {
        kind: 'staged',
        filePaths: files,
        fromPaths: files.map((f) => paged.deferred!.renamedFrom[f] ?? ''),
        opts: { contextLines: '3' }
      })
      expect(rest.diffs['zz-renamed.txt']).toContain('rename from b.txt')
      expect(paged.stagedPatch + files.map((f) => rest.diffs[f]).join('')).toBe(whole.stagedPatch)
    } finally {
      rmSync(r, { recursive: true, force: true })
    }
  })

  it('range mode (two shas) pages too, and its pieces equal the whole', async () => {
    const from = git(repo, 'rev-parse', 'HEAD').trim()
    git(repo, 'add', 'a.txt', 'b.txt', 'c.txt')
    git(repo, 'commit', '-qm', 'abc')
    const to = git(repo, 'rev-parse', 'HEAD').trim()
    const whole = await getWorkingDiff(repo, { contextLines: '3', fromSha: from, toSha: to })
    const paged = await getWorkingDiff(repo, { ...opts, fromSha: from, toSha: to })
    expect(paged.deferred?.unstaged.length).toBeGreaterThan(0)
    const rest = await getFileDiffsPage(repo, {
      kind: 'range',
      filePaths: paged.deferred!.unstaged,
      opts: { contextLines: '3' },
      fromSha: from,
      toSha: to
    })
    expect(paged.unstagedPatch + paged.deferred!.unstaged.map((f) => rest.diffs[f]).join('')).toBe(
      whole.unstagedPatch
    )
  })

  it('under the budget nothing is deferred (the snapshot is the whole answer)', async () => {
    const small = await getWorkingDiff(repo, { contextLines: '3', paged: true })
    expect(small.deferred).toBeUndefined()
  })
})

describe('the working-diff snapshot, paged, during a conflicted merge', () => {
  /** The paths whose sections a patch carries (`diff --git a/x b/x`, `diff --cc x`, and
   *  their C-quoted forms; this repo's names need only `\"` unescaped, as in JSON). */
  const sectionPaths = (patch: string) =>
    [
      ...patch.matchAll(
        /^diff (?:--git "a\/.*" "b\/(.*)"|--git a\/.* b\/(.*)|--(?:cc|combined) "(.*)"|--(?:cc|combined) (.*))$/gm
      )
    ].map((m) => {
      const quoted = m[1] ?? m[3]
      return quoted !== undefined ? (JSON.parse(`"${quoted}"`) as string) : (m[2] ?? m[4])
    })
  let merging: string
  beforeAll(() => {
    merging = mkdtempSync(join(tmpdir(), 'paged-merge-'))
    git(merging, 'init', '-q', '-b', 'main')
    for (const f of ['a.txt', 'f.txt', 'z.txt', 's1.txt', 's2.txt', 'quo"te.txt'])
      writeFileSync(join(merging, f), content(`base-${f}`, 2 * KB))
    git(merging, 'add', '-A')
    git(merging, 'commit', '-qm', 'base')
    git(merging, 'checkout', '-q', '-b', 'other')
    writeFileSync(join(merging, 'f.txt'), content('other-f', 2 * KB))
    git(merging, 'commit', '-qam', 'other')
    git(merging, 'checkout', '-q', 'main')
    writeFileSync(join(merging, 'f.txt'), content('main-f', 2 * KB))
    git(merging, 'commit', '-qam', 'main')
    try {
      git(merging, 'merge', '-q', 'other')
    } catch {
      // The conflict is the point: f.txt is unmerged.
    }
    for (const f of ['a.txt', 'z.txt', 'quo"te.txt'])
      writeFileSync(join(merging, f), content(`work-${f}`, 2 * KB))
    for (const f of ['s1.txt', 's2.txt'])
      writeFileSync(join(merging, f), content(`st-${f}`, 2 * KB))
    git(merging, 'add', 's1.txt', 's2.txt')
  })
  afterAll(() => rmSync(merging, { recursive: true, force: true }))

  it('every changed file is either in its side’s patch or deferred, exactly once', async () => {
    const whole = await getWorkingDiff(merging, { contextLines: '3' })
    for (const maxPatchBytes of [1 * KB, 5 * KB, 9 * KB]) {
      const paged = await getWorkingDiff(merging, { contextLines: '3', paged: true, maxPatchBytes })
      for (const [patch, wholePatch, deferred] of [
        [paged.unstagedPatch, whole.unstagedPatch, paged.deferred?.unstaged ?? []],
        [paged.stagedPatch, whole.stagedPatch, paged.deferred?.staged ?? []]
      ] as const) {
        const emitted = sectionPaths(patch)
        // No file is both shown and deferred, none is deferred twice.
        expect(emitted.filter((p) => deferred.includes(p))).toEqual([])
        expect(new Set(deferred).size).toBe(deferred.length)
        // Shown + deferred covers every file whose section the whole patch has.
        for (const p of sectionPaths(wholePatch)) expect([...emitted, ...deferred]).toContain(p)
      }
    }
  })
})

describe('per-file fingerprints of deferred files', () => {
  it('an unstaged file’s fingerprint changes when its index entry does (a partial stage)', async () => {
    const r = mkdtempSync(join(tmpdir(), 'paged-fp-'))
    try {
      git(r, 'init', '-q', '-b', 'main')
      const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`)
      writeFileSync(join(r, 'p.txt'), `${lines.join('\n')}\n`)
      git(r, 'add', '-A')
      git(r, 'commit', '-qm', 'base')
      // Two hunks, far apart.
      const edited = [...lines]
      edited[5] = 'changed 5'
      edited[350] = 'changed 350'
      writeFileSync(join(r, 'p.txt'), `${edited.join('\n')}\n`)
      const opts = { contextLines: '3', paged: true, maxPatchBytes: 1 }
      const before = await getWorkingDiff(r, opts)
      expect(before.deferred?.unstaged).toEqual(['p.txt'])
      // Stage only the first hunk (the worktree file itself is untouched).
      const partial = [...lines]
      partial[5] = 'changed 5'
      const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
        cwd: r,
        env,
        input: `${partial.join('\n')}\n`
      })
        .toString()
        .trim()
      git(r, 'update-index', '--cacheinfo', `100644,${blob},p.txt`)
      const after = await getWorkingDiff(r, opts)
      expect(after.deferred?.unstaged).toEqual(['p.txt'])
      expect(after.deferred?.fingerprints?.unstaged['p.txt']).not.toBe(
        before.deferred?.fingerprints?.unstaged['p.txt']
      )
    } finally {
      rmSync(r, { recursive: true, force: true })
    }
  })
})

describe('untracked files, paged', () => {
  it('a batch answers within the budget; deferred and large name the rest', async () => {
    for (const n of [1, 2, 3]) writeFileSync(join(repo, `u${n}.txt`), content(`u${n}`, 60 * KB))
    writeFileSync(join(repo, 'huge.log'), content('huge', 300 * KB))
    const page = await getUntrackedFileDiffs(repo, ['huge.log', 'u1.txt', 'u2.txt', 'u3.txt'], {
      paged: true,
      maxBytes: 100 * KB
    })
    expect(page.$paged).toBe(true)
    expect(page.large).toEqual(['huge.log'])
    expect(page.diffs['u1.txt']).toBe(await getUntrackedFileDiff(repo, 'u1.txt'))
    expect(Object.keys(page.diffs).length + page.deferred.length).toBe(3)
    // Without `paged`: the whole record, as before.
    const whole = (await getUntrackedFileDiffs(repo, ['u1.txt'])) as Record<string, string>
    expect(whole['u1.txt']).toBe(page.diffs['u1.txt'])
  })
})

describe('readGitText: a large text read page by page', () => {
  it('invalid UTF-8 keeps whole-read decoding and always advances the cursor', async () => {
    const spool = new GitTextSpool()
    const bytes = Buffer.concat([Buffer.from('xx'), Buffer.alloc(24, 0x80), Buffer.from('tail')])
    const file = join(repo, 'invalid-unicode-spool')
    writeFileSync(file, bytes)
    const id = spool.hold(file, repo, bytes.length)
    let cursor: string | null = `${id}:0`
    let actual = ''
    for (let n = 0; cursor !== null && n < bytes.length; n++) {
      const page = await readGitText(
        spool,
        repo,
        { kind: 'untrackedDiff', filePath: 'unused' },
        cursor,
        { maxBytes: 4 }
      )
      expect(page.text.length).toBeGreaterThan(0)
      actual += page.text
      cursor = page.cursor
    }
    expect(cursor).toBeNull()
    expect(actual).toBe(bytes.toString('utf8'))
  })

  it.each(['é', '€', '😀'])(
    'a giant %s line is byte-exact across production 4 MiB pages',
    async (char) => {
      const spool = new GitTextSpool()
      const text = `xxx${char.repeat(Math.ceil((2 * PAGE_MAX_BYTES) / Buffer.byteLength(char)))}\n`
      const file = join(repo, `unicode-spool-${Buffer.byteLength(char)}`)
      writeFileSync(file, text)
      const id = spool.hold(file, repo, Buffer.byteLength(text))
      let cursor: string | null = `${id}:0`
      const pages: string[] = []
      do {
        const page = await readGitText(
          spool,
          repo,
          { kind: 'untrackedDiff', filePath: 'unused' },
          cursor
        )
        expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(PAGE_MAX_BYTES)
        pages.push(page.text)
        cursor = page.cursor
      } while (cursor !== null)
      expect(pages.length).toBeGreaterThan(2)
      expect(Buffer.from(pages.join('')).equals(Buffer.from(text))).toBe(true)
      expect(spool.size).toBe(0)
    }
  )

  it.each([1, 2, 3, 4, 5])(
    'a tiny %s-byte test budget still makes progress by whole code points',
    async (maxBytes) => {
      const spool = new GitTextSpool()
      const text = 'aé€😀b\n'
      const file = join(repo, `small-unicode-spool-${maxBytes}`)
      writeFileSync(file, text)
      const id = spool.hold(file, repo, Buffer.byteLength(text))
      let cursor: string | null = `${id}:0`
      let actual = ''
      for (let n = 0; cursor !== null && n < Buffer.byteLength(text); n++) {
        const page = await readGitText(
          spool,
          repo,
          { kind: 'untrackedDiff', filePath: 'unused' },
          cursor,
          { maxBytes }
        )
        expect(page.text.length).toBeGreaterThan(0)
        expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(Math.max(4, maxBytes))
        actual += page.text
        cursor = page.cursor
      }
      expect(cursor).toBeNull()
      expect(actual).toBe(text)
    }
  )

  const read = async (spool: GitTextSpool, source: Parameters<typeof readGitText>[2]) => {
    let text = ''
    let pages = 0
    let total = -1
    for (let cursor: string | null = null; ; ) {
      const page = await readGitText(spool, repo, source, cursor, { maxBytes: 64 * KB })
      expect(utf8ByteLength(page.text)).toBeLessThanOrEqual(64 * KB)
      text += page.text
      total = page.totalBytes
      pages++
      if (!page.cursor) break
      cursor = page.cursor
    }
    return { text, pages, total }
  }

  it('a file diff: pages concatenate to the whole, cut at line ends', async () => {
    const spool = new GitTextSpool()
    const whole = await getFileDiff(repo, 'big.txt', false, { contextLines: '3' })
    const got = await read(spool, {
      kind: 'fileDiff',
      filePath: 'big.txt',
      staged: false,
      opts: { contextLines: '3' }
    })
    expect(got.pages).toBeGreaterThan(2)
    expect(got.text).toBe(whole)
    expect(got.total).toBe(utf8ByteLength(whole))
  })

  it('an untracked file and a stash', async () => {
    const spool = new GitTextSpool()
    expect((await read(spool, { kind: 'untrackedDiff', filePath: 'huge.log' })).text).toBe(
      await getUntrackedFileDiff(repo, 'huge.log')
    )
    git(repo, 'stash', 'push', '-q', '-u')
    expect((await read(spool, { kind: 'stashDiff', index: 0 })).text).toBe(
      await getStashDiff(repo, 0)
    )
    git(repo, 'stash', 'pop', '-q')
  })

  it('a small answer is one page with no cursor and leaves no spool', async () => {
    const spool = new GitTextSpool()
    const page = await readGitText(
      spool,
      repo,
      { kind: 'fileDiff', filePath: 'c.txt', staged: false },
      null
    )
    expect(page.cursor).toBeNull()
    expect(spool.size).toBe(0)
    expect(PAGE_MAX_BYTES).toBeGreaterThan(utf8ByteLength(page.text))
  })

  it('an expired or foreign cursor fails with GIT_TEXT_EXPIRED; the store is bounded', async () => {
    let now = 0
    const spool = new GitTextSpool({ now: () => now, idleMs: 1000, maxBytes: 400 * KB })
    const src = { kind: 'fileDiff' as const, filePath: 'big.txt', staged: false }
    const first = await readGitText(spool, repo, src, null, { maxBytes: 64 * KB })
    expect(first.cursor).not.toBeNull()
    await expect(
      readGitText(spool, '/elsewhere', src, first.cursor, { maxBytes: 64 * KB })
    ).rejects.toThrow(GIT_TEXT_EXPIRED)
    now += 1001
    await expect(
      readGitText(spool, repo, src, first.cursor, { maxBytes: 64 * KB })
    ).rejects.toThrow(GIT_TEXT_EXPIRED)
    expect(spool.size).toBe(0)
    // Over the disk bound the oldest spool goes first.
    const a = await readGitText(spool, repo, src, null, { maxBytes: 64 * KB })
    const b = await readGitText(spool, repo, src, null, { maxBytes: 64 * KB })
    await expect(readGitText(spool, repo, src, a.cursor, { maxBytes: 64 * KB })).rejects.toThrow(
      GIT_TEXT_EXPIRED
    )
    expect(
      (await readGitText(spool, repo, src, b.cursor, { maxBytes: 64 * KB })).text.length
    ).toBeGreaterThan(0)
  })
})

describe('spool lifetimes', () => {
  it('an idle spool is dropped by its own timer, not only by the next call', async () => {
    vi.useFakeTimers()
    try {
      const spool = new GitTextSpool({ idleMs: 60_000 })
      const file = join(repo, 'idle-spool.txt')
      writeFileSync(file, 'x'.repeat(100))
      spool.hold(file, repo, 100)
      expect(spool.size).toBe(1)
      await vi.advanceTimersByTimeAsync(3 * 60_000)
      expect(spool.size).toBe(0)
      await vi.waitFor(() => expect(existsSync(file)).toBe(false))
    } finally {
      vi.useRealTimers()
    }
  })

  it('stale spool folders of exited processes are swept; a live process keeps its own', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-text-sweep-'))
    try {
      const dead = join(root, 'slayzone-git-text-2147483646-abc')
      const live = join(root, `slayzone-git-text-${process.pid}-def`)
      const legacyOld = join(root, 'slayzone-git-text-ghi')
      const legacyNew = join(root, 'slayzone-git-text-jkl')
      const other = join(root, 'unrelated-dir')
      for (const d of [dead, live, legacyOld, legacyNew, other]) mkdirSync(d)
      const dayAgo = (Date.now() - 2 * 24 * 60 * 60_000) / 1000
      utimesSync(legacyOld, dayAgo, dayAgo)
      sweepStaleGitTextDirs(root)
      expect(existsSync(dead)).toBe(false)
      expect(existsSync(legacyOld)).toBe(false)
      expect(existsSync(live)).toBe(true)
      expect(existsSync(legacyNew)).toBe(true)
      expect(existsSync(other)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
