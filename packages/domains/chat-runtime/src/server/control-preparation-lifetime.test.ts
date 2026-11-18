import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, vi } from 'vitest'
import type { PreparedChatControl } from '@slayzone/terminal/runtime'
import { openComputerChatRuntime } from './computer-online-runtime'
// Fails the test on a lifecycle model / runtime disagreement.
import '../../../terminal/src/server/runtime/chat-lifecycle-strict-testkit'
const identity = { id: 'c', taskId: 't', tabId: 'tab', mode: 'claude-chat', epoch: 1 }
const workerPath = fileURLToPath(new URL('../../../../apps/computer/dist/bin.cjs', import.meta.url))
const call = (operationId: string) => ({
  route: { id: 'c', epoch: 1 },
  target: 'ops',
  method: 'kill',
  operationId,
  args: ['tab']
})
async function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), 'control-lifetime-'))
  const r = await openComputerChatRuntime({ stateDir, hubScope: 'h', computerId: 'pc', workerPath })
  await r.bootstrap({
    identity,
    projectId: null,
    cwd: '/tmp',
    revision: 1,
    providerConfig: {},
    defaultFlags: null,
    env: {}
  })
  const close = vi.fn(),
    listeners = new Set<() => void>()
  const control: PreparedChatControl = {
    spawnId: 'generation',
    acknowledged: Promise.resolve(),
    onPhysicalExit: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    ownsPhysicalStop: () => false,
    close,
    run: async <T>(work: () => T | Promise<T>) => work()
  }
  vi.spyOn(r.transport, 'prepareDurableControl').mockReturnValue(control)
  const run = vi.spyOn(control, 'run')
  return {
    r,
    control,
    close,
    run,
    listeners,
    async dispose() {
      vi.useRealTimers()
      await r.close()
      rmSync(stateDir, { recursive: true, force: true })
    }
  }
}
test('uncommitted preparation expires without a cancel, reconnect or durable work', async () => {
  const f = await fixture(),
    token = randomUUID()
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const result = await f.r.prepareControl({
      kind: 'control.prepare',
      token,
      identity,
      value: call('abandoned')
    })
    expect(result).toMatchObject({ available: true, token, pendingDurability: true })
    await vi.advanceTimersByTimeAsync(29999)
    expect(f.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.close).toHaveBeenCalled()
    expect(f.listeners.size).toBe(0)
    await expect(f.r.invoke({ ...call('abandoned'), controlToken: token })).rejects.toThrow(
      /stale|unconfirmed/
    )
  } finally {
    await f.dispose()
  }
})
test('renewal retains a live request; committing durable receipt outlives uncommitted lease', async () => {
  const f = await fixture(),
    token = randomUUID()
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>((r) => {
      release = r
    }),
    running = new Promise<void>((r) => {
      entered = r
    })
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await f.r.prepareControl({ kind: 'control.prepare', token, identity, value: call('committed') })
    await vi.advanceTimersByTimeAsync(20000)
    await expect(
      f.r.prepareControl({ kind: 'control.renew', token, identity })
    ).resolves.toMatchObject({ ok: true })
    await vi.advanceTimersByTimeAsync(20000)
    expect(f.close).not.toHaveBeenCalled()
    f.run.mockImplementation(async <T>(work: () => T | Promise<T>) => {
      entered()
      await gate
      return work()
    })
    const invocation = f.r.invoke({ ...call('committed'), controlToken: token })
    await running
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.close).not.toHaveBeenCalled()
    await f.r.prepareControl({ kind: 'control.cancel', token, identity })
    expect(f.close).not.toHaveBeenCalled()
    release()
    await invocation
    expect((await f.r.storage.receipt('c', 'committed'))?.state).toBe('delivered')
    await f.r.invoke({ ...call('committed'), controlToken: token })
    expect(f.control.run).toHaveBeenCalledTimes(1)
  } finally {
    release()
    await f.dispose()
  }
})
test('known cancellation can release a preparation while its actual ACK is still pending', async () => {
  const f = await fixture(),
    token = randomUUID()
  let ack!: () => void
  f.control.acknowledged = new Promise<void>((r) => {
    ack = r
  })
  try {
    const preparing = f.r.prepareControl({
      kind: 'control.prepare',
      token,
      identity,
      value: call('cancelled')
    })
    void preparing.catch(() => undefined)
    await f.r.prepareControl({ kind: 'control.cancel', token, identity })
    expect(f.close).toHaveBeenCalled()
    ack()
    await expect(preparing).rejects.toThrow(/authority|cancelled/)
  } finally {
    ack()
    await f.dispose()
  }
})
