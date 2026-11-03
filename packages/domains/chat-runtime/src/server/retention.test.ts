import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { createComputerChatRuntime } from './computer-runtime'

const dirs: string[] = [],
  runtimes: ReturnType<typeof createComputerChatRuntime>[] = []
const now = Date.now(),
  old = now - 3 * 86_400_000
const identity = { id: 'c', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 }
function setup(
  dir = mkdtempSync(join(tmpdir(), 'chat-retention-')),
  hasExternalTaskWork?: (taskId: string) => boolean
) {
  if (!dirs.includes(dir)) dirs.push(dir)
  const r = createComputerChatRuntime({
    stateDir: dir,
    hubScope: 'hub',
    computerId: 'pc',
    hasExternalTaskWork
  })
  runtimes.push(r)
  r.bootstrap({
    identity,
    projectId: null,
    cwd: '/tmp',
    revision: 1,
    providerConfig: { chatConversationId: 'native' },
    defaultFlags: null,
    env: {}
  })
  return { r, dir }
}
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('retention defaults off, validates policy and persists it across restart', async () => {
  const { r, dir } = setup()
  r.storage.append(
    'c',
    1,
    { kind: 'assistant-text', messageId: 'old', text: 'keep by default' },
    old
  )
  expect(await r.retention.runNow(now)).toBeNull()
  expect(r.storage.read('c', -1)).toHaveLength(1)
  for (const days of [-1, 1.5, Infinity, NaN])
    expect(() => r.retention.configure(days)).toThrow(/retention/i)
  r.retention.configure(2)
  await r.close()
  const next = setup(dir).r
  expect(next.retention.days).toBe(2)
  await next.retention.runNow(now)
  expect(next.storage.read('c', -1)).toEqual([])
  expect(await next.local.data.getNextSeqForTab('tab')).toBe(1)
  expect(
    next.storage.append(
      'c',
      1,
      { kind: 'assistant-text', messageId: 'new', text: 'after expiry' },
      now
    ).seq
  ).toBe(1)
  expect(
    next.storage.appendAt(
      'c',
      1,
      0,
      { kind: 'assistant-text', messageId: 'late', text: 'stale writer' },
      now
    )
  ).toBe('clash')
  await next.local.data.clearChatEventsForTab('tab')
  expect(await next.local.data.getNextSeqForTab('tab')).toBe(0)
})

test('expiry removes old content and cached pages, preserves new references, task files and retry identities', async () => {
  const { r } = setup()
  const put = (
    kind: Parameters<typeof r.storage.putRecord>[2]['kind'],
    id: string,
    value: unknown,
    at = old
  ) => r.storage.putRecord('c', 1, { kind, id, value, at })
  const file = (id: string, text: string) =>
    r.attachments.put(
      'tab',
      {
        artifactId: id,
        name: id + '.txt',
        kind: 'text',
        mediaType: 'text/plain',
        size: Buffer.byteLength(text)
      },
      Buffer.from(text)
    )
  const kept = file('kept', 'retained attachment'),
    expired = file('expired', 'expired attachment')
  r.storage.compose((db) => {
    db.prepare("UPDATE records SET saved_at=? WHERE kind='attachment'").run(old)
  })
  r.storage.append(
    'c',
    1,
    { kind: 'assistant-text', messageId: 'old', text: 'expired history' },
    old
  )
  r.storage.append(
    'c',
    1,
    {
      kind: 'user-message',
      id: 'new',
      text: 'new',
      content: [{ type: 'attachment', attachment: kept }]
    },
    now
  )
  put('draft', 'state', {
    draft: { text: 'expired draft', attachments: [expired], rev: 9 },
    scroll: { kind: 'bottom' }
  })
  put('prompt', 'p', { text: 'expired prompt' })
  put('workspace', 'w', { diff: 'expired diff' })
  put('queue', 'q', {
    id: 'q',
    tabId: 'tab',
    send: 'expired queue',
    original: 'expired queue',
    position: 0
  })
  put('timeline', 'checkpoint', { data: 'cached expired history' })
  put('thread', 'child', { id: 'child', parentTabId: 'tab', title: 'expired thread title' })
  put('settings', 'attachment-message:old', [expired])
  put('settings', 'diagnostic:old', { message: 'expired diagnostic' })
  const a = (await r.artifacts.invoke({
    route: { id: 'c', epoch: 1 },
    method: 'uploadArtifactBlob',
    args: [
      {
        taskId: 'task',
        title: 'task-file.txt',
        data: Buffer.from('task file survives').toString('base64')
      }
    ],
    operationId: 'file'
  })) as { id: string }
  r.storage.acceptCommand('c', 1, 'old-attempt', { text: 'expired input' })
  r.storage.completeCommand('c', 1, 'old-attempt', { send: 'expired receipt content' })
  r.storage.compose((db) => {
    db.prepare("UPDATE receipts SET saved_at=? WHERE id='old-attempt'").run(old)
  })
  r.retention.configure(1)
  await r.retention.runNow(now)
  expect(r.storage.read('c', -1)).toMatchObject([{ seq: 1, event: { id: 'new' } }])
  expect((await r.ops.getTabState('tab'))?.draft).toEqual({ text: '', attachments: [], rev: 10 })
  expect(await r.local.queue.list('tab')).toEqual([])
  expect(
    r.storage
      .findRecords('settings')
      .some(
        (m) =>
          m.id.startsWith('metadata:') &&
          (m.value as { kind?: string; value?: { removed?: boolean } }).kind === 'queue-item' &&
          (m.value as { value: { removed?: boolean } }).value.removed
      )
  ).toBe(true)
  expect(
    r.storage.records('c').filter((v) => ['prompt', 'workspace', 'timeline'].includes(v.kind))
  ).toEqual([])
  expect(r.storage.getRecord('c', 'thread', 'child')).toMatchObject({
    id: 'child',
    title: 'Thread'
  })
  expect(r.storage.getRecord('c', 'settings', 'provider')).toMatchObject({
    chatConversationId: 'native'
  })
  expect(Buffer.from(await r.attachments.reader.read(kept))).toEqual(
    Buffer.from('retained attachment')
  )
  await expect(r.attachments.reader.read(expired)).rejects.toThrow()
  expect(() => r.attachments.readBlob(expired.contentHash!)).toThrow()
  expect(
    await r.artifacts.invoke({
      route: { id: 'c', epoch: 1 },
      method: 'readArtifactContent',
      args: [a.id]
    })
  ).toBe('task file survives')
  expect(r.storage.receipt('c', 'old-attempt')).toMatchObject({
    state: 'delivered',
    result: null,
    resultExpired: true
  })
  expect(r.storage.acceptCommand('c', 1, 'old-attempt', { text: 'expired input' })).toBe(
    'duplicate'
  )
})

test('live agents, in-flight calls, prepared migrations and Trash defer expiry', async () => {
  let nativeActive = true
  const { r } = setup(undefined, () => nativeActive)
  r.storage.append(
    'c',
    1,
    { kind: 'assistant-text', messageId: 'old', text: 'active content' },
    old
  )
  r.retention.configure(1)
  await r.retention.runNow(now)
  expect(r.storage.read('c', -1)).toHaveLength(1)
  nativeActive = false
  const info = r.transport.getSessionInfo
  r.transport.getSessionInfo = () => ({ pid: 42, ended: false }) as ReturnType<typeof info>
  await r.retention.runNow(now)
  expect(r.storage.read('c', -1)).toHaveLength(1)
  r.transport.getSessionInfo = info
  await r.retention.access('c', async () => {
    await r.retention.runNow(now)
  })
  expect(r.storage.read('c', -1)).toHaveLength(1)
  await r.applyTaskLifecycle('task', 'paused', 1)
  await r.retention.runNow(now)
  expect(r.storage.read('c', -1)).toHaveLength(1)
  await r.applyTaskLifecycle('task', 'active', 2)
  r.storage.freeze('c', 1, 'moving')
  await r.retention.runNow(now)
  expect(r.storage.read('c', -1)).toHaveLength(1)
  r.storage.unfreeze('c', 1, 'moving')
  await r.retention.runNow(now)
  expect(r.storage.read('c', -1)).toEqual([])
})

test('foreground draft waits for a sweep to finish flushing old projections', async () => {
  const { r } = setup()
  r.storage.append('c', 1, { kind: 'assistant-text', messageId: 'old', text: 'old' }, old)
  r.retention.configure(1)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>((resolve) => {
      release = resolve
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve
    })
  const original = r.transport.removeSession
  r.transport.removeSession = async () => {
    entered()
    await gate
  }
  const sweep = r.retention.runNow(now)
  await started
  let saved = false
  const save = r
    .invoke({
      route: { id: 'c', epoch: 1 },
      target: 'ops',
      method: 'saveTabDraft',
      args: ['tab', { text: 'new draft', attachments: [] }],
      operationId: 'save-after-prune'
    })
    .then(() => {
      saved = true
    })
  await Promise.resolve()
  expect(saved).toBe(false)
  release()
  await Promise.all([sweep, save])
  r.transport.removeSession = original
  expect((await r.ops.getTabState('tab'))?.draft.text).toBe('new draft')
})

test('expiry rebuilds a hydrated reader without leaving the open chat unusable', async () => {
  const { r } = setup()
  r.storage.append(
    'c',
    1,
    { kind: 'notice', id: 'old', level: 'info', text: 'expired cached reply' },
    old
  )
  await r.ops.hydrate({ taskId: 'task', tabId: 'tab', mode: 'claude-chat', cwd: '/tmp' })
  r.retention.configure(1)
  await r.retention.runNow(now)
  expect(r.transport.getSessionInfo('tab')).not.toBeNull()
  expect((await r.transport.getReplay('tab', -1)).live.afterSeq).toBe(0)
  expect(JSON.stringify(await r.transport.readEventsSince('tab', -1))).not.toContain(
    'expired cached reply'
  )
})

test('expired queue receipts reject delayed retries without recreating a message', async () => {
  const { r } = setup()
  const req = {
    route: { id: 'c', epoch: 1 },
    target: 'queue',
    method: 'push',
    args: ['tab', 'old text', 'old text', { id: 'queued' }],
    operationId: 'old-queue-attempt'
  }
  await r.invoke(req)
  r.storage.compose((db) => {
    db.prepare('UPDATE receipts SET saved_at=?').run(old)
    db.prepare("UPDATE records SET saved_at=? WHERE kind='queue'").run(old)
  })
  r.retention.configure(1)
  await r.retention.runNow(now)
  await expect(r.invoke(req)).rejects.toThrow(/expired.*not repeated/)
  expect(await r.local.queue.list('tab')).toEqual([])
  await r.invoke({ ...req, operationId: 'explicit-new-attempt' })
  expect(await r.local.queue.list('tab')).toEqual([])
  await r.invoke({
    ...req,
    operationId: 'new-message',
    args: ['tab', 'old text', 'old text', { id: 'new-message' }]
  })
  expect(await r.local.queue.list('tab')).toMatchObject([{ id: 'new-message', send: 'old text' }])
})

test('a large sweep yields to foreground work and disabling stops further batches', async () => {
  const { r } = setup()
  r.storage.compose((db) =>
    db.transaction(() => {
      const insert = db.prepare('INSERT INTO events VALUES(?,?,?,?)')
      for (let seq = 0; seq < 1800; seq++)
        insert.run(
          'c',
          seq,
          old,
          JSON.stringify({ kind: 'assistant-text', messageId: 'm' + seq, text: 'old' })
        )
    })()
  )
  r.retention.configure(1)
  setImmediate(() => r.retention.configure(0))
  await r.retention.runNow(now)
  const n = r.storage.read('c', -1).length
  expect(n).toBeGreaterThan(0)
  expect(n).toBeLessThan(1800)
  r.retention.configure(1)
  await r.retention.runNow(now)
  expect(r.storage.read('c', -1)).toEqual([])
  expect(await r.local.data.getNextSeqForTab('tab')).toBe(1800)
})

test('manual backups retain readable expired history without restoring live provider state', async () => {
  const { r } = setup()
  r.storage.append(
    'c',
    1,
    { kind: 'assistant-text', messageId: 'old', text: 'backup-only marker' },
    old
  )
  const backup = await r.backups.create()
  r.retention.configure(1)
  await r.retention.runNow(now)
  expect(r.storage.read('c', -1)).toEqual([])
  const archive = await r.backups.restore(backup.id)
  expect(r.backups.read(archive.id, 'c').events).toMatchObject([
    { event: { text: 'backup-only marker' } }
  ])
  expect(archive.providerResumable).toBe(false)
  expect(r.retention.days).toBe(1)
})

test('v2 storage upgrades preserve history and command identities', async () => {
  const { default: Database } = await import('better-sqlite3')
  const { r, dir } = setup()
  r.storage.append(
    'c',
    1,
    { kind: 'assistant-text', messageId: 'old', text: 'survives schema upgrade' },
    old
  )
  r.storage.acceptCommand('c', 1, 'legacy-op', { text: 'input' })
  r.storage.completeCommand('c', 1, 'legacy-op', { value: 'old result' })
  r.storage.migrationCheckpoint(identity, 'activated-move', [
    { kind: 'settings', id: 'cli-details', value: 'duplicate old cache', at: old }
  ])
  r.storage.compose((db) => {
    db.prepare(
      "UPDATE conversations SET migration_id='activated-move',migration_hash=? WHERE id='c'"
    ).run('a'.repeat(64))
  })
  const path = r.storage.path
  await r.close()
  const raw = new Database(path)
  raw.exec(
    'ALTER TABLE receipts DROP COLUMN saved_at; ALTER TABLE receipts DROP COLUMN result_expired; PRAGMA user_version=2'
  )
  raw.close()
  const next = setup(dir).r
  expect(next.storage.read('c', -1)[0].event).toMatchObject({ text: 'survives schema upgrade' })
  expect(next.storage.acceptCommand('c', 1, 'legacy-op', { text: 'input' })).toBe('duplicate')
  expect(next.storage.migrationCheckpoint(identity, 'activated-move')).toBeNull()
  expect(next.storage.receipt('c', 'legacy-op')).toMatchObject({
    result: { value: 'old result' },
    resultExpired: false
  })
  next.retention.configure(1)
  await next.retention.runNow(now)
  // Old receipts had no timestamp. Preserve recent uncertain outcomes for a full window after upgrade.
  expect(next.storage.receipt('c', 'legacy-op')?.resultExpired).toBe(false)
})

test('enabled policy schedules expiry, while disabling cancels subsequent sweeps', async () => {
  vi.useFakeTimers()
  try {
    const { r } = setup()
    r.storage.append(
      'c',
      1,
      { kind: 'assistant-text', messageId: 'old', text: 'scheduled expiry' },
      old
    )
    r.retention.configure(1)
    await vi.advanceTimersByTimeAsync(5001)
    expect(r.storage.read('c', -1)).toEqual([])
    r.retention.configure(0)
    r.storage.append('c', 1, { kind: 'assistant-text', messageId: 'kept', text: 'off now' }, old)
    await vi.advanceTimersByTimeAsync(2 * 86_400_000)
    expect(r.storage.read('c', -1)).toHaveLength(1)
    await r.close()
  } finally {
    vi.useRealTimers()
  }
})

test('task deletion during quiescence wins over retention and cannot rehydrate the tab', async () => {
  const { r } = setup()
  r.storage.append(
    'c',
    1,
    { kind: 'assistant-text', messageId: 'old', text: 'deleted during sweep' },
    old
  )
  r.retention.configure(1)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>((resolve) => {
      release = resolve
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve
    })
  r.transport.removeSession = async () => {
    entered()
    await gate
  }
  const sweep = r.retention.runNow(now)
  await started
  const deletion = r.applyTaskLifecycle('task', 'deleted', 1)
  release()
  await Promise.all([sweep, deletion])
  expect(r.storage.conversation('c')?.state).toBe('deleted')
  expect(r.storage.read('c', -1)).toEqual([])
  expect(r.transport.getSessionInfo('tab')).toBeNull()
})

test('an invalid persisted period cannot turn a sweep into deleting all history', async () => {
  const { r, dir } = setup()
  r.storage.append(
    'c',
    1,
    { kind: 'assistant-text', messageId: 'old', text: 'invalid policy keeps history' },
    old
  )
  r.retention.configure(1)
  r.storage.compose((db) => {
    db.prepare('UPDATE retention_policy SET days=-1').run()
  })
  await r.close()
  const next = setup(dir).r
  expect(next.retention.days).toBe(0)
  expect(await next.retention.runNow(now)).toBeNull()
  expect(next.storage.read('c', -1)).toHaveLength(1)
})

test('a failed expiry transaction preserves history and releases foreground calls', async () => {
  const { r } = setup()
  r.storage.append(
    'c',
    1,
    { kind: 'notice', id: 'old', level: 'info', text: 'keep until committed' },
    old
  )
  r.storage.putRecord('c', 1, {
    kind: 'timeline',
    id: 'checkpoint',
    value: { data: 'old cached page' },
    at: old
  })
  r.retention.configure(1)
  const put = r.storage.putRecord
  r.storage.putRecord = (...args) => {
    if (args[2].id === 'event-sequence-floor') throw new Error('disk full')
    return put(...args)
  }
  await expect(r.retention.runNow(now)).rejects.toThrow('disk full')
  expect(r.storage.read('c', -1)).toHaveLength(1)
  expect(r.storage.getRecord('c', 'timeline', 'checkpoint')).not.toBeNull()
  r.storage.putRecord = put
  await r.invoke({
    route: { id: 'c', epoch: 1 },
    target: 'ops',
    method: 'saveTabDraft',
    args: ['tab', { text: 'after failure', attachments: [] }],
    operationId: 'after-disk-failure'
  })
  await r.retention.runNow(now)
  expect(r.storage.read('c', -1)).toEqual([])
})

test('shutdown still closes storage when a running sweep fails', async () => {
  const { r } = setup()
  r.retention.configure(1)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>((resolve) => {
      release = resolve
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve
    })
  r.transport.removeSession = async () => {
    entered()
    await gate
    throw new Error('quiescence failed')
  }
  const sweep = r.retention.runNow(now)
  await started
  const close = r.close()
  release()
  await expect(sweep).rejects.toThrow('quiescence failed')
  await expect(close).resolves.toBeUndefined()
  expect(() => r.storage.read('c', -1)).toThrow(/not open|closed/i)
})
