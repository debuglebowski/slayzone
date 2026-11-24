/**
 * A connector worker's exit, as its upgrade supervisor reports it — code, signal,
 * uptime, whether it was asked to stop. Before, the supervisor kept these only in an
 * Error nobody logged: a worker the OOM killer SIGKILLed left no trace.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { launchUpgradeWorker, readLogTail, type WorkerExit } from './upgrade-runtime'
import type { ComputerConfig } from './config'

const config = {
  hubUrl: 'ws://127.0.0.1:1/computers',
  allowedRoots: []
} as unknown as ComputerConfig

function worker(source: string): {
  exit: Promise<WorkerExit>
  stop: () => Promise<void>
} {
  const entry = join(mkdtempSync(join(tmpdir(), 'worker-exit-')), 'worker.cjs')
  writeFileSync(entry, source)
  let resolve!: (exit: WorkerExit) => void
  const exit = new Promise<WorkerExit>((r) => (resolve = r))
  const w = launchUpgradeWorker(entry, config, false, undefined, process.env, undefined, resolve)
  return { exit, stop: () => w.stop() }
}

describe('launchUpgradeWorker reports how its worker ended', () => {
  it('a crash: its code, not requested', async () => {
    const { exit } = worker('process.exit(4)')
    expect(await exit).toMatchObject({
      code: 4,
      signal: null,
      requested: false
    })
    expect((await exit).pid).toBeGreaterThan(0)
    expect((await exit).uptimeMs).toBeGreaterThanOrEqual(0)
  })

  it.skipIf(process.platform === 'win32')(
    'killed by a signal (the OOM killer): the signal',
    async () => {
      const { exit } = worker("process.kill(process.pid, 'SIGKILL')")
      expect(await exit).toMatchObject({
        code: null,
        signal: 'SIGKILL',
        requested: false
      })
    }
  )

  it('the fatal it reported over IPC before exiting', async () => {
    const { exit } = worker(
      "process.send({type:'fatal', error:'credential store unreadable'}, () => process.exit(1))"
    )
    expect(await exit).toMatchObject({
      code: 1,
      fatal: 'credential store unreadable'
    })
  })

  it('a stop the supervisor asked for is not a crash', async () => {
    const { exit, stop } = worker('setInterval(() => {}, 1000)')
    await new Promise((r) => setTimeout(r, 100))
    await stop()
    expect(await exit).toMatchObject({ requested: true })
  })
})

describe('readLogTail', () => {
  it('the last whole lines, joined; empty for a missing file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'log-tail-')), 'host.log')
    writeFileSync(file, `${'x'.repeat(100)}\nfirst kept\n\nError: listen EADDRINUSE\n`)
    expect(readLogTail(file, 40)).toBe('first kept | Error: listen EADDRINUSE')
    expect(readLogTail(`${file}.missing`)).toBe('')
  })
})
