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
 *   - Its directory is a protected path (`setProtectedPaths` in config.ts), so no
 *     fs/git/proc frame can name it even when an allowed root contains it.
 *   - Append-only by construction: every write opens with `O_APPEND`, and the file
 *     and its directory are created `0600` / `0700` in the computer's own state dir.
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

import { chmodSync, closeSync, mkdirSync, openSync, renameSync, statSync, writeSync } from 'node:fs'
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
  /** Append one line. Never throws: a full disk must not fail the request. */
  record(entry: RequestLogEntry): void
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
  'signal'
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

  const rotate = (): void => {
    for (let i = keep - 1; i >= 1; i--) {
      try {
        renameSync(`${filePath}.${i}`, `${filePath}.${i + 1}`)
      } catch {
        /* that generation does not exist yet */
      }
    }
    renameSync(filePath, `${filePath}.1`)
    size = 0
  }

  const append = (line: string): void => {
    const fd = openSync(filePath, 'a', 0o600)
    try {
      writeSync(fd, line)
    } finally {
      closeSync(fd)
    }
    size += Buffer.byteLength(line)
  }

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
        if (size > 0 && size + Buffer.byteLength(line) > maxBytes) rotate()
        append(line)
      } catch (err) {
        // Never fail a request over its log line; say so on the computer's stdout log.
        opts.onError?.(err)
      }
    }
  }
}
