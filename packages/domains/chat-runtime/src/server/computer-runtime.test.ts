import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createComputerChatRuntime } from './computer-runtime'

const dirs: string[] = []
const runtimes: Array<ReturnType<typeof createComputerChatRuntime>> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function runtime(stateDir = mkdtempSync(join(tmpdir(), 'slz-computer-chat-')), hubScope = 'hub-a') {
  if (!dirs.includes(stateDir)) dirs.push(stateDir)
  const r = createComputerChatRuntime({ stateDir, hubScope, computerId: 'computer-a' })
  runtimes.push(r)
  return { r, stateDir }
}
const bootstrap = {
  identity: { id: 'storage-a', taskId: 'task-a', tabId: 'tab-a', mode: 'claude-chat', epoch: 1 },
  projectId: 'project-a',
  cwd: '/tmp',
  revision: 1,
  providerConfig: {},
  defaultFlags: null,
  env: {}
}
const createOpts = { taskId: 'task-a', tabId: 'tab-a', mode: 'claude-chat', cwd: '/tmp' }

test('drafts persist on computer and restore without a hub database', async () => {
  const { r, stateDir } = runtime()
  r.bootstrap(bootstrap)
  await r.ops.hydrate(createOpts)
  expect(await r.ops.saveTabDraft('tab-a', { text: 'private draft', attachments: [] })).toEqual({
    rev: 1
  })
  await r.close()
  const next = runtime(stateDir).r
  next.bootstrap(bootstrap)
  expect((await next.ops.getTabState('tab-a'))?.draft.text).toBe('private draft')
})

test('chat prompt recall keeps the latest 500 entries without truncating conversation history', () => {
  const { r } = runtime()
  r.bootstrap(bootstrap)
  r.storage.transaction(() => {
    for (let i = 0; i < 501; i++)
      r.local.data.persistChatEventSync!(
        'tab-a',
        i,
        {
          kind: 'user-message',
          id: `message-${i}`,
          text: `prompt ${i}`
        },
        1000 + i
      )
  })
  const prompts = r.prompts('task-a', 'claude-chat')
  expect(prompts).toHaveLength(500)
  expect(prompts[0].text).toBe('prompt 1')
  expect(prompts.at(-1)?.text).toBe('prompt 500')
  expect(r.storage.read(bootstrap.identity.id, -1, 1000)).toHaveLength(501)
})

test('two hubs can use the same task and tab ids without sharing chat content', async () => {
  const a = runtime(),
    b = runtime(a.stateDir, 'hub-b')
  a.r.bootstrap(bootstrap)
  b.r.bootstrap(bootstrap)
  await a.r.ops.saveTabDraft('tab-a', { text: 'hub-a-only', attachments: [] })
  expect((await b.r.ops.getTabState('tab-a'))?.draft.text ?? '').toBe('')
})

test('a failed timeline page write rolls back all pages and its checkpoint', async () => {
  const { r } = runtime()
  r.bootstrap(bootstrap)
  const page = (n: number, text: string) => ({
    page: n,
    startRow: n,
    endRow: n + 1,
    rows: text,
    summary: '{}',
    searchText: text
  })
  await r.local.data.saveTimeline('tab-a', {
    dropPagesFrom: null,
    pages: [page(0, 'old')],
    checkpoint: { version: 'v', seq: 0, data: 'old' }
  })
  const original = r.storage.putRecord.bind(r.storage)
  r.storage.putRecord = (id, epoch, record) => {
    if (record.kind === 'timeline' && record.id === 'page:1') throw new Error('disk full')
    return original(id, epoch, record)
  }
  await expect(
    r.local.data.saveTimeline('tab-a', {
      dropPagesFrom: 0,
      pages: [page(0, 'new'), page(1, 'new')],
      checkpoint: { version: 'v', seq: 1, data: 'new' }
    })
  ).rejects.toThrow('disk full')
  expect(await r.local.data.loadTimelinePages('tab-a', [0])).toEqual([{ page: 0, rows: 'old' }])
  expect((await r.local.data.loadTimelineCheckpoint('tab-a'))?.seq).toBe(0)
})

test('invocation fences cross-tab mutations and persists retry receipts', async () => {
  const { r } = runtime()
  r.bootstrap(bootstrap)
  const req = {
    route: { id: 'storage-a', epoch: 1 },
    target: 'ops',
    method: 'saveTabDraft',
    operationId: 'save-a',
    args: ['tab-a', { text: 'private', attachments: [] }]
  }
  await expect(
    r.invoke({ ...req, args: ['another-tab', { text: 'leak', attachments: [] }] })
  ).rejects.toThrow(/ownership|tab/i)
  expect(await r.invoke(req)).toEqual({ rev: 1 })
  expect(await r.invoke(req)).toEqual({ rev: 1 })
  expect((await r.ops.getTabState('tab-a'))?.draft.rev).toBe(1)
  await expect(r.invoke({ ...req, route: { id: 'storage-a', epoch: 0 } })).rejects.toThrow()
})

test('an accepted operation without a completion receipt is not automatically executed again', async () => {
  const { r } = runtime()
  r.bootstrap(bootstrap)
  const req = {
    route: { id: 'storage-a', epoch: 1 },
    target: 'ops',
    method: 'saveTabDraft',
    operationId: 'uncertain',
    args: ['tab-a', { text: 'unknown', attachments: [] }]
  }
  r.storage.acceptCommand('storage-a', 1, 'uncertain', {
    target: req.target,
    method: req.method,
    args: req.args
  })
  await expect(r.invoke(req)).rejects.toThrow(/unconfirmed/i)
  expect(await r.ops.getTabState('tab-a')).toBeNull()
})

test('queue handoff survives a crash until its user-message event commits', async () => {
  const { r, stateDir } = runtime()
  r.bootstrap(bootstrap)
  await r.local.queue.push('tab-a', 'hello', 'hello', { id: 'queued-message' })
  expect((await r.local.queue.pop('tab-a'))?.id).toBe('queued-message')
  await r.close()
  const next = runtime(stateDir).r
  next.bootstrap(bootstrap)
  expect((await next.local.queue.list('tab-a')).map((m) => m.id)).toEqual(['queued-message'])
  next.local.data.persistChatEventSync!(
    'tab-a',
    0,
    {
      kind: 'user-message',
      id: 'queued-message',
      text: 'hello',
      content: [{ type: 'text', text: 'hello' }]
    },
    1
  )
  expect(await next.local.queue.list('tab-a')).toEqual([])
  expect((await next.local.data.loadChatEvents('tab-a'))[0].event).toMatchObject({
    id: 'queued-message',
    text: 'hello'
  })
})

test('workspace metadata and lazy diff reads survive computer restart', async () => {
  const { r, stateDir } = runtime()
  r.bootstrap(bootstrap)
  const record = {
    id: 'capture',
    tabId: 'tab-a',
    messageId: 'm',
    computerId: 'computer-a',
    rootPath: '/tmp',
    files: []
  }
  await r.workspaceStore.begin({ ...record, status: 'pending' })
  await r.workspaceStore.save({
    ...record,
    status: 'complete',
    files: [
      {
        path: 'a.ts',
        kind: 'modified',
        additions: 1,
        deletions: 0,
        binary: false,
        diff: 'private diff'
      }
    ]
  })
  expect((await r.workspaceStore.get('tab-a', 'capture'))?.files[0]).toMatchObject({
    diff: null,
    hasDiff: true
  })
  await r.close()
  const next = runtime(stateDir).r
  next.bootstrap(bootstrap)
  expect(await next.workspaceStore.getFileDiff!('tab-a', 'capture', 'a.ts')).toBe('private diff')
  expect(await next.workspaceStore.get('another-tab', 'capture')).toBeNull()
})

test('terminal hook prompts survive before a tab bootstrap and never enter metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'slz-hook-chat-'))
  dirs.push(root)
  const metadata: unknown[] = []
  const a = createComputerChatRuntime({
    stateDir: root,
    hubScope: 'hook-hub',
    computerId: 'pc',
    onMetadata: (u) => metadata.push(u)
  })
  a.captureHook({
    agentId: 'claude-code',
    mode: 'claude-code',
    hookEvent: 'UserPromptSubmit',
    taskId: 'hook-task',
    sessionId: 'provider',
    raw: { prompt: 'local hook marker' }
  })
  await a.close()
  const b = createComputerChatRuntime({ stateDir: root, hubScope: 'hook-hub', computerId: 'pc' })
  try {
    expect(b.prompts('hook-task')).toMatchObject([
      { text: 'local hook marker', agent_id: 'claude-code', cli_session_id: 'provider' }
    ])
    expect(JSON.stringify(metadata)).not.toContain('local hook marker')
  } finally {
    await b.close()
  }
})

test('Trash pauses chat without losing drafts or queue; final purge cannot be undone by old state', async () => {
  const { r } = runtime()
  r.bootstrap(bootstrap)
  await r.ops.saveTabDraft('tab-a', { text: 'undo keeps this', attachments: [] })
  await r.queueOps.push('tab-a', 'queued prompt', 'queued prompt', { id: 'queued' })
  await r.applyTaskLifecycle('task-a', 'paused', 1)
  await expect(
    r.invoke({
      route: { id: 'storage-a', epoch: 1 },
      target: 'ops',
      method: 'saveTabDraft',
      operationId: 'paused-write',
      args: ['tab-a', { text: 'should fail', attachments: [] }]
    })
  ).rejects.toThrow(/paused/i)
  expect(await r.ops.getTabState('tab-a')).toMatchObject({ draft: { text: 'undo keeps this' } })
  expect(await r.queueOps.list('tab-a')).toHaveLength(1)
  await r.applyTaskLifecycle('task-a', 'active', 2)
  expect(
    await r.invoke({
      route: { id: 'storage-a', epoch: 1 },
      target: 'ops',
      method: 'saveTabDraft',
      operationId: 'restored-write',
      args: ['tab-a', { text: 'restored', attachments: [] }]
    })
  ).toEqual({ rev: 2 })
  await r.applyTaskLifecycle('task-a', 'deleted', 3)
  expect(await r.applyTaskLifecycle('task-a', 'active', 4)).toMatchObject({ state: 'deleted' })
  expect(r.storage.conversation('storage-a')).toMatchObject({ state: 'deleted' })
  expect(r.prompts('task-a')).toEqual([])
  expect(() =>
    r.captureHook({
      agentId: 'claude-code',
      mode: 'claude-code',
      taskId: 'task-a',
      hookEvent: 'UserPromptSubmit',
      raw: { prompt: 'late prompt' }
    })
  ).toThrow(/deleted/i)
})

test('deleted native sessions remain excluded after newer and stale bootstraps', async () => {
  const { r } = runtime()
  r.bootstrap({
    ...bootstrap,
    honoredConversations: ['native'],
    providerConfig: { chatConversationId: 'native' }
  })
  expect(await r.local.data.isHonoredConversation('task-a', 'claude-chat', 'native')).toBe(true)
  r.bootstrap({
    ...bootstrap,
    revision: 2,
    providerConfig: {},
    deletedConversations: [{ mode: 'claude-chat', conversationId: 'native' }]
  })
  expect(await r.local.data.isHonoredConversation('task-a', 'claude-chat', 'native')).toBe(false)
  r.bootstrap({
    ...bootstrap,
    honoredConversations: ['native'],
    providerConfig: { chatConversationId: 'native' }
  })
  expect(await r.local.data.isHonoredConversation('task-a', 'claude-chat', 'native')).toBe(false)
})

test('computer bootstrap preserves user default settings added on main', async () => {
  const { r } = runtime()
  r.bootstrap({
    ...bootstrap,
    settings: {
      'chat_default_mode:claude-chat': 'plan',
      'chat_default_model:claude-chat': 'sonnet'
    }
  })
  expect(await r.local.data.getDefaultChatMode('claude-chat')).toBe('plan')
  expect(await r.local.data.readSetting('chat_default_model:claude-chat')).toBe('sonnet')
})

test('side questions and live-setting guards use the injected transport', async () => {
  const { r } = runtime()
  r.bootstrap(bootstrap)
  const { createChatOps } = await import('@slayzone/terminal/runtime')
  const questions: unknown[] = [],
    cancelled: unknown[] = []
  const ops = createChatOps({
    dataOps: r.local.data,
    transport: {
      ...r.transport,
      askSideQuestion: async (...args) => {
        questions.push(args)
        return { text: 'local answer' }
      },
      cancelSideQuestion: (...args) => {
        cancelled.push(args)
      },
      isTurnOpen: () => true,
      getSessionTerminalState: () => 'running',
      sendControlRequest: async () => {
        throw new Error('control refused')
      }
    }
  })
  expect(
    await ops.askSideQuestion({ ...createOpts, requestId: 'q', question: 'why?', history: [] })
  ).toEqual({ text: 'local answer' })
  ops.cancelSideQuestion({ tabId: 'tab-a', requestId: 'q' })
  expect(questions).toEqual([['tab-a', { requestId: 'q', question: 'why?', history: [] }]])
  expect(cancelled).toEqual([['tab-a', 'q']])
  await expect(ops.setModel({ ...createOpts, chatModel: 'sonnet' })).rejects.toThrow(
    /during this turn/
  )
})
