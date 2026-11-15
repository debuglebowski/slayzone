/**
 * Local append-only request log (T-27): one JSON line per hub → computer request,
 * kept on the computer where the hub cannot read, change or delete it.
 *
 * WHY LOCAL. The hub keeps its own audit log, but the hub is the party this one
 * holds to account: a Cloud Device's user must be able to see what a hub asked
 * their machine to do — and who asked — from a record the hub has no hand in.
 *
 * HOW THE HUB IS KEPT OUT.
 *   - No hub → computer method reads, lists, rotates or clears it. This module
 *     exposes `record` and nothing else; there is no read or truncate API.
 *   - Its directory is a protected path (`setProtectedPaths` in path-jail.ts), so no
 *     fs/git/proc frame can name it even when an allowed root contains it.
 *   - Append-only by construction: every write opens with `O_APPEND`, and the file
 *     and its directory are created `0600` / `0700` in the computer's own state dir.
 *   - Off the request path (FU5 computer stalls): `record` only queues the line; ONE
 *     writer appends the queued lines in order, batched, through `fs.promises` (the
 *     libuv pool), opening the file anew for each batch — so a file a shell removed is
 *     created again, as before. `flush()` waits for what was recorded; `close()` /
 *     process exit write what is still queued synchronously. A hard kill loses at most
 *     the lines of the current turn of the event loop (accepted: orders FU5 Q1).
 *   - Rotated by SIZE, by this module alone: `requests.log` → `.1` … `.{keep}`;
 *     the oldest generation is overwritten. Never on a hub command.
 *   Frame-level only: a shell the hub starts runs as this OS user and can delete
 *   the file like any other. It is a record, not a tamper-proof one — for that,
 *   ship the lines off the machine (the file is plain JSON lines).
 *
 * WHAT A LINE HOLDS. Time, hub host, method, actor (user id + hub route), a target
 * summary (ids, paths, program NAME — see {@link summarizeTarget}), the result,
 * and for a refusal the computer's own reason. Never file contents, argv, env,
 * stdin, terminal input, search queries, or a foreign error text (a git or gh
 * stderr can echo a credential-bearing remote URL).
 *
 * @module computer/request-log
 */

import {
  appendFileSync,
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync
} from 'node:fs'
import { appendFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { RequestActor } from '@slayzone/computer-transport/shared'

export const REQUEST_LOG_DIR_NAME = 'request-log'
export const REQUEST_LOG_FILE_NAME = 'requests.log'
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
const DEFAULT_KEEP = 9

export type RequestResult = 'ok' | 'error' | 'refused'

export interface RequestLogEntry {
  /** Hub host this request came over (a computer may serve several hubs). */
  hub: string
  method: string
  /** `null` = the request carried no valid actor (a pre-v3 hub); it was refused. */
  actor: RequestActor | null
  params: unknown
  result: RequestResult
  /** JSON-RPC error code on `error` / `refused`. */
  code?: number
  /** The computer's own reason, on `refused` only. */
  reason?: string
}

export interface RequestLog {
  /** Absolute path of the live log file. */
  readonly filePath: string
  /**
   * Queue one line; written in order shortly after, off the main thread. Never throws
   * and never touches the disk itself: a full or slow disk must not fail or stall
   * the request.
   */
  record(entry: RequestLogEntry): void
  /** Resolves once every line recorded so far is written (or reported failed). */
  flush(): Promise<void>
  /** Write every queued line now, synchronously (process exit). */
  flushSync(): void
  /** Write what is queued and stop the exit hook. Later lines are still written. */
  close(): Promise<void>
}

/** Live logs, written out synchronously if the process exits without closing them. */
const openLogs = new Set<{ flushSync(): void }>()
let exitHooked = false
function writeOnExit(log: { flushSync(): void }): void {
  openLogs.add(log)
  if (exitHooked) return
  exitHooked = true
  process.on('exit', () => {
    for (const open of openLogs) open.flushSync()
  })
}

const MAX_STRING = 300

function clip(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value
}

/** `/bin/zsh -l` → `zsh`. The program, never its arguments. */
function programName(command: unknown): string | undefined {
  if (typeof command !== 'string') return undefined
  const first = command.trim().split(/\s+/)[0] ?? ''
  const base = first.split(/[\\/]/).pop() ?? ''
  return /^[A-Za-z0-9._+-]{1,64}$/.test(base) ? base : undefined
}

/** `gh pr create …` → `pr create`: leading subcommand words only. */
function ghSubcommand(args: unknown): string | undefined {
  if (!Array.isArray(args)) return undefined
  const words: string[] = []
  for (const a of args.slice(0, 2)) {
    if (typeof a !== 'string' || !/^[a-z][a-z-]{0,31}$/.test(a)) break
    words.push(a)
  }
  return words.length > 0 ? words.join(' ') : undefined
}

/** Id and path keys copied verbatim (clipped). Everything else is dropped. */
const TARGET_KEYS = [
  'sessionId',
  'warmId',
  'watchId',
  'projectId',
  'cwd',
  'path',
  'rootPath',
  'filePath',
  'dirPath',
  'targetPath',
  'oldPath',
  'newPath',
  'srcPath',
  'destPath',
  'absoluteSrc',
  'targetDir',
  'repoPath',
  'projectPath',
  'worktreePath',
  'branch',
  'signal',
  // direct.grant / direct.revoke: the id is safe to keep; the token hash is not kept.
  'grantId'
] as const

/**
 * The part of a request's params that is safe to keep: ids, paths, the program
 * name of a spawn, the subcommand of a `gh` call, the roots of a refused
 * folder-limit change. An allow-list, so a param added later is dropped until
 * someone decides it is safe.
 */
export function summarizeTarget(method: string, params: unknown): Record<string, unknown> {
  if (params === null || typeof params !== 'object') return {}
  const p = params as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of TARGET_KEYS) {
    const v = clip(p[key])
    if (v !== undefined) out[key] = v
  }
  const program = programName(p.command)
  if (program) out.program = program
  if (p.shell === true) out.shell = true
  if (method === 'gh.exec') {
    const sub = ghSubcommand(p.args)
    if (sub) out.subcommand = sub
  }
  if (Array.isArray(p.roots)) {
    out.roots = p.roots
      .slice(0, 20)
      .map(clip)
      .filter((r) => r !== undefined)
  }
  return out
}

/**
 * Open (creating if needed) the request log under `<stateDir>/request-log/`.
 * Creation is synchronous and throws on an unwritable state dir, so a computer
 * that cannot keep its log refuses to start rather than working unlogged.
 */
export function createRequestLog(opts: {
  stateDir: string
  maxBytes?: number
  keep?: number
  now?: () => Date
  /** A line that could not be written (disk full, file removed by a shell). */
  onError?: (err: unknown) => void
}): RequestLog {
  const dir = join(opts.stateDir, REQUEST_LOG_DIR_NAME)
  const filePath = join(dir, REQUEST_LOG_FILE_NAME)
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const keep = Math.max(1, opts.keep ?? DEFAULT_KEEP)
  const now = opts.now ?? (() => new Date())

  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  // Touch with O_APPEND and fix the mode of a file an older run (or umask) left wider.
  closeSync(openSync(filePath, 'a', 0o600))
  chmodSync(filePath, 0o600)
  let size = statSync(filePath).size

  // `size` is the file's size as the queued lines will leave it: rotation is decided
  // per line, when it is queued, by the same rule as before — a line that would pass
  // `maxBytes` starts a new generation — so the generations hold the same lines.
  /** Lines waiting, each batch tagged with whether a rotation must happen before it. */
  const queue: Array<{ rotateFirst: boolean; text: string }> = []
  let writing: Promise<void> | null = null

  const rotateSync = (): void => {
    for (let i = keep - 1; i >= 1; i--) {
      try {
        renameSync(`${filePath}.${i}`, `${filePath}.${i + 1}`)
      } catch {
        /* that generation does not exist yet */
      }
    }
    renameSync(filePath, `${filePath}.1`)
  }
  const rotateAsync = async (): Promise<void> => {
    for (let i = keep - 1; i >= 1; i--) {
      await rename(`${filePath}.${i}`, `${filePath}.${i + 1}`).catch(() => undefined)
    }
    await rename(filePath, `${filePath}.1`)
  }
  const enqueue = (line: string): void => {
    const bytes = Buffer.byteLength(line)
    const rotateFirst = size > 0 && size + bytes > maxBytes
    if (rotateFirst) size = 0
    size += bytes
    const last = queue[queue.length - 1]
    if (last && !rotateFirst) last.text += line
    else queue.push({ rotateFirst, text: line })
  }
  const report = (err: unknown): void => {
    try {
      opts.onError?.(err)
    } catch {
      /* a reporter must not break the writer */
    }
  }
  /** The one writer: drains the queue in order, a batch per append. */
  const drain = async (): Promise<void> => {
    // One turn later: the lines of this turn go out as one batch.
    await new Promise<void>((next) => setImmediate(next))
    for (let batch = queue.shift(); batch; batch = queue.shift()) {
      // A failed rotation (the live file removed by a shell) is reported, never a
      // reason to drop the batch: the append below re-creates the file.
      if (batch.rotateFirst) await rotateAsync().catch(report)
      try {
        await appendFile(filePath, batch.text, { flag: 'a', mode: 0o600 })
      } catch (err) {
        report(err)
      }
    }
  }
  const schedule = (): void => {
    if (writing) return
    writing = drain().finally(() => {
      writing = null
      if (queue.length > 0) schedule()
    })
  }
  const flushSync = (): void => {
    for (let batch = queue.shift(); batch; batch = queue.shift()) {
      if (batch.rotateFirst)
        try {
          rotateSync()
        } catch (err) {
          report(err)
        }
      try {
        appendFileSync(filePath, batch.text, { flag: 'a', mode: 0o600 })
      } catch (err) {
        report(err)
      }
    }
  }
  const handle = { flushSync }
  writeOnExit(handle)

  return {
    filePath,
    record(entry) {
      try {
        const line = `${JSON.stringify({
          ts: now().toISOString(),
          hub: entry.hub,
          method: entry.method,
          actor: entry.actor,
          target: summarizeTarget(entry.method, entry.params),
          result: entry.result,
          ...(entry.code !== undefined ? { code: entry.code } : {}),
          ...(entry.reason !== undefined ? { reason: clip(entry.reason) } : {})
        })}\n`
        enqueue(line)
        schedule()
      } catch (err) {
        // Never fail a request over its log line; say so on the computer's stdout log.
        report(err)
      }
    },
    async flush() {
      while (writing) await writing
    },
    flushSync,
    async close() {
      openLogs.delete(handle)
      while (writing) await writing
      flushSync()
    }
  }
}
