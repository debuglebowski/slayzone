/**
 * Final review round 2, R2-1: the M5 reaper ended a group whose leader was gone
 * without proving the group was ours. Once the recorded group dies its id can be
 * recycled into a new group whose leader exits (a script that backgrounds a server,
 * `nohup … &`, a pipeline) — and after a reboot every id is recycled. The reviewer
 * SIGTERMed an unrelated `sleep` that way. Now an entry from another boot is dropped
 * without a kill, and a dead-leader group is ended only with positive proof (a live
 * member that already ran while the recording host was known alive); with no proof
 * the entry is forgotten and nothing is killed.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createProcHandlers, ProcMethods } from './handlers/proc'
import { createProcGroupLedger, currentBootId, processStartedAt } from './proc-group-ledger'

let dir: string
let ledgerPath: string
const strays: number[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'proc-ledger-'))
  mkdirSync(join(dir, 'computer-runtime'), { recursive: true })
  ledgerPath = join(dir, 'computer-runtime', 'proc-groups.json')
})

afterEach(() => {
  for (const pgid of strays.splice(0)) {
    try {
      process.kill(-pgid, 'SIGKILL')
    } catch {
      // gone
    }
  }
  rmSync(dir, { recursive: true, force: true })
})

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** A group whose leader exits at once, leaving `sleep` running in it (the repro). */
async function deadLeaderGroup(): Promise<number> {
  const leader: ChildProcess = spawn('sh', ['-c', 'sleep 120 & exit 0'], {
    detached: true,
    stdio: 'ignore'
  })
  const pgid = leader.pid as number
  strays.push(pgid)
  await new Promise((r) => leader.once('exit', r))
  expect(groupAlive(pgid)).toBe(true)
  return pgid
}

const deadOwner = { pid: 99997, startedAt: 'Mon Nov  2 09:00:00 2026' }

function writeLedger(groups: unknown[]): void {
  writeFileSync(ledgerPath, JSON.stringify({ groups }))
}

const ledger = () => createProcGroupLedger(ledgerPath, () => {})
const remaining = () =>
  (JSON.parse(readFileSync(ledgerPath, 'utf8')) as { groups: unknown[] }).groups.length

describe.skipIf(process.platform === 'win32')('R2-1: the reaper proves a group is ours', () => {
  it("the reviewer's repro: an unrelated group that reused the id survives", async () => {
    const pgid = await deadLeaderGroup()
    writeLedger([
      { pgid, startedAt: 'Mon Nov  2 09:00:00 2026', owner: deadOwner, boot: await currentBootId() }
    ])

    expect(await ledger().reapOrphans()).toBe(0)
    expect(groupAlive(pgid)).toBe(true)
    expect(remaining()).toBe(0) // forgotten, not kept to be retried
  })

  it('an entry from another boot is dropped without a kill, even with a matching leader', async () => {
    const leader = spawn('sleep', ['120'], { detached: true, stdio: 'ignore' })
    const pgid = leader.pid as number
    strays.push(pgid)
    await waitFor(() => groupAlive(pgid))
    const startedAt = await processStartedAt(pgid)
    writeLedger([{ pgid, startedAt, owner: deadOwner, boot: 'a boot before a restart' }])

    expect(await ledger().reapOrphans()).toBe(0)
    expect(groupAlive(pgid)).toBe(true)
    expect(remaining()).toBe(0)
  })

  it('a dead-leader group with a member that ran while its host was alive is ended', async () => {
    const pgid = await deadLeaderGroup()
    writeLedger([
      {
        pgid,
        // Recorded before the member started, by a host last seen alive after it.
        startedAt: await processStartedAt(process.pid),
        owner: deadOwner,
        boot: await currentBootId(),
        aliveAt: Date.now() + 2000
      }
    ])

    expect(await ledger().reapOrphans()).toBe(1)
    await waitFor(() => !groupAlive(pgid))
  })

  it('a clean quit leaves no entry behind, even with a record still in flight', async () => {
    const ctx = {
      dialer: { notify: () => true },
      config: {
        hubUrl: 'ws://localhost:0/computers',
        name: 'test',
        allowedRoots: [tmpdir()],
        capabilities: ['proc']
      },
      log: () => {}
    }
    const proc = createProcHandlers(ctx as never, undefined, { groupLedgerPath: ledgerPath })
    await proc.orphansReaped
    const settled = (await proc.handlers[ProcMethods.procSpawn]({
      sessionId: 'a',
      command: 'sleep',
      args: ['30']
    })) as { pid: number }
    strays.push(settled.pid)
    await proc.groupsRecorded()
    expect(remaining()).toBe(1)
    const inFlight = (await proc.handlers[ProcMethods.procSpawn]({
      sessionId: 'b',
      command: 'sleep',
      args: ['30']
    })) as { pid: number }
    strays.push(inFlight.pid)

    proc.disposeAll()
    await proc.groupsRecorded()

    expect(remaining()).toBe(0)
  })
})
