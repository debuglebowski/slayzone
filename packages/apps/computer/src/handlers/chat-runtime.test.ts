import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { createChatRuntimeHandlers } from './chat-runtime'
const dirs: string[] = [],
  handles: Array<ReturnType<typeof createChatRuntimeHandlers>> = []
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const bootstrap = {
  identity: { id: 'store', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 },
  projectId: null,
  cwd: realpathSync(tmpdir()),
  revision: 1,
  providerConfig: {},
  defaultFlags: null,
  env: {}
}
function setup(extra: Partial<Parameters<typeof createChatRuntimeHandlers>[0]> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'slz-chat-rpc-'))
  dirs.push(stateDir)
  const notifications: unknown[] = []
  const h = createChatRuntimeHandlers({
    ...extra,
    ctx: {
      config: {
        hubUrl: 'ws://hub/computers',
        name: 'test',
        allowedRoots: [realpathSync(tmpdir())],
        capabilities: ['proc']
      },
      dialer: {
        notify: (m, p) => {
          notifications.push({ m, p })
          return true
        }
      },
      log: () => {}
    },
    stateDir,
    hubScope: 'hub',
    computerId: () => 'computer',
    getProjectPaths: () => null
  })
  handles.push(h)
  return { h, stateDir, notifications }
}
test('computer endpoints persist drafts and reject foreign tab commands', async () => {
  const { h } = setup()
  await h.request({ kind: 'bootstrap', value: bootstrap })
  expect(
    await h.request({
      kind: 'invoke',
      value: {
        route: { id: 'store', epoch: 1 },
        target: 'ops',
        method: 'saveTabDraft',
        operationId: 'draft',
        args: ['tab', { text: 'local only', attachments: [] }]
      }
    })
  ).toEqual({ rev: 1 })
  await expect(
    h.request({
      kind: 'invoke',
      value: {
        route: { id: 'store', epoch: 1 },
        target: 'ops',
        method: 'saveTabDraft',
        operationId: 'foreign',
        args: ['foreign', { text: 'wrong', attachments: [] }]
      }
    })
  ).rejects.toThrow(/ownership/i)
  expect(
    await h.request({
      kind: 'invoke',
      value: {
        route: { id: 'store', epoch: 1 },
        target: 'ops',
        method: 'getTabState',
        args: ['tab']
      }
    })
  ).toMatchObject({ draft: { text: 'local only' } })
})

test('diagnostic policy accepts only explicit booleans', async () => {
  const { h } = setup()
  expect(await h.request({ kind: 'diagnostics.configure', enabled: false, verbose: true })).toEqual(
    { enabled: false, verbose: true }
  )
  await expect(
    h.request({ kind: 'diagnostics.configure', enabled: 'false', verbose: true })
  ).rejects.toThrow()
})

test('computer-only test seeding is gated, atomic and epoch/task fenced', async () => {
  const { h } = setup()
  await h.request({ kind: 'bootstrap', value: bootstrap })
  const seed = {
    kind: 'test.seedEvents',
    route: { id: 'store', epoch: 1 },
    fromSeq: 1,
    events: [{ kind: 'assistant-text', messageId: 'a', text: 'computer-only marker' }]
  }
  try {
    vi.stubEnv('PLAYWRIGHT', 'true')
    await expect(h.request(seed)).rejects.toThrow(/test-only/i)
    vi.stubEnv('PLAYWRIGHT', '1')
    await expect(h.request({ ...seed, route: { id: 'store', epoch: 2 } })).rejects.toThrow(
      /ownership/i
    )
    expect(await h.request(seed)).toEqual({ ok: true })
    expect(await h.request(seed)).toEqual({ ok: true })
    expect(
      await h.request({ kind: 'test.readEvents', route: seed.route, afterSeq: -1, limit: 1 })
    ).toMatchObject([{ seq: 1, event: { text: 'computer-only marker' } }])
    await expect(
      h.request({
        ...seed,
        fromSeq: 0,
        events: [
          { kind: 'notice', text: 'must rollback' },
          { kind: 'assistant-text', text: 'conflict' }
        ]
      })
    ).rejects.toThrow()
    expect(
      await h.request({ kind: 'test.readEvents', route: seed.route, afterSeq: -1, limit: 10 })
    ).toMatchObject([{ seq: 1 }])
    await expect(
      h.request({ ...seed, events: Array.from({ length: 1001 }, () => ({ kind: 'notice' })) })
    ).rejects.toThrow()
    await expect(
      h.request({ ...seed, events: [{ kind: 'notice', text: 'x'.repeat(8 * 1024 * 1024) }] })
    ).rejects.toThrow(/byte limit/i)
    await h.request({ kind: 'task.lifecycle', taskId: 'task', state: 'paused', revision: 1 })
    await expect(h.request({ ...seed, fromSeq: 1 })).rejects.toThrow(/paused/i)
  } finally {
    vi.unstubAllEnvs()
  }
})
test('file listing still obeys the computer allowed-roots guard', async () => {
  const { h } = setup()
  await h.request({ kind: 'bootstrap', value: bootstrap })
  await expect(
    h.request({
      kind: 'invoke',
      value: {
        route: { id: 'store', epoch: 1 },
        target: 'ops',
        method: 'listFiles',
        args: ['/etc', '', 10]
      }
    })
  ).rejects.toThrow()
})

test('authenticated dispatch exposes chat requests and rejects a missing actor', async () => {
  const { createHubRequestHandler } = await import('../main')
  const stateDir = mkdtempSync(join(tmpdir(), 'slz-chat-dispatch-'))
  dirs.push(stateDir)
  const dispatch = createHubRequestHandler({
    stateDir,
    hubScope: 'hub-dispatch',
    getComputerId: () => 'computer',
    shutdown: () => {},
    dialer: { notify: () => true },
    config: {
      hubUrl: 'ws://hub/computers',
      name: 'test',
      allowedRoots: [realpathSync(tmpdir())],
      capabilities: ['proc']
    }
  })
  try {
    await expect(
      dispatch.handle('chat.request', { kind: 'bootstrap', value: bootstrap }, undefined)
    ).rejects.toThrow(/actor|older|protocol/i)
    expect(
      await dispatch.handle(
        'chat.request',
        { kind: 'bootstrap', value: bootstrap },
        { userId: null, route: 'test chat' }
      )
    ).toMatchObject({ ok: true })
  } finally {
    await dispatch.dispose()
  }
})

test('catalog operations execute on the computer and reject unlisted methods and paths', async () => {
  const { h } = setup()
  expect(await h.request({ kind: 'catalog', method: 'getAutocompleteUsage', args: [] })).toEqual({})
  await expect(
    h.request({ kind: 'catalog', method: 'listFiles', args: ['/etc', '', 10] })
  ).rejects.toThrow()
  await expect(
    h.request({
      kind: 'catalog',
      method: 'saveTabDraft',
      args: ['tab', { text: 'bad', attachments: [] }]
    })
  ).rejects.toThrow()
})

test('retention policy accepts whole days, supports disabling and refuses malformed input', async () => {
  const { h } = setup()
  expect(await h.request({ kind: 'retention.configure', days: 14 })).toEqual({ days: 14 })
  expect(await h.request({ kind: 'retention.configure', days: 0 })).toEqual({ days: 0 })
  for (const days of [-1, 1.2, '14'])
    await expect(h.request({ kind: 'retention.configure', days })).rejects.toThrow()
})

test('lifecycle fences native starts before awaiting their stop acknowledgement', async () => {
  let release!: () => void
  const stopping = new Promise<void>((resolve) => {
    release = resolve
  })
  const stopTask = vi.fn(async () => stopping)
  const { h } = setup({ stopTask })
  await h.request({ kind: 'bootstrap', value: bootstrap })
  let acknowledged = false
  const pause = h
    .request({ kind: 'task.lifecycle', taskId: 'task', state: 'paused', revision: 1 })
    .then(() => {
      acknowledged = true
    })
  expect(() => h.assertTaskActive('task')).toThrow(/paused|deleted/i)
  await vi.waitFor(() => expect(stopTask).toHaveBeenCalledWith('task', 'paused'))
  expect(acknowledged).toBe(false)
  release()
  await pause
  await h.request({ kind: 'task.lifecycle', taskId: 'task', state: 'active', revision: 2 })
  expect(() => h.assertTaskActive('task')).not.toThrow()
  await h.request({ kind: 'task.lifecycle', taskId: 'task', state: 'deleted', revision: 3 })
  // A purge says so: the task's terminals' saved output goes with it (pty-history).
  expect(stopTask).toHaveBeenLastCalledWith('task', 'deleted')
  expect(() => h.assertTaskActive('task')).toThrow(/paused|deleted/i)
  expect(() => h.assertTaskActive('other')).not.toThrow()
})

test('direct link: history reads under the granted epoch; a stale epoch is refused by the computer itself', async () => {
  const { h } = setup()
  await h.request({ kind: 'bootstrap', value: bootstrap })
  try {
    vi.stubEnv('PLAYWRIGHT', '1')
    await h.request({
      kind: 'test.seedEvents',
      route: { id: 'store', epoch: 1 },
      fromSeq: 1,
      events: [{ kind: 'assistant-text', messageId: 'a', text: 'direct marker' }]
    })
  } finally {
    vi.unstubAllEnvs()
  }
  // The same answer the hub relays, for each direct read.
  for (const [method, args] of [
    ['getReplay', ['tab', -1]],
    ['searchTimeline', ['tab', 'direct marker']]
  ] as const) {
    const relayed = await h.request({
      kind: 'invoke',
      value: { route: { id: 'store', epoch: 1 }, target: 'ops', method, args: [...args] }
    })
    expect(await h.direct.read('tab', 1, method, [...args])).toEqual(relayed)
  }

  await expect(h.direct.read('tab', 2, 'getReplay', ['tab', -1])).rejects.toThrow(/epoch/i)
  await expect(h.direct.read('foreign', 1, 'getReplay', ['foreign', -1])).rejects.toThrow()
  await expect(
    h.direct.read('tab', 1, 'saveTabDraft' as never, ['tab', { text: 'x', attachments: [] }])
  ).rejects.toThrow(/not a direct chat read/)
  expect(
    h.direct.watch(
      'tab',
      2,
      () => undefined,
      () => undefined
    )
  ).toBeNull()
  const stop = h.direct.watch(
    'tab',
    1,
    () => undefined,
    () => undefined
  )
  expect(stop).not.toBeNull()
  stop?.()
})

test('direct link: simple commands run under the granted epoch and tell the hub to drain metadata', async () => {
  const { h, notifications } = setup()
  await h.request({ kind: 'bootstrap', value: bootstrap })
  notifications.length = 0
  expect(
    await h.direct.command(
      'tab',
      1,
      'saveTabDraft',
      ['tab', { text: 'direct draft', attachments: [] }],
      'op-1'
    )
  ).toEqual({ rev: 1 })
  // The same operation again is the same receipt, not a second write.
  expect(
    await h.direct.command(
      'tab',
      1,
      'saveTabDraft',
      ['tab', { text: 'direct draft', attachments: [] }],
      'op-1'
    )
  ).toEqual({ rev: 1 })
  expect(
    notifications.filter((n) => (n as { p: { name?: string } }).p?.name === 'chat-direct-write')
  ).toEqual([
    {
      m: 'event',
      p: {
        name: 'chat-direct-write',
        payload: { tabId: 'tab', conversationId: 'store', epoch: 1, method: 'saveTabDraft' }
      }
    },
    {
      m: 'event',
      p: {
        name: 'chat-direct-write',
        payload: { tabId: 'tab', conversationId: 'store', epoch: 1, method: 'saveTabDraft' }
      }
    }
  ])
  expect(
    await h.request({
      kind: 'invoke',
      value: {
        route: { id: 'store', epoch: 1 },
        target: 'ops',
        method: 'getTabState',
        args: ['tab']
      }
    })
  ).toMatchObject({ draft: { text: 'direct draft' } })
  await expect(
    h.direct.command('tab', 2, 'saveTabScroll', ['tab', { atBottom: true }], 'op-2')
  ).rejects.toThrow(/epoch/i)
  await expect(h.direct.command('tab', 1, 'send' as never, ['tab', {}], 'op-3')).rejects.toThrow(
    /not a direct chat command/
  )
})
