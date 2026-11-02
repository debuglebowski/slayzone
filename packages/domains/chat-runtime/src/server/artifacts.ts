import { AsyncLocalStorage } from 'node:async_hooks'
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
  openSync,
  closeSync,
  fsyncSync
} from 'node:fs'
import { z } from 'zod'
import { join } from 'node:path'
import { createStandaloneArtifacts, BlobStore } from '@slayzone/task-artifacts/storage'
import type { ChatAttachment } from '@slayzone/terminal-contracts'
import { chatAttachmentSchema, chatRouteSchema } from '../shared'
import type { ChatStorage } from './storage'
import type { createLocalChatData } from './local-data'
import type { createLocalAttachments } from './attachments'

const id = z.string().min(1).max(200),
  title = z.string().min(1).max(512),
  ref = z.union([z.string().max(200), z.number().int()])
const artifact = id.transform((v) => v)
const object = z.object({ artifactId: id })
export const artifactMethodSchemas = {
  importFolder: z.tuple([z.object({ id, taskId: id, name: title, parentId: id.nullable() })]),
  listArtifactsByTask: z.tuple([id]),
  getArtifact: z.tuple([id]),
  readArtifactContent: z.tuple([id]),
  getArtifactMtime: z.tuple([id]),
  uploadArtifactBlob: z.tuple([
    z.object({
      taskId: id,
      title,
      data: z
        .string()
        .max(14_000_000)
        .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
      folderId: id.nullish()
    })
  ]),
  updateArtifact: z.tuple([
    z
      .object({
        id,
        title: title.optional(),
        folderId: id.nullish(),
        content: z.string().max(10_000_000).optional(),
        renderMode: z.string().nullish(),
        viewMode: z.string().nullish(),
        language: z.string().nullish(),
        readabilityOverride: z.enum(['compact', 'normal']).nullish(),
        widthOverride: z.enum(['narrow', 'wide']).nullish(),
        zoomPct: z.number().nullish(),
        htmlThemeOverride: z.enum(['light', 'dark']).nullish(),
        mutateVersion: z.boolean().optional()
      })
      .strict()
  ]),
  deleteArtifact: z.tuple([artifact]),
  reorderArtifacts: z.tuple([
    z.union([z.array(id), z.object({ folderId: id.nullable(), artifactIds: z.array(id) })])
  ]),
  listArtifactVersions: z.tuple([
    object.extend({
      limit: z.number().int().positive().max(1000).optional(),
      offset: z.number().int().nonnegative().optional()
    })
  ]),
  readArtifactVersion: z.tuple([object.extend({ versionRef: ref })]),
  resolveArtifactVersion: z.tuple([object.extend({ versionRef: ref })]),
  getCurrentArtifactVersion: z.tuple([object]),
  createArtifactVersion: z.tuple([object.extend({ name: title.nullish() })]),
  renameArtifactVersion: z.tuple([object.extend({ versionRef: ref, newName: title.nullable() })]),
  diffArtifactVersions: z.tuple([object.extend({ a: ref, b: ref.optional() })]),
  pruneArtifactVersions: z.tuple([
    object.extend({
      keepLast: z.number().int().nonnegative().optional(),
      keepNamed: z.boolean().optional(),
      keepCurrent: z.boolean().optional(),
      dryRun: z.boolean().optional()
    })
  ]),
  setCurrentArtifactVersion: z.tuple([object.extend({ versionRef: ref })]),
  listFoldersByTask: z.tuple([id]),
  getOrCreateFolderByName: z.tuple([z.object({ taskId: id, name: title })]),
  createFolder: z.tuple([z.object({ taskId: id, name: title, parentId: id.nullish() })]),
  updateFolder: z.tuple([z.object({ id, name: title.optional(), parentId: id.nullish() })]),
  deleteFolder: z.tuple([id]),
  reorderFolders: z.tuple([z.object({ parentId: id.nullable(), folderIds: z.array(id) })]),
  writeArtifactContent: z.tuple([
    object.extend({
      data: z
        .string()
        .max(14_000_000)
        .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
      append: z.boolean().optional(),
      mutateCurrent: z.boolean().optional(),
      mutateRef: ref.optional(),
      author: z
        .object({ type: z.enum(['user', 'agent']).nullable(), id: z.string().nullable() })
        .optional()
    })
  ]),
  readBytes: z.tuple([id, ref.optional()]),
  seal: z.tuple([chatAttachmentSchema]),
  searchArtifacts: z.tuple([
    z.object({
      taskId: id,
      query: z.string().max(10000),
      folderId: id.nullish(),
      titlesOnly: z.boolean().optional(),
      contentOnly: z.boolean().optional(),
      regex: z.boolean().optional(),
      caseSensitive: z.boolean().optional(),
      limit: z.number().int().positive().max(1000).optional(),
      maxMatches: z.number().int().positive().max(1000).optional()
    })
  ])
} as const
const reads = new Set([
  'listArtifactsByTask',
  'getArtifact',
  'readArtifactContent',
  'getArtifactMtime',
  'listArtifactVersions',
  'readArtifactVersion',
  'resolveArtifactVersion',
  'getCurrentArtifactVersion',
  'diffArtifactVersions',
  'listFoldersByTask',
  'readBytes',
  'searchArtifacts'
])
export const computerArtifactRequestSchema = z.object({
  route: chatRouteSchema,
  method: z.enum(
    Object.keys(artifactMethodSchemas) as [
      keyof typeof artifactMethodSchemas,
      ...Array<keyof typeof artifactMethodSchemas>
    ]
  ),
  args: z.array(z.unknown()),
  operationId: id.optional()
})

export function createLocalArtifacts(
  storage: ChatStorage,
  local: ReturnType<typeof createLocalChatData>,
  attachments: ReturnType<typeof createLocalAttachments>
) {
  const context = new AsyncLocalStorage<import('../shared').ConversationIdentity>()
  const { db, store } = storage.compose((raw) =>
    createStandaloneArtifacts(raw, storage.dir, () => {
      const taskId = context.getStore()?.taskId
      if (taskId && storage.taskLifecycle(taskId).state !== 'active')
        throw new Error('Task chat is paused or deleted')
    })
  )
  storage.onTaskPurge((taskId) => {
    // Runs inside the owning tombstone transaction, outside an invocation context.
    storage.compose((raw) => {
      raw.prepare('DELETE FROM task_artifacts WHERE task_id=?').run(taskId)
      raw.prepare('DELETE FROM artifact_folders WHERE task_id=?').run(taskId)
    })
    store.cleanupTaskArtifacts(taskId)
  })
  storage.compose((raw) => {
    raw.function('computer_chat_artifact_owner', () => context.getStore()?.id ?? '')
    raw.exec(`CREATE TABLE IF NOT EXISTS artifact_owners(id TEXT PRIMARY KEY,kind TEXT NOT NULL,conversation_id TEXT NOT NULL REFERENCES conversations(id));
    CREATE TRIGGER IF NOT EXISTS chat_artifact_owner AFTER INSERT ON task_artifacts BEGIN INSERT INTO artifact_owners VALUES(NEW.id,'artifact',computer_chat_artifact_owner()); END;
    CREATE TRIGGER IF NOT EXISTS chat_folder_owner AFTER INSERT ON artifact_folders BEGIN INSERT INTO artifact_owners VALUES(NEW.id,'folder',computer_chat_artifact_owner()); END;
    CREATE TRIGGER IF NOT EXISTS chat_artifact_owner_delete AFTER DELETE ON task_artifacts BEGIN DELETE FROM artifact_owners WHERE id=OLD.id; END;
    CREATE TRIGGER IF NOT EXISTS chat_folder_owner_delete AFTER DELETE ON artifact_folders BEGIN DELETE FROM artifact_owners WHERE id=OLD.id; END;
   `)
  })
  const blobs = new BlobStore(storage.dir)
  async function checkArtifact(id: string, taskId: string) {
    const a = await store.getArtifact(db, id)
    if (!a || a.task_id !== taskId) throw new Error('Artifact is outside this task')
    return a
  }
  async function checkFolder(id: string | null | undefined, taskId: string) {
    if (!id) return
    const row = await db.get<{ task_id: string }>(
      'SELECT task_id FROM artifact_folders WHERE id=?',
      [id]
    )
    if (!row || row.task_id !== taskId) throw new Error('Folder is outside this task')
  }
  async function seal(tabId: string, ref: ChatAttachment) {
    const owner = local.owner(tabId),
      a = await checkArtifact(ref.artifactId, owner.taskId)
    const { version, blobPath } = await store.resolveArtifactVersion(db, {
      artifactId: a.id,
      versionRef: ref.contentHash ?? 'current'
    })
    if (!blobPath) throw new Error('Local artifact blob path is missing')
    const bytes = readFileSync(blobPath)
    return attachments.put(
      tabId,
      { ...ref, name: a.title, contentHash: version.content_hash, size: version.size },
      bytes
    )
  }
  async function invoke(raw: unknown): Promise<unknown> {
    const req = computerArtifactRequestSchema.parse(raw),
      owner = storage.conversation(req.route.id)
    if (!owner || owner.state !== 'active' || owner.identity.epoch !== req.route.epoch)
      throw new Error('Artifact ownership is unavailable or deleted')
    const taskId = owner.identity.taskId,
      tabId = owner.identity.tabId,
      // biome-ignore lint/suspicious/noExplicitAny: Each heterogeneous tuple is validated by its method schema before dispatch.
      args = artifactMethodSchemas[req.method].parse(req.args) as any[],
      first = args[0]
    const read = reads.has(req.method)
    if (!read && storage.taskLifecycle(taskId).state !== 'active')
      throw new Error('Task chat is paused or deleted')
    if (!read && !req.operationId) throw new Error('Artifact mutation requires an operation id')
    if (req.method === 'listArtifactsByTask' || req.method === 'listFoldersByTask') {
      if (first !== taskId) throw new Error('Artifact task scope mismatch')
    } else if (
      [
        'uploadArtifactBlob',
        'getOrCreateFolderByName',
        'createFolder',
        'searchArtifacts',
        'importFolder'
      ].includes(req.method)
    ) {
      if (first.taskId !== taskId) throw new Error('Artifact task scope mismatch')
      await checkFolder(first.folderId ?? first.parentId, taskId)
    } else if (req.method === 'reorderArtifacts') {
      for (const id of Array.isArray(first) ? first : first.artifactIds)
        await checkArtifact(id, taskId)
    } else if (req.method === 'reorderFolders') {
      for (const id of first.folderIds) await checkFolder(id, taskId)
      await checkFolder(first.parentId, taskId)
    } else if (req.method === 'updateFolder' || req.method === 'deleteFolder') {
      await checkFolder(typeof first === 'string' ? first : first.id, taskId)
      if (typeof first !== 'string') await checkFolder(first.parentId, taskId)
    } else if (req.method === 'seal') await checkArtifact(first.artifactId, taskId)
    else {
      await checkArtifact(
        typeof first === 'string' ? first : (first.artifactId ?? first.id),
        taskId
      )
      if (req.method === 'updateArtifact') await checkFolder(first.folderId, taskId)
    }
    if (!read) {
      const receipt = storage.receipt(owner.identity.id, req.operationId!)
      if (receipt) {
        storage.acceptCommand(owner.identity.id, req.route.epoch, req.operationId!, {
          method: req.method,
          args
        })
        if (receipt.resultExpired)
          throw new Error(
            'Artifact operation result expired under chat retention; operation was not repeated'
          )
        if (receipt.state !== 'delivered')
          throw new Error('Artifact operation outcome is unconfirmed')
        return receipt.result
      }
      storage.acceptCommand(owner.identity.id, req.route.epoch, req.operationId!, {
        method: req.method,
        args
      })
    }
    return context.run(owner.identity, async () => {
      let result: unknown
      if (req.method === 'importFolder') {
        const existing = await db.get<{ task_id: string; kind: string }>(
          'SELECT f.task_id,o.kind FROM artifact_folders f JOIN artifact_owners o ON o.id=f.id WHERE f.id=?',
          [first.id]
        )
        if (existing && existing.task_id !== taskId) throw new Error('Folder task scope mismatch')
        if (!existing) {
          await db.run('INSERT INTO artifact_folders(id,task_id,name,parent_id) VALUES(?,?,?,?)', [
            first.id,
            taskId,
            first.name,
            first.parentId
          ])
          await db.run("UPDATE artifact_owners SET kind='external-folder' WHERE id=?", [first.id])
        } else if (existing.kind === 'external-folder')
          await db.run('UPDATE artifact_folders SET name=?,parent_id=? WHERE id=?', [
            first.name,
            first.parentId,
            first.id
          ])
        result = null
      } else if (req.method === 'listFoldersByTask')
        result = (await store.listFoldersByTask(db, taskId)).filter((f) =>
          storage.compose(
            (raw) =>
              !!raw.prepare("SELECT 1 FROM artifact_owners WHERE id=? AND kind='folder'").get(f.id)
          )
        )
      else if (req.method === 'uploadArtifactBlob')
        result = await store.uploadArtifactBlob(db, {
          ...first,
          bytes: Buffer.from(first.data, 'base64')
        })
      else if (req.method === 'writeArtifactContent') {
        const dir = mkdtempSync(join(storage.dir, '.write-')),
          sourcePath = join(dir, 'content')
        try {
          writeFileSync(sourcePath, Buffer.from(first.data, 'base64'), { mode: 0o600 })
          result = await store.writeArtifactContent(db, { ...first, sourcePath })
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      } else if (req.method === 'readBytes' || req.method === 'resolveArtifactVersion') {
        const artifactId = req.method === 'readBytes' ? first : first.artifactId,
          versionRef = req.method === 'readBytes' ? (args[1] ?? 'current') : first.versionRef
        const { version, blobPath } = await store.resolveArtifactVersion(db, {
          artifactId,
          versionRef
        })
        if (!blobPath) throw new Error('Local artifact blob path is missing')
        result = {
          version,
          data: Buffer.from(
            req.method === 'readBytes' && (!args[1] || args[1] === 'current')
              ? await store.readArtifactBytes(db, artifactId)
              : readFileSync(blobPath)
          ).toString('base64')
        }
      } else if (req.method === 'seal') result = await seal(tabId, first)
      else {
        if (req.method === 'pruneArtifactVersions' && storage.hasBlobLeases())
          throw new Error('A chat backup is copying files; retry pruning when it finishes')
        const method = store[req.method as keyof typeof store]
        if (typeof method !== 'function') throw new Error('Unknown computer artifact method')
        result = await (method as (...args: unknown[]) => unknown).call(store, db, ...args)
      }
      if (!read) {
        // The full artifact can be reconstructed after a hub rollback; relay locators contain no names or bytes.
        const artifactIds =
          req.method === 'uploadArtifactBlob'
            ? [String((result as { id: string }).id)]
            : req.method === 'updateArtifact'
              ? [first.id]
              : req.method === 'reorderArtifacts'
                ? Array.isArray(first)
                  ? first
                  : first.artifactIds
                : first?.artifactId
                  ? [first.artifactId]
                  : []
        for (const id of artifactIds) {
          const a = await store.getArtifact(db, id)
          if (!a) continue
          const v = await store.getCurrentArtifactVersion(db, { artifactId: a.id })
          if (v) {
            const path = blobs.blobPath(v.content_hash)
            if (existsSync(path)) {
              const fd = openSync(path, 'r')
              try {
                fsyncSync(fd)
              } finally {
                closeSync(fd)
              }
            }
          }
          local.metadata(tabId, 'artifact-changed', {
            id: a.id,
            folderId: a.folder_id,
            order: a.order
          })
        }
        if (
          ['createFolder', 'getOrCreateFolderByName', 'updateFolder'].includes(req.method) &&
          result &&
          (await db.get("SELECT 1 FROM artifact_owners WHERE id=? AND kind='folder'", [
            (result as { id: string }).id
          ]))
        ) {
          const f = result as { id: string; parent_id: string | null; order: number }
          local.metadata(tabId, 'folder-changed', {
            id: f.id,
            parentId: f.parent_id,
            order: f.order
          })
        }
        if (req.method === 'deleteArtifact')
          local.metadata(tabId, 'artifact-deleted', { id: first })
        if (req.method === 'deleteFolder') local.metadata(tabId, 'folder-deleted', { id: first })
        storage.completeCommand(
          owner.identity.id,
          req.route.epoch,
          req.operationId!,
          result ?? null
        )
      }
      return result
    })
  }
  return {
    invoke,
    seal,
    store,
    db,
    collectGarbage() {
      return storage.transaction(() => {
        if (storage.hasBlobLeases()) return 0
        let removed = 0
        const hashes = storage.compose(
          (raw) =>
            new Set(
              (
                raw.prepare('SELECT DISTINCT content_hash FROM artifact_versions').all() as {
                  content_hash: string
                }[]
              ).map((r) => r.content_hash)
            )
        )
        for (const hash of blobs.listAllHashes())
          if (!hashes.has(hash) && blobs.delete(hash)) removed++
        return removed
      })
    },
    async metadata(id: string) {
      const snapshot = local.metadataSnapshot(id),
        i = snapshot.identity,
        updates: import('./local-data').ChatMetadataUpdate[] = []
      const add = (kind: 'artifact-changed' | 'folder-changed', key: string, value: unknown) =>
        updates.push({
          operationId: `snapshot:${id}:${key}`,
          sequence: snapshot.counter,
          conversationId: id,
          taskId: i.taskId,
          tabId: i.tabId,
          epoch: i.epoch,
          kind,
          value
        })
      for (const a of await store.listArtifactsByTask(db, i.taskId))
        if (
          await db.get('SELECT 1 FROM artifact_owners WHERE id=? AND conversation_id=?', [a.id, id])
        )
          add('artifact-changed', a.id, { id: a.id, folderId: a.folder_id, order: a.order })
      for (const f of await store.listFoldersByTask(db, i.taskId))
        if (
          await db.get(
            "SELECT 1 FROM artifact_owners WHERE id=? AND conversation_id=? AND kind='folder'",
            [f.id, id]
          )
        )
          add('folder-changed', f.id, { id: f.id, parentId: f.parent_id, order: f.order })
      updates.sort(
        (a, b) => Number(b.kind === 'folder-changed') - Number(a.kind === 'folder-changed')
      )
      return { ...snapshot, updates: [...snapshot.updates, ...updates] }
    }
  }
}
