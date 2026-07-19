import path from 'node:path'
import { existsSync, readFileSync, unlinkSync, rmSync, statSync } from 'node:fs'
import type { SlayzoneDb } from '@slayzone/platform'
import type {
  CreateArtifactInput,
  UpdateArtifactInput,
  TaskArtifact,
  RenderMode,
  ArtifactFolder,
  CreateArtifactFolderInput,
  UpdateArtifactFolderInput
} from '@slayzone/task/shared'
import { getExtensionFromTitle } from '@slayzone/task/shared'
import type {
  VersionRef,
  ArtifactVersion,
  DiffResult,
  PruneReport
} from '@slayzone/task-artifacts/shared'

// Electron-free artifact store. Single implementation behind both the IPC handlers
// (../main/handlers.ts) and the tRPC `artifacts` router. Disk reads + the worker
// `namedTxn` calls live here; callers add their own post-mutation notification
// (`onMutation` for IPC). `dataDir` is the app data root (env `SLAYZONE_STORE_DIR` /
// `app.getPath('userData')` for IPC, `ctx.dataRoot` for tRPC — aligned via
// `app.setPath('userData', dataRoot)` at boot). The binary upload/download flows
// run here too (uploads are pure fs+worker; the Electron *dialog* orchestration
// stays in the IPC handlers / router, both reusing the tree helpers below).

export function parseArtifact(row: Record<string, unknown> | undefined): TaskArtifact | null {
  if (!row) return null
  return {
    id: row.id as string,
    task_id: row.task_id as string,
    folder_id: (row.folder_id as string) ?? null,
    title: row.title as string,
    render_mode: (row.render_mode as RenderMode) ?? null,
    view_mode: (row.view_mode as string) ?? null,
    readability_override: (row.readability_override as 'compact' | 'normal' | null) ?? null,
    width_override: (row.width_override as 'narrow' | 'wide' | null) ?? null,
    language: (row.language as string) ?? null,
    order: row.order as number,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    current_version_id: (row.current_version_id as string) ?? null
  }
}

export function parseFolder(row: Record<string, unknown> | undefined): ArtifactFolder | null {
  if (!row) return null
  return {
    id: row.id as string,
    task_id: row.task_id as string,
    parent_id: (row.parent_id as string) ?? null,
    name: row.name as string,
    order: row.order as number,
    created_at: row.created_at as string
  }
}

/** Build a folderId → relative-path resolver from a task's full folder list. */
export function buildFolderPathResolver(
  folders: Record<string, unknown>[]
): (id: string) => string {
  const byId = new Map(folders.map((f) => [f.id as string, f]))
  function folderPath(id: string): string {
    const f = byId.get(id)
    if (!f) return ''
    const parent = f.parent_id as string | null
    return parent ? path.join(folderPath(parent), f.name as string) : (f.name as string)
  }
  return folderPath
}

/** Collect a folder id plus all its (transitive) descendant folder ids. */
export function collectFolderAndDescendants(
  folders: Record<string, unknown>[],
  rootId: string
): Set<string> {
  const targetIds = new Set<string>([rootId])
  let changed = true
  while (changed) {
    changed = false
    for (const f of folders) {
      const id = f.id as string
      const parentId = f.parent_id as string | null
      if (parentId && targetIds.has(parentId) && !targetIds.has(id)) {
        targetIds.add(id)
        changed = true
      }
    }
  }
  return targetIds
}

export type ArtifactStore = ReturnType<typeof createArtifactStore>

export function createArtifactStore(dataDir: string) {
  const artifactsDir = path.join(dataDir, 'artifacts')

  function getArtifactFilePath(taskId: string, artifactId: string, title: string): string {
    const ext = getExtensionFromTitle(title) || '.txt'
    return path.join(artifactsDir, taskId, `${artifactId}${ext}`)
  }

  // Fallback to pre-v127 path for users where the boot-time disk migration silently
  // failed (permission/FS errors). Belt-and-suspenders — read on every miss, don't mutate.
  function getLegacyArtifactFilePath(taskId: string, artifactId: string, title: string): string {
    const ext = getExtensionFromTitle(title) || '.txt'
    return path.join(dataDir, 'assets', taskId, `${artifactId}${ext}`)
  }

  async function getRow(db: SlayzoneDb, id: string): Promise<Record<string, unknown> | undefined> {
    return (await db.prepare('SELECT * FROM task_artifacts WHERE id = ?').get(id)) as
      | Record<string, unknown>
      | undefined
  }

  return {
    artifactsDir,
    getArtifactFilePath,

    async listArtifactsByTask(db: SlayzoneDb, taskId: string): Promise<TaskArtifact[]> {
      const rows = (await db
        .prepare(
          'SELECT * FROM task_artifacts WHERE task_id = ? ORDER BY "order" ASC, created_at ASC'
        )
        .all(taskId)) as Record<string, unknown>[]
      return rows.map(parseArtifact).filter(Boolean) as TaskArtifact[]
    },

    async getArtifact(db: SlayzoneDb, id: string): Promise<TaskArtifact | null> {
      return parseArtifact(await getRow(db, id))
    },

    async createArtifact(db: SlayzoneDb, data: CreateArtifactInput): Promise<TaskArtifact | null> {
      const row = await db.namedTxn('task-artifacts:create', {
        dataDir,
        taskId: data.taskId,
        folderId: data.folderId ?? null,
        title: data.title,
        renderMode: data.renderMode ?? null,
        language: data.language ?? null,
        content: data.content ?? ''
      })
      return parseArtifact(row)
    },

    async updateArtifact(
      db: SlayzoneDb,
      data: UpdateArtifactInput & { mutateVersion?: boolean }
    ): Promise<TaskArtifact | null> {
      // Mirror the original `data.x !== undefined` checks: only forward keys the caller
      // actually provided so the worker rebuilds the same SET clause.
      const setKeys: string[] = []
      for (const key of [
        'title',
        'folderId',
        'renderMode',
        'viewMode',
        'readabilityOverride',
        'widthOverride',
        'language',
        'content'
      ] as const) {
        if (data[key] !== undefined) setKeys.push(key)
      }
      const row = await db.namedTxn(
        'task-artifacts:update',
        {
          dataDir,
          id: data.id,
          mutateVersion: data.mutateVersion,
          title: data.title,
          folderId: data.folderId,
          renderMode: data.renderMode,
          viewMode: data.viewMode,
          readabilityOverride: data.readabilityOverride,
          widthOverride: data.widthOverride,
          language: data.language,
          content: data.content,
          setKeys
        }
      )
      if (row === null) return null
      return parseArtifact(row ?? undefined)
    },

    async deleteArtifact(db: SlayzoneDb, id: string): Promise<boolean> {
      const existing = await getRow(db, id)
      if (!existing) return false
      const filePath = getArtifactFilePath(existing.task_id as string, id, existing.title as string)
      if (existsSync(filePath)) unlinkSync(filePath)
      await db.prepare('DELETE FROM task_artifacts WHERE id = ?').run(id)
      return true
    },

    async reorderArtifacts(
      db: SlayzoneDb,
      data: string[] | { folderId: string | null; artifactIds: string[] }
    ): Promise<void> {
      const artifactIds = Array.isArray(data) ? data : data.artifactIds
      await db.batchTxn(
        artifactIds.map((id, index) => ({
          type: 'run',
          sql: 'UPDATE task_artifacts SET "order" = ? WHERE id = ?',
          params: [index, id]
        }))
      )
    },

    async readArtifactContent(db: SlayzoneDb, id: string): Promise<string | null> {
      const existing = await getRow(db, id)
      if (!existing) return null
      const filePath = getArtifactFilePath(existing.task_id as string, id, existing.title as string)
      if (existsSync(filePath)) return readFileSync(filePath, 'utf-8')
      const legacyPath = getLegacyArtifactFilePath(
        existing.task_id as string,
        id,
        existing.title as string
      )
      if (existsSync(legacyPath)) return readFileSync(legacyPath, 'utf-8')
      // No working file on disk (e.g. artifacts created via `slay artifacts write`,
      // which only persists blobs — no materialized working copy). Fall back to the
      // CURRENT version's blob so content still loads. Returns '' only when the
      // artifact genuinely has no version yet.
      if (existing.current_version_id != null) {
        try {
          return await this.readArtifactVersion(db, { artifactId: id, versionRef: 'current' })
        } catch {
          return ''
        }
      }
      return ''
    },

    async getArtifactPath(db: SlayzoneDb, id: string): Promise<string | null> {
      const existing = await getRow(db, id)
      if (!existing) return null
      return getArtifactFilePath(existing.task_id as string, id, existing.title as string)
    },

    async getArtifactMtime(db: SlayzoneDb, id: string): Promise<number | null> {
      const existing = await getRow(db, id)
      if (!existing) return null
      const filePath = getArtifactFilePath(existing.task_id as string, id, existing.title as string)
      try {
        return statSync(filePath).mtimeMs
      } catch {
        return null
      }
    },

    async uploadArtifact(
      db: SlayzoneDb,
      data: { taskId: string; sourcePath: string; title?: string }
    ): Promise<TaskArtifact | null> {
      const row = await db.namedTxn('task-artifacts:upload', {
        dataDir,
        taskId: data.taskId,
        sourcePath: data.sourcePath,
        title: data.title ?? path.basename(data.sourcePath)
      })
      return parseArtifact(row)
    },

    async pasteArtifactFiles(
      db: SlayzoneDb,
      data: { sourcePaths: string[]; destTaskId: string; destFolderId: string | null }
    ): Promise<TaskArtifact[]> {
      const rows = await db.namedTxn('task-artifacts:pasteFiles', {
        dataDir,
        sourcePaths: data.sourcePaths,
        destTaskId: data.destTaskId,
        destFolderId: data.destFolderId
      })
      return rows.map(parseArtifact).filter(Boolean) as TaskArtifact[]
    },

    async uploadArtifactBlob(
      db: SlayzoneDb,
      data: { taskId: string; title: string; bytes: Uint8Array; folderId?: string | null }
    ): Promise<TaskArtifact | null> {
      const row = await db.namedTxn('task-artifacts:uploadBlob', {
        dataDir,
        taskId: data.taskId,
        title: data.title,
        bytes: data.bytes,
        folderId: data.folderId ?? null
      })
      return parseArtifact(row)
    },

    async uploadArtifactDir(
      db: SlayzoneDb,
      data: { taskId: string; dirPath: string; parentFolderId: string | null }
    ): Promise<{ folders: ArtifactFolder[]; artifacts: TaskArtifact[] }> {
      const result = await db.namedTxn('task-artifacts:uploadDir', {
        dataDir,
        taskId: data.taskId,
        dirPath: data.dirPath,
        parentFolderId: data.parentFolderId
      })
      return {
        folders: result.folders.map(parseFolder).filter(Boolean) as ArtifactFolder[],
        artifacts: result.artifacts.map(parseArtifact).filter(Boolean) as TaskArtifact[]
      }
    },

    cleanupTaskArtifacts(taskId: string): void {
      const taskDir = path.join(artifactsDir, taskId)
      if (existsSync(taskDir)) rmSync(taskDir, { recursive: true, force: true })
    },

    // --- Versions ---
    // The `@slayzone/task-artifacts` version helpers operate on a synchronous
    // better-sqlite3 db + `TxnRunner`, so they run inside the DB worker via `namedTxn`
    // (see ../main/artifacts-txns.ts). Each named txn re-formats `VersionError` into a
    // serializable `[CODE] message` string before crossing the worker boundary.

    listArtifactVersions(
      db: SlayzoneDb,
      data: { artifactId: string; limit?: number; offset?: number }
    ): Promise<ArtifactVersion[]> {
      // Worker DB boundary erases types (TxnResult registry not merged in this
      // compilation); assert the known row shape here so consumers stay typed.
      return db.namedTxn('task-artifacts:versions:list', {
        artifactId: data.artifactId,
        limit: data.limit,
        offset: data.offset
      }) as Promise<ArtifactVersion[]>
    },

    readArtifactVersion(
      db: SlayzoneDb,
      data: { artifactId: string; versionRef: VersionRef }
    ): Promise<string> {
      return db.namedTxn('task-artifacts:versions:read', {
        dataDir,
        artifactId: data.artifactId,
        versionRef: data.versionRef
      }) as Promise<string>
    },

    createArtifactVersion(
      db: SlayzoneDb,
      data: { artifactId: string; name?: string | null }
    ): Promise<ArtifactVersion> {
      return db.namedTxn('task-artifacts:versions:create', {
        dataDir,
        artifactId: data.artifactId,
        name: data.name ?? null
      }) as Promise<ArtifactVersion>
    },

    renameArtifactVersion(
      db: SlayzoneDb,
      data: { artifactId: string; versionRef: VersionRef; newName: string | null }
    ): Promise<ArtifactVersion> {
      return db.namedTxn('task-artifacts:versions:rename', {
        artifactId: data.artifactId,
        versionRef: data.versionRef,
        newName: data.newName
      }) as Promise<ArtifactVersion>
    },

    diffArtifactVersions(
      db: SlayzoneDb,
      data: { artifactId: string; a: VersionRef; b?: VersionRef }
    ): Promise<DiffResult> {
      return db.namedTxn('task-artifacts:versions:diff', {
        dataDir,
        artifactId: data.artifactId,
        a: data.a,
        b: data.b
      }) as Promise<DiffResult>
    },

    pruneArtifactVersions(
      db: SlayzoneDb,
      data: {
        artifactId: string
        keepLast?: number
        keepNamed?: boolean
        keepCurrent?: boolean
        dryRun?: boolean
      }
    ): Promise<PruneReport> {
      return db.namedTxn('task-artifacts:versions:prune', {
        dataDir,
        artifactId: data.artifactId,
        keepLast: data.keepLast,
        keepNamed: data.keepNamed,
        keepCurrent: data.keepCurrent,
        dryRun: data.dryRun
      }) as Promise<PruneReport>
    },

    async setCurrentArtifactVersion(
      db: SlayzoneDb,
      data: { artifactId: string; versionRef: VersionRef }
    ): Promise<ArtifactVersion> {
      // The worker switches the current pointer AND flushes the version's bytes back to
      // the artifact's on-disk file; it returns the version row.
      const result = (await db.namedTxn('task-artifacts:versions:setCurrent', {
        dataDir,
        artifactId: data.artifactId,
        versionRef: data.versionRef
      })) as { version: ArtifactVersion }
      return result.version
    },

    // --- Folders ---

    async listFoldersByTask(db: SlayzoneDb, taskId: string): Promise<ArtifactFolder[]> {
      const rows = (await db
        .prepare(
          'SELECT * FROM artifact_folders WHERE task_id = ? ORDER BY "order" ASC, created_at ASC'
        )
        .all(taskId)) as Record<string, unknown>[]
      return rows.map(parseFolder).filter(Boolean) as ArtifactFolder[]
    },

    async getOrCreateFolderByName(
      db: SlayzoneDb,
      data: { taskId: string; name: string }
    ): Promise<ArtifactFolder | null> {
      const row = await db.namedTxn(
        'task-artifacts:folders:getOrCreateByName',
        { taskId: data.taskId, name: data.name }
      )
      return parseFolder(row)
    },

    async createFolder(
      db: SlayzoneDb,
      data: CreateArtifactFolderInput
    ): Promise<ArtifactFolder | null> {
      const row = await db.namedTxn(
        'task-artifacts:folders:create',
        { taskId: data.taskId, parentId: data.parentId ?? null, name: data.name }
      )
      return parseFolder(row)
    },

    async updateFolder(
      db: SlayzoneDb,
      data: UpdateArtifactFolderInput
    ): Promise<ArtifactFolder | null> {
      const existing = (await db.prepare('SELECT * FROM artifact_folders WHERE id = ?').get(
        data.id
      )) as Record<string, unknown> | undefined
      if (!existing) return null

      const sets: string[] = []
      const values: unknown[] = []
      if (data.name !== undefined) {
        sets.push('name = ?')
        values.push(data.name)
      }
      if (data.parentId !== undefined) {
        sets.push('parent_id = ?')
        values.push(data.parentId)
      }
      if (sets.length > 0) {
        values.push(data.id)
        await db
          .prepare(`UPDATE artifact_folders SET ${sets.join(', ')} WHERE id = ?`)
          .run(...values)
      }

      const row = (await db.prepare('SELECT * FROM artifact_folders WHERE id = ?').get(data.id)) as
        | Record<string, unknown>
        | undefined
      return parseFolder(row)
    },

    async deleteFolder(db: SlayzoneDb, id: string): Promise<boolean> {
      const existing = (await db.prepare('SELECT * FROM artifact_folders WHERE id = ?').get(id)) as
        | Record<string, unknown>
        | undefined
      if (!existing) return false
      await db.prepare('DELETE FROM artifact_folders WHERE id = ?').run(id)
      return true
    },

    async reorderFolders(
      db: SlayzoneDb,
      data: { parentId: string | null; folderIds: string[] }
    ): Promise<void> {
      await db.batchTxn(
        data.folderIds.map((id, index) => ({
          type: 'run',
          sql: 'UPDATE artifact_folders SET "order" = ? WHERE id = ?',
          params: [index, id]
        }))
      )
    }
  }
}
