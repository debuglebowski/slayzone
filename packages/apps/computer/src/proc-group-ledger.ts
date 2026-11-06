/**
 * Which process groups this computer started, kept on disk so a crash does not
 * orphan them (final review M5). Proc leaders are spawned detached (their own
 * POSIX group, see `handlers/proc.ts`): a computer that is SIGKILLed, crashes or
 * hits the supervised stop backstop leaves `pnpm dev` running — the row reads
 * stopped with no Stop, and the next Start fails with "address in use". The next
 * session host reads this ledger and ends the groups a dead host left behind.
 *
 * Never kill without proof (final review round 2, R2-1). A group id is a pid, and
 * pids are recycled: once a recorded group dies, its id can lead an unrelated group
 * whose own leader exits (a script that backgrounds a server, `nohup … &`). So:
 * - each entry carries the boot it was recorded in; an entry from another boot is
 *   dropped and nothing is killed (after a reboot every id is someone else's);
 * - the recording host's identity is (pid, start time); while it runs, its entries
 *   are its own and are kept (an upgrade handoff, several handler sets in a process);
 * - a live leader is ours only when its start time matches the recorded one;
 * - a group whose leader is gone is ours only with positive proof: a live member
 *   that started no earlier than the recorded leader and no later than the moment
 *   the host was last known alive (`aliveAt`, refreshed by a heartbeat). An entry
 *   is forgotten when its leader exits, so a surviving dead-leader entry means the
 *   leader outlived its host — the group held its id from the record until then, and
 *   a member already running at `aliveAt` cannot belong to a later, recycled group.
 *   With no such member, the entry is forgotten and nothing is killed.
 *
 * POSIX only: Windows has no process groups here (`PROCESS_TREE_DETACHED` false).
 *
 * @module computer/proc-group-ledger
 */
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { killPidTree } from '@slayzone/platform'

export interface LedgerOwner {
  pid: number
  /** `ps -o lstart=` of the owner; '' when it could not be read. */
  startedAt: string
}

interface LedgerEntry {
  pgid: number
  startedAt: string
  owner: LedgerOwner
  /** The boot the entry was recorded in ({@link currentBootId}). */
  boot?: string
  /** Epoch ms the recording host was last known alive. */
  aliveAt?: number
}

export interface ProcGroupLedger {
  /** Record a group this host just started. Resolves once it is on disk. */
  record(pgid: number): Promise<void>
  /** The group exited or was stopped: forget it. */
  forget(pgid: number): void
  /**
   * Shutdown: forget every group this host recorded (it has just ended them), now,
   * and ignore records still in flight. A clean quit leaves nothing to reap.
   */
  close(): void
  /** Resolves once every write so far is on disk. */
  settled(): Promise<void>
  /** End the groups dead hosts left behind; resolves with how many were ended. */
  reapOrphans(): Promise<number>
}

const TERM_GRACE_MS = 2_000
/** How often a host with recorded groups refreshes its `aliveAt`. */
export const LEDGER_HEARTBEAT_MS = 30_000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** `ps` output in a fixed format whatever the user's locale. */
function ps(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      args,
      { timeout: 2000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } },
      (err, stdout) => resolve(err ? '' : stdout)
    )
  })
}

/** A process's start time, or '' when it is gone or `ps` failed. */
export async function processStartedAt(pid: number): Promise<string> {
  return (await ps(['-o', 'lstart=', '-p', String(pid)])).trim()
}

/** `lstart` text → epoch ms (whole seconds), or NaN. */
function lstartMs(lstart: string): number {
  return Date.parse(lstart.replace(/\s+/g, ' '))
}

/**
 * This boot's identity, or '' when it cannot be read (then no entry ever proves
 * itself: nothing is killed). Linux: the kernel's boot id; macOS/BSD: boot time.
 */
export function currentBootId(): Promise<string> {
  if (process.platform === 'linux') {
    try {
      return Promise.resolve(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim())
    } catch {
      return Promise.resolve('')
    }
  }
  return new Promise((resolve) => {
    execFile('sysctl', ['-n', 'kern.boottime'], { timeout: 2000 }, (err, stdout) => {
      const sec = err ? null : /sec\s*=\s*(\d+)/.exec(stdout)
      resolve(sec ? `boottime:${sec[1]}` : '')
    })
  })
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Start times (epoch ms) of the live members of group `pgid`. */
async function memberStarts(pgid: number): Promise<number[]> {
  const starts: number[] = []
  for (const line of (await ps(['-A', '-o', 'pgid=,lstart='])).split('\n')) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
    if (!m || Number(m[1]) !== pgid) continue
    const at = lstartMs(m[2] as string)
    if (Number.isFinite(at)) starts.push(at)
  }
  return starts
}

function isEntry(value: unknown): value is LedgerEntry {
  const e = value as LedgerEntry
  return (
    !!e &&
    Number.isInteger(e.pgid) &&
    e.pgid > 1 &&
    typeof e.startedAt === 'string' &&
    !!e.owner &&
    Number.isInteger(e.owner.pid) &&
    typeof e.owner.startedAt === 'string'
  )
}

export function createProcGroupLedger(
  path: string,
  log: (msg: string, data?: Record<string, unknown>) => void,
  ownerOverride?: LedgerOwner
): ProcGroupLedger {
  const owner: Promise<LedgerOwner> = ownerOverride
    ? Promise.resolve(ownerOverride)
    : processStartedAt(process.pid).then((startedAt) => ({ pid: process.pid, startedAt }))
  const boot = currentBootId()
  let pending: Promise<void> = Promise.resolve()
  let closed = false
  let heartbeat: ReturnType<typeof setInterval> | null = null
  /** Groups this host recorded and has not forgotten. */
  const mine = new Set<number>()

  // Read-modify-write per change: several handler sets (or an upgrade's two hosts)
  // may share the file, so never write back a stale in-memory copy.
  function read(): LedgerEntry[] {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { groups?: unknown }
      return Array.isArray(parsed.groups) ? parsed.groups.filter(isEntry) : []
    } catch {
      return []
    }
  }

  function write(groups: LedgerEntry[]): void {
    try {
      mkdirSync(dirname(path), { recursive: true })
      const temp = `${path}.${process.pid}.tmp`
      writeFileSync(temp, JSON.stringify({ groups }), { mode: 0o600 })
      renameSync(temp, path)
    } catch (err) {
      log('proc group ledger write failed', { error: String(err) })
    }
  }

  const sameOwner = (a: LedgerOwner, b: LedgerOwner) =>
    a.pid === b.pid && a.startedAt === b.startedAt

  async function ownerAlive(o: LedgerOwner): Promise<boolean> {
    if (!pidAlive(o.pid)) return false
    return (await processStartedAt(o.pid)) === o.startedAt
  }

  /** Positive proof that `entry`'s live group is the one recorded — see the module doc. */
  async function provenOurs(entry: LedgerEntry): Promise<boolean> {
    if (pidAlive(entry.pgid)) return (await processStartedAt(entry.pgid)) === entry.startedAt
    if (!groupAlive(entry.pgid) || typeof entry.aliveAt !== 'number') return false
    const leaderStart = lstartMs(entry.startedAt)
    if (!Number.isFinite(leaderStart)) return false
    return (await memberStarts(entry.pgid)).some(
      (start) => start >= leaderStart && start <= entry.aliveAt!
    )
  }

  async function endGroup(pgid: number): Promise<void> {
    try {
      killPidTree(pgid, 'SIGTERM')
    } catch {
      return
    }
    const deadline = Date.now() + TERM_GRACE_MS
    while (Date.now() < deadline && groupAlive(pgid)) await sleep(100)
    if (groupAlive(pgid)) {
      try {
        killPidTree(pgid, 'SIGKILL')
      } catch {
        // gone
      }
    }
  }

  /** Refresh `aliveAt` on this host's entries, so a crash leaves a recent bound. */
  async function beat(): Promise<void> {
    const me = await owner
    if (closed || mine.size === 0) return
    const now = Date.now()
    write(read().map((e) => (sameOwner(e.owner, me) ? { ...e, aliveAt: now } : e)))
  }

  function syncHeartbeat(): void {
    if (mine.size > 0 && !closed && !heartbeat) {
      heartbeat = setInterval(() => {
        pending = pending.then(beat)
      }, LEDGER_HEARTBEAT_MS)
      heartbeat.unref?.()
    } else if ((mine.size === 0 || closed) && heartbeat) {
      clearInterval(heartbeat)
      heartbeat = null
    }
  }

  return {
    record(pgid) {
      mine.add(pgid)
      syncHeartbeat()
      const done = (async () => {
        const [me, startedAt, bootId] = await Promise.all([owner, processStartedAt(pgid), boot])
        // Already exited (nothing to recover later), forgotten meanwhile, or shut down.
        if (!startedAt || closed || !mine.has(pgid)) return
        write([
          ...read().filter((e) => e.pgid !== pgid),
          { pgid, startedAt, owner: me, boot: bootId, aliveAt: Date.now() }
        ])
      })().catch((err) => log('proc group ledger record failed', { error: String(err) }))
      pending = pending.then(() => done)
      return done
    },

    forget(pgid) {
      mine.delete(pgid)
      syncHeartbeat()
      pending = pending.then(() => write(read().filter((e) => e.pgid !== pgid)))
    },

    close() {
      closed = true
      syncHeartbeat()
      const pgids = new Set(mine)
      mine.clear()
      // Now, not queued: the process may be about to exit.
      if (pgids.size > 0) write(read().filter((e) => !pgids.has(e.pgid)))
    },

    settled() {
      return pending
    },

    async reapOrphans() {
      const [me, bootId] = await Promise.all([owner, boot])
      let ended = 0
      for (const entry of read()) {
        if (sameOwner(entry.owner, me) || (await ownerAlive(entry.owner))) continue
        const sameBoot = !!bootId && entry.boot === bootId
        if (sameBoot && (await provenOurs(entry))) {
          await endGroup(entry.pgid)
          ended++
          log('ended a process group a crashed computer left running', { pgid: entry.pgid })
        } else if (groupAlive(entry.pgid)) {
          log('left a recorded process group alone: not provably ours', {
            pgid: entry.pgid,
            reason: sameBoot ? 'no proof' : 'another boot'
          })
        }
        const pgid = entry.pgid
        const owned = entry.owner
        write(read().filter((e) => !(e.pgid === pgid && sameOwner(e.owner, owned))))
      }
      return ended
    }
  }
}
