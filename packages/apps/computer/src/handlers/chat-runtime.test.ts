import * as runtimeFactory from '@slayzone/chat-runtime/server'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import Database from 'better-sqlite3'
import { build } from 'esbuild'
import { toolPreviewVersion, type ChatRowDetailRef } from '@slayzone/terminal-contracts'
import { decodeTimelineState } from '@slayzone/terminal/timeline-checkpoint'
import { TIMELINE_PROJECTION_VERSION } from '@slayzone/terminal/timeline-projection'
import { createChatRuntimeHandlers } from './chat-runtime'
import { createFixtureChatRuntime, projectScopedDeps } from '../project-scope.fixture'
import { createSpawnAdmission } from '../spawn-admission'
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
  const h = createFixtureChatRuntime({
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
test('online runtime readiness, bootstrap, drafts and metadata use the worker owner without native SQL on main', async () => {
  const { h } = setup()
  const methods = ['prepare', 'exec', 'pragma', 'backup', 'close'] as const
  const native = methods.map((method) => vi.spyOn(Database.prototype, method))
  try {
    await h.request({ kind: 'bootstrap', value: bootstrap })
    await h.request({
      kind: 'invoke',
      value: {
        route: { id: 'store', epoch: 1 },
        target: 'ops',
        method: 'saveTabDraft',
        operationId: 'owner-draft',
        args: ['tab', { text: 'worker owned', attachments: [] }]
      }
    })
    expect(await h.request({ kind: 'metadata.snapshot', id: 'store' })).toMatchObject({
      identity: bootstrap.identity
    })
    await h.close()
    for (const method of native) expect(method).not.toHaveBeenCalled()
  } finally {
    for (const method of native) method.mockRestore()
  }
})
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

test('relayed and direct history reads hold spawn admission after ownership validation', async () => {
  const release = vi.fn()
  const holdHistoryRead = vi.fn(() => release)
  const { h } = setup({ admission: { ...createSpawnAdmission(), holdHistoryRead } })
  await h.request({ kind: 'bootstrap', value: bootstrap })
  const invoke = (method: string, args: unknown[], operationId?: string) =>
    h.request({
      kind: 'invoke',
      value: { route: { id: 'store', epoch: 1 }, target: 'ops', method, args, operationId }
    })
  const version = TIMELINE_PROJECTION_VERSION

  await invoke('getInfo', ['tab'])
  await expect(invoke('openTimeline', ['foreign', version])).rejects.toThrow(/ownership/)
  await expect(h.direct.read('tab', 2, 'openTimeline', ['tab', version])).rejects.toThrow(/epoch/)
  expect(holdHistoryRead).not.toHaveBeenCalled()

  const context = { taskId: 'task', tabId: 'tab', mode: 'claude-chat', cwd: bootstrap.cwd }
  await invoke('hydrate', [context], 'hydrate')
  expect(holdHistoryRead).toHaveBeenCalledTimes(1)
  expect(release).toHaveBeenCalledTimes(1)

  await invoke('hydrate', [context], 'hydrate')
  expect(holdHistoryRead).toHaveBeenCalledTimes(1)

  await invoke('openTimeline', ['tab', version])
  await h.direct.read('tab', 1, 'getReplay', ['tab', -1])
  expect(holdHistoryRead).toHaveBeenCalledTimes(3)
  expect(release).toHaveBeenCalledTimes(3)
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
    // The task's project is placed here: its agent starts inside it (§9 Phase 7c).
    getProjectPaths: projectScopedDeps({ p1: realpathSync(tmpdir()) }).getProjectPaths,
    shutdown: () => {},
    dialer: { notify: () => true },
    config: {
      hubUrl: 'ws://hub/computers',
      name: 'test',
      allowedRoots: [realpathSync(tmpdir())],
      capabilities: ['proc']
    }
  })
  const placed = { ...bootstrap, projectId: 'p1' }
  try {
    await expect(
      dispatch.handle('chat.request', { kind: 'bootstrap', value: placed }, undefined)
    ).rejects.toThrow(/actor|older|protocol/i)
    expect(
      await dispatch.handle(
        'chat.request',
        { kind: 'bootstrap', value: placed },
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
  await expect(h.assertTaskActive('task')).rejects.toThrow(/admission|paused|deleted/i)
  await vi.waitFor(() => expect(stopTask).toHaveBeenCalledWith('task', 'paused'))
  expect(acknowledged).toBe(false)
  release()
  await pause
  await h.request({ kind: 'task.lifecycle', taskId: 'task', state: 'active', revision: 2 })
  await expect(h.assertTaskActive('task')).resolves.toBeUndefined()
  await h.request({ kind: 'task.lifecycle', taskId: 'task', state: 'deleted', revision: 3 })
  // A purge says so: the task's terminals' saved output goes with it (pty-history).
  expect(stopTask).toHaveBeenLastCalledWith('task', 'deleted')
  await expect(h.assertTaskActive('task')).rejects.toThrow(/admission|paused|deleted/i)
  await expect(h.assertTaskActive('other')).resolves.toBeUndefined()
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
    await h.direct.watch(
      'tab',
      2,
      () => undefined,
      () => undefined
    )
  ).toBeNull()
  const stop = await h.direct.watch(
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

test('inventory: one conversation whose state cannot be read is flagged, the others are reported', async () => {
  const { h, stateDir } = setup()
  await h.request({ kind: 'bootstrap', value: bootstrap })
  await h.request({
    kind: 'bootstrap',
    value: { ...bootstrap, identity: { ...bootstrap.identity, id: 'other', tabId: 'tab2' } }
  })
  const { default: Database } = await import('better-sqlite3')
  const { readdirSync } = await import('node:fs')
  const runtime = join(stateDir, 'computer-runtime')
  const ns = readdirSync(runtime).find((d) => /^[a-f0-9]{64}$/.test(d))!
  const raw = new Database(join(runtime, ns, 'chat.sqlite'))
  raw
    .prepare(
      "UPDATE records SET value='{broken' WHERE conversation_id='store' AND kind='settings' AND id='bootstrap'"
    )
    .run()
  raw.close()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const inventory = (await h.request({ kind: 'inventory' })) as Array<{
    identity: { id: string }
    unreadable?: boolean
    bootstrapRevision?: number
  }>
  expect(inventory.find((e) => e.identity.id === 'store')).toMatchObject({ unreadable: true })
  expect(inventory.find((e) => e.identity.id === 'other')).toMatchObject({ bootstrapRevision: 1 })
})

test('a storage-only owner (task content / artifact store) opens without any folder; no agent starts there', async () => {
  const { h } = setup()
  const identity = {
    id: 'content',
    taskId: 'task',
    tabId: 'task-content:task',
    mode: 'claude-chat',
    epoch: 1
  }
  // The hub sends a storage-only owner no folder (it never runs an agent): the
  // task may have no worktree, base dir or placed project on this computer.
  await expect(
    h.request({ kind: 'bootstrap', value: { ...bootstrap, identity, cwd: '' } })
  ).resolves.toMatchObject({ ok: true })
  await expect(
    h.request({
      kind: 'invoke',
      value: {
        route: { id: 'content', epoch: 1 },
        target: 'ops',
        method: 'takeOver',
        operationId: 'take-1',
        args: [{ tabId: 'task-content:task', taskId: 'task', mode: 'claude-chat', cwd: '' }]
      }
    })
  ).rejects.toThrow(/no folder on this computer/)
})

test('archive.blob: a restored archive serves an image only to the conversation that references it, in bounded chunks', async () => {
  const { h } = setup()
  await h.request({ kind: 'bootstrap', value: bootstrap })
  await h.request({
    kind: 'bootstrap',
    value: {
      ...bootstrap,
      identity: { id: 'other', taskId: 'task2', tabId: 'tab2', mode: 'claude-chat', epoch: 1 }
    }
  })
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(700 * 1024, 7)])
  const sha = (await import('node:crypto')).createHash('sha256').update(png).digest('hex')
  try {
    vi.stubEnv('PLAYWRIGHT', '1')
    await h.request({
      kind: 'test.seedEvents',
      route: { id: 'store', epoch: 1 },
      fromSeq: 0,
      events: [
        {
          kind: 'tool-result',
          toolUseId: 't',
          isError: false,
          rawContent: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') }
            }
          ],
          structured: null
        }
      ]
    })
  } finally {
    vi.unstubAllEnvs()
  }
  const backupId = '00000000-0000-4000-8000-000000000001',
    archiveId = '00000000-0000-4000-8000-000000000002'
  await h.request({ kind: 'backup.create', id: backupId })
  await h.request({ kind: 'backup.restore', backupId, archiveId })
  const read = (conversationId: string, offset: number) =>
    h.request({ kind: 'archive.blob', archiveId, conversationId, sha256: sha, offset }) as Promise<{
      mediaType: string
      size: number
      offset: number
      data: string
    }>
  const parts: Buffer[] = []
  for (let offset = 0; offset < png.length; ) {
    const chunk = await read('store', offset)
    expect(chunk).toMatchObject({ mediaType: 'image/png', size: png.length, offset })
    const bytes = Buffer.from(chunk.data, 'base64')
    expect(bytes.length).toBeLessThanOrEqual(512 * 1024)
    parts.push(bytes)
    offset += bytes.length
  }
  expect(Buffer.concat(parts)).toEqual(png)
  await expect(read('other', 0)).rejects.toThrow(/not part of this archive conversation/i)
  await expect(
    h.request({
      kind: 'archive.blob',
      archiveId,
      conversationId: 'store',
      sha256: '../x',
      offset: 0
    })
  ).rejects.toThrow()
})

test('computer handler uses the bundled projection worker and survives its startup failure', async () => {
  const source = (
    await build({
      entryPoints: [
        join(
          import.meta.dirname,
          '../../../../domains/terminal/src/server/runtime/chat-timeline-worker-entry.ts'
        )
      ],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      write: false
    })
  ).outputFiles[0].text
  for (const [workerSource, expectedKind] of [
    [source, 'paged'],
    ["throw new Error('worker startup fault')", 'full']
  ] as const) {
    vi.stubGlobal('__SLAYZONE_TIMELINE_WORKER_SOURCE__', workerSource)
    const { h } = setup()
    try {
      await h.request({ kind: 'bootstrap', value: bootstrap })
      const rawContent = 'complete stored output '.repeat(600)
      const thinking = 'Historical reasoning for the file read'
      vi.stubEnv('PLAYWRIGHT', '1')
      try {
        await h.request({
          kind: 'test.seedEvents',
          route: { id: 'store', epoch: 1 },
          fromSeq: 0,
          events: [
            { kind: 'tool-call', id: 'tool', name: 'Read', input: { file_path: '/sample' } },
            {
              kind: 'tool-result',
              toolUseId: 'tool',
              rawContent,
              structured: null,
              isError: false
            },
            { kind: 'assistant-thinking', messageId: 'thought', text: thinking, hasSignature: true }
          ]
        })
      } finally {
        vi.unstubAllEnvs()
      }
      await h.request({
        kind: 'invoke',
        value: {
          route: { id: 'store', epoch: 1 },
          target: 'ops',
          method: 'hydrate',
          operationId: 'hydrate-worker',
          args: [{ taskId: 'task', tabId: 'tab', mode: 'claude-chat', cwd: bootstrap.cwd }]
        }
      })
      const opened = (await h.request({
        kind: 'invoke',
        value: {
          route: { id: 'store', epoch: 1 },
          target: 'ops',
          method: 'openTimeline',
          args: ['tab', toolPreviewVersion(TIMELINE_PROJECTION_VERSION, { hideThinking: true })]
        }
      })) as { kind: string; snapshot?: { state: string; toolPreviews: boolean } }
      expect(opened.kind).toBe(expectedKind)
      if (expectedKind === 'paged') {
        expect(opened.snapshot?.toolPreviews).toBe(true)
        const [row, thought] = decodeTimelineState(opened.snapshot!.state).timeline
        if (row?.kind !== 'tool') throw new Error('Expected a tool row')
        expect(row.invocation.result?.rawContent).not.toBe(rawContent)
        const ref = row.invocation.toolDetail
        if (!ref) throw new Error('Expected a tool preview')
        const read = (tabId: string, detail: ChatRowDetailRef) =>
          h.request({
            kind: 'invoke',
            value: {
              route: { id: 'store', epoch: 1 },
              target: 'ops',
              method: 'toolDetail',
              args: [tabId, detail, 0]
            }
          })
        expect(await read('tab', ref)).toMatchObject({ data: expect.stringContaining(rawContent) })
        await expect(read('tab', { ...ref, instance: 'previous-open' })).resolves.toBeNull()
        await expect(read('another-tab', ref)).rejects.toThrow(/ownership/i)
        if (thought?.kind !== 'thinking' || !thought.textDetail)
          throw new Error('Expected a thinking stub')
        expect(thought.text).toBe('')
        expect(await read('tab', thought.textDetail)).toMatchObject({
          data: JSON.stringify(thinking)
        })
        await expect(read('another-tab', thought.textDetail)).rejects.toThrow(/ownership/i)
        await expect(
          h.request({
            kind: 'invoke',
            value: {
              route: { id: 'store', epoch: 1 },
              target: 'ops',
              method: 'searchTimeline',
              args: ['tab', '/SAMPLE', false]
            }
          })
        ).resolves.toEqual({ pages: [], toolUseIds: ['tool'], windowedPages: [0] })
      }
      await h.request({
        kind: 'invoke',
        value: {
          route: { id: 'store', epoch: 1 },
          target: 'ops',
          method: 'saveTabDraft',
          operationId: 'draft-worker',
          args: ['tab', { text: 'draft stays available', attachments: [] }]
        }
      })
    } finally {
      await h.close()
      vi.unstubAllGlobals()
    }
  }
})

test('storage compaction: status, refused start with its reason, cancel, malformed input', async () => {
  const { h } = setup()
  const status = (await h.request({ kind: 'storage.status' })) as Record<string, unknown>
  expect(status).toMatchObject({
    supported: true,
    autoVacuum: 'none',
    backfillDone: false,
    job: null,
    last: null
  })
  expect(typeof status.fileBytes).toBe('number')
  // A fresh store's image backfill has not run yet: a rebuild waits for it.
  await expect(h.request({ kind: 'storage.compact' })).rejects.toThrow(/backfill/i)
  expect(await h.request({ kind: 'storage.cancel' })).toBeNull()
  await expect(h.request({ kind: 'storage.compact', force: true })).rejects.toThrow()
})

test('online handler close drains remaining controllers and keeps its failed result on repeated close', async () => {
  const open = runtimeFactory.openComputerChatRuntime
  const error = new Error('store cleanup failed after physical exit')
  const factory = vi
    .spyOn(runtimeFactory, 'openComputerChatRuntime')
    .mockImplementation(async (opts) => {
      const r = await open(opts)
      const close = r.close.bind(r)
      return {
        ...r,
        close: async () => {
          await close()
          throw error
        }
      }
    })
  const { h } = setup()
  try {
    await h.request({ kind: 'bootstrap', value: bootstrap })
    const closing = h.close()
    await expect(closing).rejects.toBe(error)
    expect(h.close()).toBe(closing)
    await expect(h.close()).rejects.toBe(error)
    expect(h.ownedPids()).toEqual([])
  } finally {
    factory.mockRestore()
    handles.splice(handles.indexOf(h), 1)
  }
})
