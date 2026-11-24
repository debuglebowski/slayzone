/**
 * How a computer process that fails to start ends. Before, `void main()` left any
 * startup failure as an unhandled rejection: 0.41.1 connector workers died every
 * ~30s with a bare `RpcDisposedError: computer-local closed: local connection
 * closed` in the journal, no reason in computer.log, and nothing to their supervisor.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { runMain } from './startup-failure'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function fakeProcess() {
  return {
    pid: 4242,
    exitCode: undefined as number | undefined,
    connected: true,
    send: vi.fn((_msg: unknown, cb?: () => void) => {
      cb?.()
      return true
    }),
    exit: vi.fn(),
    stderr: { write: vi.fn() }
  }
}

it('a startup failure is logged with its reason, reported to the supervisor, and exits 1', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'startup-failure-'))
  roots.push(stateDir)
  const proc = fakeProcess()
  const failure = Object.assign(new Error('computer-local closed: local connection closed'), {
    name: 'RpcDisposedError'
  })
  const onUnhandled = vi.fn()
  process.on('unhandledRejection', onUnhandled)
  try {
    await runMain(() => Promise.reject(failure), { proc, stateDir: () => stateDir, tag: 'worker' })
    await new Promise((r) => setTimeout(r, 20))
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
  expect(onUnhandled).not.toHaveBeenCalled()
  expect(proc.exitCode).toBe(1)
  expect(proc.send).toHaveBeenCalledWith(
    { type: 'fatal', error: 'RpcDisposedError: computer-local closed: local connection closed' },
    expect.any(Function)
  )
  expect(proc.exit).toHaveBeenCalledWith(1)
  const log = readFileSync(join(stateDir, 'logs', 'computer.log'), 'utf8')
  expect(log).toContain('[worker 4242] startup failed')
  expect(log).toContain('RpcDisposedError: computer-local closed: local connection closed')
  expect(proc.stderr.write).toHaveBeenCalledWith(expect.stringContaining('startup failed'))
})

it('a successful start changes nothing', async () => {
  const proc = fakeProcess()
  await runMain(() => Promise.resolve(), { proc, stateDir: () => '/nonexistent', tag: 'worker' })
  expect(proc.exitCode).toBeUndefined()
  expect(proc.exit).not.toHaveBeenCalled()
  expect(proc.send).not.toHaveBeenCalled()
})

it('an unknown log directory still exits 1 with the reason on stderr', async () => {
  const proc = fakeProcess()
  await runMain(() => Promise.reject(new Error('no config')), {
    proc,
    stateDir: () => {
      throw new Error('cannot resolve')
    },
    tag: 'computer'
  })
  expect(proc.exitCode).toBe(1)
  expect(proc.stderr.write).toHaveBeenCalledWith(expect.stringContaining('no config'))
})
