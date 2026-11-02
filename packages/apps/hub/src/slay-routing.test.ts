import { expect, it, vi } from 'vitest'
import { createRoutingSlayExecutor } from './slay-routing'

function fixture(computerId: string | null = 'remote') {
  const request = vi.fn(async (_id, method) =>
    method === 'slay.setup' ? { ok: true } : { configured: false }
  )
  const local = { checkSlayConfigured: vi.fn(() => true), setupSlay: vi.fn(() => ({ ok: true })) }
  const resolveComputer = vi.fn(async () => computerId)
  const gate = vi.fn(async () => {})
  return {
    request,
    local,
    resolveComputer,
    gate,
    executor: createRoutingSlayExecutor({ gateway: { request }, local, resolveComputer, gate })
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
  expect(f.local.checkSlayConfigured).not.toHaveBeenCalled()
  expect(f.local.setupSlay).not.toHaveBeenCalled()
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
  expect(f.local.setupSlay).not.toHaveBeenCalled()
})
it('preserves standalone local behavior when no computer exists', async () => {
  const f = fixture(null)
  expect(await f.executor.checkConfigured(target)).toBe(true)
  expect(await f.executor.setup(target)).toEqual({ ok: true })
  expect(f.local.setupSlay).toHaveBeenCalledWith('/remote/repo', 'project')
  expect(f.request).not.toHaveBeenCalled()
})
