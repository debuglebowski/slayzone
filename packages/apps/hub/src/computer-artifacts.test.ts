import { mkdtempSync, realpathSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import { taskSessionStore } from '@slayzone/task/server'
import { createArtifactStore } from '@slayzone/task-artifacts/server'
import { createChatRuntimeHandlers } from '../../computer/src/handlers/chat-runtime'
import { createComputerChatServices } from './computer-chat'
import { createComputerArtifactStorage } from './computer-artifacts'

test('new chat files and versions stay on owner; general artifacts stay on hub', async () => {
  const h = await createTestHarness(),
    dir = mkdtempSync(join(realpathSync(tmpdir()), 'chat-files-')),
    hubDir = join(dir, 'hub')
  const pc = createChatRuntimeHandlers({
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
  try {
    h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','P','#000')").run()
    h.db
      .prepare("INSERT INTO tasks(id,project_id,title,worktree_path) VALUES('t','p','Task',?)")
      .run(dir)
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
      local: createArtifactStore(hubDir),
      chat,
      request
    })
    const a = await store.uploadArtifactBlob(h.slayDb, {
      taskId: 't',
      title: 'PRIVATE-file.txt',
      bytes: Buffer.from('PRIVATE bytes'),
      chatTabId: 'tab',
      operationId: 'upload'
    })
    expect(a!.title).toBe('PRIVATE-file.txt')
    expect(h.db.prepare('SELECT title FROM task_artifacts WHERE id=?').get(a!.id)).toEqual({
      title: 'Chat attachment'
    })
    expect(existsSync(join(hubDir, 'blobs'))).toBe(false)
    expect(Buffer.from(await store.readArtifactBytes(h.slayDb, a!.id)).toString()).toBe(
      'PRIVATE bytes'
    )
    await store.updateArtifact(h.slayDb, { id: a!.id, content: 'PRIVATE edited' })
    expect(await store.readArtifactContent(h.slayDb, a!.id)).toBe('PRIVATE edited')
    await chat.relay.ops.saveTabDraft('tab', {
      text: '',
      attachments: [
        { artifactId: a!.id, name: a!.title, kind: 'text', mediaType: 'text/plain', size: 13 }
      ]
    })
    expect((await chat.relay.ops.getTabState('tab'))?.draft.attachments[0].contentHash).toMatch(
      /^[a-f0-9]{64}$/
    )
    const folder = await store.createFolder(h.slayDb, { taskId: 't', name: 'General folder' })
    const copies = await store.copyArtifacts(h.slayDb, {
      artifactIds: [a!.id],
      destTaskId: 't',
      destFolderId: folder!.id
    })
    expect(copies[0].folder_id).toBe(folder!.id)
    expect(h.db.prepare('SELECT name FROM artifact_folders WHERE id=?').get(folder!.id)).toEqual({
      name: 'General folder'
    })
    const path = join(dir, 'binary'),
      binary = Buffer.from([0, 255, 128])
    writeFileSync(path, binary)
    await store.writeArtifactContent(h.slayDb, { artifactId: copies[0].id, sourcePath: path })
    expect(Buffer.from(await store.readArtifactBytes(h.slayDb, copies[0].id))).toEqual(binary)
    expect((await store.listArtifactsByTask(h.slayDb, 't'))[0].title).toBe('PRIVATE-file.txt')
    const general = await store.uploadArtifactBlob(h.slayDb, {
      taskId: 't',
      title: 'general.txt',
      bytes: Buffer.from('general')
    })
    expect(h.db.prepare('SELECT title FROM task_artifacts WHERE id=?').get(general!.id)).toEqual({
      title: 'general.txt'
    })
    expect(existsSync(join(hubDir, 'blobs'))).toBe(true)
  } finally {
    await pc.close()
    h.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})
