/**
 * Which process groups this computer started, kept on disk so a crash does not
 * orphan them (final review M5). Proc leaders are spawned detached (their own
 * POSIX group, see `handlers/proc.ts`): a computer that is SIGKILLed, crashes or
 * hits the supervised stop backstop leaves `pnpm dev` running — the row reads
 * stopped with no Stop, and the next Start fails with "address in use". The next
 * session host reads this ledger and ends the groups a dead host left behind.
 *
 * Identity is (pid, start time) for both the group leader and the host that
 * recorded it, so a recycled pid is never mistaken for ours:
 * - an entry whose host is still running (two hosts during an upgrade handoff, or
 *   several handler sets in one process) is that host's, and is kept;
 * - a leader pid that now runs something else (start time differs) is left alone;
 * - a leader that exited while its group lives on (a pid cannot be reused while it
 *   is a live process-group id) is still ours, and the group is ended.
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
}

export interface ProcGroupLedger {
  /** Record a group this host just started. Resolves once it is on disk. */
  record(pgid: number): Promise<void>
  /** The group exited or was stopped: forget it. */
  forget(pgid: number): void
  /** Resolves once every `record` so far is on disk. */
  settled(): Promise<void>
  /** End the groups dead hosts left behind; resolves with how many were ended. */
  reapOrphans(): Promise<number>
}

const TERM_GRACE_MS = 2_000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A process's start time, or '' when it is gone or `ps` failed. */
export function processStartedAt(pid: number): Promise<string> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 2000 }, (err, stdout) =>
      resolve(err ? '' : stdout.trim())
    )
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
  let pending: Promise<void> = Promise.resolve()

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

  /** True while `entry`'s group is still the one this ledger recorded. */
  async function stillOurs(entry: LedgerEntry): Promise<boolean> {
    if (pidAlive(entry.pgid)) return (await processStartedAt(entry.pgid)) === entry.startedAt
    return groupAlive(entry.pgid)
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

  return {
    record(pgid) {
      const done = (async () => {
        const [me, startedAt] = await Promise.all([owner, processStartedAt(pgid)])
        // Already exited: nothing to recover later.
        if (!startedAt) return
        write([...read().filter((e) => e.pgid !== pgid), { pgid, startedAt, owner: me }])
      })().catch((err) => log('proc group ledger record failed', { error: String(err) }))
      pending = pending.then(() => done)
      return done
    },

    forget(pgid) {
      pending = pending.then(() => write(read().filter((e) => e.pgid !== pgid)))
    },

    settled() {
      return pending
    },

    async reapOrphans() {
      const me = await owner
      let ended = 0
      for (const entry of read()) {
        if (sameOwner(entry.owner, me) || (await ownerAlive(entry.owner))) continue
        if (await stillOurs(entry)) {
          await endGroup(entry.pgid)
          ended++
          log('ended a process group a crashed computer left running', { pgid: entry.pgid })
        }
        const pgid = entry.pgid
        const owned = entry.owner
        write(read().filter((e) => !(e.pgid === pgid && sameOwner(e.owner, owned))))
      }
      return ended
    }
  }
}
