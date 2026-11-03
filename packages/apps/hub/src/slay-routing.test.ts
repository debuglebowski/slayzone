import { expect, it, vi } from 'vitest'
import { createRoutingSlayExecutor } from './slay-routing'

function fixture(computerId: string | null = 'remote') {
  const request = vi.fn(async (_id, method) =>
    method === 'slay.setup' ? { ok: true } : { configured: false }
  )
  const resolveComputer = vi.fn(async () => computerId)
  const gate = vi.fn(async () => {})
  return {
    request,
    resolveComputer,
    gate,
    executor: createRoutingSlayExecutor({ gateway: { request }, resolveComputer, gate })
  }
}
const target = { taskId: 'task', projectId: 'project', projectPath: '/remote/repo' }
it('routes both operations to task computer without probing hub', async () => {
  const f = fixture()
  expect(await f.executor.checkConfigured(target)).toBe(false)
  expect(await f.executor.setup(target)).toEqual({ ok: true })
  expect(f.resolveComputer).toHaveBeenCalledWith(target)
  expect(f.gate).toHaveBeenCalledWith('remote')
  expect(f.request).toHaveBeenCalledWith('remote', 'slay.checkConfigured', {
    projectPath: '/remote/repo',
    projectId: 'project'
  })
  expect(f.request).toHaveBeenCalledWith('remote', 'slay.setup', {
    projectPath: '/remote/repo',
    projectId: 'project'
  })
})
it('never falls back to hub when computer is offline or access denied', async () => {
  const f = fixture()
  f.request.mockRejectedValue(new Error('offline'))
  await expect(f.executor.checkConfigured(target)).rejects.toThrow('offline')
  await expect(f.executor.setup(target)).rejects.toThrow('offline')
  f.gate.mockRejectedValue(new Error('denied'))
  f.request.mockClear()
  await expect(f.executor.setup(target)).rejects.toThrow('denied')
  expect(f.request).not.toHaveBeenCalled()
})
it('no computer: "connect a computer" — slay never runs on the hub', async () => {
  const f = fixture(null)
  await expect(f.executor.checkConfigured(target)).rejects.toThrow(/Connect a computer/)
  await expect(f.executor.setup(target)).rejects.toThrow(/Connect a computer/)
  expect(f.request).not.toHaveBeenCalled()
})
