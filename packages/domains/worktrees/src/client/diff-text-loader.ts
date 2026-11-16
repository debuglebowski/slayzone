/**
 * The git panel's per-file patches that are not in the snapshot's own patch text
 * (FU1 S5): the files a paged snapshot deferred, and the untracked files' preview.
 * Framework-free, observed through `subscribe`/`getSnapshot`.
 *
 *  - Deferred files load in budgeted batches (`getFileDiffsPage`), a rename with its
 *    old path; they reload when the snapshot's fingerprint changes (a deferred file
 *    changed on disk), and leave when they are no longer deferred.
 *  - A file whose own patch is over the budget (`large`) shows its FIRST page; the
 *    rest loads on request ({@link DiffTextLoader.loadRest}) — every byte reachable,
 *    none fetched unasked. A page cursor that expired reads the text again.
 *  - Untracked files: each new one is fetched once (as before), in budgeted batches
 *    when the computer pages them; an older computer's whole record still works.
 *
 * Keys: `u:<path>` unstaged (or a range's file), `s:<path>` staged, `?:<path>` untracked.
 *
 * @module worktrees/client/diff-text-loader
 */
import { utf8ByteLength } from '@slayzone/platform/bounded-reads'
import {
  type GitDiffTextOpts,
  type GitFileDiffsPage,
  type GitTextPage,
  type GitTextSource,
  isGitTextExpired
} from '../shared/git-text'
import type { GitDiffSnapshot } from '../shared/types'

export type DiffFilesKind = 'unstaged' | 'staged' | 'range' | 'untracked'

/** The routed reads (`worktrees.getFileDiffsPage`, paged `getUntrackedFileDiffs`, `readGitText`). */
export interface DiffTextSource {
  filesPage(
    kind: DiffFilesKind,
    filePaths: string[],
    fromPaths?: string[]
  ): Promise<GitFileDiffsPage>
  untrackedPage(
    filePaths: string[]
  ): Promise<Record<string, string> | ({ $paged: true } & GitFileDiffsPage)>
  text(source: GitTextSource, cursor: string | null): Promise<GitTextPage>
}

/** One file's patch as loaded so far. */
export interface DiffText {
  text: string
  /** More of it to load (a large file read by its first page). */
  rest: { cursor: string; remainingBytes: number } | null
  loading: boolean
  failed: boolean
}

export interface DiffTextContext {
  opts: GitDiffTextOpts
  fromSha?: string
  toSha?: string
}

/** Files per batch request (each answer is byte-bounded by the computer anyway). */
const BATCH_FILES = 1000
const NO_TEXTS: ReadonlyMap<string, DiffText> = new Map()

export class DiffTextLoader {
  private texts: ReadonlyMap<string, DiffText> = NO_TEXTS
  private readonly sources = new Map<string, GitTextSource>()
  private readonly listeners = new Set<() => void>()
  /** Keys being fetched (never fetched twice at once). */
  private readonly pending = new Set<string>()
  private fingerprint: string | null = null
  /** Bumped when the tracked files' contents changed: older answers are dropped. */
  private generation = 0
  private running = 0
  private disposed = false

  constructor(
    private readonly source: DiffTextSource,
    private readonly ctx: DiffTextContext
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): ReadonlyMap<string, DiffText> => this.texts

  /** Whether a fetch is under way. */
  get busy(): boolean {
    return this.running > 0
  }

  dispose(): void {
    this.disposed = true
    this.listeners.clear()
    this.texts = NO_TEXTS
    this.sources.clear()
    this.pending.clear()
  }

  private update(edit: (texts: Map<string, DiffText>) => void): void {
    if (this.disposed) return
    const next = new Map(this.texts)
    edit(next)
    this.texts = next
    for (const l of this.listeners) l()
  }

  private get range(): boolean {
    return !!this.ctx.fromSha && !!this.ctx.toSha
  }

  /** The text source of one file (to read it page by page). */
  private textSource(key: string, fromPath?: string): GitTextSource {
    const filePath = key.slice(2)
    const from = fromPath ? { fromPath } : {}
    if (key.startsWith('?:')) return { kind: 'untrackedDiff', filePath }
    if (this.range)
      return {
        kind: 'rangeFileDiff',
        fromSha: this.ctx.fromSha!,
        toSha: this.ctx.toSha!,
        filePath,
        ...from,
        opts: this.ctx.opts
      }
    return {
      kind: 'fileDiff',
      filePath,
      staged: key.startsWith('s:'),
      ...from,
      opts: this.ctx.opts
    }
  }

  /** Bring the loaded patches in line with `snapshot`. */
  sync(snapshot: GitDiffSnapshot): void {
    if (this.disposed) return
    const d = snapshot.deferred
    const wanted = new Map<string, string | undefined>()
    for (const p of d?.unstaged ?? []) wanted.set(`u:${p}`, d?.renamedFrom[p])
    for (const p of d?.staged ?? []) wanted.set(`s:${p}`, d?.renamedFrom[p])
    const fingerprint = d?.fingerprint ?? null
    const changed = fingerprint !== this.fingerprint
    if (changed) {
      this.fingerprint = fingerprint
      this.generation++
      for (const k of this.pending) if (!k.startsWith('?:')) this.pending.delete(k)
    }
    const untracked = new Set(snapshot.untrackedFiles.map((p) => `?:${p}`))
    this.update((texts) => {
      for (const k of [...texts.keys()]) {
        const tracked = !k.startsWith('?:')
        if (tracked ? changed || !wanted.has(k) : !untracked.has(k)) {
          texts.delete(k)
          this.sources.delete(k)
        }
      }
    })
    for (const k of [...this.pending])
      if (k.startsWith('?:') && !untracked.has(k)) this.pending.delete(k)

    const missing = (k: string) => !this.texts.has(k) && !this.pending.has(k)
    for (const [side, prefix] of [
      [this.range ? 'range' : 'unstaged', 'u:'],
      ['staged', 's:']
    ] as const) {
      const keys = [...wanted.keys()].filter((k) => k.startsWith(prefix) && missing(k))
      if (keys.length) this.run(side, keys, wanted)
    }
    const newUntracked = [...untracked].filter(missing)
    if (newUntracked.length) this.run('untracked', newUntracked, wanted)
  }

  /** Fetch `keys` batch by batch until every one is answered (or cannot be). */
  private run(
    kind: DiffFilesKind,
    keys: string[],
    fromPaths: ReadonlyMap<string, string | undefined>
  ): void {
    const gen = this.generation
    for (const k of keys) this.pending.add(k)
    this.running++
    const queue = [...keys]
    const step = async (): Promise<void> => {
      while (queue.length && !this.disposed) {
        if (this.disposed || (kind !== 'untracked' && gen !== this.generation)) return
        const batch = queue.splice(0, BATCH_FILES)
        const paths = batch.map((k) => k.slice(2))
        let page: GitFileDiffsPage
        if (kind === 'untracked') {
          const answer = await this.source.untrackedPage(paths)
          page =
            (answer as { $paged?: unknown }).$paged === true
              ? (answer as GitFileDiffsPage)
              : { diffs: answer as Record<string, string>, deferred: [], large: [] }
        } else {
          const from = batch.map((k) => fromPaths.get(k) ?? '')
          page = await this.source.filesPage(kind, paths, from.some(Boolean) ? from : undefined)
        }
        if (this.disposed || (kind !== 'untracked' && gen !== this.generation)) return
        const prefix = batch[0].slice(0, 2)
        this.update((texts) => {
          for (const [p, text] of Object.entries(page.diffs))
            texts.set(prefix + p, { text, rest: null, loading: false, failed: false })
        })
        for (const p of Object.keys(page.diffs)) this.pending.delete(prefix + p)
        for (const p of page.large) await this.readFirst(prefix + p, fromPaths.get(prefix + p), gen)
        // Unanswered files go first in the next request; no progress = stop.
        const progressed = Object.keys(page.diffs).length + page.large.length > 0
        if (page.deferred.length && !progressed) {
          for (const p of page.deferred) this.pending.delete(prefix + p)
          return
        }
        queue.unshift(...page.deferred.map((p) => prefix + p))
      }
    }
    void step()
      .catch(() => {
        for (const k of keys) this.pending.delete(k)
      })
      .finally(() => {
        this.running--
      })
  }

  /** A large file: its first page now, the rest on request. */
  private async readFirst(key: string, fromPath: string | undefined, gen: number): Promise<void> {
    if (this.disposed || (!key.startsWith('?:') && gen !== this.generation)) return
    const src = this.textSource(key, fromPath)
    const page = await this.source.text(src, null).catch(() => null)
    this.pending.delete(key)
    if (this.disposed || (!key.startsWith('?:') && gen !== this.generation)) return
    this.sources.set(key, src)
    this.update((texts) =>
      texts.set(
        key,
        page
          ? {
              text: page.text,
              rest: page.cursor
                ? {
                    cursor: page.cursor,
                    remainingBytes: page.totalBytes - utf8ByteLength(page.text)
                  }
                : null,
              loading: false,
              failed: false
            }
          : { text: '', rest: null, loading: false, failed: true }
      )
    )
  }

  /** Load the rest of a large file (every remaining page). */
  async loadRest(key: string): Promise<void> {
    if (this.disposed) return
    const start = this.texts.get(key)
    const src = this.sources.get(key)
    if (!start?.rest || !src || start.loading) return
    const gen = this.generation
    const entry = { ...start, loading: true, failed: false }
    const current = () =>
      !this.disposed &&
      (key.startsWith('?:') || gen === this.generation) &&
      this.sources.get(key) === src &&
      this.texts.get(key) === entry
    this.update((t) => t.set(key, entry))
    this.running++
    try {
      const text = await readRestOfText(
        (cursor) => {
          if (!current())
            return Promise.reject(new DOMException('Diff read superseded', 'AbortError'))
          return this.source.text(src, cursor)
        },
        {
          text: start.text,
          cursor: start.rest.cursor
        }
      )
      if (!current()) return
      this.update((t) => t.set(key, { text, rest: null, loading: false, failed: false }))
    } catch (err) {
      if (!current()) return
      this.update((t) => t.set(key, { ...start, loading: false, failed: true }))
      throw err
    } finally {
      this.running--
    }
  }
}

/**
 * A text's remaining pages after `start` (its loaded part and the cursor to the
 * next page), all of them. A cursor that expired on the computer reads the text
 * again from its first page — once; a second expiry fails.
 */
export async function readRestOfText(
  read: (cursor: string | null) => Promise<GitTextPage>,
  start: { text: string; cursor: string }
): Promise<string> {
  let text = start.text
  let cursor: string | null = start.cursor
  let restarted = false
  while (cursor !== null) {
    let page: GitTextPage
    try {
      page = await read(cursor)
    } catch (err) {
      if (!isGitTextExpired(err) || restarted) throw err
      restarted = true
      page = await read(null)
      text = ''
    }
    text += page.text
    cursor = page.cursor
  }
  return text
}
