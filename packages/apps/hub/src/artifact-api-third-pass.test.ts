import Database from 'better-sqlite3'
import express from 'express'
import { mkdtempSync, realpathSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { getStorageDir, type SlayzoneDb } from '@slayzone/platform'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import { taskSessionStore } from './test-session-store'
import {
  artifactsRouter,
  createArtifactStore,
  setArtifactStorage,
  setArtifactsRouterDeps
} from '@slayzone/task-artifacts/server'
import type { TaskArtifact } from '@slayzone/task-contracts'
import type { ArtifactVersion, ArtifactSearchReport } from '@slayzone/task-artifacts/shared'
import { createTestHarness, createSlayzoneDbAdapter } from '../../../shared/test-utils/ipc-harness'
import { mountRestApp } from '../../../shared/test-utils/rest-harness'
import { createChatRuntimeHandlers } from '../../computer/src/handlers/chat-runtime'
import { registerArtifactsContentRoutes } from '../../api/src/http/rest-api/artifacts/content'
import { registerArtifactsCrudRoutes } from '../../api/src/http/rest-api/artifacts/crud'
import { registerArtifactsVersionsRoutes } from '../../api/src/http/rest-api/artifacts/versions'
import { registerArtifactsListRoute } from '../../api/src/http/rest-api/artifacts/list'
import { registerArtifactsSearchRoute } from '../../api/src/http/rest-api/artifacts/search'
import { createComputerChatServices } from './computer-chat'
import { createComputerArtifactStorage } from './computer-artifacts'

// Use the real hub service, real computer endpoint and real HTTP routes. Every
// computer request/reply takes a JSON round trip, matching the transport rather
// than accidentally relying on undefined values or in-process object identity.
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value))

async function fixture() {
  const h = await createTestHarness()
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'artifact-api-third-pass-'))
  const previousRoot = process.env.SLAYZONE_ROOT
  process.env.SLAYZONE_ROOT = join(root, 'hub')
  const hubDir = getStorageDir()
  const offline = new Set<string>()
  const preferred = new Map<string, string>([
    ['t', 'a'],
    ['other', 'b']
  ])
  const pcs = new Map(
    ['a', 'b'].map((computerId) => [
      computerId,
      createChatRuntimeHandlers({
        stateDir: join(root, computerId),
        hubScope: 'audit',
        computerId: () => computerId,
        getProjectPaths: () => null,
        ctx: {
          config: {
            hubUrl: 'ws://audit/computers',
            name: computerId,
            allowedRoots: [root],
            capabilities: ['proc']
          },
          dialer: { notify: () => true },
          log: () => {}
        }
      })
    ])
  )
  h.db.exec(`
    INSERT INTO projects(id,name,color) VALUES('p','Project','#000');
    INSERT INTO tasks(id,project_id,title) VALUES('t','p','Task'),('other','p','Other');
    INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab-a','t','claude-chat',0),('tab-b','t','claude-chat',1);
  `)
  const request = async (computerId: string, raw: unknown): Promise<unknown> => {
    if (offline.has(computerId)) throw new Error(`Computer ${computerId} offline`)
    return wire(await pcs.get(computerId)!.request(wire(raw)))
  }
  const services = (db: SlayzoneDb) =>
    createComputerChatServices({
      db,
      legacyData: { ...createDbChatDataOps(db, taskSessionStore), buildMcpEnv: async () => ({}) },
      attachments: { read: async () => new Uint8Array() },
      request,
      resolveComputer: async (taskId) => preferred.get(taskId) ?? 'a',
      defaultComputer: async () => 'a',
      hasLiveTask: async () => false
    })
  const chat = services(h.slayDb)
  const local = createArtifactStore(hubDir)
  const store = createComputerArtifactStorage({ db: h.slayDb, local, chat, request })
  setArtifactStorage(hubDir, store)
  const app = express()
  app.use(express.json())
  const deps = { db: h.slayDb, notifyRenderer: () => {} }
  // Search literal must precede CRUD's /:id route, as in the application.
  registerArtifactsSearchRoute(app, deps)
  registerArtifactsContentRoutes(app, deps)
  registerArtifactsVersionsRoutes(app, deps)
  registerArtifactsListRoute(app, deps)
  registerArtifactsCrudRoutes(app, deps)
  const rest = await mountRestApp(app)
  const upload = async (pc: string, title = `${pc}.txt`, content = `bytes ${pc}`) => {
    const owner = await chat.artifactOwner('t', pc)
    return (await store.uploadArtifactBlob(h.slayDb, {
      taskId: 't',
      title,
      bytes: Buffer.from(content),
      chatTabId: owner.tabId
    }))!
  }
  return {
    root,
    hubDir,
    h,
    chat,
    store,
    local,
    rest,
    request,
    upload,
    offline,
    preferred,
    services,
    async close() {
      await rest.close()
      for (const pc of pcs.values()) await pc.close()
      setArtifactStorage(hubDir, local)
      h.cleanup()
      if (previousRoot === undefined) delete process.env.SLAYZONE_ROOT
      else process.env.SLAYZONE_ROOT = previousRoot
      rmSync(root, { recursive: true, force: true })
    }
  }
}

type Reply<T> = { ok: boolean; data: T; error?: string }

test('third-pass control: REST computer bytes, append, explicit versions and list are binary exact', async () => {
  const f = await fixture()
  try {
    const binary = Buffer.from([0, 255, 128, 13, 10, 254])
    const a = await f.upload('a', 'binary.png')
    const put = await fetch(
      `${f.rest.url}/api/artifacts/${a.id}/content?authorType=agent&authorId=test-agent`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: binary
      }
    )
    expect(put.status).toBe(200)
    const version = ((await put.json()) as Reply<{ version: ArtifactVersion }>).data.version
    expect(version).toMatchObject({ author_type: 'agent', author_id: 'test-agent' })
    const suffix = Buffer.from([0, 253])
    expect(
      (
        await fetch(`${f.rest.url}/api/artifacts/${a.id}/content`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: suffix
        })
      ).status
    ).toBe(200)
    const current = await fetch(`${f.rest.url}/api/artifacts/${a.id}/content`)
    expect(current.status).toBe(200)
    expect(Buffer.from(await current.arrayBuffer())).toEqual(Buffer.concat([binary, suffix]))
    const historical = await fetch(
      `${f.rest.url}/api/artifacts/${a.id}/versions/content?ref=${version.version_num}`
    )
    expect(historical.status).toBe(200)
    expect(Buffer.from(await historical.arrayBuffer())).toEqual(binary)
    const listed = await f.rest.request<Reply<{ artifacts: TaskArtifact[] }>>(
      'GET',
      '/api/tasks/t/artifacts'
    )
    expect(listed.status).toBe(200)
    expect(listed.body.data.artifacts).toEqual([
      expect.objectContaining({
        id: a.id,
        title: 'binary.png',
        storage: { computerId: 'a', available: true }
      })
    ])
    expect(existsSync(join(f.hubDir, 'blobs'))).toBe(false)
  } finally {
    await f.close()
  }
})

test('third-pass: REST versions create preserves agent attribution on computer originals', async () => {
  const f = await fixture()
  try {
    const local = (await f.store.createArtifact(f.h.slayDb, {
      taskId: 't',
      title: 'hub.txt',
      content: 'hub'
    }))!
    const remote = await f.upload('a')
    for (const a of [local, remote]) {
      const result = await f.rest.request<Reply<ArtifactVersion>>(
        'POST',
        `/api/artifacts/${a.id}/versions`,
        {
          name: 'agent-checkpoint',
          authorType: 'agent',
          authorId: 'claude:session-123'
        }
      )
      expect(result.status).toBe(200)
      expect(
        result.body.data,
        a.id === local.id ? 'hub control' : 'computer original'
      ).toMatchObject({
        name: 'agent-checkpoint',
        author_type: 'agent',
        author_id: 'claude:session-123'
      })
    }
  } finally {
    await f.close()
  }
})

test('third-pass: one search limit applies across hub and computer results without duplicate scan counts', async () => {
  const f = await fixture()
  try {
    await f.store.createArtifact(f.h.slayDb, { taskId: 't', title: 'needle-hub.txt' })
    await f.upload('a', 'needle-pc.txt')
    const result = await f.rest.request<Reply<ArtifactSearchReport>>(
      'GET',
      '/api/artifacts/search?taskId=t&q=needle&titlesOnly=1&limit=1'
    )
    expect(result.status).toBe(200)
    expect.soft(result.body.data.results).toHaveLength(1)
    expect.soft(result.body.data.scannedCount).toBe(2)
    expect.soft(result.body.data.truncated).toBe(true)
  } finally {
    await f.close()
  }
})

test('third-pass: redacted locator hits cannot consume the hub search limit and hide real hub matches', async () => {
  const f = await fixture()
  try {
    const hub = (await f.store.createArtifact(f.h.slayDb, {
      taskId: 't',
      title: 'Chat manual.txt'
    }))!
    const remote = await f.upload('a', 'private.txt')
    // Deterministic ordering: a newer computer locator is scanned before the hub file.
    f.h.db
      .prepare("UPDATE task_artifacts SET updated_at='2030-01-01 00:00:00' WHERE id=?")
      .run(remote.id)
    const result = await f.rest.request<Reply<ArtifactSearchReport>>(
      'GET',
      '/api/artifacts/search?taskId=t&q=Chat&titlesOnly=1&limit=1'
    )
    expect(result.status).toBe(200)
    expect.soft(result.body.data.results.map((r) => r.artifactId)).toContain(hub.id)
    expect.soft(result.body.data.scannedCount).toBe(2)
  } finally {
    await f.close()
  }
})

test('third-pass control: offline owner lists keep placeholders and preserve hub/other computer names', async () => {
  const f = await fixture()
  try {
    const hub = (await f.store.createArtifact(f.h.slayDb, { taskId: 't', title: 'hub.txt' }))!
    const a = await f.upload('a')
    const b = await f.upload('b')
    f.offline.add('b')
    const listed = await f.rest.request<Reply<{ artifacts: TaskArtifact[] }>>(
      'GET',
      '/api/tasks/t/artifacts'
    )
    expect(listed.status).toBe(200)
    expect(listed.body.data.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: hub.id, title: 'hub.txt' }),
        expect.objectContaining({
          id: a.id,
          title: 'a.txt',
          storage: { computerId: 'a', available: true }
        }),
        expect.objectContaining({
          id: b.id,
          title: 'Chat attachment · computer unavailable',
          storage: { computerId: 'b', available: false }
        })
      ])
    )
  } finally {
    await f.close()
  }
})

test('third-pass observation: global search returns an explicit error when an unrelated computer is offline', async () => {
  const f = await fixture()
  try {
    await f.store.createArtifact(f.h.slayDb, {
      taskId: 't',
      title: 'needle-hub.txt'
    })
    await f.upload('b', 'unrelated.txt')
    f.offline.add('b')
    const result = await f.rest.request<Reply<ArtifactSearchReport>>(
      'GET',
      '/api/artifacts/search?allTasks=1&q=needle&titlesOnly=1'
    )
    // Confirm availability behavior without inventing a per-computer partial
    // result contract. Mobile explicitly reports a failed hub; its per-hub
    // partial-result support does not prove an analogous per-PC requirement.
    expect(result.status).toBe(500)
    expect(result.body).toEqual({ ok: false, error: 'Computer b offline' })
  } finally {
    await f.close()
  }
})

test.each(['a', 'b'])(
  'third-pass: restored hub recovers cross-computer folders when %s reconnects first',
  async (first) => {
    const f = await fixture()
    let restored: Database.Database | undefined
    try {
      const ownerA = await f.chat.artifactOwner('t', 'a')
      const ownerB = await f.chat.artifactOwner('t', 'b')
      const backupPath = join(f.root, 'before-files.sqlite')
      await f.h.db.backup(backupPath)
      const caller = artifactsRouter.createCaller({ db: f.h.slayDb, dataRoot: f.hubDir })
      const b = (await caller.uploadBlob({
        taskId: 't',
        title: 'file-b.txt',
        bytes: Buffer.from('private B'),
        chatTabId: ownerB.tabId
      }))!
      const folder = (await caller.foldersUpdate({ id: b.folder_id!, name: 'Private B' }))!
      const a = (await caller.uploadBlob({
        taskId: 't',
        title: 'file-a.txt',
        bytes: Buffer.from('private A'),
        folderId: folder.id,
        chatTabId: ownerA.tabId
      }))!
      expect(
        (await f.store.listFoldersByTask(f.h.slayDb, 't')).find((r) => r.id === folder.id)?.name
      ).toBe('Private B')
      restored = new Database(backupPath)
      restored.pragma('foreign_keys=ON')
      const db = createSlayzoneDbAdapter(restored)
      const after = f.services(db)
      await after.recoverComputer(first)
      if (first === 'a') {
        const partial = createComputerArtifactStorage({
          db,
          local: f.local,
          chat: after,
          request: f.request
        })
        setArtifactStorage(f.hubDir, partial)
        const partialCaller = artifactsRouter.createCaller({ db, dataRoot: f.hubDir })
        expect
          .soft(
            (await partialCaller.foldersGetByTask({ taskId: 't' })).find(
              (entry) => entry.id === folder.id
            )
          )
          .toMatchObject({ storage: { computerId: null, available: false } })
        await expect
          .soft(partialCaller.foldersUpdate({ id: folder.id, name: 'lost rename' }))
          .rejects.toThrow(/unavailable|reconnect|awaiting/i)
        await expect
          .soft(partialCaller.foldersDelete({ id: folder.id }))
          .rejects.toThrow(/unavailable|reconnect|awaiting/i)
        await expect
          .soft(
            partialCaller.foldersCreate({
              taskId: 't',
              name: 'unresolved child',
              parentId: folder.id
            })
          )
          .rejects.toThrow(/unavailable|reconnect|awaiting/i)
        await expect
          .soft(
            partialCaller.uploadBlob({
              taskId: 't',
              title: 'must-not-route-to-hub.txt',
              folderId: folder.id,
              bytes: Buffer.from('private upload')
            })
          )
          .rejects.toThrow(/unavailable|reconnect|awaiting/i)
      }
      await expect(after.recoverComputer(first === 'a' ? 'b' : 'a')).resolves.toBeUndefined()
      const recoveredStore = createComputerArtifactStorage({
        db,
        local: f.local,
        chat: after,
        request: f.request
      })
      expect(
        (await recoveredStore.listFoldersByTask(db, 't')).find((r) => r.id === folder.id)
      ).toMatchObject({ name: 'Private B', storage: { computerId: 'b', available: true } })
      const firstMembership = (await recoveredStore.listArtifactsByTask(db, 't')).find(
        (r) => r.id === a.id
      )
      expect(Buffer.from(await recoveredStore.readArtifactBytes(db, a.id)).toString()).toBe(
        'private A'
      )
      // Another A reconnect after B has published its authoritative folder heals
      // this. The normal A-then-B reconnect still leaves the file at root until
      // that extra reconnect; do not misreport the relationship as permanently lost.
      await after.recoverComputer('a', true)
      expect(
        (await recoveredStore.listArtifactsByTask(db, 't')).find((r) => r.id === a.id)
      ).toMatchObject({ folder_id: folder.id })
      expect(firstMembership).toMatchObject({ folder_id: folder.id })
    } finally {
      restored?.close()
      await f.close()
    }
  }
)

test('third-pass: copy to root preserves the explicit root destination for computer originals', async () => {
  const f = await fixture()
  try {
    const hub = (await f.store.createArtifact(f.h.slayDb, {
      taskId: 't',
      title: 'hub.txt',
      content: 'hub bytes'
    }))!
    const pc = await f.upload('a')
    const caller = artifactsRouter.createCaller({ db: f.h.slayDb, dataRoot: f.hubDir })
    for (const original of [hub, pc]) {
      const copied = await caller.copy({
        artifactIds: [original.id],
        destTaskId: 't',
        destFolderId: null
      })
      expect(copied).toHaveLength(1)
      expect(
        copied[0].folder_id,
        original.id === hub.id ? 'hub control' : 'computer original'
      ).toBeNull()
    }
  } finally {
    await f.close()
  }
})

test('third-pass: pruning all versions preserves REST access to a surviving computer working file', async () => {
  const f = await fixture()
  try {
    const hub = (await f.store.createArtifact(f.h.slayDb, {
      taskId: 't',
      title: 'hub.txt',
      content: 'hub bytes'
    }))!
    const pc = await f.upload('a')
    for (const [artifact, text] of [
      [hub, 'hub bytes'],
      [pc, 'bytes a']
    ] as const) {
      const prune = await f.rest.request<Reply<{ deletedVersions: number }>>(
        'POST',
        `/api/artifacts/${artifact.id}/versions/prune`,
        {
          keepLast: 0,
          keepNamed: false,
          keepCurrent: false
        }
      )
      expect(prune.status).toBe(200)
      expect(prune.body.data.deletedVersions).toBe(1)
      // Working bytes still exist and the text/editor read proves it. Current
      // raw content/download does not require a historical version on the hub.
      expect(await f.store.readArtifactContent(f.h.slayDb, artifact.id)).toBe(text)
      const raw = await fetch(`${f.rest.url}/api/artifacts/${artifact.id}/content`)
      expect(raw.status, artifact.id === hub.id ? 'hub control' : 'computer original').toBe(200)
      expect(await raw.text()).toBe(text)
    }
  } finally {
    await f.close()
  }
})

test('third-pass control: REST stream create and mixed-owner folder download preserve bytes and tree names', async () => {
  const f = await fixture()
  try {
    const dest = mkdtempSync(join(f.root, 'downloads-'))
    setArtifactsRouterDeps({
      onTasksChanged: () => {},
      getDownloadHost: () => ({
        getDownloadsDir: async () => dest,
        showSaveDialog: async () => ({ canceled: false, filePath: join(dest, 'file.png') }),
        showOpenDialog: async () => ({ canceled: false, filePaths: [dest] }),
        showItemInFolder: () => {},
        buildExportHtml: async (content) => content,
        renderPdfToFile: async () => {},
        renderPngToFile: async () => false
      })
    })
    const general = (await f.store.createFolder(f.h.slayDb, { taskId: 't', name: 'General' }))!
    const a = await f.upload('a')
    const b = await f.upload('b')
    for (const [artifact, name] of [
      [a, 'PC A'],
      [b, 'PC B']
    ] as const) {
      await f.store.updateFolder(f.h.slayDb, {
        id: artifact.folder_id!,
        name,
        parentId: general.id
      })
    }
    const nested = (await f.store.createFolder(f.h.slayDb, {
      taskId: 't',
      name: 'Nested',
      parentId: a.folder_id
    }))!
    const bytes = Buffer.from([0, 255, 128, 13, 10, 254])
    const create = await fetch(
      `${f.rest.url}/api/artifacts?taskId=t&title=file.png&folderId=${nested.id}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: bytes
      }
    )
    expect(create.status).toBe(200)
    const created = ((await create.json()) as Reply<TaskArtifact>).data
    expect(Buffer.from(await f.store.readArtifactBytes(f.h.slayDb, created.id))).toEqual(bytes)
    await f.store.createArtifact(f.h.slayDb, {
      taskId: 't',
      title: 'hub.txt',
      folderId: general.id,
      content: 'hub'
    })
    const caller = artifactsRouter.createCaller({ db: f.h.slayDb, dataRoot: f.hubDir })
    expect(await caller.downloadFolder({ folderId: general.id })).toBe(true)
    expect(readFileSync(join(dest, 'General', 'hub.txt'), 'utf8')).toBe('hub')
    expect(readFileSync(join(dest, 'General', 'PC A', 'a.txt'), 'utf8')).toBe('bytes a')
    expect(readFileSync(join(dest, 'General', 'PC B', 'b.txt'), 'utf8')).toBe('bytes b')
    expect(readFileSync(join(dest, 'General', 'PC A', 'Nested', 'file.png'))).toEqual(bytes)
  } finally {
    await f.close()
  }
})

test('third-pass control: task computer changes preserve original ownership and mixed folder copy/move bytes', async () => {
  const f = await fixture()
  try {
    const a = await f.upload('a', 'same.txt', 'original A')
    f.preferred.set('t', 'b')
    const b = await f.upload('b', 'same.txt', 'original B')
    const folderA = (await f.store.listFoldersByTask(f.h.slayDb, 't')).find(
      (r) => r.storage?.computerId === 'a'
    )!
    const folderB = (await f.store.listFoldersByTask(f.h.slayDb, 't')).find(
      (r) => r.storage?.computerId === 'b'
    )!
    expect(folderA.name).toBe(folderB.name)
    await f.store.updateArtifact(f.h.slayDb, { id: a.id, folderId: folderB.id })
    const copy = (
      await f.store.copyArtifacts(f.h.slayDb, {
        artifactIds: [a.id],
        destTaskId: 't',
        destFolderId: folderB.id
      })
    )[0]
    const all = await f.store.listArtifactsByTask(f.h.slayDb, 't')
    expect(all).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: a.id,
          title: 'same.txt',
          folder_id: folderB.id,
          storage: { computerId: 'a', available: true }
        }),
        expect.objectContaining({
          id: b.id,
          title: 'same.txt',
          storage: { computerId: 'b', available: true }
        }),
        expect.objectContaining({
          id: copy.id,
          folder_id: folderB.id,
          storage: { computerId: 'b', available: true }
        })
      ])
    )
    expect(Buffer.from(await f.store.readArtifactBytes(f.h.slayDb, a.id)).toString()).toBe(
      'original A'
    )
    expect(Buffer.from(await f.store.readArtifactBytes(f.h.slayDb, copy.id)).toString()).toBe(
      'original A'
    )
    expect(Buffer.from(await f.store.readArtifactBytes(f.h.slayDb, b.id)).toString()).toBe(
      'original B'
    )
  } finally {
    await f.close()
  }
})
