import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { afterEach, expect, test, vi } from 'vitest'
import { registerHubErasureCommands } from './hub-erasure'
afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = 0
})
const accounts = vi.fn(async () => [{ id: 'alice', email: 'alice@example.com' }])
function commands(erasure: (...args: never[]) => Promise<unknown>) {
  const users = new Command('users')
  registerHubErasureCommands(users, accounts as never, erasure as never)
  return users
}
/** Only the read-only views may travel as GET; anything else is a state change. */
function readOnlyGets(erasure: ReturnType<typeof vi.fn>) {
  for (const [method, , query] of erasure.mock.calls as Array<
    [string, unknown, Record<string, string> | undefined]
  >)
    if (method === 'GET') expect(['preview', 'reports']).toContain(query?.view)
}

test('erasure CLI previews by default and never deletes without email confirmation', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const erasure = vi.fn(async () => ({
    counts: { projects: 1, tasks: 2, artifacts: 3, versions: 4 }
  }))
  await commands(erasure).parseAsync(['erase-content', 'alice@example.com'], { from: 'user' })
  expect(erasure.mock.calls).toEqual([['GET', undefined, { view: 'preview', userId: 'alice' }]])
})

test('an incomplete erasure is reported with a nonzero exit code', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const erasure = vi.fn(async () => ({
    id: 'job',
    state: 'incomplete',
    counts: { projects: 1, tasks: 1, artifacts: 0, versions: 0 },
    computers: [{ id: 'pc', name: 'Laptop', deleted: false }],
    failures: []
  }))
  await commands(erasure).parseAsync(
    ['erase-content', 'alice@example.com', '--confirm', 'alice@example.com'],
    { from: 'user' }
  )
  expect(process.exitCode).toBe(2)
  expect(erasure).toHaveBeenCalledWith('POST', {
    action: 'erase-content',
    userId: 'alice',
    confirmation: 'alice@example.com'
  })
  readOnlyGets(erasure)
})

test('JSON status is one array, including when no jobs exist', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {})
  const erasure = vi.fn(async () => [])
  await commands(erasure).parseAsync(['erasure-status', 'alice@example.com', '--json'], {
    from: 'user'
  })
  expect(JSON.parse(String(output.mock.calls[0][0]))).toEqual([])
  expect(erasure).toHaveBeenCalledWith('GET', undefined, { view: 'reports', userId: 'alice' })
})

test('retry, receipt, computer request and confirmation are POSTs', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const dir = mkdtempSync(join(tmpdir(), 'hub-erasure-cli-'))
  try {
    const report = {
      id: 'job',
      state: 'complete',
      counts: { projects: 0, tasks: 0, artifacts: 0, versions: 0 },
      computers: [],
      failures: []
    }
    const erasure = vi.fn(async (_method: string, body?: { action?: string }) =>
      body?.action === 'receipt' ? { version: 1, jobId: 'job' } : report
    )
    const run = (args: string[]) => commands(erasure).parseAsync(args, { from: 'user' })
    await run(['retry-erasure', 'job'])
    expect(erasure).toHaveBeenLastCalledWith('POST', { action: 'retry-erasure', jobId: 'job' })
    const receiptFile = join(dir, 'receipt.json')
    await run(['erasure-receipt', 'job', '--output', receiptFile])
    expect(erasure).toHaveBeenLastCalledWith('POST', { action: 'receipt', jobId: 'job' })
    expect(JSON.parse(readFileSync(receiptFile, 'utf8'))).toEqual({ version: 1, jobId: 'job' })
    await run([
      'computer-erasure-request',
      'job',
      'pc',
      '--computer-hub-url',
      'wss://hub.example/computers',
      '--output',
      join(dir, 'request.json')
    ])
    expect(erasure).toHaveBeenLastCalledWith('POST', {
      action: 'computer-erasure-request',
      jobId: 'job',
      computerId: 'pc',
      hubUrl: 'wss://hub.example/computers'
    })
    const offline = join(dir, 'offline-receipt.json')
    writeFileSync(offline, JSON.stringify({ managedContentErased: true }))
    await run(['confirm-computer-erasure', offline])
    expect(erasure).toHaveBeenLastCalledWith('POST', {
      action: 'confirm-computer-erasure',
      receipt: { managedContentErased: true }
    })
    expect(erasure.mock.calls.every(([method]) => method === 'POST')).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
