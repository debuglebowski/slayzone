import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import type { SlayzoneDb } from '@slayzone/platform'
import type { ArtifactStore } from '@slayzone/task-artifacts/server'
import type { TaskArtifact, ArtifactFolder } from '@slayzone/task-contracts'
import type { HubChatOwnership, ChatComputerRequest } from '@slayzone/chat-runtime/hub'
import type { createComputerChatServices } from './computer-chat'

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
const mimeOf = (title: string) =>
  ({
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain',
    '.md': 'text/markdown'
  })[extname(title).toLowerCase()] ?? 'application/octet-stream'
const modifiedAt = (value?: string) => {
  const normalized = value?.replace(' ', 'T') ?? ''
  const parsed = Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(normalized) ? normalized : `${normalized}Z`)
  return Number.isNaN(parsed) ? -Infinity : parsed
}

/** One artifact API; each ID stays on the store that created it. No file cache on hub. */
export function createComputerArtifactStorage(opts: {
  db: SlayzoneDb
  local: ArtifactStore
  chat: ReturnType<typeof createComputerChatServices>
  request: ChatComputerRequest
}): ArtifactStore {
  const { db, local, chat } = opts
  async function assertFolderResolved(id: string | null | undefined) {
    if (id && (await db.get('SELECT 1 FROM chat_folder_placeholders WHERE folder_id=?', [id])))
      throw new Error('Folder unavailable until its owning computer reconnects')
  }
  async function location(id: string, folder = false) {
    if (folder) await assertFolderResolved(id)
    const row = await db.get<{ conversation_id: string }>(
      `SELECT conversation_id FROM ${folder ? 'chat_folder_locations' : 'chat_artifact_locations'} WHERE ${folder ? 'folder_id' : 'artifact_id'}=?`,
      [id]
    )
    if (!row) return null
    const owner = await chat.ownership.get(row.conversation_id)
    if (!owner) throw new Error('Artifact owner is unavailable')
    return owner
  }
  async function call(
    owner: HubChatOwnership,
    method: string,
    args: unknown[],
    operationId?: string
  ) {
    const current = await chat.relay.ensureTab(owner.tabId)
    if (current.taskId !== owner.taskId || current.computerId !== owner.computerId)
      throw new Error('Artifact ownership changed')
    const folderId =
      (args[0] as { folderId?: string | null; parentId?: string | null } | undefined)?.folderId ??
      (args[0] as { parentId?: string | null } | undefined)?.parentId
    if (folderId && method !== 'importFolder') await ensureFolder(current, folderId)
    const read = reads.has(method)
    const result = await chat.lifecycle.request(current.computerId!, {
      kind: 'artifact.invoke',
      value: {
        route: { id: current.id, epoch: current.epoch },
        method,
        args,
        ...(!read ? { operationId: operationId ?? randomUUID() } : {})
      }
    })
    if (!read) await chat.relay.drainMetadata(current.computerId!)
    return result
  }
  async function ensureFolder(owner: HubChatOwnership, id: string): Promise<void> {
    await assertFolderResolved(id)
    const folder = await db.get<{
      id: string
      task_id: string
      name: string
      parent_id: string | null
    }>('SELECT * FROM artifact_folders WHERE id=?', [id])
    if (!folder || folder.task_id !== owner.taskId)
      throw new Error('Destination folder belongs to another task')
    const original = await location(id, true)
    if (original?.computerId === owner.computerId) return
    if (folder.parent_id) await ensureFolder(owner, folder.parent_id)
    await call(owner, 'importFolder', [
      { id, taskId: owner.taskId, name: folder.name, parentId: folder.parent_id }
    ])
  }
  async function list(taskId: string, folder = false) {
    const rows = folder
      ? await local.listFoldersByTask(db, taskId)
      : await local.listArtifactsByTask(db, taskId)
    const locators = await db.all<{ id: string; conversation_id: string; computer_id: string }>(
      `SELECT a.id,l.conversation_id,o.computer_id FROM ${folder ? 'artifact_folders' : 'task_artifacts'} a JOIN ${folder ? 'chat_folder_locations' : 'chat_artifact_locations'} l ON l.${folder ? 'folder_id' : 'artifact_id'}=a.id JOIN chat_ownership o ON o.id=l.conversation_id WHERE a.task_id=?`,
      [taskId]
    )
    const ids = new Set(locators.map((r) => r.id)),
      computers = new Map(locators.map((r) => [r.computer_id, r.conversation_id]))
    const unresolved = new Set(
      folder
        ? (
            await db.all<{ folder_id: string }>(
              'SELECT folder_id FROM chat_folder_placeholders WHERE task_id=?',
              [taskId]
            )
          ).map((row) => row.folder_id)
        : []
    )
    const result = rows
      .filter((r) => !ids.has(r.id))
      .map((row) =>
        'parent_id' in row && unresolved.has(row.id)
          ? {
              ...row,
              name: 'Chat files · awaiting computer',
              storage: { computerId: null, available: false }
            }
          : row
      )
    for (const [computerId, conversationId] of computers) {
      const owner = await chat.ownership.get(conversationId)
      if (!owner) continue
      try {
        const remote = (await call(owner, folder ? 'listFoldersByTask' : 'listArtifactsByTask', [
          taskId
        ])) as typeof result
        const canonical = new Map(rows.map((row) => [row.id, row]))
        result.push(
          ...remote
            .filter((r) => ids.has(r.id))
            .map((r) => {
              const row = canonical.get(r.id)!
              return {
                ...r,
                order: row.order,
                ...('parent_id' in row
                  ? { parent_id: row.parent_id }
                  : { folder_id: row.folder_id }),
                storage: { computerId, available: true }
              }
            })
        )
      } catch {
        for (const row of rows.filter(
          (r) =>
            ids.has(r.id) && locators.some((l) => l.id === r.id && l.computer_id === computerId)
        ))
          result.push({
            ...row,
            ...(folder
              ? { name: 'Chat files · computer unavailable' }
              : { title: 'Chat attachment · computer unavailable' }),
            storage: { computerId, available: false }
          })
      }
    }
    return result.sort((a, b) => a.order - b.order || a.created_at.localeCompare(b.created_at))
  }
  async function upload(
    data: Parameters<ArtifactStore['uploadArtifactBlob']>[1],
    useDefaultFolder = true
  ) {
    await assertFolderResolved(data.folderId)
    let owner = data.chatTabId
      ? await chat.relay.ensureTab(data.chatTabId)
      : data.folderId
        ? await location(data.folderId, true)
        : null
    if (!owner) return local.uploadArtifactBlob(db, data)
    if (data.chatTabId) owner = await chat.artifactOwner(data.taskId, owner.computerId!)
    if (owner.taskId !== data.taskId) throw new Error('Upload chat tab belongs to another task')
    const operationId = data.operationId ?? randomUUID()
    let folderId = data.folderId
    if (!folderId && useDefaultFolder) {
      const folder = (await call(
        owner,
        'getOrCreateFolderByName',
        [{ taskId: data.taskId, name: 'Uploads' }],
        `${operationId}:folder`
      )) as ArtifactFolder
      folderId = folder.id
    }
    return call(
      owner,
      'uploadArtifactBlob',
      [
        {
          taskId: data.taskId,
          title: data.title,
          folderId,
          data: Buffer.from(data.bytes).toString('base64')
        }
      ],
      operationId
    ) as Promise<TaskArtifact | null>
  }
  const passthrough = new Set([
    'artifactsDir',
    'getArtifactFilePath',
    'cleanupTaskArtifacts',
    'uploadArtifact',
    'pasteArtifactFiles',
    'uploadArtifactDir',
    'getOrCreateFolderByName',
    'createFolder'
  ])
  return new Proxy(local, {
    get(target, key, receiver) {
      if (typeof key !== 'string') return Reflect.get(target, key, receiver)
      if (key === 'listArtifactsByTask') return (_db: SlayzoneDb, taskId: string) => list(taskId)
      if (key === 'listFoldersByTask')
        return (_db: SlayzoneDb, taskId: string) => list(taskId, true)
      if (key === 'uploadArtifactBlob')
        return (_db: SlayzoneDb, data: Parameters<ArtifactStore['uploadArtifactBlob']>[1]) =>
          upload(data)
      if (key === 'deleteFolder')
        return async (_db: SlayzoneDb, id: string) => {
          await assertFolderResolved(id)
          const folder = await db.get<{ task_id: string }>(
            'SELECT task_id FROM artifact_folders WHERE id=?',
            [id]
          )
          if (!folder) return false
          await chat.folderDeletions.record(folder.task_id, [id])
          // Acceptance is durable even when a computer is offline. Reconnect retries delivery.
          for (const row of await db.all<{ computer_id: string }>(
            'SELECT computer_id FROM chat_task_computers WHERE task_id=?',
            [folder.task_id]
          ))
            void chat.lifecycle.sync(row.computer_id).catch(() => {
              // Durable intent remains pending for the next tick/reconnect.
            })
          return true
        }
      if (key === 'copyArtifacts')
        return async (_db: SlayzoneDb, data: Parameters<ArtifactStore['copyArtifacts']>[1]) => {
          await assertFolderResolved(data.destFolderId)
          const result: TaskArtifact[] = []
          for (const id of data.artifactIds) {
            const source = await location(id),
              a = await (receiver as ArtifactStore).getArtifact(db, id)
            if (!a) throw new Error('Artifact not found')
            const bytes = await (receiver as ArtifactStore).readArtifactBytes(db, id)
            if (source) {
              const target = await chat.artifactOwner(data.destTaskId)
              const copy = await upload(
                {
                  taskId: data.destTaskId,
                  title: a.title,
                  bytes,
                  folderId: data.destFolderId,
                  chatTabId: target.tabId
                },
                false
              )
              if (copy) result.push(copy)
            } else {
              const copy = await (receiver as ArtifactStore).uploadArtifactBlob(db, {
                taskId: data.destTaskId,
                title: a.title,
                bytes,
                folderId: data.destFolderId
              })
              if (copy) result.push(copy)
            }
          }
          return result
        }
      if (key === 'createFolder')
        return async (_db: SlayzoneDb, data: Parameters<ArtifactStore['createFolder']>[1]) => {
          const owner = data.parentId ? await location(data.parentId, true) : null
          return owner ? call(owner, 'createFolder', [data]) : local.createFolder(db, data)
        }
      if (key === 'createArtifact')
        return async (_db: SlayzoneDb, data: Parameters<ArtifactStore['createArtifact']>[1]) => {
          if (!data.folderId || !(await location(data.folderId, true)))
            return local.createArtifact(db, data)
          const a = await upload({
            taskId: data.taskId,
            title: data.title,
            folderId: data.folderId,
            bytes: data.sourcePath ? readFileSync(data.sourcePath) : Buffer.from(data.content ?? '')
          })
          if (a && (data.renderMode || data.language))
            return (receiver as ArtifactStore).updateArtifact(db, {
              id: a.id,
              renderMode: data.renderMode,
              language: data.language
            })
          return a
        }
      if (key === 'reorderArtifacts' || key === 'reorderFolders')
        return async (
          _db: SlayzoneDb,
          data: string[] | { artifactIds?: string[]; folderIds?: string[] }
        ) => {
          const ids: string[] = Array.isArray(data)
            ? data
            : key === 'reorderFolders'
              ? (data.folderIds ?? [])
              : (data.artifactIds ?? [])
          const groups = new Map<string, { owner: HubChatOwnership; ids: string[] }>(),
            localIds: string[] = []
          for (const id of ids) {
            const owner = await location(id, key === 'reorderFolders')
            if (owner) {
              const group = groups.get(owner.id) ?? { owner, ids: [] }
              group.ids.push(id)
              groups.set(owner.id, group)
            } else localIds.push(id)
          }
          if (localIds.length)
            await db.batchTxn(
              localIds.map((id) => ({
                type: 'run',
                sql: `UPDATE ${key === 'reorderFolders' ? 'artifact_folders' : 'task_artifacts'} SET "order"=? WHERE id=?`,
                params: [ids.indexOf(id), id]
              }))
            )
          for (const { owner, ids: remoteIds } of groups.values())
            await call(owner, 'reorderEntries', [
              {
                kind: key === 'reorderFolders' ? 'folder' : 'artifact',
                entries: remoteIds.map((id) => ({ id, order: ids.indexOf(id) }))
              }
            ])
        }
      if (key === 'searchArtifacts')
        return async (_db: SlayzoneDb, data: Parameters<ArtifactStore['searchArtifacts']>[1]) => {
          const remoteIds = new Set(
            (
              await db.all<{ artifact_id: string }>(
                'SELECT artifact_id FROM chat_artifact_locations'
              )
            ).map((r) => r.artifact_id)
          )
          const report = await local.searchArtifacts(db, {
            ...data,
            excludeArtifactIds: [...remoteIds]
          })
          const tasks = await db.all<{ task_id: string }>(
            data.taskId
              ? 'SELECT DISTINCT task_id FROM task_artifacts WHERE task_id=?'
              : 'SELECT DISTINCT task_id FROM task_artifacts',
            [...(data.taskId ? [data.taskId] : [])]
          )
          for (const { task_id: taskId } of tasks) {
            if (
              data.projectIds &&
              !(await db.get(
                `SELECT 1 FROM tasks WHERE id=? AND project_id IN (${data.projectIds.map(() => '?').join(',')})`,
                [taskId, ...data.projectIds]
              ))
            )
              continue
            const pcs = await db.all<{ conversation_id: string }>(
              `SELECT MIN(l.conversation_id) AS conversation_id FROM chat_artifact_locations l JOIN task_artifacts a ON a.id=l.artifact_id JOIN chat_ownership o ON o.id=l.conversation_id WHERE a.task_id=? GROUP BY o.computer_id`,
              [taskId]
            )
            for (const { conversation_id } of pcs) {
              const owner = await chat.ownership.get(conversation_id)
              if (!owner) continue
              const remote = (await call(owner, 'searchArtifacts', [
                { ...data, projectIds: undefined, taskId }
              ])) as typeof report
              report.results.push(...remote.results)
              report.skippedLarge.push(...remote.skippedLarge)
              report.scannedCount += remote.scannedCount
              report.truncated ||= remote.truncated
            }
          }
          const unique = [...new Map(report.results.map((r) => [r.artifactId, r])).values()]
          unique.sort(
            (a, b) =>
              modifiedAt(b.updatedAt) - modifiedAt(a.updatedAt) ||
              a.artifactId.localeCompare(b.artifactId)
          )
          const limit = data.limit ?? 50
          report.truncated ||= unique.length > limit
          report.results = unique.slice(0, limit)
          return report
        }
      if (passthrough.has(key)) {
        const value = Reflect.get(target, key, receiver)
        if (
          typeof value === 'function' &&
          (key === 'pasteArtifactFiles' || key === 'uploadArtifactDir')
        )
          return async (
            _db: SlayzoneDb,
            data: { destFolderId?: string | null; parentFolderId?: string | null }
          ) => {
            await assertFolderResolved(data.destFolderId ?? data.parentFolderId)
            return value.call(target, db, data)
          }
        if (key === 'getOrCreateFolderByName')
          return async (_db: SlayzoneDb, data: { taskId: string; name: string }) => {
            const existing = await db.get<{ id: string }>(
              'SELECT id FROM artifact_folders WHERE task_id=? AND name=? AND parent_id IS NULL',
              [data.taskId, data.name]
            )
            if (existing) await assertFolderResolved(existing.id)
            return value.call(target, db, data)
          }
        return typeof value === 'function' ? value.bind(target) : value
      }
      const base = Reflect.get(target, key, receiver)
      if (typeof base !== 'function') return base
      // biome-ignore lint/suspicious/noExplicitAny: Heterogeneous ArtifactStore tuples are validated by the computer method schemas.
      return async (_db: SlayzoneDb, ...args: any[]) => {
        const first = args[0],
          id = typeof first === 'string' ? first : (first?.artifactId ?? first?.id)
        if (first && typeof first === 'object')
          await assertFolderResolved(first.folderId ?? first.parentId)
        if (!id) return base.apply(target, [db, ...args])
        const owner = await location(id, key === 'updateFolder' || key === 'deleteFolder')
        if (!owner) return base.apply(target, [db, ...args])
        if (key === 'readArtifactBytes') {
          const result = (await call(owner, 'readBytes', args)) as { data: string }
          return Buffer.from(result.data, 'base64')
        }
        if (key === 'getArtifactPath') {
          const [a, bytes] = (await Promise.all([
            call(owner, 'getArtifact', [id]),
            call(owner, 'readBytes', [id])
          ])) as [TaskArtifact, { data: string }]
          return `data:${mimeOf(a.title)};name=${encodeURIComponent(a.title)};base64,${bytes.data}`
        }
        if (key === 'resolveArtifactVersion') {
          const result = (await call(owner, key, args)) as { version: unknown; data: string }
          return {
            version: result.version,
            blobPath: null,
            bytes: Buffer.from(result.data, 'base64')
          }
        }
        if (key === 'writeArtifactContent') {
          return call(owner, 'writeArtifactContent', [
            {
              ...first,
              sourcePath: undefined,
              bytes: undefined,
              data: Buffer.from(first.bytes ?? readFileSync(first.sourcePath)).toString('base64')
            }
          ])
        }
        const result = await call(owner, key, args)
        return key === 'getArtifact' && result
          ? {
              ...(result as TaskArtifact),
              storage: { computerId: owner.computerId!, available: true }
            }
          : result
      }
    }
  })
}
