import { spawn } from 'child_process'
import { recordDiagnosticEvent } from '@slayzone/diagnostics/main'
import type { DiagnosticSource } from '@slayzone/diagnostics/shared'

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
    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const stdout: string[] = []
    const stderr: string[] = []
    child.stdout.on('data', (data: Buffer) => stdout.push(data.toString()))
    child.stderr.on('data', (data: Buffer) => stderr.push(data.toString()))

    let timer: ReturnType<typeof setTimeout> | undefined
    if (opts.timeout) {
      timer = setTimeout(() => { child.kill('SIGTERM') }, opts.timeout)
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
        message: code === 0 ? label : (stderrStr.trim() || `command failed: ${label}`),
        payload: {
          command: label, cwd: opts.cwd, durationMs, success: code === 0, exitCode: code,
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
      const error = new Error(errMsg) as Error & { status: number | null; stderr: string; stdout: string }
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
  return execGit([...args, '-z'], options).then(out => out.split('\0').filter(Boolean))
}
