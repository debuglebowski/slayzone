import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import type { SlayzoneDb } from '@slayzone/platform'
import {
  diffVersionContents,
  type ArtifactRangeReader,
  type ArtifactStore,
  type OpenArtifactReader
} from '@slayzone/task-artifacts/server'
import type { ArtifactReadSpec, ArtifactVersion, VersionRef } from '@slayzone/task-artifacts/shared'
import {
  BYTE_RANGE_MAX_CHUNK,
  type ByteRangePage,
  collectByteRanges,
  readByteRanges
} from '@slayzone/platform/bounded-reads'
import type { TaskArtifact, ArtifactFolder } from '@slayzone/task-contracts'
import type { HubChatOwnership, ChatComputerRequest } from '@slayzone/chat-runtime/hub'
import type { createComputerChatServices } from './computer-chat'
import { withUploadedBytes } from './computer-uploads'

const reads = new Set([
  'listArtifactsByTask',
  'getArtifact',
  'readArtifactContent',
  'readArtifactText',
  'getArtifactMtime',
  'listArtifactVersions',
  'readArtifactVersion',
  'resolveArtifactVersion',
  'getCurrentArtifactVersion',
  'diffArtifactVersions',
  'listFoldersByTask',
  'readBytes',
  'readBytesRange',
  'readRange',
  'searchArtifacts'
])

/** One range of a computer-held artifact (`readRange`); a version's row rides on range 0. */
type ArtifactRangePage = ByteRangePage & { version?: ArtifactVersion; missing?: true }

const sha256 = () => {
  const h = createHash('sha256')
  return {
    update: (b: Uint8Array) => {
      h.update(b)
    },
    digest: () => h.digest('hex')
  }
}
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
  /** Whether a computer answers bounded reads (`readRange`); absent/false = whole reads. */
  boundedReads?: (computerId: string) => boolean
}): ArtifactStore {
  const { db, local, chat } = opts
  /**
   * Decision 4: an entry its computer no longer holds (restored from an older
   * backup) keeps its hub row, marked on its location. It stays listed and
   * deletable, never a target for content.
   */
  async function isUnavailable(id: string, folder: boolean) {
    return !!(await db.get(
      folder
        ? 'SELECT 1 FROM chat_folder_locations WHERE folder_id=? AND unavailable_reason IS NOT NULL'
        : 'SELECT 1 FROM chat_artifact_locations WHERE artifact_id=? AND unavailable_reason IS NOT NULL',
      [id]
    ))
  }
  const unavailableError = (folder: boolean) =>
    new Error(
      `${folder ? 'Folder' : 'File'} is unavailable on its computer (the computer was restored from an older backup)`
    )
  async function assertFolderResolved(id: string | null | undefined, allowUnavailable = false) {
    if (id && (await db.get('SELECT 1 FROM chat_folder_placeholders WHERE folder_id=?', [id])))
      throw new Error('Folder unavailable until its owning computer reconnects')
    if (id && !allowUnavailable && (await isUnavailable(id, true))) throw unavailableError(true)
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
    if (!read)
      await chat.relay.drainMetadata(current.computerId!, false, undefined, undefined, current.id)
    return result
  }
  /**
   * `spec`'s bytes of a computer-held artifact, range by range (`readRange`, ≤ 256 KiB
   * each). Range 0 is read first (size, version row, errors as the whole read's);
   * the bytes are verified against the content hash when the etag is one.
   */
  async function openRanges(
    owner: HubChatOwnership,
    artifactId: string,
    spec: ArtifactReadSpec
  ): Promise<ArtifactRangeReader> {
    const read = (offset: number, length: number) =>
      call(owner, 'readRange', [artifactId, spec, offset, length]) as Promise<ArtifactRangePage>
    const first = await read(0, BYTE_RANGE_MAX_CHUNK)
    let firstServed = false
    const fetch = (offset: number, length: number) => {
      if (offset === 0 && !firstServed) {
        firstServed = true
        return Promise.resolve(first)
      }
      return read(offset, length)
    }
    return {
      size: first.size,
      version: first.version,
      missing: first.missing === true,
      chunks: readByteRanges(fetch, { sha256: { expect: 'etag', create: sha256 } })
    }
  }
  async function collectRanges(
    owner: HubChatOwnership,
    artifactId: string,
    spec: ArtifactReadSpec
  ) {
    const reader = await openRanges(owner, artifactId, spec)
    const parts: Uint8Array[] = []
    for await (const part of reader.chunks) parts.push(part)
    return { ...reader, bytes: Buffer.concat(parts) }
  }
  /** The same reader, its first range already read (the diff peeks at both version rows). */
  async function collectRest(reader: ArtifactRangeReader) {
    const parts: Uint8Array[] = []
    for await (const part of reader.chunks) parts.push(part)
    return Buffer.concat(parts)
  }
  const specOfRef = (versionRef: VersionRef | undefined): ArtifactReadSpec =>
    versionRef === undefined || versionRef === 'current'
      ? { kind: 'bytes' }
      : { kind: 'version', ref: versionRef }
  /** The ranged reads of a computer that answers them; null = use the whole reads. */
  async function rangedRead(
    owner: HubChatOwnership,
    key: string,
    id: string,
    // biome-ignore lint/suspicious/noExplicitAny: the store method's own arguments.
    args: any[]
  ): Promise<{ result: unknown } | null> {
    if (!opts.boundedReads?.(owner.computerId!)) return null
    const first = args[0]
    switch (key) {
      case 'readArtifactBytes':
        return { result: (await collectRanges(owner, id, specOfRef(args[1]))).bytes }
      case 'getArtifactPath': {
        const [a, read] = await Promise.all([
          call(owner, 'getArtifact', [id]) as Promise<TaskArtifact>,
          collectRanges(owner, id, { kind: 'bytes' })
        ])
        return {
          result: `data:${mimeOf(a.title)};name=${encodeURIComponent(a.title)};base64,${read.bytes.toString('base64')}`
        }
      }
      case 'resolveArtifactVersion': {
        const read = await collectRanges(owner, id, { kind: 'version', ref: first.versionRef })
        return { result: { version: read.version, blobPath: null, bytes: read.bytes } }
      }
      case 'readArtifactContent': {
        const read = await collectRanges(owner, id, { kind: 'content' })
        return { result: read.missing ? null : read.bytes.toString('utf-8') }
      }
      case 'readArtifactVersion': {
        const read = await collectRanges(owner, id, { kind: 'version', ref: first.versionRef })
        return { result: read.bytes.toString('utf-8') }
      }
      case 'diffArtifactVersions': {
        // As the computer's diff: side a, then b (or the current version); equal
        // contents are an empty diff without reading either.
        const a = await openRanges(owner, id, { kind: 'version', ref: first.a })
        const b = await openRanges(
          owner,
          id,
          first.b !== undefined ? { kind: 'version', ref: first.b } : { kind: 'currentVersion' }
        )
        if (!a.version || !b.version) throw new Error('Artifact version row missing from its range')
        if (a.version.content_hash === b.version.content_hash)
          return { result: { kind: 'text', hunks: [] } }
        return {
          result: diffVersionContents(
            a.version,
            b.version,
            await collectRest(a),
            await collectRest(b)
          )
        }
      }
      default:
        return null
    }
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
    const locators = await db.all<{
      id: string
      conversation_id: string
      computer_id: string
      unavailable_reason: string | null
    }>(
      `SELECT a.id,l.conversation_id,o.computer_id,l.unavailable_reason FROM ${folder ? 'artifact_folders' : 'task_artifacts'} a JOIN ${folder ? 'chat_folder_locations' : 'chat_artifact_locations'} l ON l.${folder ? 'folder_id' : 'artifact_id'}=a.id JOIN chat_ownership o ON o.id=l.conversation_id WHERE a.task_id=?`,
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
        const missing = new Set(
          locators
            .filter((l) => l.computer_id === computerId && l.unavailable_reason !== null)
            .map((l) => l.id)
        )
        result.push(
          ...remote
            .filter((r) => ids.has(r.id) && !missing.has(r.id))
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
            }),
          // Known to the hub, no longer held by its computer: listed, never gone.
          ...rows
            .filter((row) => missing.has(row.id))
            .map((row) => ({
              ...row,
              ...(folder
                ? { name: 'Chat files · unavailable on computer' }
                : { title: 'Chat attachment · unavailable on computer' }),
              storage: { computerId, available: false }
            }))
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
    const pc = owner.computerId!
    return withUploadedBytes(
      {
        computerId: pc,
        bounded: opts.boundedReads?.(pc) === true,
        send: (body) => chat.lifecycle.request(pc, body as never),
        source: data.bytes,
        owner: { route: { id: owner.id, epoch: owner.epoch }, operationId }
      },
      (bytes) =>
        call(
          owner,
          'uploadArtifactBlob',
          [
            {
              taskId: data.taskId,
              title: data.title,
              folderId,
              // Staged in chunks to a computer that takes them, else inline (FU1 S3).
              ...bytes
            }
          ],
          operationId
        )
    ) as Promise<TaskArtifact | null>
  }
  /**
   * Moves entries to another task, keeping their ids. The hub's rows move first
   * (canonical rows and the mirrors of computer-held entries); then every
   * computer holding some of them re-owns its copies under the destination
   * task. Each step skips what is already moved, so a retry completes a partial
   * move; until then a computer's own report keeps the hub truthful.
   */
  async function move(data: Parameters<ArtifactStore['moveArtifacts']>[1]) {
    await assertFolderResolved(data.destFolderId)
    for (const id of data.folderIds) await assertFolderResolved(id)
    if (!(await db.get('SELECT 1 FROM tasks WHERE id=?', [data.destTaskId])))
      throw new Error('Destination task not found')
    // Every entry the move touches, as the hub sees them now.
    const folders = await db.all<{ id: string }>(
      `WITH RECURSIVE tree(id) AS (
        SELECT id FROM artifact_folders WHERE task_id=? AND id IN (SELECT value FROM json_each(?))
        UNION SELECT f.id FROM artifact_folders f JOIN tree ON f.parent_id=tree.id WHERE f.task_id=?
      ) SELECT id FROM tree`,
      [data.sourceTaskId, JSON.stringify(data.folderIds), data.sourceTaskId]
    )
    const folderIds = folders.map((f) => f.id)
    const held = await db.all<{ computer_id: string }>(
      `SELECT DISTINCT o.computer_id FROM chat_artifact_locations l
        JOIN chat_ownership o ON o.id=l.conversation_id
        JOIN task_artifacts a ON a.id=l.artifact_id
        WHERE o.computer_id IS NOT NULL AND (a.id IN (SELECT value FROM json_each(?)) OR a.folder_id IN (SELECT value FROM json_each(?)))
      UNION SELECT DISTINCT o.computer_id FROM chat_folder_locations l
        JOIN chat_ownership o ON o.id=l.conversation_id
        WHERE o.computer_id IS NOT NULL AND l.folder_id IN (SELECT value FROM json_each(?))`,
      [JSON.stringify(data.artifactIds), JSON.stringify(folderIds), JSON.stringify(folderIds)]
    )
    // Reach every holding computer BEFORE the hub commits: an offline one
    // refuses the move instead of leaving it half applied.
    const targets: HubChatOwnership[] = []
    for (const { computer_id } of held) {
      const owner = await chat.artifactOwner(data.destTaskId, computer_id)
      if (data.destFolderId) await ensureFolder(owner, data.destFolderId)
      targets.push(owner)
    }
    const result = await local.moveArtifacts(db, data)
    for (const owner of targets)
      await call(owner, 'moveToTask', [
        {
          sourceTaskId: data.sourceTaskId,
          artifactIds: data.artifactIds,
          folderIds: data.folderIds,
          destFolderId: data.destFolderId
        }
      ])
    return result
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
      if (key === 'openArtifactReader') {
        const open: OpenArtifactReader = async (_db, artifactId, spec) => {
          const owner = await location(artifactId)
          if (!owner || (await isUnavailable(artifactId, false))) return null
          if (!opts.boundedReads?.(owner.computerId!)) return null
          return openRanges(owner, artifactId, spec)
        }
        return open
      }
      if (key === 'listArtifactsByTask') return (_db: SlayzoneDb, taskId: string) => list(taskId)
      if (key === 'listFoldersByTask')
        return (_db: SlayzoneDb, taskId: string) => list(taskId, true)
      if (key === 'uploadArtifactBlob')
        return (_db: SlayzoneDb, data: Parameters<ArtifactStore['uploadArtifactBlob']>[1]) =>
          upload(data)
      if (key === 'deleteFolder')
        return async (_db: SlayzoneDb, id: string) => {
          await assertFolderResolved(id, true)
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
      if (key === 'moveArtifacts')
        return (_db: SlayzoneDb, data: Parameters<ArtifactStore['moveArtifacts']>[1]) => move(data)
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
      if (key === 'createArtifact' || key === 'createArtifactFromStagedFile') {
        // `stagedPath`: only through createArtifactFromStagedFile, a file the hub
        // staged itself (the REST create route) — never a client-named one (P1).
        const create = async (
          data: Parameters<ArtifactStore['createArtifact']>[1],
          stagedPath?: string
        ) => {
          if (!data.folderId || !(await location(data.folderId, true)))
            return stagedPath === undefined
              ? local.createArtifact(db, data)
              : local.createArtifactFromStagedFile(db, data, stagedPath)
          const a = await upload({
            taskId: data.taskId,
            title: data.title,
            folderId: data.folderId,
            bytes: stagedPath ? readFileSync(stagedPath) : Buffer.from(data.content ?? '')
          })
          if (a && (data.renderMode || data.language))
            return (receiver as ArtifactStore).updateArtifact(db, {
              id: a.id,
              renderMode: data.renderMode,
              language: data.language
            })
          return a
        }
        return key === 'createArtifact'
          ? (_db: SlayzoneDb, data: Parameters<ArtifactStore['createArtifact']>[1]) => create(data)
          : (
              _db: SlayzoneDb,
              data: Parameters<ArtifactStore['createArtifact']>[1],
              stagedPath: string
            ) => create(data, stagedPath)
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
        const isFolder = key === 'updateFolder' || key === 'deleteFolder'
        const owner = await location(id, isFolder)
        if (!owner) return base.apply(target, [db, ...args])
        if (await isUnavailable(id, isFolder)) {
          // Only the hub's row is left: it can be read and removed.
          if (key === 'getArtifact') {
            const row = await base.apply(target, [db, ...args])
            return row
              ? { ...row, storage: { computerId: owner.computerId!, available: false } }
              : row
          }
          if (key === 'deleteArtifact') return base.apply(target, [db, ...args])
          throw unavailableError(isFolder)
        }
        if (key === 'readArtifactBytesRange') {
          // The computer reads only this window (computer protocol v9: every computer
          // this hub accepts has `readBytesRange`). Its errors surface as they are.
          const r = (await call(owner, 'readBytesRange', args)) as {
            data: string
            size: number
            version: string
          } | null
          return r
            ? { bytes: Buffer.from(r.data, 'base64'), size: r.size, version: r.version }
            : null
        }
        const ranged = await rangedRead(owner, key, id, args)
        if (ranged) return ranged.result
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
          const pc = owner.computerId!
          const operationId = randomUUID()
          return withUploadedBytes(
            {
              computerId: pc,
              bounded: opts.boundedReads?.(pc) === true,
              send: (body) => chat.lifecycle.request(pc, body as never),
              source: first.bytes ?? { path: first.sourcePath },
              owner: { route: { id: owner.id, epoch: owner.epoch }, operationId }
            },
            (bytes) =>
              call(
                owner,
                'writeArtifactContent',
                [
                  {
                    ...first,
                    sourcePath: undefined,
                    bytes: undefined,
                    // A file is staged range by range, never read whole (FU1 S3).
                    ...bytes
                  }
                ],
                operationId
              )
          )
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
