/**
 * Minimal async subprocess helpers for the runner's git handlers. A pared-down
 * mirror of the worktrees domain's `exec-async.ts` (`execAsync`/`execGit`) with
 * the electron/diagnostics coupling removed, so the runner stays a lightweight
 * standalone bundle.
 *
 * @module runner/handlers/exec
 */

import { spawn } from 'node:child_process'

export interface ExecResult {
  stdout: string
  stderr: string
  status: number | null
}

/** Run a subprocess, capturing stdout/stderr. Never rejects on non-zero exit. */
export function execCapture(
  command: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const stdout: string[] = []
    const stderr: string[] = []
    child.stdout.on('data', (d: Buffer) => stdout.push(d.toString()))
    child.stderr.on('data', (d: Buffer) => stderr.push(d.toString()))

    let timer: ReturnType<typeof setTimeout> | undefined
    if (opts.timeoutMs) {
      timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs)
    }

    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ stdout: stdout.join(''), stderr: stderr.join(''), status: code })
    })
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      resolve({ stdout: '', stderr: err.message, status: 1 })
    })
  })
}

/** Run `git <args>` in `cwd`, rejecting on non-zero exit with git's stderr. */
export async function execGit(args: string[], cwd: string): Promise<string> {
  const result = await execCapture('git', args, { cwd })
  if (result.status !== 0) {
    const msg = result.stderr.trim() || `git command failed: git ${args.join(' ')}`
    throw new Error(msg)
  }
  return result.stdout
}
