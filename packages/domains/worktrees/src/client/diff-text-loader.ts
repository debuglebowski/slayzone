/**
 * The git panel's per-file patches that are not in the snapshot's own patch text
 * (FU1 S5): the files a paged snapshot deferred, and the untracked files' preview.
 * Framework-free, observed through `subscribe`/`getSnapshot`.
 *
 *  - Deferred files load in budgeted batches (`getFileDiffsPage`), a rename with its
 *    old path. A file reloads when its own fingerprint changes (its content changed
 *    on disk); its old text stays until the new one arrives. Files leave when they
 *    are no longer deferred. A failed batch is retried a bounded number of times,
 *    then its files show `failed` with a retry ({@link DiffTextLoader.retry}).
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
/** A failed batch is asked again after these delays, then its files show `failed`. */
const RETRY_DELAYS_MS = [1_000, 4_000]
/** The fingerprint of an untracked file's preview (fetched once while listed). */
const UNTRACKED = ''

export class DiffTextLoader {
  private texts: ReadonlyMap<string, DiffText> = NO_TEXTS
  private readonly sources = new Map<string, GitTextSource>()
  private readonly listeners = new Set<() => void>()
  /** Every file the snapshot wants a text for, with its current fingerprint. */
  private wanted = new Map<string, string>()
  /** Renamed files' old paths, as the snapshot names them. */
  private fromPaths = new Map<string, string | undefined>()
  /** The fingerprint each loaded text was read at (stale until it is the wanted one). */
  private readonly loadedAt = new Map<string, string>()
  /** Keys being fetched, at the fingerprint asked for (never fetched twice at once). */
  private readonly pending = new Map<string, string>()
  private running = 0
  private disposed = false
  private readonly retryDelaysMs: readonly number[]
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()

  constructor(
    private readonly source: DiffTextSource,
    private readonly ctx: DiffTextContext,
    options: { retryDelaysMs?: readonly number[] } = {}
  ) {
    this.retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS
  }

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
    this.loadedAt.clear()
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
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

  /** Whether an answer read at `fingerprint` is still the one `key` wants. */
  private current(key: string, fingerprint: string): boolean {
    return !this.disposed && this.wanted.get(key) === fingerprint
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

  /**
   * Bring the loaded patches in line with `snapshot`. A file whose content changed
   * keeps its old text on screen until the new one arrives; only the files whose own
   * fingerprint changed are read again (an older computer's single fingerprint
   * covers them all).
   */
  sync(snapshot: GitDiffSnapshot): void {
    if (this.disposed) return
    const d = snapshot.deferred
    const wanted = new Map<string, string>()
    const fromPaths = new Map<string, string | undefined>()
    for (const [side, prefix] of [
      ['unstaged', 'u:'],
      ['staged', 's:']
    ] as const)
      for (const p of d?.[side] ?? []) {
        wanted.set(prefix + p, d?.fingerprints?.[side][p] ?? `all:${d?.fingerprint ?? ''}`)
        fromPaths.set(prefix + p, d?.renamedFrom[p])
      }
    for (const p of snapshot.untrackedFiles) wanted.set(`?:${p}`, UNTRACKED)
    this.wanted = wanted
    this.fromPaths = fromPaths
    for (const [k, fp] of [...this.pending]) if (wanted.get(k) !== fp) this.pending.delete(k)
    this.update((texts) => {
      for (const k of [...texts.keys()])
        if (!wanted.has(k)) {
          texts.delete(k)
          this.sources.delete(k)
          this.loadedAt.delete(k)
        }
    })
    this.fetchMissing()
  }

  /** Ask again for a file whose text could not be read. */
  retry(key: string): void {
    if (this.disposed || !this.texts.get(key)?.failed || this.pending.has(key)) return
    this.loadedAt.delete(key)
    this.fetchMissing([key])
  }

  /** Fetch every wanted text not loaded at its fingerprint (and not on its way). */
  private fetchMissing(only?: string[]): void {
    // A failed file was settled at its fingerprint: it waits for a retry or a change.
    const missing = (k: string) =>
      this.wanted.has(k) && !this.pending.has(k) && this.loadedAt.get(k) !== this.wanted.get(k)
    const keys = (only ?? [...this.wanted.keys()]).filter(missing)
    for (const [side, prefix] of [
      [this.range ? 'range' : 'unstaged', 'u:'],
      ['staged', 's:'],
      ['untracked', '?:']
    ] as const) {
      const batch = keys.filter((k) => k.startsWith(prefix))
      if (batch.length) this.run(side, batch, 0)
    }
  }

  /** Record `key`'s text as read at `fingerprint`. */
  private settle(key: string, fingerprint: string, text: DiffText): void {
    this.pending.delete(key)
    this.loadedAt.set(key, fingerprint)
    this.update((texts) => texts.set(key, text))
  }

  /** Fetch `keys` batch by batch until every one is answered (or cannot be). */
  private run(kind: DiffFilesKind, keys: string[], attempt: number): void {
    const asked = new Map(keys.map((k) => [k, this.wanted.get(k)!]))
    for (const [k, fp] of asked) this.pending.set(k, fp)
    const mine = (k: string) =>
      this.pending.get(k) === asked.get(k) && this.current(k, asked.get(k)!)
    this.running++
    const queue = [...keys]
    const step = async (): Promise<void> => {
      while (queue.length && !this.disposed) {
        const batch = queue.splice(0, BATCH_FILES).filter(mine)
        if (!batch.length) continue
        const paths = batch.map((k) => k.slice(2))
        let page: GitFileDiffsPage
        if (kind === 'untracked') {
          const answer = await this.source.untrackedPage(paths)
          page =
            (answer as { $paged?: unknown }).$paged === true
              ? (answer as GitFileDiffsPage)
              : { diffs: answer as Record<string, string>, deferred: [], large: [] }
        } else {
          const from = batch.map((k) => this.fromPaths.get(k) ?? '')
          page = await this.source.filesPage(kind, paths, from.some(Boolean) ? from : undefined)
        }
        if (this.disposed) return
        const prefix = batch[0].slice(0, 2)
        const answered = new Set<string>()
        for (const [p, text] of Object.entries(page.diffs)) {
          const k = prefix + p
          answered.add(k)
          if (mine(k))
            this.settle(k, asked.get(k)!, { text, rest: null, loading: false, failed: false })
        }
        for (const p of page.large) {
          answered.add(prefix + p)
          await this.readFirst(prefix + p, asked.get(prefix + p)!)
        }
        for (const p of page.deferred) answered.add(prefix + p)
        // A file the reply leaves out is gone from disk: nothing to show (the next
        // snapshot drops it).
        for (const k of batch)
          if (!answered.has(k) && mine(k))
            this.settle(k, asked.get(k)!, { text: '', rest: null, loading: false, failed: false })
        // Unanswered files go first in the next request; no progress = stop.
        const progressed = Object.keys(page.diffs).length + page.large.length > 0
        const later = page.deferred.map((p) => prefix + p)
        if (later.length && !progressed) {
          for (const k of later) if (mine(k)) this.pending.delete(k)
          return
        }
        queue.unshift(...later)
      }
    }
    void step()
      .catch(() => {
        const failed = keys.filter(mine)
        for (const k of failed) this.pending.delete(k)
        if (!failed.length || this.disposed) return
        const delay = this.retryDelaysMs[attempt]
        if (delay !== undefined) {
          // Transient (a computer reconnecting): ask again for what is still wanted.
          const timer = setTimeout(() => {
            this.timers.delete(timer)
            if (this.disposed) return
            const again = failed.filter(
              (k) => !this.pending.has(k) && this.current(k, asked.get(k)!)
            )
            if (again.length) this.run(kind, again, attempt + 1)
          }, delay)
          this.timers.add(timer)
          return
        }
        // Out of retries: each file shows its failure and a retry (its old text, if
        // it had one, stays readable under the failure).
        for (const k of failed)
          if (this.current(k, asked.get(k)!)) {
            const old = this.texts.get(k)
            this.loadedAt.set(k, asked.get(k)!)
            this.update((texts) =>
              texts.set(k, { text: old?.text ?? '', rest: null, loading: false, failed: true })
            )
          }
      })
      .finally(() => {
        this.running--
      })
  }

  /** A large file: its first page now, the rest on request. */
  private async readFirst(key: string, fingerprint: string): Promise<void> {
    if (!this.current(key, fingerprint)) return
    const src = this.textSource(key, this.fromPaths.get(key))
    const page = await this.source.text(src, null).catch(() => null)
    if (!this.current(key, fingerprint) || this.pending.get(key) !== fingerprint) return
    this.sources.set(key, src)
    this.settle(
      key,
      fingerprint,
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
  }

  /** Load the rest of a large file (every remaining page). */
  async loadRest(key: string): Promise<void> {
    if (this.disposed) return
    const start = this.texts.get(key)
    const src = this.sources.get(key)
    const fingerprint = this.loadedAt.get(key)
    if (!start?.rest || !src || start.loading || fingerprint === undefined) return
    const entry = { ...start, loading: true, failed: false }
    const current = () =>
      this.current(key, fingerprint) &&
      this.loadedAt.get(key) === fingerprint &&
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
