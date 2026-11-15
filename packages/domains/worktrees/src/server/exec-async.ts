// eslint-disable-next-line no-restricted-imports -- KNOWN DEBT: hubSpawnSync runs worktree setup scripts + submodule update synchronously and can block the hub for minutes; convert callers to hubSpawn.
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { createWriteStream } from 'fs'
import { basename } from 'path'
import { recordDiagnosticEvent } from '@slayzone/diagnostics/record'
import type { DiagnosticEvent, DiagnosticSource } from '@slayzone/diagnostics/shared'
import { gitCommand, mergePathLists } from '@slayzone/platform'
import { assertHubLocalExecEnabled } from '@slayzone/platform/hub-switch-refusal'
import { getEnrichedPath } from '@slayzone/terminal/shell-env'

/**
 * Where this package's processes run and what they report to. The defaults are the
 * HUB's: its enriched login-shell PATH, the T-06 refusal (on a hub with
 * `SLAYZONE_HUB_ENABLE_PROCESSES=0` every spawn is refused before it starts,
 * `NO_COMPUTER_CONNECTED`) and its diagnostics store. A computer running the same
 * git ops (`@slayzone/worktrees/git-ops`) supplies its own PATH and log, and no
 * refusal — running them is its job.
 */
export interface GitExecEnvironment {
  /** The PATH to merge in front of the inherited one; null = inherit as is. */
  loginShellPath(): string | null
  /** Throws to refuse starting `command` here. */
  refuse(command: string): void
  diagnostic(event: DiagnosticEvent): void
}

const hubEnvironment: GitExecEnvironment = {
  loginShellPath: () => getEnrichedPath(),
  refuse: (command) =>
    assertHubLocalExecEnabled({ op: 'exec', detail: { command: basename(command) } }),
  diagnostic: (event) => recordDiagnosticEvent(event)
}

let environment: GitExecEnvironment = hubEnvironment

/** Replace (part of) the exec environment; `null` restores the hub's. */
export function configureGitExec(next: Partial<GitExecEnvironment> | null): void {
  environment = next ? { ...hubEnvironment, ...next } : hubEnvironment
}

/** Report through the configured environment (the hub's diagnostics by default). */
export function gitDiagnostic(event: DiagnosticEvent): void {
  environment.diagnostic(event)
}

/**
 * The ONE place this package starts a process — refused first where the
 * environment says so. Inside a `new Promise` executor the refusal becomes a
 * rejection; a sync caller gets the throw.
 */
function refuseOnSwitchedOffHub(command: string): void {
  environment.refuse(command)
}

/**
 * `spawn`'s trailing `(args?, options?)` with the user's login-shell PATH merged into
 * `options.env` (or the inherited env). A hub started from the Dock or a service
 * manager has the OS's bare PATH, so `gh` and the tools a repo's git hooks call
 * (Git LFS) — installed via Homebrew, nvm, … — would not resolve.
 */
function withLoginShellPath(rest: unknown[]): unknown[] {
  const at = Array.isArray(rest[0]) ? 1 : 0
  const options = (rest[at] ?? {}) as { env?: NodeJS.ProcessEnv }
  const enrichedPath = environment.loginShellPath()
  if (!enrichedPath) return rest
  const env = options.env ?? process.env
  const next = [...rest]
  next[at] = { ...options, env: { ...env, PATH: mergePathLists(enrichedPath, env.PATH) } }
  return next
}

/**
 * `git` → its absolute path on the PATH the child gets (gitCommand, cached): a bare
 * name makes the OS try every PATH entry on every spawn. Any other command as is.
 */
function resolveGit(command: string, args: unknown[]): string {
  if (command !== 'git') return command
  const options = (args[Array.isArray(args[0]) ? 1 : 0] ?? {}) as { env?: NodeJS.ProcessEnv }
  return gitCommand(options.env ?? process.env)
}

/** `spawn` with the login-shell PATH, refused first on a hub with processes switched off. */
export const hubSpawn = ((command: string, ...rest: unknown[]): ChildProcess => {
  refuseOnSwitchedOffHub(command)
  const args = withLoginShellPath(rest)
  return (spawn as (...a: unknown[]) => ChildProcess)(resolveGit(command, args), ...args)
}) as typeof spawn

/** `spawnSync` with the login-shell PATH, refused first on a hub with processes switched off. */
export const hubSpawnSync = ((command: string, ...rest: unknown[]) => {
  refuseOnSwitchedOffHub(command)
  const args = withLoginShellPath(rest)
  return (spawnSync as (...a: unknown[]) => unknown)(resolveGit(command, args), ...args)
}) as typeof spawnSync

export function trimOutput(value: unknown, maxLength = 1200): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized) return null
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength)}...[trimmed:${normalized.length - maxLength}]`
}

export interface ExecResult {
  stdout: string
  stderr: string
  status: number | null
  /** Set when the process could not be STARTED (fd exhaustion, binary missing, bad
   *  cwd) — the command never ran, so stdout/stderr/status are not its answer. */
  spawnError?: string
}

/** Async subprocess execution — won't block the main process. */
export function execAsync(
  command: string,
  args: string[],
  opts: {
    cwd?: string
    timeout?: number
    source?: DiagnosticSource
    /** Exit codes that are a normal answer, logged as a command — not a failure (e.g.
     *  `git diff --no-index` exits 1 when the files differ). Default `[0]`. */
    okExitCodes?: readonly number[]
  } = {}
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const label = `${command} ${args.join(' ')}`
    const source = opts.source ?? 'git'
    const startedAt = Date.now()
    const child = hubSpawn(command, args, {
      cwd: opts.cwd,
      // No opportunistic index writes from reads: plain `git status` rewrites
      // `.git/index` on every run while a tracked file is newer than the index, and
      // the panel's fs watcher sees that write → re-reads → rewrites → a refresh loop.
      // Commands that need the lock (add, commit, …) still take it.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const stdout: string[] = []
    const stderr: string[] = []
    child.stdout.on('data', (data: Buffer) => stdout.push(data.toString()))
    child.stderr.on('data', (data: Buffer) => stderr.push(data.toString()))

    let timer: ReturnType<typeof setTimeout> | undefined
    if (opts.timeout) {
      timer = setTimeout(() => {
        child.kill('SIGTERM')
      }, opts.timeout)
    }

    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      const durationMs = Date.now() - startedAt
      const stdoutStr = stdout.join('')
      const stderrStr = stderr.join('')
      const ok = code !== null && (opts.okExitCodes ?? [0]).includes(code)

      gitDiagnostic({
        level: ok ? 'info' : 'error',
        source,
        event: ok ? `${source}.command` : `${source}.command_failed`,
        message: ok ? label : stderrStr.trim() || `command failed: ${label}`,
        payload: {
          command: label,
          cwd: opts.cwd,
          durationMs,
          success: ok,
          exitCode: code,
          ...(!ok && { stderr: trimOutput(stderrStr), stdout: trimOutput(stdoutStr) })
        }
      })

      resolve({ stdout: stdoutStr, stderr: stderrStr, status: code })
    })
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      // A spawn failure never reaches 'close' with a real exit, so log it here — an
      // fd-exhausted hub otherwise fails every git call with nothing in diagnostics.
      gitDiagnostic({
        level: 'error',
        source,
        event: `${source}.spawn_failed`,
        message: `could not start ${command}: ${err.message}`,
        payload: { command: label, cwd: opts.cwd, durationMs: Date.now() - startedAt }
      })
      resolve({ stdout: '', stderr: err.message, status: 1, spawnError: err.message })
    })
  })
}

/** Async git execution — rejects on non-zero exit. */
export function execGit(args: string[], options: { cwd: string }): Promise<string> {
  return execAsync('git', args, { cwd: options.cwd }).then((result) => {
    if (result.status !== 0) {
      const errMsg = result.stderr.trim() || `git command failed: git ${args.join(' ')}`
      const error = new Error(errMsg) as Error & {
        status: number | null
        stderr: string
        stdout: string
      }
      error.status = result.status
      error.stderr = result.stderr
      error.stdout = result.stdout
      throw error
    }
    return result.stdout
  })
}

/** Like execGit, but appends -z for NUL-delimited output and returns a parsed filename array. */
export function execGitFileList(args: string[], options: { cwd: string }): Promise<string[]> {
  return execGit([...args, '-z'], options).then((out) => out.split('\0').filter(Boolean))
}

/**
 * `git <args> -z` whose NUL-delimited output is handed to `onPath` entry by entry as
 * it streams — never joined into one string (a repo's ignored files can run to
 * hundreds of MB). Each read chunk is parsed on its own tick, so a long listing
 * never holds the event loop. Rejects like {@link execGit} on a non-zero exit.
 */
export function streamGitPaths(
  args: string[],
  options: { cwd: string },
  onPath: (path: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const fullArgs = [...args, '-z']
    const label = `git ${fullArgs.join(' ')}`
    const startedAt = Date.now()
    const child = hubSpawn('git', fullArgs, {
      cwd: options.cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let pending: Buffer = Buffer.alloc(0)
    let count = 0
    const stderr: string[] = []
    child.stdout.on('data', (chunk: Buffer) => {
      let buf = pending.length ? Buffer.concat([pending, chunk]) : chunk
      let at = buf.indexOf(0)
      while (at !== -1) {
        if (at > 0) {
          onPath(buf.toString('utf8', 0, at))
          count++
        }
        buf = buf.subarray(at + 1)
        at = buf.indexOf(0)
      }
      // Copy the tail: a subarray would pin the whole chunk.
      pending = Buffer.from(buf)
    })
    child.stderr.on('data', (data: Buffer) => stderr.push(data.toString()))
    child.on('error', (err) => {
      gitDiagnostic({
        level: 'error',
        source: 'git',
        event: 'git.spawn_failed',
        message: `could not start git: ${err.message}`,
        payload: { command: label, cwd: options.cwd, durationMs: Date.now() - startedAt }
      })
      reject(err)
    })
    child.on('close', (code) => {
      if (pending.length) onPath(pending.toString('utf8'))
      const ok = code === 0
      const stderrStr = stderr.join('')
      gitDiagnostic({
        level: ok ? 'info' : 'error',
        source: 'git',
        event: ok ? 'git.command' : 'git.command_failed',
        message: ok ? label : stderrStr.trim() || `command failed: ${label}`,
        payload: {
          command: label,
          cwd: options.cwd,
          durationMs: Date.now() - startedAt,
          success: ok,
          exitCode: code,
          entries: count,
          ...(!ok && { stderr: trimOutput(stderrStr) })
        }
      })
      if (ok) resolve()
      else {
        const error = new Error(stderrStr.trim() || `git command failed: ${label}`) as Error & {
          status: number | null
          stderr: string
        }
        error.status = code
        error.stderr = stderrStr
        reject(error)
      }
    })
  })
}

interface StreamOptions {
  cwd: string
  /** Exit codes that are a normal answer (default `[0]`), as {@link execAsync}. */
  okExitCodes?: readonly number[]
}

/** A non-ok exit, shaped like {@link execGit}'s error. */
function gitFailure(label: string, code: number | null, stderr: string): Error {
  const error = new Error(stderr.trim() || `git command failed: ${label}`) as Error & {
    status: number | null
    stderr: string
  }
  error.status = code
  error.stderr = stderr
  return error
}

/**
 * Run `command args`, handing stdout to `onData` chunk by chunk. `onData` returning
 * false stops it: the process is killed, the rest of its output ignored, and the
 * run counts as answered (`stopped`). A non-ok exit of a run that was not stopped
 * rejects like {@link execGit}. Logged like {@link execAsync}.
 */
function streamCommand(
  command: string,
  args: string[],
  opts: StreamOptions,
  onData: (chunk: Buffer) => boolean
): Promise<{ stopped: boolean; bytes: number; code: number | null }> {
  return new Promise((resolve, reject) => {
    const label = `${command} ${args.join(' ')}`
    const startedAt = Date.now()
    const child = hubSpawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stopped = false
    let bytes = 0
    const stderr: string[] = []
    child.stdout.on('data', (chunk: Buffer) => {
      if (stopped) return
      bytes += chunk.length
      if (!onData(chunk)) {
        stopped = true
        child.kill('SIGTERM')
      }
    })
    child.stderr.on('data', (data: Buffer) => stderr.push(data.toString()))
    child.on('error', (err) => {
      gitDiagnostic({
        level: 'error',
        source: 'git',
        event: 'git.spawn_failed',
        message: `could not start ${command}: ${err.message}`,
        payload: { command: label, cwd: opts.cwd, durationMs: Date.now() - startedAt }
      })
      reject(err)
    })
    child.on('close', (code) => {
      const ok = stopped || (code !== null && (opts.okExitCodes ?? [0]).includes(code))
      const stderrStr = stderr.join('')
      gitDiagnostic({
        level: ok ? 'info' : 'error',
        source: 'git',
        event: ok ? 'git.command' : 'git.command_failed',
        message: ok ? label : stderrStr.trim() || `command failed: ${label}`,
        payload: {
          command: label,
          cwd: opts.cwd,
          durationMs: Date.now() - startedAt,
          success: ok,
          exitCode: code,
          bytes,
          ...(stopped && { stoppedAtBudget: true }),
          ...(!ok && { stderr: trimOutput(stderrStr) })
        }
      })
      if (ok) resolve({ stopped, bytes, code })
      else reject(gitFailure(label, code, stderrStr))
    })
  })
}

/**
 * `command args`'s whole output if it is at most `maxBytes` (UTF-8 bytes), else
 * `complete: false` — the process is stopped as soon as it passes the budget, so a
 * huge output is never held.
 */
export async function readCommandCapped(
  command: string,
  args: string[],
  opts: StreamOptions & { maxBytes: number }
): Promise<{ complete: true; text: string; code: number | null } | { complete: false }> {
  const chunks: Buffer[] = []
  let total = 0
  const { stopped, code } = await streamCommand(command, args, opts, (chunk) => {
    total += chunk.length
    if (total > opts.maxBytes) return false
    chunks.push(chunk)
    return true
  })
  if (stopped) return { complete: false }
  return { complete: true, text: Buffer.concat(chunks).toString('utf8'), code }
}

/** Line starts that open one file's section of a patch. */
const FILE_HEADERS = ['diff --git ', 'diff --cc ', 'diff --combined '].map((h) => Buffer.from(h))

/**
 * `git <args>`'s patch, WHOLE FILES ONLY, up to `maxBytes`: the files whose
 * sections fit (in git's order), and how many. `complete`: the whole patch fit.
 * Past the budget git is stopped; a first file larger than the budget gives an
 * empty text (0 files) — the caller reads such a file on its own, page by page.
 */
export async function readGitPatchFiles(
  args: string[],
  opts: StreamOptions & { maxBytes: number }
): Promise<{ text: string; files: number; complete: boolean }> {
  const chunks: Buffer[] = []
  let total = 0
  const { stopped } = await streamCommand('git', args, opts, (chunk) => {
    total += chunk.length
    chunks.push(chunk)
    return total <= opts.maxBytes
  })
  const all = Buffer.concat(chunks)
  const starts = fileSectionStarts(all)
  if (!stopped) return { text: all.toString('utf8'), files: starts.length, complete: true }
  // The last section that STARTS within the budget ends where the next one starts:
  // every section before that start fits.
  let cut = 0
  let files = 0
  for (let k = 0; k < starts.length && starts[k] <= opts.maxBytes; k++) {
    cut = starts[k]
    files = k
  }
  return { text: all.subarray(0, cut).toString('utf8'), files, complete: false }
}

/** Byte offsets where a file's section of a patch starts (a header at a line start). */
function fileSectionStarts(patch: Buffer): number[] {
  const starts: number[] = []
  for (let i = 0; i < patch.length; i = patch.indexOf(10, i) + 1 || patch.length) {
    if (patch[i] !== 100 /* d */) continue
    if (FILE_HEADERS.some((h) => patch.subarray(i, i + h.length).equals(h))) starts.push(i)
  }
  return starts
}

/**
 * `command args`'s whole output written to `file` (streamed, with back-pressure:
 * never held in memory). Resolves with its size.
 */
export function spoolCommand(
  command: string,
  args: string[],
  opts: StreamOptions,
  file: string
): Promise<number> {
  const out = createWriteStream(file, { mode: 0o600 })
  let pending = Promise.resolve()
  const run = streamCommand(command, args, opts, (chunk) => {
    pending = pending.then(
      () =>
        new Promise<void>((resolve, reject) => {
          out.write(chunk, (err) => (err ? reject(err) : resolve()))
        })
    )
    return true
  })
  return run.then(
    async ({ bytes }) => {
      await pending
      await new Promise<void>((resolve, reject) =>
        out.end((err?: Error | null) => (err ? reject(err) : resolve()))
      )
      return bytes
    },
    async (err) => {
      out.destroy()
      throw err
    }
  )
}
