/**
 * `slay pty` and the terminal sessions a computer still runs from a previous hub run
 * that are not attached to their tabs: `list` shows them in their own section (its
 * `--json` stays the attached sessions, unchanged), `unattached` lists them, `attach`
 * adopts one again, `kill` stops one.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { apiDelete, apiGet, apiPost } from '../api'
import { ptyCommand } from './pty'

vi.mock('../api', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiDelete: vi.fn(),
  apiFetch: vi.fn()
}))

const attached = [
  {
    sessionId: 'task-1:task-1',
    taskId: 'task-1',
    tabId: 'task-1',
    label: null,
    mode: 'claude-code',
    state: 'idle',
    createdAt: Date.now() - 60_000,
    lastOutputTime: Date.now()
  }
]
const unattached = [
  {
    computerId: 'pc-1',
    sessionId: 'task-2:tab-9',
    taskId: 'task-2',
    tabId: 'tab-9',
    spawnId: 'run-1',
    pid: 4242,
    detection: true,
    mode: 'codex',
    startedAt: Date.now() - 3 * 3_600_000,
    status: 'unattached',
    reason: 'mode-mismatch',
    detail: 'the process runs codex, the tab claude-code'
  }
]

let out: string[]
beforeEach(() => {
  out = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.join(' '))
  })
  vi.mocked(apiGet).mockImplementation(async (path: string) =>
    path === '/api/pty/unattached' ? unattached : attached
  )
})
afterEach(() => vi.restoreAllMocks())

const run = (...args: string[]) => ptyCommand().parseAsync(args, { from: 'user' })

test('list: the unattached ones in their own section, with the reason and what to do', async () => {
  await run('list')
  const text = out.join('\n')
  expect(text).toContain('task-1:task-1')
  expect(text).toMatch(/Not attached/)
  expect(text).toContain('task-2:tab-9')
  expect(text).toContain('mode-mismatch')
  expect(text).toContain('pc-1')
  expect(text).toMatch(/slay pty attach/)
})

test('list --json is the attached sessions, unchanged', async () => {
  await run('list', '--json')
  expect(JSON.parse(out.join('\n'))).toEqual(attached)
})

test('unattached --json lists them as the hub has them', async () => {
  await run('unattached', '--json')
  expect(JSON.parse(out.join('\n'))).toEqual(unattached)
})

test('attach: by session id prefix, addressed by computer and session', async () => {
  vi.mocked(apiPost).mockResolvedValue({ ok: true })
  await run('attach', 'task-2')
  expect(apiPost).toHaveBeenCalledWith('/api/pty/unattached/pc-1/task-2%3Atab-9/attach', {})
  expect(out.join('\n')).toContain('Attached: task-2:tab-9')
})

test('kill: an id that is not an attached session stops the unattached one', async () => {
  vi.mocked(apiDelete).mockResolvedValue({ ok: true })
  await run('kill', 'task-2')
  expect(apiDelete).toHaveBeenCalledWith('/api/pty/unattached/pc-1/task-2%3Atab-9')
  expect(out.join('\n')).toContain('Stopped: task-2:tab-9')
})

test('kill: an attached session is still killed the usual way', async () => {
  vi.mocked(apiDelete).mockResolvedValue({ ok: true })
  await run('kill', 'task-1')
  expect(apiDelete).toHaveBeenCalledWith('/api/pty/task-1%3Atask-1')
})
