import Database from 'better-sqlite3'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { createFixtureChatRuntime } from '../../computer/src/project-scope.fixture'
import { createComputerChatServices } from './computer-chat'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import { createChatThreadStore } from '../../../domains/terminal/src/server/chat-threads-store'
import { taskSessionStore } from './test-session-store'
import { createArtifactStore } from '@slayzone/task-artifacts/server'
import { createComputerArtifactStorage } from './computer-artifacts'
import type {
  ArchivedArtifactVersion,
  ArchivedChatConversation,
  ArchivedChatRecordPage,
  ChatAttachment,
  ChatComputerOps,
  ComputerChatArchive,
  ComputerChatBackup
} from '@slayzone/terminal-contracts'
import type { TaskArtifact } from '@slayzone/task-contracts'
import { createFakeCodex } from '@slayzone/test-utils/fake-codex'
import {
  fakeChild,
  emitLine,
  sj,
  until
} from '../../../domains/terminal/src/server/runtime/chat-transport-testkit'
import { createComputerChatRuntime } from '../../../domains/chat-runtime/src/server/computer-runtime'

// Third independent audit. All stores, homes and links are disposable. These
// tests call production services and parsers; provider starts are forbidden.
const dirs: string[] = []
const runtimes: ReturnType<typeof createComputerChatRuntime>[] = []
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const DAY = 86_400_000
const clock = Date.now()
const old = clock - 3 * DAY
const native = '33333333-4444-4555-8666-777777777777'
function directory() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'content-third-pass-'))
  dirs.push(dir)
  return dir
}
function bootstrap(id = 'root', tabId = id, taskId = 'task') {
  return {
    identity: { id, taskId, tabId, mode: 'claude-chat', epoch: 1 },
    projectId: null,
    cwd: realpathSync(tmpdir()),
    revision: 1,
    providerConfig: { chatConversationId: native },
    defaultFlags: null,
    env: {}
  }
}
function runtime(dir = directory()) {
  const r = createComputerChatRuntime({
    stateDir: dir,
    hubScope: 'audit',
    computerId: 'pc',
    transport: {
      whichBinary: async () => {
        throw new Error('Content audit forbids provider starts')
      }
    }
  })
  runtimes.push(r)
  r.bootstrap(bootstrap())
  return r
}
function putFile(r: ReturnType<typeof runtime>, tabId = 'root', id = 'file') {
  const bytes = Buffer.from('pinned third-pass attachment')
  const ref = r.attachments.put(
    tabId,
    {
      artifactId: id,
      name: id + '.txt',
      kind: 'text',
      mediaType: 'text/plain',
      size: bytes.length
    },
    bytes
  )
  return { bytes, ref }
}
function ageAttachments(r: ReturnType<typeof runtime>) {
  r.storage.compose((db) =>
    db.prepare("UPDATE records SET saved_at=? WHERE kind='attachment'").run(old)
  )
}
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function rpcFixture() {
  const dir = directory()
  const starts: string[] = []
  const open = () =>
    createFixtureChatRuntime({
      stateDir: dir,
      hubScope: 'audit',
      computerId: () => 'pc',
      getProjectPaths: () => null,
      admission: {
        enqueue: (lane) => {
          starts.push(lane)
          throw new Error('Content audit forbids provider starts')
        },
        cancel: () => true,
        prioritize: () => false,
        isQueued: () => false,
        stats: () => ({ queued: 0, active: 0, concurrency: 1 })
      },
      ctx: {
        config: {
          hubUrl: 'ws://audit/computers',
          name: 'audit',
          allowedRoots: [realpathSync(tmpdir())],
          capabilities: ['proc']
        },
        dialer: { notify: () => true },
        log: () => {}
      }
    })
  let pc = open()
  const request = async <T = unknown>(value: unknown): Promise<T> =>
    wire(await pc.request(wire(value))) as T
  await request({ kind: 'bootstrap', value: bootstrap() })
  const invoke = (
    method: string,
    args: unknown[],
    operationId: string = randomUUID(),
    id = 'root',
    epoch = 1
  ) =>
    request({
      kind: 'invoke',
      value: { route: { id, epoch }, target: 'ops', method, args, operationId }
    })
  return {
    dir,
    starts,
    request,
    invoke,
    dbPath: join(
      dir,
      'computer-runtime',
      createHash('sha256').update(JSON.stringify('audit')).digest('hex'),
      'chat.sqlite'
    ),
    restart: async () => {
      await pc.close()
      pc = open()
    },
    close: async () => {
      await pc.close()
    }
  }
}

test('new: retained messages keep full session summaries when their old session anchor expires', async () => {
  const r = runtime()
  // Codex reports turn-init at process handshake, so a long-lived conversation
  // can have many recent turns whose session anchor predates their retention window.
  r.bootstrap({
    ...bootstrap('codex'),
    identity: { ...bootstrap('codex').identity, mode: 'codex-chat' }
  })
  r.storage.append(
    'codex',
    1,
    { kind: 'turn-init', sessionId: native, model: 'test', cwd: '/tmp', tools: [] },
    old
  )
  r.storage.transaction(() => {
    for (let n = 0; n < 601; n++)
      r.local.data.persistChatEventSync!(
        'codex',
        n + 1,
        { kind: 'user-message', id: `recent-${n}`, text: `recent question ${n}` },
        clock + n
      )
  })
  expect(r.prompts('task')).toHaveLength(500)
  expect(r.promptSummaries('task', [native])[0].count).toBe(601)
  r.retention.configure(1)
  await r.retention.runNow(clock)
  expect(r.storage.read('codex', -1)).toHaveLength(601)
  expect(r.promptSummaries('task', [native])).toEqual([
    { conversationId: native, count: 601, firstPrompt: 'recent question 0', firstAt: clock }
  ])
})

test.each(['retention', 'source deletion'] as const)(
  'new: real native import pins its attachment in the destination before %s removes the source',
  async (cleanup) => {
    const dir = directory()
    const fake = createFakeCodex({ root: dir })
    fake.setScenario({
      threads: [native],
      processes: [
        {
          methods: {
            'thread/turns/list': {
              result: {
                data: [
                  {
                    id: 'native-turn',
                    items: [
                      {
                        type: 'userMessage',
                        id: 'native-message',
                        clientId: 'original',
                        content: [{ type: 'text', text: 'source' }]
                      }
                    ]
                  }
                ],
                nextCursor: null
              }
            }
          }
        }
      ]
    })
    const r = createComputerChatRuntime({
      stateDir: dir,
      hubScope: 'audit',
      computerId: 'pc',
      transport: {
        whichBinary: async () => join(fake.binDir, 'codex'),
        spawn: (cmd, args, opts) => spawn(cmd, args, opts)
      }
    })
    runtimes.push(r)
    const codexBootstrap = (id: string) => ({
      ...bootstrap(id),
      identity: { ...bootstrap(id).identity, mode: 'codex-chat' }
    })
    r.bootstrap(codexBootstrap('root'))
    r.bootstrap(codexBootstrap('sibling'))
    try {
      const { ref, bytes } = putFile(r)
      ageAttachments(r)
      r.storage.append(
        'root',
        1,
        {
          kind: 'user-message',
          id: 'original',
          text: 'source',
          content: [{ type: 'attachment', attachment: ref }]
        },
        old
      )
      // The real Codex driver imports this native turn and uses task-wide saved
      // attachment content. No test-created destination event or permissive mock.
      await r.invoke({
        route: { id: 'sibling', epoch: 1 },
        target: 'ops',
        method: 'switchConversation',
        operationId: 'import',
        args: [
          {
            taskId: 'task',
            tabId: 'sibling',
            mode: 'codex-chat',
            cwd: dir,
            conversationId: native,
            sourceMode: 'codex-chat'
          }
        ]
      })
      await until(
        () =>
          r.storage
            .read('sibling', -1)
            .some((row) => row.event.kind === 'user-message' && row.event.id === 'original'),
        5000
      )
      const imported = r.storage
        .read('sibling', -1)
        .find((row) => row.event.kind === 'user-message')!
      expect(imported.event).toMatchObject({
        history: true,
        content: [
          { type: 'attachment', attachment: ref },
          { type: 'text', text: 'source' }
        ]
      })
      expect(Buffer.from(await r.attachments.reader.read(ref))).toEqual(bytes)
      expect(fake.current().run(0)!.requests('turn/start')).toEqual([])
      await r.transport.removeSession('sibling')
      if (cleanup === 'retention') {
        r.retention.configure(1)
        await r.retention.runNow(clock)
      } else {
        await r.deleteConversation({ ...bootstrap('root').identity, mode: 'codex-chat', epoch: 2 })
      }
      expect(r.storage.read('root', -1)).toEqual([])
      expect(r.storage.read('sibling', -1).some((row) => row.event.kind === 'user-message')).toBe(
        true
      )
      expect(Buffer.from(await r.attachments.reader.read(ref))).toEqual(bytes)
    } finally {
      await r.close()
      fake.dispose()
    }
  }
)

test('control: retention keeps a pinned version in its own tab while pruning an unreferenced old version', async () => {
  const r = runtime()
  const kept = putFile(r, 'root', 'kept')
  const expired = putFile(r, 'root', 'expired')
  ageAttachments(r)
  r.storage.append(
    'root',
    1,
    {
      kind: 'user-message',
      id: 'current',
      text: 'kept',
      content: [{ type: 'attachment', attachment: kept.ref }]
    },
    clock
  )
  r.retention.configure(1)
  await r.retention.runNow(clock)
  expect(Buffer.from(await r.attachments.reader.read(kept.ref))).toEqual(kept.bytes)
  await expect(r.attachments.reader.read(expired.ref)).rejects.toThrow()
})

test('control: default-off retention preserves zero-clock migrated attachment pins and long queues across restart', async () => {
  const dir = directory()
  const r = runtime(dir)
  const { ref, bytes } = putFile(r)
  r.storage.compose((db) =>
    db.prepare("UPDATE records SET saved_at=0 WHERE kind='attachment'").run()
  )
  r.storage.transaction(() => {
    for (let n = 0; n < 1205; n++)
      r.storage.putRecord('root', 1, {
        kind: 'queue',
        id: `q-${n}`,
        value: {
          id: `q-${n}`,
          tabId: 'root',
          send: `queued ${n}`,
          original: `queued ${n}`,
          position: n,
          createdAt: new Date(old).toISOString()
        },
        at: 0
      })
  })
  expect(await r.retention.runNow(clock)).toBeNull()
  await r.close()
  const next = runtime(dir)
  expect(next.retention.days).toBe(0)
  expect(await next.local.queue.list('root')).toHaveLength(1205)
  expect(Buffer.from(await next.attachments.reader.read(ref))).toEqual(bytes)
})

test('control: long queue expiry crosses batches without dropping current entries or reopening sequence slots', async () => {
  const r = runtime()
  r.storage.transaction(() => {
    for (let n = 0; n < 1205; n++)
      r.storage.putRecord('root', 1, {
        kind: 'queue',
        id: `q-${n}`,
        value: {
          id: `q-${n}`,
          tabId: 'root',
          send: `queued ${n}`,
          original: `queued ${n}`,
          position: n
        },
        at: old
      })
    r.storage.putRecord('root', 1, {
      kind: 'queue',
      id: 'current',
      value: { id: 'current', tabId: 'root', send: 'recent', original: 'recent', position: 1205 },
      at: clock
    })
    for (let n = 0; n < 1101; n++)
      r.storage.append(
        'root',
        1,
        { kind: 'assistant-text', messageId: `m-${n}`, text: 'expired' },
        old
      )
  })
  r.retention.configure(1)
  const report = await r.retention.runNow(clock)
  expect(report).toMatchObject({ events: 1101, records: 1205 })
  expect(await r.local.queue.list('root')).toMatchObject([{ id: 'current', send: 'recent' }])
  expect(
    r.storage.append('root', 1, { kind: 'assistant-text', messageId: 'new', text: 'new' }).seq
  ).toBe(1101)
  expect(r.storage.appendAt('root', 1, 1, { kind: 'stderr', text: 'late' }, clock)).toBe('clash')
})

test('new: read-only archive exposes unsent queue text and its attachment after live task deletion', async () => {
  const f = await rpcFixture()
  try {
    const artifact = await f.request<TaskArtifact>({
      kind: 'artifact.invoke',
      value: {
        route: { id: 'root', epoch: 1 },
        method: 'uploadArtifactBlob',
        operationId: 'file',
        args: [
          {
            taskId: 'task',
            title: 'queue.txt',
            data: Buffer.from('queue-only file').toString('base64')
          }
        ]
      }
    })
    const ref: ChatAttachment = {
      artifactId: artifact.id,
      name: 'queue.txt',
      kind: 'text',
      mediaType: 'text/plain',
      size: 15
    }
    const sealed = await f.request<ChatAttachment>({
      kind: 'artifact.invoke',
      value: { route: { id: 'root', epoch: 1 }, method: 'seal', operationId: 'seal', args: [ref] }
    })
    await f.request({
      kind: 'invoke',
      value: {
        route: { id: 'root', epoch: 1 },
        target: 'queue',
        method: 'push',
        operationId: 'queue',
        args: [
          'root',
          'only unsent private text',
          '/raw only unsent private text',
          {
            id: 'unsent',
            content: [
              { type: 'text', text: 'only unsent private text' },
              { type: 'attachment', attachment: sealed }
            ]
          }
        ]
      }
    })
    const backup = await f.request<ComputerChatBackup>({
      kind: 'backup.create',
      id: randomUUID()
    })
    await f.request({ kind: 'task.lifecycle', taskId: 'task', state: 'deleted', revision: 1 })
    const archive = await f.request<ComputerChatArchive>({
      kind: 'backup.restore',
      backupId: backup.id,
      archiveId: randomUUID()
    })
    const rows: ArchivedChatRecordPage['records'] = []
    let afterCursor = 0
    for (;;) {
      const page = await f.request<ArchivedChatRecordPage>({
        kind: 'archive.records',
        archiveId: archive.id,
        conversationId: 'root',
        afterCursor
      })
      rows.push(...page.records)
      if (!page.hasMore) break
      expect(page.nextCursor).toBeGreaterThan(afterCursor)
      afterCursor = page.nextCursor
    }
    // Prove the snapshot contains it: this tests projection completeness, not
    // corrupt archives or unsupported DB schemas (prior F11).
    const r = new Database(join(f.dbPath, '..', 'backups', backup.id, 'chat.sqlite'), {
      readonly: true
    })
    try {
      expect(r.prepare("SELECT count(*) AS n FROM records WHERE kind='queue'").get()).toEqual({
        n: 1
      })
    } finally {
      r.close()
    }
    expect(f.starts).toEqual([])
    expect(rows.find((row) => row.kind === 'queue')).toMatchObject({
      id: 'unsent',
      value: {
        send: 'only unsent private text',
        content: [{ type: 'text' }, { type: 'attachment', attachment: sealed }]
      }
    })
  } finally {
    await f.close()
  }
})

test('control: public chat upload uses a task-file store that remains discoverable in archives after chat deletion', async () => {
  const f = await threadFixture()
  try {
    const store = createComputerArtifactStorage({
      db: f.slayDb,
      local: createArtifactStore(join(f.dir, 'hub-originals')),
      chat: f.hub,
      request: (_pc, req) => f.request(req)
    })
    const artifact = await store.uploadArtifactBlob(f.slayDb, {
      taskId: 'task',
      title: 'retained.txt',
      bytes: Buffer.from('separate task original'),
      chatTabId: 'parent'
    })
    const location = f.db
      .prepare('SELECT conversation_id FROM chat_artifact_locations WHERE artifact_id=?')
      .get(artifact!.id) as { conversation_id: string }
    const owner = (await f.hub.ownership.get(location.conversation_id))!
    expect(owner.tabId.startsWith('artifact-store:')).toBe(true)
    f.db.prepare("DELETE FROM terminal_tabs WHERE id='parent'").run()
    await f.hub.lifecycle.syncTask('task')
    const backup = await f.request<ComputerChatBackup>({
      kind: 'backup.create',
      id: randomUUID()
    })
    const archive = await f.request<ComputerChatArchive>({
      kind: 'backup.restore',
      backupId: backup.id,
      archiveId: randomUUID()
    })
    const listed = await f.request<ArchivedChatConversation[]>({
      kind: 'archive.conversations',
      archiveId: archive.id
    })
    const records = await f.request<ArchivedChatRecordPage>({
      kind: 'archive.records',
      archiveId: archive.id,
      conversationId: owner.id,
      afterCursor: 0
    })
    const version = records.records.find((row) => row.kind === 'artifact-version')!
      .value as ArchivedArtifactVersion
    const file = await f.request<Awaited<ReturnType<ChatComputerOps['archiveFile']>>>({
      kind: 'archive.file',
      archiveId: archive.id,
      conversationId: owner.id,
      artifactId: artifact!.id,
      contentHash: version.contentHash
    })
    expect(file.data).toBe(Buffer.from('separate task original').toString('base64'))
    expect(listed.map((row) => row.id)).toContain(owner.id)
  } finally {
    await f.close()
  }
})

test('control: archive paging returns every sparse event and mixed record exactly once, including an oversized first record', async () => {
  const r = runtime()
  const expectedSeqs: number[] = []
  const expectedIds: string[] = ['large-first']
  r.storage.putRecord('root', 1, {
    kind: 'workspace',
    id: 'large-first',
    value: { diff: 'x'.repeat(4 * 1024 * 1024 + 64) },
    at: clock
  })
  r.storage.transaction(() => {
    for (let n = 0; n < 421; n++) {
      const seq = n * 3
      expectedSeqs.push(seq)
      r.storage.appendAt(
        'root',
        1,
        seq,
        { kind: 'assistant-text', messageId: `m-${n}`, text: `event ${n}` },
        clock
      )
    }
    for (let n = 0; n < 237; n++) {
      expectedIds.push(`p-${n}`)
      r.storage.putRecord('root', 1, {
        kind: 'prompt',
        id: `p-${n}`,
        value: { text: `record ${n}` },
        at: clock
      })
    }
  })
  const route = { id: 'root', epoch: 1 }
  for (let n = 0; n < 13; n++)
    await r.artifacts.invoke({
      route,
      method: 'uploadArtifactBlob',
      operationId: `file-${n}`,
      args: [
        {
          taskId: 'task',
          title: `file-${n}.txt`,
          data: Buffer.from(`version ${n}`).toString('base64')
        }
      ]
    })
  const backup = await r.backups.create()
  const archive = await r.backups.restore(backup.id)
  const seqs: number[] = []
  let afterSeq = -1
  for (let pages = 0; ; pages++) {
    expect(pages).toBeLessThan(100)
    const page = r.backups.read(archive.id, 'root', afterSeq, 37)
    seqs.push(...page.events.map((row) => row.seq))
    if (!page.hasMore) break
    expect(page.nextSeq).toBeGreaterThan(afterSeq)
    afterSeq = page.nextSeq
  }
  const rows: ReturnType<typeof r.backups.records>['records'] = []
  let cursor = 0
  for (let pages = 0; ; pages++) {
    expect(pages).toBeLessThan(100)
    const page = r.backups.records(archive.id, 'root', cursor)
    expect(page.records.length).toBeGreaterThan(0)
    rows.push(...page.records)
    if (!page.hasMore) break
    expect(page.nextCursor).toBeGreaterThan(cursor)
    cursor = page.nextCursor
  }
  expect(seqs).toEqual(expectedSeqs)
  expect(
    rows
      .filter((row) => row.kind !== 'artifact-version' && row.kind !== 'artifact-original')
      .map((row) => row.id)
      .sort()
  ).toEqual(expectedIds.sort())
  expect(rows.filter((row) => row.kind === 'artifact-version')).toHaveLength(13)
  expect(rows.filter((row) => row.kind === 'artifact-original')).toHaveLength(13)
  expect(
    new Set(rows.filter((row) => row.kind === 'artifact-original').map((row) => row.id)).size
  ).toBe(13)
  expect(new Set(rows.map((row) => row.cursor)).size).toBe(rows.length)
  expect(rows.map((row) => row.cursor)).toEqual(rows.map((row) => row.cursor).sort((a, b) => a - b))
})

test('control: sealed historical attachment survives original-version prune, original deletion, GC and reopen', async () => {
  const dir = directory()
  const r = runtime(dir)
  const route = { id: 'root', epoch: 1 }
  const file = (await r.artifacts.invoke({
    route,
    method: 'uploadArtifactBlob',
    operationId: 'upload',
    args: [
      { taskId: 'task', title: 'versioned.txt', data: Buffer.from('pinned v1').toString('base64') }
    ]
  })) as { id: string }
  const ref = (await r.artifacts.invoke({
    route,
    method: 'seal',
    operationId: 'seal',
    args: [
      { artifactId: file.id, name: 'versioned.txt', kind: 'text', mediaType: 'text/plain', size: 9 }
    ]
  })) as ChatAttachment
  r.storage.append(
    'root',
    1,
    {
      kind: 'user-message',
      id: 'historic',
      text: 'preserve',
      content: [{ type: 'attachment', attachment: ref }]
    },
    clock
  )
  await r.artifacts.invoke({
    route,
    method: 'updateArtifact',
    operationId: 'edit',
    args: [{ id: file.id, content: 'unpinned v2' }]
  })
  const report = await r.artifacts.invoke({
    route,
    method: 'pruneArtifactVersions',
    operationId: 'prune',
    args: [{ artifactId: file.id, keepLast: 1, keepCurrent: true, keepNamed: false }]
  })
  expect(report).toMatchObject({ deletedVersions: 1 })
  await r.artifacts.invoke({
    route,
    method: 'deleteArtifact',
    operationId: 'delete',
    args: [file.id]
  })
  r.artifacts.collectGarbage()
  r.attachments.collectGarbage()
  await r.close()
  const next = runtime(dir)
  expect(Buffer.from(await next.attachments.reader.read(ref)).toString()).toBe('pinned v1')
  const backup = await next.backups.create()
  const archive = await next.backups.restore(backup.id)
  expect(next.backups.attachment(archive.id, 'root', ref).toString()).toBe('pinned v1')
})

test('control: reset clears events, queue and timeline, fences late old-child output, and preserves native session provenance', async () => {
  const dir = directory()
  const child = fakeChild({ exitOnKill: true })
  const r = createComputerChatRuntime({
    stateDir: dir,
    hubScope: 'audit',
    computerId: 'pc',
    transport: {
      whichBinary: async () => '/isolated/fake-claude',
      spawn: () => {
        setImmediate(() => child.emitter.emit('spawn'))
        return child.child
      }
    }
  })
  runtimes.push(r)
  r.bootstrap(bootstrap())
  const opts = { taskId: 'task', tabId: 'root', mode: 'claude-chat', cwd: dir }
  await r.ops.start(opts)
  emitLine(child, sj.init(native))
  await until(() => r.storage.read('root', -1).some((row) => row.event.kind === 'turn-init'))
  r.storage.append('root', 1, {
    kind: 'assistant-text',
    messageId: 'old',
    text: 'cleared old text'
  })
  await r.local.queue.push('root', 'cleared queued text', 'cleared queued text', {
    id: 'old-queue'
  })
  await r.local.data.saveTimeline('root', {
    checkpoint: null,
    dropPagesFrom: null,
    pages: [
      {
        page: 0,
        startRow: 0,
        endRow: 1,
        rows: 'old timeline',
        summary: '{}',
        searchText: 'cleared old text'
      }
    ]
  })
  const info = await r.invoke({
    route: { id: 'root', epoch: 1 },
    target: 'ops',
    method: 'reset',
    operationId: 'reset',
    args: [opts]
  })
  emitLine(child, sj.text('late old process text', { id: 'late' }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(info).toMatchObject({ pid: null })
  expect(r.transport.getSessionTerminalState('root')).toBe('not-spawned')
  expect(r.storage.read('root', -1)).toEqual([])
  expect(await r.local.queue.list('root')).toEqual([])
  expect(r.storage.records('root').filter((row) => row.kind === 'workspace')).toEqual([])
  expect(await r.local.data.searchTimelinePages('root', 'cleared')).toEqual([])
  expect(
    JSON.stringify(r.storage.records('root').filter((row) => row.kind === 'timeline'))
  ).not.toContain('old timeline')
  expect(await r.local.data.getCurrentConversationId('task', 'claude-chat')).toBeNull()
  // Reset is a new chat, not a native-provider transcript erasure operation.
  expect(await r.local.data.isHonoredConversation('task', 'claude-chat', native)).toBe(true)
})

test('control: permanent deletion fences an accepted but not-yet-executed draft write across restart', async () => {
  const f = await rpcFixture()
  try {
    const writing = f.invoke(
      'saveTabDraft',
      ['root', { text: 'accepted just before deletion', attachments: [] }],
      'late-save'
    )
    const deleting = f.request({
      kind: 'task.lifecycle',
      taskId: 'task',
      state: 'deleted',
      revision: 2
    })
    const result = await Promise.allSettled([writing, deleting])
    expect(result[0].status).toBe('rejected')
    expect(result[1]).toMatchObject({ status: 'fulfilled', value: { state: 'deleted' } })
    await f.restart()
    const db = new Database(f.dbPath, { readonly: true })
    try {
      for (const table of ['events', 'records', 'receipts'])
        expect(
          db.prepare(`SELECT count(*) AS n FROM ${table} WHERE conversation_id='root'`).get()
        ).toEqual({ n: 0 })
    } finally {
      db.close()
    }
    await expect(
      f.invoke('saveTabDraft', ['root', { text: 'stale retry', attachments: [] }], 'late-save')
    ).rejects.toThrow(/epoch|deleted/i)
    expect(f.starts).toEqual([])
  } finally {
    await f.close()
  }
})

test('control: fork and rewind preserve cached branch history and native provenance across computer restart', async () => {
  const dir = directory()
  const fakes: ReturnType<typeof fakeChild>[] = []
  const spawns: string[][] = []
  const r = createComputerChatRuntime({
    stateDir: dir,
    hubScope: 'audit',
    computerId: 'pc',
    transport: {
      whichBinary: async () => '/isolated/fake-claude',
      spawn: (_cmd, args) => {
        const child = fakeChild({ exitOnKill: true })
        fakes.push(child)
        spawns.push(args)
        setImmediate(() => child.emitter.emit('spawn'))
        return child.child
      }
    }
  })
  runtimes.push(r)
  r.bootstrap(bootstrap())
  const opts = { taskId: 'task', tabId: 'root', mode: 'claude-chat', cwd: dir }
  await r.ops.start(opts)
  const turn = async (
    child: ReturnType<typeof fakeChild>,
    id: string,
    sessionId: string,
    uuid: string
  ) => {
    await r.ops.send('root', { id, content: [{ type: 'text', text: id }] })
    await until(() => child.stdin.some((row) => row.type === 'user' && row.uuid === id))
    emitLine(child, sj.lifecycle(id, 'queued'))
    emitLine(child, sj.lifecycle(id, 'started'))
    emitLine(child, sj.init(sessionId))
    emitLine(child, sj.text('answer ' + id, { id: 'answer-' + id, uuid }))
    emitLine(child, sj.success())
    emitLine(child, sj.lifecycle(id, 'completed'))
    await until(() => r.transport.getSessionTerminalState('root') === 'idle')
  }
  await turn(fakes[0], 'm1', native, 'a1')
  await turn(fakes[0], 'm2', native, 'a2')
  const fork = (await r.invoke({
    route: { id: 'root', epoch: 1 },
    target: 'ops',
    method: 'fork',
    operationId: 'fork',
    args: [{ ...opts, messageId: 'm1' }]
  })) as { conversationId: string; fromConversationId: string }
  expect(fork.fromConversationId).toBe(native)
  expect(spawns[1]).toContain('--fork-session')
  expect(spawns[1][spawns[1].indexOf('--resume') + 1]).toBe(native)
  expect(spawns[1][spawns[1].indexOf('--resume-session-at') + 1]).toBe('a1')
  await turn(fakes[1], 'm3', fork.conversationId, 'a3')
  fakes[1].answer('rewind_conversation', () => ({ success: { rewound: true, prefillText: 'm3' } }))
  expect(
    await r.invoke({
      route: { id: 'root', epoch: 1 },
      target: 'ops',
      method: 'rewind',
      operationId: 'rewind',
      args: [{ ...opts, messageId: 'm3', scope: 'before', conversation: true, files: false }]
    })
  ).toMatchObject({ prefillText: 'm3' })
  await r.close()
  const next = runtime(dir)
  const events = next.storage.read('root', -1).map((row) => row.event)
  expect(events.filter((event) => event.kind === 'user-message').map((event) => event.id)).toEqual([
    'm1',
    'm2',
    'm3'
  ])
  expect(
    events.filter((event) => event.kind === 'conversation-branch').map((event) => event.reason)
  ).toEqual(['forked', 'rewound'])
  expect(await next.local.data.getCurrentConversationId('task', 'claude-chat')).toBe(
    fork.conversationId
  )
  expect(await next.local.data.isHonoredConversation('task', 'claude-chat', native)).toBe(true)
})

async function threadFixture() {
  const h = await createTestHarness()
  const dir = directory()
  h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','P','#000')").run()
  h.db
    .prepare(
      'INSERT INTO tasks(id,project_id,title,has_worktree,provider_config) VALUES(?,?,?,1,?)'
    )
    .run('task', 'p', 'Task', JSON.stringify({ 'claude-chat': { chatConversationId: native } }))
  h.db
    .prepare(
      "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('parent','task','claude-chat',0)"
    )
    .run()
  await createChatThreadStore(h.slayDb).create({
    id: 'child',
    parentTabId: 'parent',
    taskId: 'task',
    mode: 'claude-chat',
    parentConversationId: native,
    answerId: 'answer',
    sourceMessageId: 'message',
    sourceUuid: 'source',
    title: 'private child topic',
    conversationId: null,
    closedAt: null,
    createdAt: clock
  })
  h.db
    .prepare(
      "INSERT INTO chat_tab_state(tab_id,draft_text,updated_at) VALUES('parent','parent draft',?)"
    )
    .run(clock)
  h.db
    .prepare(
      "INSERT INTO chat_tab_state(tab_id,draft_text,updated_at) VALUES('child','private child draft',?)"
    )
    .run(clock)
  const open = () =>
    createFixtureChatRuntime({
      taskFolder: (taskId) => (taskId === 'task' ? dir : null),
      stateDir: dir,
      hubScope: 'audit',
      computerId: () => 'pc',
      getProjectPaths: () => null,
      ctx: {
        config: {
          hubUrl: 'ws://audit/computers',
          name: 'audit',
          allowedRoots: [realpathSync(tmpdir())],
          capabilities: ['proc']
        },
        dialer: { notify: () => true },
        log: () => {}
      }
    })
  let pc = open()
  const request = async <T = unknown>(req: unknown): Promise<T> =>
    wire(await pc.request(wire(req))) as T
  const hub = createComputerChatServices({
    db: h.slayDb,
    legacyData: {
      ...createDbChatDataOps(h.slayDb, taskSessionStore),
      buildMcpEnv: async () => ({})
    },
    attachments: {
      read: async () => {
        throw new Error('No fixture attachments')
      }
    },
    request: async (_pc, req) => wire(await pc.request(wire(req))),
    resolveComputer: async () => 'pc',
    defaultComputer: async () => 'pc',
    hasLiveTask: async () => false
  })
  await hub.relay.ops.getTabState('parent')
  await hub.relay.ops.getTabState('child')
  return {
    ...h,
    dir,
    hub,
    request,
    restart: async () => {
      await pc.close()
      pc = open()
    },
    close: async () => {
      await pc.close()
      h.cleanup()
    }
  }
}

test('new: acknowledged child-tab deletion removes its private title from the live parent thread list', async () => {
  const f = await threadFixture()
  try {
    const args = {
      taskId: 'task',
      tabId: 'parent',
      mode: 'claude-chat',
      cwd: realpathSync(tmpdir())
    }
    expect(await f.hub.relay.ops.listThreads(args)).toMatchObject([
      { id: 'child', title: 'private child topic' }
    ])
    f.db.prepare("DELETE FROM terminal_tabs WHERE id='child'").run()
    await f.hub.lifecycle.syncTask('task')
    expect(await f.hub.ownership.forTab('child')).toMatchObject({
      state: 'deleted',
      cleanupPending: false
    })
    await f.restart()
    expect(await f.hub.relay.ops.listThreads(args)).toEqual([])
  } finally {
    await f.close()
  }
})

test('control: parent-tab deletion cascades child ownership fences while unrelated task store survives', async () => {
  const f = await threadFixture()
  try {
    const parent = (await f.hub.ownership.forTab('parent'))!
    const child = (await f.hub.ownership.forTab('child'))!
    f.db.prepare("INSERT INTO tasks(id,project_id,title) VALUES('other','p','Other')").run()
    f.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('other-tab','other','claude-chat',0)"
      )
      .run()
    await f.hub.relay.ops.saveTabDraft('other-tab', { text: 'unrelated history', attachments: [] })
    f.db.prepare("DELETE FROM terminal_tabs WHERE id='parent'").run()
    await f.hub.lifecycle.syncTask('task')
    for (const owner of [parent, child]) {
      expect(await f.request({ kind: 'inspect', id: owner.id })).toMatchObject({ state: 'deleted' })
      await expect(
        f.request({
          kind: 'invoke',
          value: {
            route: { id: owner.id, epoch: owner.epoch },
            target: 'ops',
            method: 'saveTabDraft',
            operationId: randomUUID(),
            args: [owner.tabId, { text: 'late', attachments: [] }]
          }
        })
      ).rejects.toThrow(/epoch|deleted/i)
    }
    expect((await f.hub.relay.ops.getTabState('other-tab'))?.draft.text).toBe('unrelated history')
  } finally {
    await f.close()
  }
})

test('control: child drafts survive task Trash and undo; stale lifecycle revisions cannot reopen a purged task', async () => {
  const f = await threadFixture()
  try {
    f.db.prepare("UPDATE tasks SET deleted_at=datetime('now') WHERE id='task'").run()
    await f.hub.lifecycle.syncTask('task')
    expect((await f.hub.relay.ops.getTabState('child'))?.draft.text).toBe('private child draft')
    await expect(
      f.hub.relay.ops.saveTabDraft('child', { text: 'blocked', attachments: [] })
    ).rejects.toThrow(/paused/i)
    f.db.prepare("UPDATE tasks SET deleted_at=NULL WHERE id='task'").run()
    await f.hub.lifecycle.syncTask('task')
    await expect(
      f.hub.relay.ops.saveTabDraft('child', { text: 'after undo', attachments: [] })
    ).resolves.toMatchObject({ rev: 1 })
    f.db.prepare("DELETE FROM tasks WHERE id='task'").run()
    await f.hub.lifecycle.syncTask('task')
    expect(
      await f.request({ kind: 'task.lifecycle', taskId: 'task', state: 'active', revision: 1 })
    ).toMatchObject({ state: 'deleted' })
  } finally {
    await f.close()
  }
})
