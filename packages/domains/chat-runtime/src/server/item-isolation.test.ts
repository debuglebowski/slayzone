/**
 * P3 — one bad item never stops everything (computer side). Each test plants ONE
 * bad item next to good ones and proves the good ones are still processed, the
 * bad one is recorded in the computer's `item_faults` ledger, and the caller's
 * own operation does not fail for someone else's item.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { listQuarantine } from '@slayzone/platform/quarantine'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { createComputerChatRuntime } from './computer-runtime'

const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function runtime() {
  const dir = mkdtempSync(join(tmpdir(), 'chat-isolation-'))
  dirs.push(dir)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  return { dir, r: createComputerChatRuntime({ stateDir: dir, hubScope: 'hub', computerId: 'pc' }) }
}

function bootstrap(r: ReturnType<typeof runtime>['r'], taskId: string, id = `c-${taskId}`) {
  r.bootstrap({
    identity: { id, taskId, tabId: `tab-${taskId}`, mode: 'claude-chat', epoch: 1 },
    projectId: null,
    cwd: '/tmp',
    revision: 1,
    providerConfig: {},
    defaultFlags: null,
    env: {}
  })
  return { id, epoch: 1 }
}

test('deleted-task file cleanup: an unsafe task id is completed, never blocks other tasks', async () => {
  const { r } = runtime()
  try {
    const route = bootstrap(r, 'good')
    const a = (await r.artifacts.invoke({
      route,
      method: 'uploadArtifactBlob',
      args: [{ taskId: 'good', title: 'f.txt', data: Buffer.from('x').toString('base64') }],
      operationId: 'u'
    })) as { id: string }
    expect(a.id).toBeTruthy()
    // A pending cleanup whose task id can never name a folder (left by an old build).
    r.storage.compose((raw) => {
      raw.prepare("INSERT INTO task_lifecycle VALUES('..','deleted',1)").run()
      raw.prepare("INSERT INTO task_cleanup_pending VALUES('..')").run()
    })
    // The user's deletion of 'good' must succeed despite the bad row.
    await expect(r.applyTaskLifecycle('good', 'deleted', 1)).resolves.toMatchObject({
      state: 'deleted'
    })
    expect(r.storage.pendingTaskCleanup()).toEqual([])
  } finally {
    await r.close()
  }
})

test('deleted-task file cleanup: a damaged task fails alone and is recorded', async () => {
  const { r } = runtime()
  try {
    bootstrap(r, 'good')
    bootstrap(r, 'bad')
    await r.applyTaskLifecycle('bad', 'deleted', 1)
    r.storage.compose((raw) =>
      raw.prepare("INSERT OR IGNORE INTO task_cleanup_pending VALUES('bad')").run()
    )
    const original = r.storage.completeTaskCleanup
    r.storage.completeTaskCleanup = (taskId: string) => {
      if (taskId === 'bad') throw new Error('EBUSY: resource busy')
      return original(taskId)
    }
    await expect(r.applyTaskLifecycle('good', 'deleted', 1)).resolves.toMatchObject({
      state: 'deleted'
    })
    expect(r.storage.pendingTaskCleanup()).toEqual(['bad'])
    expect(r.storage.listFaults()).toMatchObject([
      { pass: 'computer.task-file-cleanup', item_key: 'bad', task_id: 'bad', kind: 'transient' }
    ])
    // The bad task's OWN deletion still reports its failure.
    await expect(r.applyTaskLifecycle('bad', 'deleted', 2)).rejects.toThrow('EBUSY')
    r.storage.completeTaskCleanup = original
    await r.applyTaskLifecycle('bad', 'deleted', 3)
    expect(r.storage.listFaults()).toEqual([])
  } finally {
    await r.close()
  }
})

async function seedTwoTasksAndArchives(r: ReturnType<typeof runtime>['r'], stateDir: string) {
  for (const taskId of ['alice', 'bob']) {
    r.bootstrap({
      identity: { id: taskId, taskId, tabId: taskId, mode: 'claude-chat', epoch: 1 },
      projectId: null,
      cwd: stateDir,
      revision: 1,
      providerConfig: {},
      defaultFlags: null,
      env: {}
    })
    r.storage.append(
      taskId,
      1,
      { kind: 'assistant-text', messageId: taskId, text: `${taskId} secret` },
      Date.now()
    )
  }
  const backup = await r.backups.create('manual')
  const good = await r.backups.restore(backup.id)
  const broken = await r.backups.restore(backup.id)
  return { good, broken }
}

test('erasure: an unreadable archive that never held the task does not block it', async () => {
  const { dir, r } = runtime()
  try {
    const { good, broken } = await seedTwoTasksAndArchives(r, dir)
    // Damage: the archive's manifest is unreadable and its database holds no 'carol'.
    writeFileSync(join(r.backups.archiveDir, broken.id, 'manifest.json'), '{"torn')
    r.bootstrap({
      identity: { id: 'carol', taskId: 'carol', tabId: 'carol', mode: 'claude-chat', epoch: 1 },
      projectId: null,
      cwd: dir,
      revision: 1,
      providerConfig: {},
      defaultFlags: null,
      env: {}
    })
    await r.applyTaskLifecycle('carol', 'deleted', 2)
    await expect(r.eraseTask('carol', 2)).resolves.toMatchObject({ erased: true })
    // The unreadable archive is set aside and listed for the user; the readable one stays.
    expect(listQuarantine(r.storage.dir)).toMatchObject([{ pass: 'chat-archive' }])
    expect(r.backups.listArchives().map((a) => a.id)).toEqual([good.id])
  } finally {
    await r.close()
  }
})

test('erasure: an unreadable archive holding the task is deleted with it; readable ones are erased', async () => {
  const { dir, r } = runtime()
  try {
    const { good, broken } = await seedTwoTasksAndArchives(r, dir)
    writeFileSync(join(r.backups.archiveDir, broken.id, 'manifest.json'), '{"torn')
    await r.applyTaskLifecycle('alice', 'deleted', 2)
    await expect(r.eraseTask('alice', 2)).resolves.toMatchObject({ erased: true })
    expect(r.backups.conversations(good.id).map((c) => c.taskId)).toEqual(['bob'])
    expect(existsSync(join(r.backups.archiveDir, broken.id))).toBe(false)
    expect(listQuarantine(r.storage.dir)).toEqual([])
  } finally {
    await r.close()
  }
})

test('retention: one conversation whose history cannot be read does not stop the sweep', async () => {
  const { r } = runtime()
  try {
    const old = Date.now() - 3 * 86_400_000
    for (const taskId of ['a-bad', 'b-good']) {
      bootstrap(r, taskId)
      r.storage.append(
        `c-${taskId}`,
        1,
        { kind: 'assistant-text', messageId: 'm', text: 'old' },
        old
      )
    }
    // A damaged event row: its JSON cannot be parsed.
    r.storage.compose((raw) =>
      raw.prepare("UPDATE events SET event='{broken' WHERE conversation_id='c-a-bad'").run()
    )
    r.retention.configure(1)
    await r.retention.runNow()
    expect(r.storage.read('c-b-good', -1)).toEqual([])
    expect(r.storage.listFaults()).toMatchObject([
      { pass: 'computer.chat-retention', item_key: 'c-a-bad', task_id: 'a-bad' }
    ])
  } finally {
    await r.close()
  }
})

test('hub session refresh: a malformed row is left out alone; the other sessions are listed', async () => {
  const { createTestHarness } = await import('../../../../shared/test-utils/ipc-harness')
  const { createChatOwnershipStore } = await import('./hub-ownership')
  const { createHubChatRelay } = await import('./hub-relay')
  const h = await createTestHarness()
  try {
    h.db.exec(`INSERT INTO projects(id,name,color) VALUES('p','P','#000');
      INSERT INTO tasks(id,project_id,title) VALUES('task','p','T');
      INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)`)
    const ownership = createChatOwnershipStore(h.slayDb)
    await ownership.register({
      id: 'c',
      taskId: 'task',
      tabId: 'tab',
      mode: 'claude-chat',
      computerId: 'pc',
      epoch: 1
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const relay = createHubChatRelay({
      db: h.slayDb,
      ownership,
      request: async (_pc, value) => {
        if ((value as { kind: string }).kind === 'sessions')
          return [
            { sessionId: 42, taskId: null, state: 'idle' },
            { sessionId: 'task:tab', taskId: 'task', state: 'running' }
          ]
        return []
      },
      resolveComputer: async () => 'pc',
      defaultComputer: async () => 'pc',
      bootstrap: async () => {
        throw new Error('unused')
      },
      migrate: async () => {
        throw new Error('unused')
      },
      onSessionsChanged: () => {},
      onState: async () => {}
    })
    await relay.refreshSessions('pc')
    expect(relay.sessions.list()).toMatchObject([{ sessionId: 'task:tab', state: 'running' }])
    expect(
      h.db.prepare("SELECT pass, computer_id FROM item_faults WHERE origin='hub'").all()
    ).toEqual([{ pass: 'hub-session-refresh', computer_id: 'pc' }])
  } finally {
    h.cleanup()
  }
})
