/**
 * Background-job liveness for claude sessions.
 *
 * Claude can leave work running after a tool call returns: `Bash` with
 * run_in_background (or a foreground command auto-backgrounded on timeout) and
 * `Monitor`. The hub learns each job's id from claude's `PostToolUse` hook, but
 * claude fires NO hook when a job exits on its own — so the hub asks the computer,
 * which owns the process tree, which of those jobs still have a live process.
 *
 * A job is identified among the pty session's DESCENDANTS (claude's own children
 * by ppid — a job that daemonized away is finished as far as claude is concerned):
 *   - shell: stdout is claude's `<…>/tasks/<id>.output` file — exact, id-based.
 *   - monitor: stdout is a pipe, so its command line: claude runs every job as
 *     `<shell> -c "… && eval '<command>' …"` with POSIX single-quote escaping.
 *     Also the fallback for a shell job whose stdout could not be read.
 * A match that stops working (claude changes its wrapper) reads as "exited":
 * the indicator disappears rather than sticking.
 *
 * @module computer/background-jobs
 */

import { execFile } from 'node:child_process'
import { readlink } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface BackgroundJobProbe {
  id: string
  kind: 'shell' | 'monitor'
  command: string | null
}

export interface ProcRow {
  pid: number
  ppid: number
  args: string
}

const EXEC_TIMEOUT_MS = 5_000

/** `cmd` as claude passes it to `eval`: single-quoted, `'` → `'"'"'`. */
export function claudeEvalArg(cmd: string): string {
  return `'${cmd.replace(/'/g, `'"'"'`)}'`
}

/** Parse `ps -A -ww -o pid=,ppid=,args=` output. */
export function parsePsRows(out: string): ProcRow[] {
  const rows: ProcRow[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line)
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3].trim() })
  }
  return rows
}

/** Every process below `rootPid` (breadth-first, root excluded). */
export function descendantsOf(rootPid: number, rows: ProcRow[]): ProcRow[] {
  const byParent = new Map<number, ProcRow[]>()
  for (const r of rows) {
    const list = byParent.get(r.ppid)
    if (list) list.push(r)
    else byParent.set(r.ppid, [r])
  }
  const out: ProcRow[] = []
  const queue = [rootPid]
  const seen = new Set(queue)
  while (queue.length > 0) {
    for (const child of byParent.get(queue.shift()!) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      out.push(child)
      queue.push(child.pid)
    }
  }
  return out
}

/** Ids of `jobs` with a live process among `descendants`. `stdoutByPid` maps a
 *  descendant to the file its fd 1 points at, where known. */
export function matchLiveJobs(
  jobs: readonly BackgroundJobProbe[],
  descendants: readonly ProcRow[],
  stdoutByPid: ReadonlyMap<number, string>
): string[] {
  const outputs = new Set(stdoutByPid.values())
  const alive: string[] = []
  for (const job of jobs) {
    const outputFile = `/tasks/${job.id}.output`
    const byOutput = job.kind === 'shell' && [...outputs].some((path) => path.endsWith(outputFile))
    const evalArg = job.command ? `eval ${claudeEvalArg(job.command)}` : null
    const byCommand = evalArg !== null && descendants.some((d) => d.args.includes(evalArg))
    if (byOutput || byCommand) alive.push(job.id)
  }
  return alive
}

/** fd 1 target of each pid, best-effort (a pid that exited or is unreadable is
 *  just absent). Linux: /proc. macOS: one `lsof` for all pids. */
async function readStdoutPaths(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  if (pids.length === 0) return out
  if (process.platform === 'linux') {
    await Promise.all(
      pids.map((pid) =>
        readlink(`/proc/${pid}/fd/1`).then(
          (path) => void out.set(pid, path),
          () => undefined
        )
      )
    )
    return out
  }
  // `-b -n -P -w`: no blocking kernel calls, DNS/port lookups or warnings; `-a`:
  // AND the filters; `-d 1`: fd 1 only; `-F pn`: machine-readable pid + name.
  // lsof exits 1 when some pid has no match — the output is still valid.
  const res = await execFileAsync(
    'lsof',
    ['-b', '-n', '-P', '-w', '-a', '-p', pids.join(','), '-d', '1', '-F', 'pn'],
    {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024
    }
  ).catch((err: { stdout?: string }) => ({ stdout: err.stdout ?? '' }))
  let pid = 0
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid) out.set(pid, line.slice(1))
  }
  return out
}

/**
 * Which of `jobs` still run under `rootPid` (the pty session's process). `null`
 * when this platform can't tell (Windows) — the caller must treat every job as
 * finished rather than show one forever.
 */
export async function probeBackgroundJobs(
  rootPid: number,
  jobs: readonly BackgroundJobProbe[]
): Promise<string[] | null> {
  if (process.platform === 'win32') return null
  if (jobs.length === 0) return []
  const { stdout } = await execFileAsync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,args='], {
    timeout: EXEC_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024
  })
  const descendants = descendantsOf(rootPid, parsePsRows(stdout))
  const needStdout = jobs.some((j) => j.kind === 'shell')
  const stdoutByPid = needStdout
    ? await readStdoutPaths(descendants.map((d) => d.pid))
    : new Map<number, string>()
  return matchLiveJobs(jobs, descendants, stdoutByPid)
}
