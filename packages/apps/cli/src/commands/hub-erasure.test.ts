import { Command } from 'commander'
import { afterEach, expect, test, vi } from 'vitest'
import { registerHubErasureCommands } from './hub-erasure'
afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = 0
})
test('erasure CLI previews by default and never deletes without email confirmation', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const request = vi.fn(async (method: string) =>
    method === 'GET'
      ? [{ id: 'alice', email: 'alice@example.com' }]
      : { counts: { projects: 1, tasks: 2, artifacts: 3, versions: 4 } }
  )
  const users = new Command('users')
  registerHubErasureCommands(users, request as never)
  await users.parseAsync(['erase-content', 'alice@example.com'], { from: 'user' })
  expect(request.mock.calls.every(([method]) => method === 'GET')).toBe(true)
})
test('an incomplete erasure is reported with a nonzero exit code', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const request = vi.fn(async (method: string) =>
    method === 'GET'
      ? [{ id: 'alice', email: 'alice@example.com' }]
      : {
          id: 'job',
          state: 'incomplete',
          counts: { projects: 1, tasks: 1, artifacts: 0, versions: 0 },
          computers: [{ id: 'pc', name: 'Laptop', deleted: false }],
          failures: []
        }
  )
  const users = new Command('users')
  registerHubErasureCommands(users, request as never)
  await users.parseAsync(['erase-content', 'alice@example.com', '--confirm', 'alice@example.com'], {
    from: 'user'
  })
  expect(process.exitCode).toBe(2)
  expect(request).toHaveBeenCalledWith('PATCH', {
    action: 'erase-content',
    userId: 'alice',
    confirmation: 'alice@example.com'
  })
})

test('JSON status is one array, including when no jobs exist', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {})
  const request = vi.fn(async (_method: string, _body: unknown, query?: { erasure?: string }) =>
    query?.erasure === 'reports' ? [] : [{ id: 'alice', email: 'alice@example.com' }]
  )
  const users = new Command('users')
  registerHubErasureCommands(users, request as never)
  await users.parseAsync(['erasure-status', 'alice@example.com', '--json'], { from: 'user' })
  expect(JSON.parse(String(output.mock.calls[0][0]))).toEqual([])
})
