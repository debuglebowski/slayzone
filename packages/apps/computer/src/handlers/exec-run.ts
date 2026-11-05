/**
 * `exec.run`: one shell command the hub asks this computer to run to completion —
 * an automation's `run_command` / `ai` action. The command runs through `/bin/sh -c`
 * (`cmd /c` on Windows), the same shell the hub's own engine used, in a jailed cwd
 * (T-27): the given one, else the named project's folder ON THIS COMPUTER, else
 * the first allowed root. Its own process group, so a timeout ends the whole tree.
 * Output is captured up to a cap (the hub keeps only a tail anyway).
 *
 * @module computer/handlers/exec-run
 */
import { spawn } from 'node:child_process'
import {
  HubToComputerMethods,
  execRunParamsSchema,
  type ExecRunResult
} from '@slayzone/computer-transport/shared'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnCwd } from '../config'
import { resolveCommand } from './resolve-command'
import type { HandlerContext, HubMethodTable } from './types'

/** Per-stream capture cap: the head is dropped first (the tail says what failed). */
const OUTPUT_CAP = 1024 * 1024
const KILL_GRACE_MS = 2000

function capped(): { push(chunk: string): void; text(): string } {
  let buf = ''
  return {
    push(chunk) {
      buf += chunk
      if (buf.length > OUTPUT_CAP) buf = buf.slice(buf.length - OUTPUT_CAP)
    },
    text: () => buf
  }
}

/**
 * A program the hub named by argv, resolved on this computer: its PATH (as the OS
 * would, PATHEXT on Windows), else under its own home. No shell — args reach the
 * program unsplit — except a Windows `.cmd`/`.bat`, which only cmd.exe can run.
 */
function programInvocation(
  argv: { file: string; args: string[]; homeFallbacks?: string[] },
  cwd: string,
  win: boolean
): { file: string; args: string[] } | null {
  const env = process.env as Record<string, string>
  const resolved =
    resolveCommand(argv.file, env, cwd) ??
    (argv.homeFallbacks ?? [])
      .map((rel) => resolveCommand(join(homedir(), rel), env, cwd))
      .find((p): p is string => p !== null) ??
    null
  if (!resolved) return null
  if (win && /\.(cmd|bat)$/i.test(resolved)) {
    const quote = (a: string) => `"${a.replace(/"/g, '""')}"`
    return {
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', `"${[resolved, ...argv.args].map(quote).join(' ')}"`]
    }
  }
  return { file: resolved, args: argv.args }
}

export function createExecRunHandlers(
  ctx: HandlerContext,
  getProjectPaths?: () => { get(projectId: string): { path: string } | null } | null
): HubMethodTable {
  async function execRun(raw: unknown): Promise<ExecRunResult> {
    const params = execRunParamsSchema.parse(raw)
    const projectDir =
      params.cwd === undefined && params.projectId
        ? getProjectPaths?.()?.get(params.projectId)?.path
        : undefined
    const cwd = spawnCwd(params.cwd ?? projectDir, ctx.config.allowedRoots)
    const win = process.platform === 'win32'
    const invocation = params.argv
      ? programInvocation(params.argv, cwd, win)
      : {
          file: win ? 'cmd.exe' : '/bin/sh',
          args: win ? ['/c', params.command ?? ''] : ['-c', params.command ?? '']
        }
    if (!invocation) {
      return {
        stdout: '',
        stderr: `${params.argv?.file} not found on this computer (PATH or home)`,
        status: 127,
        timedOut: false
      }
    }
    const child = spawn(invocation.file, invocation.args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !win
    })
    const stdout = capped()
    const stderr = capped()
    child.stdout.on('data', (d: Buffer) => stdout.push(d.toString()))
    child.stderr.on('data', (d: Buffer) => stderr.push(d.toString()))

    let timedOut = false
    const signalTree = (sig: NodeJS.Signals): void => {
      try {
        if (!win && child.pid) process.kill(-child.pid, sig)
        else child.kill(sig)
      } catch {
        /* already gone */
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      signalTree('SIGTERM')
      setTimeout(() => signalTree('SIGKILL'), KILL_GRACE_MS).unref?.()
    }, params.timeoutMs)

    return new Promise<ExecRunResult>((resolve) => {
      child.on('close', (code) => {
        clearTimeout(timer)
        // A backgrounded child may still hold the group: end it with its leader.
        if (timedOut) signalTree('SIGKILL')
        resolve({ stdout: stdout.text(), stderr: stderr.text(), status: code, timedOut })
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        resolve({ stdout: '', stderr: err.message, status: null, timedOut: false })
      })
    })
  }

  return { [HubToComputerMethods.execRun]: execRun }
}
