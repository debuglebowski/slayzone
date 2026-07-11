import { FleetErrorCodes, RpcError } from '@slayzone/fleet/shared'
import { describe, expect, it, vi } from 'vitest'
import { createHubRequestHandler } from './main'

describe('createHubRequestHandler (wave-1 skeleton)', () => {
  it.each(['pty.spawn', 'pty.kill', 'pty.resize', 'pty.write', 'pty.getBufferSince', 'fs.readFile', 'git.clone'])(
    'answers %s with -32001 unimplemented',
    async (method) => {
      const handler = createHubRequestHandler(() => {})
      const err = await handler(method, {}).then(
        () => null,
        (e: unknown) => e
      )
      expect(err).toBeInstanceOf(RpcError)
      expect((err as RpcError).code).toBe(FleetErrorCodes.unimplemented)
      expect((err as RpcError).message).toBe(`unimplemented: ${method}`)
    }
  )

  it('acks runner.shutdown and then triggers the shutdown callback', async () => {
    const shutdown = vi.fn()
    const handler = createHubRequestHandler(shutdown)
    const pending = handler('runner.shutdown', { reason: 'maintenance' })
    expect(shutdown).not.toHaveBeenCalled() // ack built before shutdown fires…
    const result = await pending
    expect(result).toEqual({ ok: true })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(shutdown).toHaveBeenCalledWith('maintenance') // …stop after the ack resolves
  })

  it('defaults the shutdown reason', async () => {
    const shutdown = vi.fn()
    const handler = createHubRequestHandler(shutdown)
    await handler('runner.shutdown', undefined)
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(shutdown).toHaveBeenCalledWith('hub-requested')
  })
})
