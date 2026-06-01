import type { Database } from 'better-sqlite3'
import path from 'path'
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  copyFileSync,
  readdirSync,
  statSync
} from 'fs'
import { randomUUID } from 'crypto'
import { getExtensionFromTitle } from '@slayzone/task/shared'
import { uniqueName } from '@slayzone/file-editor/shared'
import {
  BlobStore,
  betterSqliteTxn,
  createVersion,
  saveCurrent,
  setCurrentVersion,
  listVersions,
  resolveVersionRef,
  readVersionContent,
  renameVersion,
  pruneVersions,
  diffVersions,
  isVersionError
} from '@slayzone/task-artifacts/main'
import type { AuthorContext, VersionRef } from '@slayzone/task-artifacts/shared'

/**
 * Named-transaction adapters for task artifacts + their version history.
 *
 * These are the conditional read-modify-write operations that can't be shipped
 * as a static `batchTxn` op list, because they:
 *   - read MAX("order") / look up an existing row, THEN insert based on it, or
 *   - call the `@slayzone/task-artifacts` version helpers, which operate on a
 *     SYNCHRONOUS better-sqlite3 db + `TxnRunner` and must therefore run inside
 *     the DB worker (the async `SlayzoneDb` proxy can't be handed to them).
 *
 * Each function receives the worker's synchronous `db` and owns its own
 * `betterSqliteTxn(db)` where a transaction is needed — the worker does NOT
 * re-wrap. File-system writes (artifact content files + blob store) happen here
 * too, inside the worker, so the row, the on-disk file and the version blob stay
 * consistent. `dataDir` is passed in params (the worker has no Electron
 * `app.getPath`), and `artifactsDir` is derived from it the same way the IPC
 * layer does.
 *
 * Pure: imports only better-sqlite3 types, fs/path/crypto and the worker-safe
 * `@slayzone/task-artifacts/main` + `@slayzone/{task,file-editor}/shared`
 * barrels — safe to pull into the worker bundle.
 *
 * Returns are kept structured-cloneable (raw rows / version objects / scalars):
 * the IPC layer parses rows via `parseArtifact` / `parseFolder` after the call.
 */

const uiAuthor: AuthorContext = { type: 'user', id: null }

type Row = Record<string, unknown> | undefined

// `VersionError` thrown in the worker loses its class identity once its message
// crosses the thread boundary (only `err.message` is forwarded). Format the
// renderer-facing `[CODE] message` string here so the contract is preserved.
function wrapVersionError<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err: unknown) {
    if (isVersionError(err)) {
      throw new Error(`[${err.code}] ${err.message}`)
    }
    throw err
  }
}

function artifactsDirOf(dataDir: string): string {
  return path.join(dataDir, 'artifacts')
}

function artifactFilePath(dataDir: string, taskId: string, artifactId: string, title: string): string {
  const ext = getExtensionFromTitle(title) || '.txt'
  return path.join(artifactsDirOf(dataDir), taskId, `${artifactId}${ext}`)
}

function selectArtifact(db: Database, id: string): Row {
  return db.prepare('SELECT * FROM task_artifacts WHERE id = ?').get(id) as Row
}

function selectFolder(db: Database, id: string): Row {
  return db.prepare('SELECT * FROM artifact_folders WHERE id = ?').get(id) as Row
}

export interface CreateArtifactTxnParams {
  dataDir: string
  taskId: string
  folderId: string | null
  title: string
  renderMode: string | null
  language: string | null
  content: string
}

export interface UpdateArtifactTxnParams {
  dataDir: string
  id: string
  mutateVersion?: boolean
  // Only present when the corresponding field is being updated.
  title?: string
  folderId?: string | null
  renderMode?: string | null
  viewMode?: string | null
  readabilityOverride?: 'compact' | 'normal' | null
  widthOverride?: 'narrow' | 'wide' | null
  language?: string | null
  content?: string
  // Mirrors `'x' in data` checks so we know which optional keys were provided.
  setKeys: string[]
}

export interface UploadArtifactTxnParams {
  dataDir: string
  taskId: string
  sourcePath: string
  title: string
}

export interface PasteFilesTxnParams {
  dataDir: string
  sourcePaths: string[]
  destTaskId: string
  destFolderId: string | null
}

export interface UploadBlobTxnParams {
  dataDir: string
  taskId: string
  title: string
  bytes: Uint8Array
  folderId: string | null
}

export interface UploadDirTxnParams {
  dataDir: string
  taskId: string
  dirPath: string
  parentFolderId: string | null
}

export interface VersionsListTxnParams {
  artifactId: string
  limit?: number
  offset?: number
}

export interface VersionsReadTxnParams {
  dataDir: string
  artifactId: string
  versionRef: VersionRef
}

export interface VersionsCreateTxnParams {
  dataDir: string
  artifactId: string
  name?: string | null
}

export interface VersionsRenameTxnParams {
  artifactId: string
  versionRef: VersionRef
  newName: string | null
}

export interface VersionsDiffTxnParams {
  dataDir: string
  artifactId: string
  a: VersionRef
  b?: VersionRef
}

export interface VersionsPruneTxnParams {
  dataDir: string
  artifactId: string
  keepLast?: number
  keepNamed?: boolean
  keepCurrent?: boolean
  dryRun?: boolean
}

export interface VersionsSetCurrentTxnParams {
  dataDir: string
  artifactId: string
  versionRef: VersionRef
}

export interface FolderCreateTxnParams {
  taskId: string
  parentId: string | null
  name: string
}

export interface FolderGetOrCreateTxnParams {
  taskId: string
  name: string
}

export const artifactsTxns = {
  'task-artifacts:create': (db: Database, p: CreateArtifactTxnParams): Row => {
    const blobStore = new BlobStore(p.dataDir)
    const versionTxn = betterSqliteTxn(db)
    const id = randomUUID()
    const folderId = p.folderId ?? null
    const maxOrder =
      (
        db
          .prepare(
            folderId
              ? 'SELECT MAX("order") as m FROM task_artifacts WHERE task_id = ? AND folder_id = ?'
              : 'SELECT MAX("order") as m FROM task_artifacts WHERE task_id = ? AND folder_id IS NULL'
          )
          .get(...(folderId ? [p.taskId, folderId] : [p.taskId])) as { m: number | null }
      ).m ?? -1

    db.prepare(`
      INSERT INTO task_artifacts (id, task_id, folder_id, title, render_mode, language, "order")
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, p.taskId, folderId, p.title, p.renderMode ?? null, p.language ?? null, maxOrder + 1)

    // Write content to disk
    const filePath = artifactFilePath(p.dataDir, p.taskId, id, p.title)
    mkdirSync(path.dirname(filePath), { recursive: true })
    const initialBytes = Buffer.from(p.content ?? '', 'utf-8')
    writeFileSync(filePath, initialBytes)

    // Seed v1 for the new artifact.
    createVersion(db, versionTxn, blobStore, {
      artifactId: id,
      bytes: initialBytes,
      author: uiAuthor
    })

    return selectArtifact(db, id)
  },

  'task-artifacts:update': (db: Database, p: UpdateArtifactTxnParams): Row | null => {
    const blobStore = new BlobStore(p.dataDir)
    const versionTxn = betterSqliteTxn(db)
    const existing = selectArtifact(db, p.id)
    if (!existing) return null

    const has = (k: string): boolean => p.setKeys.includes(k)

    const sets: string[] = []
    const values: unknown[] = []
    if (has('title')) {
      sets.push('title = ?')
      values.push(p.title)
    }
    if (has('folderId')) {
      sets.push('folder_id = ?')
      values.push(p.folderId)
    }
    if (has('renderMode')) {
      sets.push('render_mode = ?')
      values.push(p.renderMode)
    }
    if (has('viewMode')) {
      sets.push('view_mode = ?')
      values.push(p.viewMode)
    }
    if (has('readabilityOverride')) {
      sets.push('readability_override = ?')
      values.push(p.readabilityOverride)
    }
    if (has('widthOverride')) {
      sets.push('width_override = ?')
      values.push(p.widthOverride)
    }
    if (has('language')) {
      sets.push('language = ?')
      values.push(p.language)
    }
    if (sets.length > 0) {
      sets.push("updated_at = datetime('now')")
      values.push(p.id)
      db.prepare(`UPDATE task_artifacts SET ${sets.join(', ')} WHERE id = ?`).run(...values)
    }

    // If title changed and extension changed, rename file on disk
    const taskId = existing.task_id as string
    const oldTitle = existing.title as string
    const newTitle = has('title') ? (p.title as string) : oldTitle
    const artifactsDir = artifactsDirOf(p.dataDir)
    if (has('title')) {
      const oldExt = getExtensionFromTitle(oldTitle) || '.txt'
      const newExt = getExtensionFromTitle(newTitle) || '.txt'
      if (oldExt !== newExt) {
        const oldPath = path.join(artifactsDir, taskId, `${p.id}${oldExt}`)
        const newPath = path.join(artifactsDir, taskId, `${p.id}${newExt}`)
        if (existsSync(oldPath)) {
          const content = readFileSync(oldPath, 'utf-8')
          writeFileSync(newPath, content, 'utf-8')
          unlinkSync(oldPath)
        }
      }
    }

    // UI autosave: `saveCurrent` mutates current in place when mutable
    // (tip + unnamed) or auto-branches when locked. Explicit "Create
    // version" still uses `createVersion` to always create a row.
    if (has('content')) {
      const filePath = artifactFilePath(p.dataDir, taskId, p.id, newTitle)
      mkdirSync(path.dirname(filePath), { recursive: true })
      const bytes = Buffer.from(p.content as string, 'utf-8')
      writeFileSync(filePath, bytes)
      if (p.mutateVersion) {
        saveCurrent(db, versionTxn, blobStore, { artifactId: p.id, bytes, author: uiAuthor })
      } else {
        createVersion(db, versionTxn, blobStore, { artifactId: p.id, bytes, author: uiAuthor })
      }
    }

    return selectArtifact(db, p.id)
  },

  'task-artifacts:upload': (db: Database, p: UploadArtifactTxnParams): Row => {
    const blobStore = new BlobStore(p.dataDir)
    const versionTxn = betterSqliteTxn(db)
    const id = randomUUID()
    const title = p.title
    const maxOrder =
      (
        db
          .prepare('SELECT MAX("order") as m FROM task_artifacts WHERE task_id = ?')
          .get(p.taskId) as { m: number | null }
      ).m ?? -1

    db.prepare(`
      INSERT INTO task_artifacts (id, task_id, title, "order")
      VALUES (?, ?, ?, ?)
    `).run(id, p.taskId, title, maxOrder + 1)

    const filePath = artifactFilePath(p.dataDir, p.taskId, id, title)
    mkdirSync(path.dirname(filePath), { recursive: true })
    copyFileSync(p.sourcePath, filePath)

    // Seed v1 from uploaded bytes.
    createVersion(db, versionTxn, blobStore, {
      artifactId: id,
      bytes: readFileSync(filePath),
      author: uiAuthor
    })

    return selectArtifact(db, id)
  },

  'task-artifacts:pasteFiles': (db: Database, p: PasteFilesTxnParams): Row[] => {
    const blobStore = new BlobStore(p.dataDir)
    const versionTxn = betterSqliteTxn(db)
    const { sourcePaths, destTaskId, destFolderId } = p
    if (!sourcePaths.length) return []

    const artifactsDir = artifactsDirOf(p.dataDir)
    const artifactsRootPrefix = artifactsDir + path.sep
    const created: Row[] = []

    versionTxn(() => {
      for (const srcPath of sourcePaths) {
        if (!existsSync(srcPath)) continue
        const stat = statSync(srcPath)
        if (!stat.isFile()) continue

        const newId = randomUUID()
        let title = path.basename(srcPath)
        let renderMode: string | null = null
        let language: string | null = null

        if (srcPath.startsWith(artifactsRootPrefix)) {
          const idMatch = path.basename(srcPath).match(/^([0-9a-f-]{36})\./)
          if (idMatch) {
            const sourceRow = selectArtifact(db, idMatch[1])
            if (sourceRow) {
              title = sourceRow.title as string
              renderMode = (sourceRow.render_mode as string | null) ?? null
              language = (sourceRow.language as string | null) ?? null
            }
          }
        }

        const siblingTitles = new Set<string>(
          (
            db
              .prepare(
                destFolderId
                  ? 'SELECT title FROM task_artifacts WHERE task_id = ? AND folder_id = ?'
                  : 'SELECT title FROM task_artifacts WHERE task_id = ? AND folder_id IS NULL'
              )
              .all(...(destFolderId ? [destTaskId, destFolderId] : [destTaskId])) as {
              title: string
            }[]
          ).map((r) => r.title)
        )
        title = uniqueName(title, siblingTitles)

        const maxOrder =
          (
            db
              .prepare(
                destFolderId
                  ? 'SELECT MAX("order") as m FROM task_artifacts WHERE task_id = ? AND folder_id = ?'
                  : 'SELECT MAX("order") as m FROM task_artifacts WHERE task_id = ? AND folder_id IS NULL'
              )
              .get(...(destFolderId ? [destTaskId, destFolderId] : [destTaskId])) as {
              m: number | null
            }
          ).m ?? -1

        db.prepare(`
          INSERT INTO task_artifacts (id, task_id, folder_id, title, render_mode, language, "order")
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(newId, destTaskId, destFolderId, title, renderMode, language, maxOrder + 1)

        const destFilePath = artifactFilePath(p.dataDir, destTaskId, newId, title)
        mkdirSync(path.dirname(destFilePath), { recursive: true })
        copyFileSync(srcPath, destFilePath)

        createVersion(db, versionTxn, blobStore, {
          artifactId: newId,
          bytes: readFileSync(destFilePath),
          author: uiAuthor
        })

        const row = selectArtifact(db, newId)
        if (row) created.push(row)
      }
    })

    return created
  },

  'task-artifacts:uploadBlob': (db: Database, p: UploadBlobTxnParams): Row => {
    const blobStore = new BlobStore(p.dataDir)
    const versionTxn = betterSqliteTxn(db)
    const id = randomUUID()
    const folderId = p.folderId ?? null

    const siblingTitles = new Set<string>(
      (
        db
          .prepare(
            folderId
              ? 'SELECT title FROM task_artifacts WHERE task_id = ? AND folder_id = ?'
              : 'SELECT title FROM task_artifacts WHERE task_id = ? AND folder_id IS NULL'
          )
          .all(...(folderId ? [p.taskId, folderId] : [p.taskId])) as { title: string }[]
      ).map((r) => r.title)
    )
    const title = uniqueName(p.title, siblingTitles)

    const maxOrder =
      (
        db
          .prepare(
            folderId
              ? 'SELECT MAX("order") as m FROM task_artifacts WHERE task_id = ? AND folder_id = ?'
              : 'SELECT MAX("order") as m FROM task_artifacts WHERE task_id = ? AND folder_id IS NULL'
          )
          .get(...(folderId ? [p.taskId, folderId] : [p.taskId])) as { m: number | null }
      ).m ?? -1

    db.prepare(`
      INSERT INTO task_artifacts (id, task_id, folder_id, title, "order")
      VALUES (?, ?, ?, ?, ?)
    `).run(id, p.taskId, folderId, title, maxOrder + 1)

    const filePath = artifactFilePath(p.dataDir, p.taskId, id, title)
    mkdirSync(path.dirname(filePath), { recursive: true })
    const buf = Buffer.from(p.bytes)
    writeFileSync(filePath, buf)

    createVersion(db, versionTxn, blobStore, {
      artifactId: id,
      bytes: buf,
      author: uiAuthor
    })

    return selectArtifact(db, id)
  },

  'task-artifacts:uploadDir': (
    db: Database,
    p: UploadDirTxnParams
  ): { folders: Row[]; artifacts: Row[] } => {
    const versionTxn = betterSqliteTxn(db)
    const createdFolders: Row[] = []
    const createdArtifacts: Row[] = []

    function walkDir(dirPath: string, parentFolderId: string | null): void {
      const entries = readdirSync(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)
        if (entry.isDirectory()) {
          const folderId = randomUUID()
          const maxOrder =
            (
              db
                .prepare(
                  parentFolderId
                    ? 'SELECT MAX("order") as m FROM artifact_folders WHERE task_id = ? AND parent_id = ?'
                    : 'SELECT MAX("order") as m FROM artifact_folders WHERE task_id = ? AND parent_id IS NULL'
                )
                .get(...(parentFolderId ? [p.taskId, parentFolderId] : [p.taskId])) as {
                m: number | null
              }
            ).m ?? -1

          db.prepare(`
            INSERT INTO artifact_folders (id, task_id, parent_id, name, "order")
            VALUES (?, ?, ?, ?, ?)
          `).run(folderId, p.taskId, parentFolderId, entry.name, maxOrder + 1)

          createdFolders.push(selectFolder(db, folderId))
          walkDir(fullPath, folderId)
        } else if (entry.isFile()) {
          const artifactId = randomUUID()
          const title = entry.name
          const maxOrder =
            (
              db
                .prepare(
                  parentFolderId
                    ? 'SELECT MAX("order") as m FROM task_artifacts WHERE task_id = ? AND folder_id = ?'
                    : 'SELECT MAX("order") as m FROM task_artifacts WHERE task_id = ? AND folder_id IS NULL'
                )
                .get(...(parentFolderId ? [p.taskId, parentFolderId] : [p.taskId])) as {
                m: number | null
              }
            ).m ?? -1

          db.prepare(`
            INSERT INTO task_artifacts (id, task_id, folder_id, title, "order")
            VALUES (?, ?, ?, ?, ?)
          `).run(artifactId, p.taskId, parentFolderId, title, maxOrder + 1)

          const filePath = artifactFilePath(p.dataDir, p.taskId, artifactId, title)
          mkdirSync(path.dirname(filePath), { recursive: true })
          copyFileSync(fullPath, filePath)

          createdArtifacts.push(selectArtifact(db, artifactId))
        }
      }
    }

    versionTxn(() => {
      walkDir(p.dirPath, p.parentFolderId)
    })

    return { folders: createdFolders, artifacts: createdArtifacts }
  },

  'task-artifacts:versions:list': (db: Database, p: VersionsListTxnParams): unknown =>
    listVersions(db, p.artifactId, { limit: p.limit, offset: p.offset }),

  'task-artifacts:versions:read': (db: Database, p: VersionsReadTxnParams): string =>
    wrapVersionError(() => {
      const blobStore = new BlobStore(p.dataDir)
      const v = resolveVersionRef(db, p.artifactId, p.versionRef)
      const buf = readVersionContent(blobStore, v)
      return buf.toString('utf-8')
    }),

  'task-artifacts:versions:create': (db: Database, p: VersionsCreateTxnParams): unknown =>
    wrapVersionError(() => {
      const blobStore = new BlobStore(p.dataDir)
      const versionTxn = betterSqliteTxn(db)
      const existing = selectArtifact(db, p.artifactId)
      if (!existing) throw new Error('Artifact not found')
      const filePath = artifactFilePath(
        p.dataDir,
        existing.task_id as string,
        p.artifactId,
        existing.title as string
      )
      const bytes = existsSync(filePath) ? readFileSync(filePath) : Buffer.alloc(0)
      return createVersion(db, versionTxn, blobStore, {
        artifactId: p.artifactId,
        bytes,
        name: p.name ?? null,
        honorUnchanged: true,
        author: uiAuthor
      })
    }),

  'task-artifacts:versions:rename': (db: Database, p: VersionsRenameTxnParams): unknown =>
    wrapVersionError(() => {
      const versionTxn = betterSqliteTxn(db)
      return renameVersion(db, versionTxn, p.artifactId, p.versionRef, p.newName)
    }),

  'task-artifacts:versions:diff': (db: Database, p: VersionsDiffTxnParams): unknown =>
    wrapVersionError(() => {
      const blobStore = new BlobStore(p.dataDir)
      return diffVersions(db, blobStore, { artifactId: p.artifactId, a: p.a, b: p.b })
    }),

  'task-artifacts:versions:prune': (db: Database, p: VersionsPruneTxnParams): unknown =>
    wrapVersionError(() => {
      const blobStore = new BlobStore(p.dataDir)
      const versionTxn = betterSqliteTxn(db)
      return pruneVersions(db, versionTxn, blobStore, p.artifactId, {
        keepLast: p.keepLast,
        keepNamed: p.keepNamed,
        keepCurrent: p.keepCurrent,
        dryRun: p.dryRun
      })
    }),

  // Returns { version, filePath, bytes } so the IPC layer can flush the switched
  // version's bytes back to the artifact's on-disk file (the editor re-reads it).
  'task-artifacts:versions:setCurrent': (
    db: Database,
    p: VersionsSetCurrentTxnParams
  ): { version: unknown; filePath: string; bytes: Buffer } =>
    wrapVersionError(() => {
      const blobStore = new BlobStore(p.dataDir)
      const versionTxn = betterSqliteTxn(db)
      const existing = selectArtifact(db, p.artifactId)
      if (!existing) throw new Error('Artifact not found')
      const v = setCurrentVersion(db, versionTxn, p.artifactId, p.versionRef)
      // Flush the switched version's bytes to disk so the editor reloads
      // the correct content. Without this, the on-disk file still reflects
      // the prior current and saves would diff against stale bytes.
      const bytes = readVersionContent(blobStore, v)
      const filePath = artifactFilePath(
        p.dataDir,
        existing.task_id as string,
        p.artifactId,
        existing.title as string
      )
      mkdirSync(path.dirname(filePath), { recursive: true })
      writeFileSync(filePath, bytes)
      return { version: v, filePath, bytes }
    }),

  'task-artifacts:folders:create': (db: Database, p: FolderCreateTxnParams): Row => {
    const id = randomUUID()
    const parentId = p.parentId ?? null
    const maxOrder =
      (
        db
          .prepare(
            parentId
              ? 'SELECT MAX("order") as m FROM artifact_folders WHERE task_id = ? AND parent_id = ?'
              : 'SELECT MAX("order") as m FROM artifact_folders WHERE task_id = ? AND parent_id IS NULL'
          )
          .get(...(parentId ? [p.taskId, parentId] : [p.taskId])) as { m: number | null }
      ).m ?? -1

    db.prepare(`
      INSERT INTO artifact_folders (id, task_id, parent_id, name, "order")
      VALUES (?, ?, ?, ?, ?)
    `).run(id, p.taskId, parentId, p.name, maxOrder + 1)

    return selectFolder(db, id)
  },

  'task-artifacts:folders:getOrCreateByName': (
    db: Database,
    p: FolderGetOrCreateTxnParams
  ): Row => {
    const existing = db
      .prepare('SELECT * FROM artifact_folders WHERE task_id = ? AND parent_id IS NULL AND name = ?')
      .get(p.taskId, p.name) as Row
    if (existing) return existing

    const id = randomUUID()
    const maxOrder =
      (
        db
          .prepare(
            'SELECT MAX("order") as m FROM artifact_folders WHERE task_id = ? AND parent_id IS NULL'
          )
          .get(p.taskId) as { m: number | null }
      ).m ?? -1

    db.prepare(`
      INSERT INTO artifact_folders (id, task_id, parent_id, name, "order")
      VALUES (?, ?, NULL, ?, ?)
    `).run(id, p.taskId, p.name, maxOrder + 1)

    return selectFolder(db, id)
  }
} satisfies Record<string, (db: Database, params: never) => unknown>
