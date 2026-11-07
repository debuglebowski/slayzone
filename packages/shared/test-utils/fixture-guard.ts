/**
 * Fail a harness file that leaves processes running in its own temp dirs.
 *
 * Installed per file by harness-setup.ts. It records every dir the file creates with
 * `mkdtemp` (sync, callback or promise; named imports included), and after the file's
 * own `afterAll` hooks (setup-file hooks run last) looks for processes rooted in them
 * (fixture-processes.cjs: naming a dir, or descending from one that does). Anything
 * still there after a short grace — a stop already sent may still be landing — is
 * killed and the file fails, naming each process. A leaked computer or session host
 * otherwise outlives the run: `pnpm test:unit` once left ~90 behind every run.
 *
 * A reaper watchdog (fixture-reaper-watchdog.cjs) is not a leak: it exits by itself
 * once its owner or its dir is gone.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { afterAll } from 'vitest'
import { killFixtureProcesses, fixtureProcesses, type FixtureProcess } from './fixture-reaper'

/** How long processes may take to finish exiting after the file's own teardown. */
const GRACE_MS = 5_000

/** The temp dirs this process created, as both their given and real spellings. */
const tracked = new Set<string>()

function track(dir: string): void {
  tracked.add(dir)
  try {
    tracked.add(fs.realpathSync(dir))
  } catch {
    /* gone already */
  }
}

/** Wraps every `mkdtemp` flavour so a dir made by this file is recorded. */
export function trackTempDirs(): void {
  const mkdtempSync = fs.mkdtempSync
  fs.mkdtempSync = ((...args: Parameters<typeof mkdtempSync>) => {
    const dir = mkdtempSync(...args)
    track(String(dir))
    return dir
  }) as typeof fs.mkdtempSync
  const mkdtemp = fs.mkdtemp
  fs.mkdtemp = ((prefix: string, ...rest: unknown[]) => {
    const cb = rest.pop() as (err: NodeJS.ErrnoException | null, dir: string) => void
    return (mkdtemp as (...a: unknown[]) => void)(
      prefix,
      ...rest,
      (err: NodeJS.ErrnoException | null, dir: string) => {
        if (!err) track(String(dir))
        cb(err, dir)
      }
    )
  }) as typeof fs.mkdtemp
  const mkdtempP = fsp.mkdtemp
  const wrappedP = (async (...args: Parameters<typeof mkdtempP>) => {
    const dir = await mkdtempP(...args)
    track(String(dir))
    return dir
  }) as typeof fsp.mkdtemp
  fsp.mkdtemp = wrappedP
  fs.promises.mkdtemp = wrappedP
  // Named ESM imports of `node:fs` / `node:fs/promises` read these bindings.
  syncBuiltinESMExports()
}

const describe = (p: FixtureProcess): string => `pid ${p.pid}: ${p.args.slice(0, 300)}`

/** The processes still rooted in this file's temp dirs once the grace is over. */
async function leftovers(): Promise<FixtureProcess[]> {
  const dirs = [...tracked]
  const deadline = Date.now() + GRACE_MS
  for (;;) {
    const found = fixtureProcesses(dirs)
    if (found.length === 0 || Date.now() >= deadline) return found
    await new Promise((r) => setTimeout(r, 200))
  }
}

/** Registers the end-of-file check (call from a setup file). */
export function failOnLeakedFixtureProcesses(): void {
  afterAll(async () => {
    if (tracked.size === 0) return
    const left = await leftovers()
    if (left.length === 0) return
    killFixtureProcesses([...tracked])
    throw new Error(
      `this file left ${left.length} process${left.length === 1 ? '' : 'es'} running in its temp dirs ` +
        `(killed now; stop them in its teardown — fixture-reaper.ts killFixtureProcesses):\n` +
        left.map(describe).join('\n')
    )
  }, GRACE_MS + 30_000)
}
