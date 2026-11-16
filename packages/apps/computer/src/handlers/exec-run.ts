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
import { spawnCwd } from '../path-jail'
import { resolveCommand } from '@slayzone/platform'
import type { HandlerContext, HubMethodTable } from './types'

/** Per-stream capture cap: the head is dropped first (the tail says what failed). */
const OUTPUT_CAP = 1024 * 1024
export const KILL_GRACE_MS = 2000

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
export function programInvocation(
  argv: { file: string; args: string[]; homeFallbacks?: string[] },
  cwd: string,
  platform: NodeJS.Platform = process.platform
): { file: string; args: string[]; windowsVerbatimArguments?: true } | null {
  const env = process.env as Record<string, string>
  const resolved =
    resolveCommand(argv.file, env, cwd, platform) ??
    (argv.homeFallbacks ?? [])
      .map((rel) => resolveCommand(join(homedir(), rel), env, cwd, platform))
      .find((p): p is string => p !== null) ??
    null
  if (!resolved) return null
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(resolved)) {
    // Only cmd.exe runs these. Its line is passed verbatim (Node would re-quote it)
    // and each part quoted for cmd; the args carry no newline (the prompt is stdin).
    const quote = (a: string) => `"${a.replace(/"/g, '""')}"`
    return {
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', `"${[resolved, ...argv.args].map(quote).join(' ')}"`],
      windowsVerbatimArguments: true
    }
  }
  return { file: resolved, args: argv.args }
}

/**
 * What `exec.run` touches outside itself. Production uses the defaults; tests
 * inject a fake child, a hand-driven clock, or a recorded signal to prove the
 * timeout/kill contract without racing a wall clock.
 */
export interface ExecRunDeps {
  spawn?: typeof spawn
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** Signal a whole process group (POSIX). */
  killGroup?: (pgid: number, sig: NodeJS.Signals) => void
}

export function createExecRunHandlers(
  ctx: HandlerContext,
  getProjectPaths?: () => { get(projectId: string): { path: string } | null } | null,
  deps: ExecRunDeps = {}
): HubMethodTable {
  const spawnChild = deps.spawn ?? spawn
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer =
    deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const killGroup =
    deps.killGroup ?? ((pgid: number, sig: NodeJS.Signals) => process.kill(-pgid, sig))
  async function execRun(raw: unknown): Promise<ExecRunResult> {
    const params = execRunParamsSchema.parse(raw)
    const projectDir =
      params.cwd === undefined && params.projectId
        ? getProjectPaths?.()?.get(params.projectId)?.path
        : undefined
    const cwd = spawnCwd(params.cwd ?? projectDir, ctx.config.allowedRoots)
    const win = process.platform === 'win32'
    const invocation = params.argv
      ? programInvocation(params.argv, cwd)
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
    const stdin = params.argv?.stdin
    const child = spawnChild(invocation.file, invocation.args, {
      cwd,
      env: process.env,
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      detached: !win,
      ...('windowsVerbatimArguments' in invocation ? { windowsVerbatimArguments: true } : {})
    })
    if (stdin !== undefined && child.stdin) {
      // A program that exits without reading it closes the pipe: not an error here.
      child.stdin.on('error', () => undefined)
      child.stdin.end(stdin)
    }
    const stdout = capped()
    const stderr = capped()
    // Decoded as one stream (M4): per chunk, a character split across two pipe
    // chunks came out as U+FFFD.
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => stdout.push(d))
    child.stderr?.on('data', (d: string) => stderr.push(d))

    let timedOut = false
    const signalTree = (sig: NodeJS.Signals): void => {
      try {
        if (!win && child.pid) killGroup(child.pid, sig)
        else child.kill(sig)
      } catch {
        /* already gone */
      }
    }
    const timer = setTimer(() => {
      timedOut = true
      signalTree('SIGTERM')
      ;(setTimer(() => signalTree('SIGKILL'), KILL_GRACE_MS) as { unref?: () => void })?.unref?.()
    }, params.timeoutMs)

    return new Promise<ExecRunResult>((resolve) => {
      child.on('close', (code) => {
        clearTimer(timer)
        // A backgrounded child may still hold the group: end it with its leader.
        if (timedOut) signalTree('SIGKILL')
        resolve({ stdout: stdout.text(), stderr: stderr.text(), status: code, timedOut })
      })
      child.on('error', (err) => {
        clearTimer(timer)
        resolve({ stdout: '', stderr: err.message, status: null, timedOut: false })
      })
    })
  }

  return { [HubToComputerMethods.execRun]: execRun }
}
