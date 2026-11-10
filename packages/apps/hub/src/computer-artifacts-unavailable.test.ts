/**
 * Decision 4 (2026-11-09): a computer restored from an older backup no longer
 * holds files the hub knows. The hub keeps them, marked "unavailable on
 * computer": listed (never silently gone), readable as a row, deletable, and
 * never a target for new content.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, test } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import { taskSessionStore } from './test-session-store'
import { createArtifactStore } from '@slayzone/task-artifacts/server'
import { createFixtureChatRuntime } from '../../computer/src/project-scope.fixture'
import { createComputerChatServices } from './computer-chat'
import { createComputerArtifactStorage } from './computer-artifacts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function setup() {
  const h = await createTestHarness(),
    dir = mkdtempSync(join(realpathSync(tmpdir()), 'chat-unavailable-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  cleanups.push(() => h.cleanup())
  const pc = createFixtureChatRuntime({
    taskFolder: () => dir,
    stateDir: join(dir, 'pc'),
    hubScope: 'hub',
    computerId: () => 'pc',
    getProjectPaths: () => null,
    ctx: {
      config: {
        hubUrl: 'ws://hub/computers',
        name: 'pc',
        allowedRoots: [realpathSync(tmpdir())],
        capabilities: ['proc']
      },
      dialer: { notify: () => true },
      log: () => {}
    }
  })
  cleanups.push(() => pc.close())
  h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','P','#000')").run()
  h.db.prepare("INSERT INTO tasks(id,project_id,title,has_worktree) VALUES('t','p','Task',1)").run()
  h.db
    .prepare(
      "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','t','claude-chat',0)"
    )
    .run()
  const request = (_pc: string, p: unknown) => pc.request(p)
  const chat = createComputerChatServices({
    db: h.slayDb,
    legacyData: {
      ...createDbChatDataOps(h.slayDb, taskSessionStore),
      buildMcpEnv: async () => ({})
    },
    attachments: { read: async () => new Uint8Array() },
    request,
    resolveComputer: async () => 'pc',
    defaultComputer: async () => 'pc',
    hasLiveTask: async () => false
  })
  const store = createComputerArtifactStorage({
    db: h.slayDb,
    local: createArtifactStore(join(dir, 'hub')),
    chat,
    request
  })
  /** What the hub does when the computer's re-read no longer lists the entry. */
  const markUnavailable = (
    table: 'chat_artifact_locations' | 'chat_folder_locations',
    id: string
  ) =>
    h.db
      .prepare(
        `UPDATE ${table} SET unavailable_reason='missing-on-computer',unavailable_since=1 WHERE ${table === 'chat_artifact_locations' ? 'artifact_id' : 'folder_id'}=?`
      )
      .run(id)
  return { h, pc, store, markUnavailable }
}

test('a file missing on its computer is listed as unavailable, readable as a row, and deletable', async () => {
  const { h, pc, store, markUnavailable } = await setup()
  const kept = (await store.uploadArtifactBlob(h.slayDb, {
    taskId: 't',
    title: 'kept.txt',
    bytes: Buffer.from('kept'),
    chatTabId: 'tab'
  }))!
  const lost = (await store.uploadArtifactBlob(h.slayDb, {
    taskId: 't',
    title: 'lost.txt',
    bytes: Buffer.from('lost'),
    chatTabId: 'tab'
  }))!
  // The restored computer no longer has it.
  await pc.request({ kind: 'artifact.invoke', value: await deleteOnComputer(h, lost.id) })
  markUnavailable('chat_artifact_locations', lost.id)

  const listed = await store.listArtifactsByTask(h.slayDb, 't')
  expect(listed.map((a) => [a.id, a.title, a.storage])).toEqual(
    expect.arrayContaining([
      [kept.id, 'kept.txt', { computerId: 'pc', available: true }],
      [lost.id, 'Chat attachment · unavailable on computer', { computerId: 'pc', available: false }]
    ])
  )
  expect(await store.getArtifact(h.slayDb, lost.id)).toMatchObject({
    id: lost.id,
    storage: { computerId: 'pc', available: false }
  })
  await expect(store.readArtifactBytes(h.slayDb, lost.id)).rejects.toThrow(
    /unavailable on its computer/
  )
  await store.deleteArtifact(h.slayDb, lost.id)
  expect(h.db.prepare('SELECT 1 FROM task_artifacts WHERE id=?').get(lost.id)).toBeUndefined()
  expect((await store.listArtifactsByTask(h.slayDb, 't')).map((a) => a.id)).toEqual([kept.id])
})

test('a folder missing on its computer is listed as unavailable, takes no new files, and is deletable', async () => {
  const { h, store, markUnavailable } = await setup()
  const file = (await store.uploadArtifactBlob(h.slayDb, {
    taskId: 't',
    title: 'in-uploads.txt',
    bytes: Buffer.from('x'),
    chatTabId: 'tab'
  }))!
  const folderId = file.folder_id!
  expect(folderId).toBeTruthy()
  markUnavailable('chat_folder_locations', folderId)
  const folders = await store.listFoldersByTask(h.slayDb, 't')
  expect(folders.find((f) => f.id === folderId)).toMatchObject({
    name: 'Chat files · unavailable on computer',
    storage: { computerId: 'pc', available: false }
  })
  await expect(
    store.uploadArtifactBlob(h.slayDb, {
      taskId: 't',
      title: 'more.txt',
      bytes: Buffer.from('y'),
      folderId
    })
  ).rejects.toThrow(/unavailable on its computer/)
  expect(await store.deleteFolder(h.slayDb, folderId)).toBe(true)
})

/** The artifact.invoke payload deleting a file on the computer only. */
async function deleteOnComputer(h: Awaited<ReturnType<typeof createTestHarness>>, id: string) {
  const owner = h.db
    .prepare(
      'SELECT o.id,o.epoch FROM chat_artifact_locations l JOIN chat_ownership o ON o.id=l.conversation_id WHERE l.artifact_id=?'
    )
    .get(id) as { id: string; epoch: number }
  return {
    route: { id: owner.id, epoch: owner.epoch },
    method: 'deleteArtifact',
    args: [id],
    operationId: `computer-only-delete-${id}`
  }
}
