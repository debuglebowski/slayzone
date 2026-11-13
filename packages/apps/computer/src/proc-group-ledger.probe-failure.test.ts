/**
 * A probe that fails once (`ps` or `sysctl` past its timeout on a loaded machine) is
 * not "no proof": the reaper used to read it as such, forget the entry, and so leave
 * a crashed computer's group running forever. Each probe's FIRST call fails here.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const failFirst = new Set<string>()
const failed = new Set<string>()
const failAlways = new Set<string>()

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const execFile = ((file: string, args: string[], ...rest: unknown[]) => {
    const key = `${file} ${args[0]}`
    if (failAlways.has(key) || (failFirst.has(key) && !failed.has(key))) {
      failed.add(key)
      const cb = rest.find((a) => typeof a === 'function') as (e: Error, o: string) => void
      setImmediate(() => cb(Object.assign(new Error('timed out'), { killed: true }), ''))
      return { kill: () => true, on: () => undefined } as never
    }
    return (real.execFile as (...a: unknown[]) => ChildProcess)(file, args, ...rest)
  }) as typeof real.execFile
  return { ...real, execFile, default: { ...real, execFile } }
})

const { createProcGroupLedger, processStartedAt } = await import('./proc-group-ledger')

let dir: string
let ledgerPath: string
const strays: number[] = []

beforeEach(() => {
  failFirst.clear()
  failAlways.clear()
  failed.clear()
  dir = mkdtempSync(join(tmpdir(), 'proc-ledger-probe-'))
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

/** This boot's id as currentBootId reads it, read here so the ledger's own read is its first. */
function bootIdHere(): string {
  if (process.platform === 'linux')
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  const sec = /sec\s*=\s*(\d+)/.exec(
    execFileSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8' })
  )
  return `boottime:${sec?.[1]}`
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function deadLeaderGroup(): Promise<number> {
  const leader = spawn('sh', ['-c', 'sleep 120 & exit 0'], { detached: true, stdio: 'ignore' })
  const pgid = leader.pid as number
  strays.push(pgid)
  await new Promise((r) => leader.once('exit', r))
  return pgid
}

describe.skipIf(process.platform === 'win32')('the reaper when a probe fails once', () => {
  // The boot id first: once read it is kept for the process, so a later case would
  // never call sysctl again.
  it.each([
    [process.platform === 'linux' ? 'unused -' : 'sysctl -n', 'the boot id'],
    ['ps -A', 'the group listing']
  ])('%s (%s) failing once still ends a provably ours group', async (probe) => {
    const pgid = await deadLeaderGroup()
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        groups: [
          {
            pgid,
            startedAt: await processStartedAt(process.pid),
            owner: { pid: 99997, startedAt: 'Mon Nov  2 09:00:00 2026' },
            boot: bootIdHere(),
            aliveAt: Date.now() + 2000
          }
        ]
      })
    )
    failFirst.add(probe)
    expect(await createProcGroupLedger(ledgerPath, () => {}).reapOrphans()).toBe(1)
    const start = Date.now()
    while (groupAlive(pgid) && Date.now() - start < 5000)
      await new Promise((r) => setTimeout(r, 20))
    expect(groupAlive(pgid)).toBe(false)
  })

  it('a listing that keeps failing kills nothing and keeps the entry for the next start', async () => {
    const pgid = await deadLeaderGroup()
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        groups: [
          {
            pgid,
            startedAt: await processStartedAt(process.pid),
            owner: { pid: 99997, startedAt: 'Mon Nov  2 09:00:00 2026' },
            boot: bootIdHere(),
            aliveAt: Date.now() + 2000
          }
        ]
      })
    )
    failAlways.add('ps -A')
    expect(await createProcGroupLedger(ledgerPath, () => {}).reapOrphans()).toBe(0)
    expect(groupAlive(pgid)).toBe(true)
    expect(JSON.parse(readFileSync(ledgerPath, 'utf8')).groups).toHaveLength(1)
  })
})
