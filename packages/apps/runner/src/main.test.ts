import { FleetErrorCodes, RpcError } from '@slayzone/fleet/shared'
import { describe, expect, it, vi } from 'vitest'
import type { RunnerConfig } from './config'
import type { RunnerDialer } from './handlers/types'
import { createHubRequestHandler } from './main'

const fakeDialer: RunnerDialer = { notify: () => true }

const testConfig: RunnerConfig = {
  hubUrl: 'ws://localhost:0/fleet',
  name: 'test-runner',
  allowedRoots: ['/tmp'],
  capabilities: ['pty', 'git', 'fs', 'proc']
}

function makeDispatch(shutdown: (reason: string) => void = () => {}) {
  return createHubRequestHandler({ shutdown, dialer: fakeDialer, config: testConfig })
}

describe('createHubRequestHandler dispatch table', () => {
  it.each(['fs.readFile', 'git.clone', 'proc.status', 'bogus.method'])(
    'answers unknown method %s with -32001 unimplemented',
    async (method) => {
      const { handle } = makeDispatch()
      const err = await handle(method, {}).then(
        () => null,
        (e: unknown) => e
      )
      expect(err).toBeInstanceOf(RpcError)
      expect((err as RpcError).code).toBe(FleetErrorCodes.unimplemented)
      expect((err as RpcError).message).toBe(`unimplemented: ${method}`)
    }
  )

  it('routes implemented methods (git.isGitRepo does not throw unimplemented)', async () => {
    const { handle } = makeDispatch()
    // /tmp is inside allowedRoots but not a git repo → resolves to { isRepo: false }.
    const result = await handle('git.isGitRepo', { path: '/tmp' })
    expect(result).toEqual({ isRepo: false })
  })

  it('acks runner.shutdown and then triggers the shutdown callback', async () => {
    const shutdown = vi.fn()
    const { handle } = makeDispatch(shutdown)
    const pending = handle('runner.shutdown', { reason: 'maintenance' })
    expect(shutdown).not.toHaveBeenCalled() // ack built before shutdown fires…
    const result = await pending
    expect(result).toEqual({ ok: true })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(shutdown).toHaveBeenCalledWith('maintenance') // …stop after the ack resolves
  })

  it('defaults the shutdown reason', async () => {
    const shutdown = vi.fn()
    const { handle } = makeDispatch(shutdown)
    await handle('runner.shutdown', undefined)
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(shutdown).toHaveBeenCalledWith('hub-requested')
  })

  it('dispose() is callable with no live sessions', () => {
    const { dispose } = makeDispatch()
    expect(() => dispose()).not.toThrow()
  })
})
