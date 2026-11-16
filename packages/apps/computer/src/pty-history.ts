/**
 * Task terminal history that outlives the computer process.
 *
 * A terminal's scrollback is the session's RingBuffer, in this process's memory —
 * so an app or computer restart used to bring every shell tab back to a bare
 * prompt. This keeps a copy on disk. The next start of the same session — with
 * nothing on the hub's screen to continue (`carryOutput` with its old buffer at
 * hand) and no agent resume that reprints its own conversation — begins with that
 * output, the terminal state a dead program left behind undone, and a divider.
 *
 * HOW IT IS WRITTEN: an append log in the buffer's replay-ready form. The first
 * write is the whole buffer (`toString()`, the same cap as the scrollback); after
 * that, at most once per `flushMs` while output changes, only the chunks printed
 * since the last write are appended. A whole rewrite happens again only when the
 * appends no longer continue the buffer (it was cleared, or more than its cap went
 * by between two writes) or the file has grown to twice the larger of its last
 * whole write and {@link COMPACT_FLOOR_CHARS} (compaction). So the bytes written
 * are bounded by what the terminal printed — an agent's spinner costs its own few
 * bytes a frame, not the whole scrollback a second — plus at most as much again
 * for compaction, plus one whole buffer per session start; and the file stays under
 * ~2× the scrollback cap. A whole write goes to a temp file unique to this process
 * and write (`<file>.<pid>.<n>.tmp`), is fsynced, and is renamed into place from the
 * main thread; appends go through a descriptor opened on that file. So the
 * synchronous shutdown write ({@link PtyHistoryTracker.flushSync}) and the async
 * writes never share a temp file, and an async write still in flight when it runs
 * lands in the replaced copy or is discarded — never over the newer file.
 *
 * WHAT A CRASH LOSES: a computer process that dies loses at most the output of the
 * last `flushMs` (1 s by default) plus one write in flight. A clean shutdown loses
 * nothing (`flushSync`). An OS crash or power loss can also lose appends the OS had
 * not yet written back (they are not fsynced); a whole write is fsynced before it
 * replaces the file, so the file is never left empty or torn by a rewrite.
 *
 * WHERE: `<dir>/<taskId>/<sha256(sessionId)>.txt` under the computer's own state dir,
 * one dir per hub (the caller scopes `dir`), mode 0700/0600. Never the hub's DB, and
 * nothing here is sent anywhere: the output reaches the hub exactly as scrollback
 * always has, as terminal output.
 *
 * GONE WHEN: the hub kills the session (closing a tab, restarting a terminal — the
 * same moments the in-memory buffer was dropped), the hub deletes the tab
 * (`pty.forget`), the task is purged (lifecycle `deleted`; a trashed task keeps it
 * for a restore), or it goes unused for `maxAgeMs` (a backstop for a tab deleted
 * while this computer was offline).
 *
 * @module computer/pty-history
 */
import { createHash } from 'node:crypto'
import {
  appendFile,
  appendFileSync,
  close,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { mkdir, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

/** What the divider line says (tests and the e2e look for it). */
export const PTY_HISTORY_DIVIDER_TEXT = 'Restored output · the terminal restarted below'

const DEFAULT_FLUSH_MS = 1000
const DEFAULT_MAX_AGE_MS = 30 * 24 * 3600 * 1000
/**
 * The file is rewritten whole once it reaches twice the larger of this and its last
 * whole write: a small buffer's log does not compact on every few lines.
 */
export const COMPACT_FLOOR_CHARS = 256 * 1024
/** A temp file this old was left by a write that never finished (a crash). */
const STALE_TMP_MS = 10 * 60_000
/** Unique per process: no two writes ever share a temp file. */
let tmpCounter = 0
/** A task id is one path segment: anything else is never persisted. */
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/

/**
 * What a program that died mid-run left switched on, switched off before new output
 * lands under it: the alternate screen (only when it was left on — `?1049l` also
 * restores a saved cursor, which on the main screen would jump the divider), mouse
 * and focus reporting, bracketed paste, application cursor keys and keypad, the
 * kitty keyboard flags, a hidden cursor, the scroll region and attributes.
 */
function resetLeftoverModes(output: string): string {
  const altOn = output.lastIndexOf('\x1b[?1049h')
  const altOff = output.lastIndexOf('\x1b[?1049l')
  return (
    (altOn > altOff ? '\x1b[?1049l' : '') +
    '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?1004l\x1b[?2004l' +
    '\x1b[?1l\x1b>\x1b[=0;1u\x1b[?25h\x1b[r\x1b[0m'
  )
}

/** The bytes a restored session starts with: its old output, made safe, then the divider. */
export function restoredPrefix(saved: string): string {
  return `${saved}${resetLeftoverModes(saved)}\r\n\x1b[2m── ${PTY_HISTORY_DIVIDER_TEXT} ──\x1b[0m\r\n`
}

/** The session's buffer as the history reads it (a RingBuffer). */
export interface PtyHistorySource {
  /** The whole buffer, replay-ready. */
  toString(): string
  /** Chunks after `afterSeq`, verbatim. */
  getChunksSince(afterSeq: number): ReadonlyArray<{ seq: number; data: string }>
  getCurrentSeq(): number
}

export interface PtyHistoryTracker {
  /** The buffer grew: write what is new within `flushMs`. */
  changed(): void
  /** The buffer was changed in place (cleared, rewritten): the next write is whole. */
  rewritten(): void
  /** Write now, synchronously (shutdown). */
  flushSync(): void
  /** Write what is pending, then stop. */
  close(): Promise<void>
  /** Stop without writing (the output is being forgotten). */
  cancel(): Promise<void>
}

export interface PtyHistory {
  /** The saved output of `sessionId`, or null. */
  load(taskId: string, sessionId: string): string | null
  /** Keep `source` on disk while the session runs. Null for an unsafe task id. */
  track(taskId: string, sessionId: string, source: PtyHistorySource): PtyHistoryTracker | null
  forget(taskId: string, sessionId: string): Promise<void>
  forgetTask(taskId: string): Promise<void>
  /** Remove history unused for `maxAgeMs`, temp files a crash left, and task dirs left empty. */
  sweep(): Promise<void>
}

/** What the file at the path holds, as this tracker wrote it. */
interface OnDisk {
  /** Opened for append on the file as it was renamed into place. */
  fd: number
  /** The last chunk in it. */
  seq: number
  /** Its length (chars) and that of its last whole write. */
  chars: number
  wholeChars: number
}

type WritePlan = { whole: boolean; data: string; seq: number }

/**
 * Where one hub's task terminal history lives under a computer's state dir:
 * `<stateDir>/computer-runtime/pty-history/<sha256(hubScope) hex, 24 chars>`. The ONE
 * definition — the live computer writes there (main.ts) and offline erasure deletes
 * there (offline-erasure.ts), so the two can never name different folders.
 */
export function ptyHistoryDir(stateDir: string, hubScope: string): string {
  return join(
    stateDir,
    'computer-runtime',
    'pty-history',
    createHash('sha256').update(hubScope).digest('hex').slice(0, 24)
  )
}

const appendTo = (fd: number, data: string): Promise<void> =>
  new Promise((resolve, reject) => appendFile(fd, data, (err) => (err ? reject(err) : resolve())))
const closeFd = (fd: number): Promise<void> => new Promise((resolve) => close(fd, () => resolve()))

export function createPtyHistory(opts: {
  dir: string
  flushMs?: number
  maxAgeMs?: number
}): PtyHistory {
  const flushMs = opts.flushMs ?? DEFAULT_FLUSH_MS
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  const taskDir = (taskId: string) => join(opts.dir, taskId)
  const fileOf = (taskId: string, sessionId: string) =>
    join(
      taskDir(taskId),
      `${createHash('sha256').update(sessionId).digest('hex').slice(0, 40)}.txt`
    )
  const tmpOf = (file: string) => `${file}.${process.pid}.${++tmpCounter}.tmp`
  /** One write chain per file, so a forget never races a write that recreates it. */
  const chains = new Map<string, Promise<void>>()
  const queue = (file: string, work: () => Promise<void>): Promise<void> => {
    const next = (chains.get(file) ?? Promise.resolve()).then(work, work)
    const settled = next.catch(() => {
      // The caller sees the failure through `next`; the chain only orders work.
    })
    chains.set(file, settled)
    void settled.then(() => {
      if (chains.get(file) === settled) chains.delete(file)
    })
    return next
  }

  return {
    load(taskId, sessionId) {
      if (!SAFE_TASK_ID.test(taskId)) return null
      try {
        const saved = readFileSync(fileOf(taskId, sessionId), 'utf8')
        return saved.length > 0 ? saved : null
      } catch {
        return null
      }
    },

    track(taskId, sessionId, source) {
      if (!SAFE_TASK_ID.test(taskId)) return null
      const file = fileOf(taskId, sessionId)
      let timer: ReturnType<typeof setTimeout> | undefined
      let stopped = false
      /** Bumped by `flushSync`: an async write begun before it must not land after it. */
      let generation = 0
      /** Async writes queued or running. */
      let inFlight = 0
      let disk: OnDisk | undefined
      let wholeNext = false

      /** What the next write is: the new chunks, or the whole buffer. Null = nothing new. */
      const plan = (): WritePlan | null => {
        const seq = source.getCurrentSeq()
        if (disk && !wholeNext) {
          if (seq === disk.seq) return null
          const chunks = source.getChunksSince(disk.seq)
          // Contiguous from the last chunk on disk: nothing evicted or cut in between.
          if (chunks.length === seq - disk.seq && chunks[0]?.seq === disk.seq + 1) {
            const data = chunks.map((c) => c.data).join('')
            if (disk.chars + data.length <= 2 * Math.max(disk.wholeChars, COMPACT_FLOOR_CHARS))
              return { whole: false, data, seq }
          }
        }
        return { whole: true, data: source.toString(), seq }
      }

      /**
       * Put a fully written temp file in place and append to it from now on. Sync, so
       * nothing interleaves: the descriptor is the file just renamed into place. On a
       * failure nothing is left to append to — the next write is whole again.
       */
      const install = (tmp: string, p: WritePlan, closePrevious: (fd: number) => void): void => {
        const previous = disk
        disk = undefined
        if (previous) closePrevious(previous.fd)
        try {
          renameSync(tmp, file)
        } catch (err) {
          rmSync(tmp, { force: true })
          throw err
        }
        disk = {
          fd: openSync(file, 'a'),
          seq: p.seq,
          chars: p.data.length,
          wholeChars: p.data.length
        }
      }

      const writeAsync = (): Promise<void> => {
        timer = undefined
        if (stopped) return Promise.resolve()
        const gen = generation
        inFlight++
        return queue(file, async () => {
          try {
            if (stopped || gen !== generation) return
            const p = plan()
            if (!p) return
            if (!p.whole) {
              const target = disk as OnDisk
              try {
                await appendTo(target.fd, p.data)
              } catch (err) {
                // Part of it may have landed: start over from a whole copy.
                if (disk === target) wholeNext = true
                throw err
              }
              // Replaced meanwhile (`flushSync`): this went to the old copy.
              if (disk !== target) return
              target.seq = p.seq
              target.chars += p.data.length
              return
            }
            wholeNext = false
            const tmp = tmpOf(file)
            try {
              await mkdir(taskDir(taskId), { recursive: true, mode: 0o700 })
              await writeFile(tmp, p.data, { mode: 0o600, flush: true })
            } catch (err) {
              wholeNext = true
              await rm(tmp, { force: true })
              throw err
            }
            // Stopped, or a newer copy was written synchronously meanwhile: discard.
            if (stopped || gen !== generation) {
              await rm(tmp, { force: true })
              return
            }
            // Nothing else of this tracker writes to the old descriptor (one chain).
            install(tmp, p, (fd) => void closeFd(fd))
          } finally {
            inFlight--
          }
        })
      }

      const release = (): Promise<void> => {
        const last = disk
        disk = undefined
        return last ? queue(file, () => closeFd(last.fd)) : (chains.get(file) ?? Promise.resolve())
      }

      return {
        changed() {
          // Throttle, not debounce: steady output still writes once per `flushMs`.
          if (stopped || timer) return
          timer = setTimeout(() => {
            void writeAsync().catch(() => {
              // A failed write leaves the previous copy; the next change retries.
            })
          }, flushMs)
          timer.unref?.()
        },
        rewritten() {
          wholeNext = true
        },
        flushSync() {
          if (stopped) return
          if (timer) clearTimeout(timer)
          timer = undefined
          // Whatever async write is in flight must not land over this one.
          generation++
          try {
            // With an async write in flight (now discarded, or landing in the copy this
            // replaces) the buffer is written whole; otherwise only what is new.
            const p =
              inFlight > 0
                ? { whole: true, data: source.toString(), seq: source.getCurrentSeq() }
                : plan()
            if (!p) return
            if (!p.whole && disk) {
              appendFileSync(disk.fd, p.data)
              disk.seq = p.seq
              disk.chars += p.data.length
              return
            }
            mkdirSync(taskDir(taskId), { recursive: true, mode: 0o700 })
            const tmp = tmpOf(file)
            try {
              writeFileSync(tmp, p.data, { mode: 0o600, flush: true })
            } catch (err) {
              rmSync(tmp, { force: true })
              throw err
            }
            wholeNext = false
            // An async append may still be writing to the old descriptor: closed after it.
            install(tmp, p, (fd) => void queue(file, () => closeFd(fd)))
          } catch {
            // Shutting down: nothing to report to. The next write is whole.
            wholeNext = true
          }
        },
        async close() {
          if (stopped) return
          if (timer) clearTimeout(timer)
          await writeAsync().catch(() => {
            // The previous copy stays; nothing to report to at close.
          })
          stopped = true
          await release()
        },
        async cancel() {
          stopped = true
          if (timer) clearTimeout(timer)
          timer = undefined
          await release()
        }
      }
    },

    async forget(taskId, sessionId) {
      if (!SAFE_TASK_ID.test(taskId)) return
      const file = fileOf(taskId, sessionId)
      await queue(file, async () => {
        await rm(file, { force: true })
        // Temp files of writes that never finished (`<file>.<pid>.<n>.tmp`; older: `<file>.tmp`).
        const prefix = `${basename(file)}.`
        const left = await readdir(taskDir(taskId)).catch(() => [] as string[])
        await Promise.all(
          left
            .filter((f) => f.startsWith(prefix) && f.endsWith('.tmp'))
            .map((f) => rm(join(taskDir(taskId), f), { force: true }))
        )
      })
      await rmdir(taskDir(taskId)).catch(() => {
        // Not empty (other tabs), or already gone.
      })
    },

    async forgetTask(taskId) {
      if (!SAFE_TASK_ID.test(taskId)) return
      await Promise.all([...chains.entries()].map(([, p]) => p))
      await rm(taskDir(taskId), { recursive: true, force: true })
    },

    async sweep() {
      const cutoff = Date.now() - maxAgeMs
      const tmpCutoff = Date.now() - STALE_TMP_MS
      let tasks: string[]
      try {
        tasks = await readdir(opts.dir)
      } catch {
        return
      }
      for (const task of tasks) {
        const dir = join(opts.dir, task)
        let files: string[]
        try {
          files = await readdir(dir)
        } catch {
          continue
        }
        for (const f of files) {
          const s = await stat(join(dir, f)).catch(() => null)
          if (s && s.mtimeMs < (f.endsWith('.tmp') ? tmpCutoff : cutoff))
            await rm(join(dir, f), { force: true })
        }
        await rmdir(dir).catch(() => {
          // Not empty: some of its history is still in use.
        })
      }
    }
  }
}
