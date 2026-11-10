import { mkdtempSync, realpathSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import { taskSessionStore } from './test-session-store'
import { createArtifactStore } from '@slayzone/task-artifacts/server'
import { createFixtureChatRuntime } from '../../computer/src/project-scope.fixture'
import { createComputerChatServices } from './computer-chat'
import { createComputerArtifactStorage } from './computer-artifacts'

test('new chat files and versions stay on owner; general artifacts stay on hub', async () => {
  const h = await createTestHarness(),
    dir = mkdtempSync(join(realpathSync(tmpdir()), 'chat-files-')),
    hubDir = join(dir, 'hub')
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
  try {
    h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','P','#000')").run()
    h.db
      .prepare("INSERT INTO tasks(id,project_id,title,has_worktree) VALUES('t','p','Task',1)")
      .run()
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
    const second = await store.uploadArtifactBlob(h.slayDb, {
      taskId: 't',
      title: 'second.txt',
      bytes: Buffer.from('second'),
      chatTabId: 'tab'
    })
    const fileOrder = [second!.id, general!.id, a!.id, copies[0].id]
    await store.reorderArtifacts(h.slayDb, fileOrder)
    expect((await store.listArtifactsByTask(h.slayDb, 't')).map((file) => file.id)).toEqual(
      fileOrder
    )
    expect((await store.listArtifactsByTask(h.slayDb, 't')).map((file) => file.order)).toEqual([
      0, 1, 2, 3
    ])
    const uploads = (await store.listFoldersByTask(h.slayDb, 't')).find((f) => f.id !== folder!.id)!
    await store.reorderFolders(h.slayDb, { parentId: null, folderIds: [folder!.id, uploads.id] })
    expect((await store.listFoldersByTask(h.slayDb, 't')).map((f) => [f.id, f.order])).toEqual([
      [folder!.id, 0],
      [uploads.id, 1]
    ])
    // P1: a create takes no path; only the hub's own staged file (the REST create
    // route's request body) gives initial bytes, through its own entry.
    const staged = await store.createArtifactFromStagedFile(
      h.slayDb,
      { taskId: 't', title: 'staged.bin', folderId: folder!.id },
      path
    )
    expect(Buffer.from(await store.readArtifactBytes(h.slayDb, staged!.id))).toEqual(binary)
    const noPath = await store.createArtifact(h.slayDb, {
      taskId: 't',
      title: 'no-path.txt',
      sourcePath: path
    } as never)
    expect(await store.readArtifactContent(h.slayDb, noPath!.id)).toBe('')
  } finally {
    await pc.close()
    h.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('moving files to another task keeps ids on hub and computer, and survives metadata recovery', async () => {
  const h = await createTestHarness(),
    dir = mkdtempSync(join(realpathSync(tmpdir()), 'chat-move-')),
    hubDir = join(dir, 'hub')
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
  try {
    h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','P','#000')").run()
    for (const id of ['src', 'dst'])
      h.db
        .prepare("INSERT INTO tasks(id,project_id,title,has_worktree) VALUES(?,'p','Task',1)")
        .run(id)
    h.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','src','claude-chat',0)"
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
    // A chat upload (computer-held, in the computer's "Uploads" folder), a hub
    // folder holding a hub file AND a chat file, and a loose hub file.
    const upload = (await store.uploadArtifactBlob(h.slayDb, {
      taskId: 'src',
      title: 'shot.png',
      bytes: Buffer.from('PNG bytes'),
      chatTabId: 'tab'
    }))!
    const general = (await store.createFolder(h.slayDb, { taskId: 'src', name: 'General' }))!
    const hubFile = (await store.createArtifact(h.slayDb, {
      taskId: 'src',
      title: 'notes.md',
      folderId: general.id,
      content: 'hub notes'
    }))!
    const chatInHub = (await store.uploadArtifactBlob(h.slayDb, {
      taskId: 'src',
      title: 'log.txt',
      bytes: Buffer.from('chat log'),
      chatTabId: 'tab'
    }))!
    await store.updateArtifact(h.slayDb, { id: chatInHub.id, folderId: general.id })
    const loose = (await store.createArtifact(h.slayDb, {
      taskId: 'src',
      title: 'loose.txt',
      content: 'loose'
    }))!
    const before = await store.listArtifactsByTask(h.slayDb, 'src')
    const roots = {
      artifactIds: before.filter((a) => !a.folder_id).map((a) => a.id),
      folderIds: (await store.listFoldersByTask(h.slayDb, 'src'))
        .filter((f) => !f.parent_id)
        .map((f) => f.id)
    }

    await store.moveArtifacts(h.slayDb, {
      ...roots,
      sourceTaskId: 'src',
      destTaskId: 'dst',
      destFolderId: null
    })

    const moved = await store.listArtifactsByTask(h.slayDb, 'dst')
    expect(moved.map((a) => a.id).sort()).toEqual(
      [upload.id, hubFile.id, chatInHub.id, loose.id].sort()
    )
    expect(await store.listArtifactsByTask(h.slayDb, 'src')).toEqual([])
    expect(await store.listFoldersByTask(h.slayDb, 'src')).toEqual([])
    expect(Buffer.from(await store.readArtifactBytes(h.slayDb, upload.id)).toString()).toBe(
      'PNG bytes'
    )
    expect(Buffer.from(await store.readArtifactBytes(h.slayDb, chatInHub.id)).toString()).toBe(
      'chat log'
    )
    expect(await store.readArtifactContent(h.slayDb, hubFile.id)).toBe('hub notes')
    expect(moved.find((a) => a.id === chatInHub.id)!.folder_id).toBe(general.id)

    // The computer agrees after a full metadata re-read (a hub restart).
    h.db.prepare('DELETE FROM chat_metadata_progress').run()
    await expect(chat.relay.drainMetadata('pc', true)).resolves.toBeDefined()
    expect(
      h.db
        .prepare(
          `SELECT a.id,a.task_id FROM task_artifacts a JOIN chat_artifact_locations l ON l.artifact_id=a.id ORDER BY a.id`
        )
        .all()
    ).toEqual([upload.id, chatInHub.id].sort().map((id) => ({ id, task_id: 'dst' })))
    // A retry of the finished move changes nothing.
    await store.moveArtifacts(h.slayDb, {
      ...roots,
      sourceTaskId: 'src',
      destTaskId: 'dst',
      destFolderId: null
    })
    expect((await store.listArtifactsByTask(h.slayDb, 'dst')).length).toBe(4)
    // The computer still serves the chat files' versions and edits.
    await store.updateArtifact(h.slayDb, { id: upload.id, content: 'edited after move' })
    expect(await store.readArtifactContent(h.slayDb, upload.id)).toBe('edited after move')
  } finally {
    await pc.close()
    h.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})
