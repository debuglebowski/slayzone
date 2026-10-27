// eslint-disable-next-line no-restricted-imports -- KNOWN DEBT: hubSpawnSync runs worktree setup scripts + submodule update synchronously and can block the hub for minutes; convert callers to hubSpawn.
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { basename } from 'path'
import { recordDiagnosticEvent } from '@slayzone/diagnostics/server'
import type { DiagnosticSource } from '@slayzone/diagnostics/shared'
import { mergePathLists } from '@slayzone/platform'
import { assertHubLocalExecEnabled } from '@slayzone/platform/hub-switch-refusal'
import { getEnrichedPath } from '@slayzone/terminal/server'

/**
 * The ONE place this package starts a process. Everything here runs on the hub's
 * own machine (git, `gh`, setup scripts, the AI merge CLI), so on a hub with
 * `SLAYZONE_HUB_ENABLE_PROCESSES=0` each call is refused before anything spawns
 * (T-06, `NO_COMPUTER_CONNECTED`). Inside a `new Promise` executor the refusal
 * becomes a rejection; a sync caller gets the throw.
 */
function refuseOnSwitchedOffHub(command: string): void {
  assertHubLocalExecEnabled({ op: 'exec', detail: { command: basename(command) } })
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
  const enrichedPath = getEnrichedPath()
  if (!enrichedPath) return rest
  const env = options.env ?? process.env
  const next = [...rest]
  next[at] = { ...options, env: { ...env, PATH: mergePathLists(enrichedPath, env.PATH) } }
  return next
}

/** `spawn` with the login-shell PATH, refused first on a hub with processes switched off. */
export const hubSpawn = ((command: string, ...rest: unknown[]): ChildProcess => {
  refuseOnSwitchedOffHub(command)
  return (spawn as (...a: unknown[]) => ChildProcess)(command, ...withLoginShellPath(rest))
}) as typeof spawn

/** `spawnSync` with the login-shell PATH, refused first on a hub with processes switched off. */
export const hubSpawnSync = ((command: string, ...rest: unknown[]) => {
  refuseOnSwitchedOffHub(command)
  return (spawnSync as (...a: unknown[]) => unknown)(command, ...withLoginShellPath(rest))
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
}

/** Async subprocess execution — won't block the main process. */
export function execAsync(
  command: string,
  args: string[],
  opts: { cwd?: string; timeout?: number; source?: DiagnosticSource } = {}
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const label = `${command} ${args.join(' ')}`
    const source = opts.source ?? 'git'
    const startedAt = Date.now()
    const child = hubSpawn(command, args, {
      cwd: opts.cwd,
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

      recordDiagnosticEvent({
        level: code === 0 ? 'info' : 'error',
        source,
        event: code === 0 ? `${source}.command` : `${source}.command_failed`,
        message: code === 0 ? label : stderrStr.trim() || `command failed: ${label}`,
        payload: {
          command: label,
          cwd: opts.cwd,
          durationMs,
          success: code === 0,
          exitCode: code,
          ...(code !== 0 && { stderr: trimOutput(stderrStr), stdout: trimOutput(stdoutStr) })
        }
      })

      resolve({ stdout: stdoutStr, stderr: stderrStr, status: code })
    })
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      resolve({ stdout: '', stderr: err.message, status: 1 })
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
