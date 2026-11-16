import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import { taskSessionStore } from './test-session-store'
import { createArtifactStore } from '@slayzone/task-artifacts/server'
import type { ArtifactFolder, TaskArtifact } from '@slayzone/task-contracts'
import { createFixtureChatRuntime } from '../../computer/src/project-scope.fixture'
import { createComputerChatServices } from './computer-chat'
import { createComputerArtifactStorage } from './computer-artifacts'

test('folder deletion survives an offline mirror, stale metadata and an older hub snapshot', async () => {
  const h = await createTestHarness(),
    dir = mkdtempSync(join(realpathSync(tmpdir()), 'chat-folder-delete-'))
  const pcs = new Map(
    ['a', 'b'].map((computerId) => [
      computerId,
      createFixtureChatRuntime({
        stateDir: join(dir, computerId),
        hubScope: 'hub',
        computerId: () => computerId,
        getProjectPaths: () => null,
        ctx: {
          config: {
            hubUrl: 'ws://hub/computers',
            name: computerId,
            allowedRoots: [realpathSync(tmpdir())],
            capabilities: ['proc']
          },
          dialer: { notify: () => true },
          log: () => {}
        }
      })
    ])
  )
  let offline = false,
    stale: unknown = null
  try {
    h.db.exec(
      "INSERT INTO projects(id,name,color) VALUES('p','P','#000'); INSERT INTO tasks(id,project_id,title) VALUES('t','p','Task')"
    )
    const request = async (computerId: string, raw: unknown) => {
      if (computerId === 'b' && offline) throw new Error('Offline')
      if (computerId === 'b' && (raw as { kind: string }).kind === 'metadata.snapshot' && stale) {
        const value = stale
        stale = null
        return value
      }
      return pcs.get(computerId)!.request(raw)
    }
    const chat = createComputerChatServices({
      db: h.slayDb,
      legacyData: {
        ...createDbChatDataOps(h.slayDb, taskSessionStore),
        buildMcpEnv: async () => ({})
      },
      attachments: { read: async () => new Uint8Array() },
      request,
      resolveComputer: async () => 'a',
      defaultComputer: async () => 'a',
      hasLiveTask: async () => false
    })
    const store = createComputerArtifactStorage({
      db: h.slayDb,
      local: createArtifactStore(join(dir, 'hub')),
      chat,
      request
    })
    const parent = (await store.createFolder(h.slayDb, { taskId: 't', name: 'General' }))!
    const files: Array<{
      pc: string
      file: TaskArtifact
      folder: ArtifactFolder
      owner: Awaited<ReturnType<typeof chat.artifactOwner>>
    }> = []
    for (const pc of ['a', 'b']) {
      const owner = await chat.artifactOwner('t', pc),
        route = { id: owner.id, epoch: owner.epoch }
      await request(pc, {
        kind: 'artifact.invoke',
        value: {
          route,
          method: 'importFolder',
          args: [{ id: parent.id, taskId: 't', name: parent.name, parentId: null }],
          operationId: 'parent'
        }
      })
      const folder = (await request(pc, {
        kind: 'artifact.invoke',
        value: {
          route,
          method: 'createFolder',
          args: [{ taskId: 't', name: `Private ${pc}`, parentId: parent.id }],
          operationId: 'child'
        }
      })) as ArtifactFolder
      await chat.relay.drainMetadata(pc)
      const file = (await store.uploadArtifactBlob(h.slayDb, {
        taskId: 't',
        title: `${pc}.txt`,
        folderId: folder.id,
        bytes: Buffer.from(`file ${pc}`)
      }))!
      files.push({ pc, file, folder, owner })
    }
    const before = await pcs.get('b')!.request({ kind: 'metadata.snapshot', id: files[1].owner.id })
    offline = true
    expect(await store.deleteFolder(h.slayDb, parent.id)).toBe(true)
    expect(await store.listFoldersByTask(h.slayDb, 't')).toEqual([])
    expect((await store.listArtifactsByTask(h.slayDb, 't')).map((file) => file.folder_id)).toEqual([
      null,
      null
    ])
    offline = false
    await chat.lifecycle.sync('b')
    await chat.relay.drainMetadata('b')
    for (const { pc, file, owner } of files) {
      const actual = (await request(pc, {
        kind: 'artifact.invoke',
        value: {
          route: { id: owner.id, epoch: owner.epoch },
          method: 'getArtifact',
          args: [file.id]
        }
      })) as TaskArtifact
      expect(actual.folder_id).toBeNull()
      expect(Buffer.from(await store.readArtifactBytes(h.slayDb, file.id)).toString()).toBe(
        `file ${pc}`
      )
    }
    stale = before
    await chat.relay.recoverMetadata('b', files[1].owner.id)
    expect(await store.listFoldersByTask(h.slayDb, 't')).toEqual([])
    expect(
      (await store.listArtifactsByTask(h.slayDb, 't')).every((file) => file.folder_id === null)
    ).toBe(true)
    // An older hub backup can contain those folders and forget their deletion.
    h.db.exec('DELETE FROM chat_folder_deletions; DELETE FROM chat_folder_deletion_acks')
    h.db
      .prepare('INSERT INTO artifact_folders(id,task_id,name) VALUES(?,?,?)')
      .run(parent.id, 't', 'General')
    for (const { folder } of files)
      h.db
        .prepare(
          "INSERT INTO artifact_folders(id,task_id,name,parent_id) VALUES(?,'t','Chat files',?)"
        )
        .run(folder.id, parent.id)
    chat.invalidateRecovery('b')
    await chat.recoverComputer('b')
    expect(await store.listFoldersByTask(h.slayDb, 't')).toEqual([])
    expect(h.db.prepare('SELECT folder_id FROM chat_folder_deletions').all()).toEqual(
      expect.arrayContaining([{ folder_id: parent.id }])
    )
  } finally {
    for (const pc of pcs.values()) await pc.close()
    h.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})
