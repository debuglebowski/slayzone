/**
 * End a run's whole process tree and report whether anything is left — the
 * computer's half of Stop / Restart. SIGTERM to the POSIX group the leader leads
 * (every proc leader is spawned `detached`), and by pid to descendants that left
 * the group (a tool that `setsid()`s its workers; found while the leader is still
 * alive, before the first signal). Poll until nothing is left; escalate once to
 * SIGKILL. A single fire-and-forget SIGTERM let a child that ignores it keep its
 * port while the UI said "stopped", and a restart then hit EADDRINUSE.
 *
 * Windows has no group liveness to poll: `killPidTree` there is `taskkill /T /F`,
 * already forceful, so it is trusted.
 *
 * @module computer/terminate-tree
 */
import { execFile, execFileSync } from 'node:child_process'
import { killPidTree } from '@slayzone/platform'

const POLL_INTERVAL_MS = 100
/** How long the tree gets to exit on SIGTERM before SIGKILL. */
export const TERM_GRACE_MS = 2_000
/** How long SIGKILL gets to take effect. */
const KILL_SETTLE_MS = 1_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function groupHasLiveMembers(pgid: number): boolean {
  try {
    execFileSync('pgrep', ['-g', String(pgid)], { timeout: 2000, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Signal 0: true while `pid` exists (EPERM = exists, owned by someone else). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function signalPids(pids: readonly number[], sig: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, sig)
    } catch {
      // already gone
    }
  }
}

/**
 * Live descendants of `rootPid` outside its process group (one `ps` snapshot,
 * walked by parent link). Only for a root that is this process's own direct
 * child — any other root yields nothing, so an unrelated tree is never signalled.
 */
async function escapedDescendants(rootPid: number): Promise<number[]> {
  const out = await new Promise<string>((resolve) => {
    execFile(
      'ps',
      ['-A', '-o', 'pid=,ppid=,pgid='],
      { timeout: 2000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => resolve(err ? '' : stdout)
    )
  })
  const children = new Map<number, Array<{ pid: number; pgid: number }>>()
  let rootIsOurChild = false
  for (const line of out.split('\n')) {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number)
    if (!pid || !Number.isFinite(ppid) || !Number.isFinite(pgid)) continue
    if (pid === rootPid) rootIsOurChild = ppid === process.pid
    const list = children.get(ppid) ?? []
    list.push({ pid, pgid })
    children.set(ppid, list)
  }
  if (!rootIsOurChild) return []
  const escaped: number[] = []
  const queue = [rootPid]
  const seen = new Set(queue)
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      if (child.pgid !== rootPid) escaped.push(child.pid)
      queue.push(child.pid)
    }
  }
  return escaped
}

/** TERM, wait, KILL; true when nothing of the tree is left. */
export async function terminateTree(
  leaderPid: number,
  opts: { graceMs?: number } = {}
): Promise<boolean> {
  if (process.platform === 'win32') {
    killPidTree(leaderPid, 'SIGKILL')
    return true
  }
  const escaped = await escapedDescendants(leaderPid)
  killPidTree(leaderPid, 'SIGTERM')
  signalPids(escaped, 'SIGTERM')
  const alive = (): boolean => groupHasLiveMembers(leaderPid) || escaped.some(pidAlive)
  const termDeadline = Date.now() + (opts.graceMs ?? TERM_GRACE_MS)
  while (Date.now() < termDeadline && alive()) await sleep(POLL_INTERVAL_MS)
  if (!alive()) return true
  killPidTree(leaderPid, 'SIGKILL')
  signalPids(escaped, 'SIGKILL')
  const killDeadline = Date.now() + KILL_SETTLE_MS
  while (Date.now() < killDeadline && alive()) await sleep(POLL_INTERVAL_MS)
  return !alive()
}
