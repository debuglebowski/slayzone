/**
 * Task terminal history that outlives the computer process.
 *
 * A terminal's scrollback is the session's RingBuffer, in this process's memory —
 * so an app or computer restart used to bring every shell tab back to a bare
 * prompt. This keeps a copy on disk: each task terminal's buffer, written whole
 * (`toString()`, the replay-ready form, so the same cap as the scrollback) at most
 * once per `flushMs` while it changes, and synchronously at shutdown. The next start
 * of the same session — with nothing on the hub's screen to continue
 * (`carryOutput`) and no agent resume that reprints its own conversation — begins
 * with that output, the terminal state a dead program left behind undone, and a
 * divider.
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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** What the divider line says (tests and the e2e look for it). */
export const PTY_HISTORY_DIVIDER_TEXT = 'Restored output · the terminal restarted below'

const DEFAULT_FLUSH_MS = 1000
const DEFAULT_MAX_AGE_MS = 30 * 24 * 3600 * 1000
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

export interface PtyHistoryTracker {
  /** The buffer changed: write it within `flushMs`. */
  changed(): void
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
  /** Keep `read()`'s result on disk while the session runs. Null for an unsafe task id. */
  track(taskId: string, sessionId: string, read: () => string): PtyHistoryTracker | null
  forget(taskId: string, sessionId: string): Promise<void>
  forgetTask(taskId: string): Promise<void>
  /** Remove history unused for `maxAgeMs`, and task dirs left empty. */
  sweep(): Promise<void>
}

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

  async function writeAsync(taskId: string, file: string, data: string): Promise<void> {
    await mkdir(opts.dir, { recursive: true, mode: 0o700 })
    await mkdir(taskDir(taskId), { recursive: true, mode: 0o700 })
    const tmp = `${file}.tmp`
    await writeFile(tmp, data, { mode: 0o600 })
    await rename(tmp, file)
  }

  function writeSync(taskId: string, file: string, data: string): void {
    mkdirSync(taskDir(taskId), { recursive: true, mode: 0o700 })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, data, { mode: 0o600 })
    renameSync(tmp, file)
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

    track(taskId, sessionId, read) {
      if (!SAFE_TASK_ID.test(taskId)) return null
      const file = fileOf(taskId, sessionId)
      let timer: ReturnType<typeof setTimeout> | undefined
      let stopped = false
      const write = (): Promise<void> => {
        timer = undefined
        if (stopped) return Promise.resolve()
        return queue(file, () => (stopped ? Promise.resolve() : writeAsync(taskId, file, read())))
      }
      return {
        changed() {
          // Throttle, not debounce: steady output still writes once per `flushMs`.
          if (stopped || timer) return
          timer = setTimeout(() => {
            void write().catch(() => {
              // A failed write leaves the previous copy; the next change retries.
            })
          }, flushMs)
          timer.unref?.()
        },
        flushSync() {
          if (stopped) return
          if (timer) clearTimeout(timer)
          timer = undefined
          try {
            writeSync(taskId, file, read())
          } catch {
            // Shutting down: nothing to report to.
          }
        },
        async close() {
          if (stopped) return
          if (timer) clearTimeout(timer)
          await write().catch(() => {
            // The previous copy stays; nothing to report to at close.
          })
          stopped = true
        },
        async cancel() {
          stopped = true
          if (timer) clearTimeout(timer)
          timer = undefined
          await chains.get(file)
        }
      }
    },

    async forget(taskId, sessionId) {
      if (!SAFE_TASK_ID.test(taskId)) return
      const file = fileOf(taskId, sessionId)
      await queue(file, async () => {
        await rm(file, { force: true })
        await rm(`${file}.tmp`, { force: true })
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
          if (s && s.mtimeMs < cutoff) await rm(join(dir, f), { force: true })
        }
        await rmdir(dir).catch(() => {
          // Not empty: some of its history is still in use.
        })
      }
    }
  }
}
