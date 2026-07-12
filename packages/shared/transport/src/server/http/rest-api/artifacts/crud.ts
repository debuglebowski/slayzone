import type { Express, Response } from 'express'
import { createArtifactStore } from '@slayzone/task/server'
import type { RenderMode } from '@slayzone/task/shared'
import type { SlayzoneDb } from '@slayzone/platform'
import type { RestApiDeps } from '../types'
import { isResolveFailure, resolveByIdPrefix } from '../resolve'
import { getArtifactsDataRoot } from './shared'

/**
 * Artifact + folder metadata CRUD. Mirrors the metadata half of `slay tasks
 * artifacts` (cli/src/commands/tasks/artifacts.ts), reusing the shared artifact
 * store (@slayzone/task/server) — the exact ops behind the app's own artifact
 * flows (worker `namedTxn`s that also place/version the file on disk):
 *
 * - POST   /api/artifacts               { taskId, title, folderId?, renderMode?, content? }
 * - PATCH  /api/artifacts/:id           { title?, renderMode?, folderId? }  → echoes `folderName`
 * - DELETE /api/artifacts/:id
 * - POST   /api/artifact-folders        { taskId, name, parentId? }
 * - DELETE /api/artifact-folders/:id
 * - PATCH  /api/artifact-folders/:id    { parentId }   → move to another parent / "root", echoes `parentName`
 *
 * The two PATCH routes double as the CLI `mv` / `mvdir` moves: a `folderId` /
 * `parentId` is resolved as an id *prefix* to its full id (parity with the CLI's
 * resolveFolder — 404/400 on miss/ambiguous), `"root"` / `null` promotes to top
 * level, and the target's name is echoed (`folderName` / `parentName`, null for
 * "root") so the CLI can print `-> <name>` without a second round-trip.
 *
 * The content-transfer + version-history subcommands (read/write/append/
 * download/path, versions:*) stay CLI-local: they stream blob-store bytes off
 * disk and have no metadata-only mapping. Content upload has its own streaming
 * route (artifacts/content.ts POST /api/tasks/:id/artifacts).
 */

function store() {
  return createArtifactStore(getArtifactsDataRoot())
}

/** Resolve an artifact-folder id prefix; writes the failure response itself. */
async function resolveFolderPrefix(
  db: SlayzoneDb,
  prefix: string,
  res: Response
): Promise<{ id: string; name: string } | null> {
  const resolved = await resolveByIdPrefix<{ id: string; name: string }>(
    db,
    'artifact_folders',
    prefix,
    'Folder',
    'id, name'
  )
  if (isResolveFailure(resolved)) {
    res.status(resolved.status).json({ ok: false, error: resolved.error })
    return null
  }
  return resolved.row
}

export function registerArtifactsCrudRoutes(app: Express, deps: RestApiDeps): void {
  app.post('/api/artifacts', async (req, res) => {
    const body = (req.body ?? {}) as {
      taskId?: unknown
      title?: unknown
      folderId?: unknown
      renderMode?: unknown
      content?: unknown
    }
    if (typeof body.taskId !== 'string' || !body.taskId) {
      res.status(400).json({ ok: false, error: 'taskId required' })
      return
    }
    if (typeof body.title !== 'string' || !body.title.trim()) {
      res.status(400).json({ ok: false, error: 'title required' })
      return
    }
    try {
      const db = deps.db
      const task = await resolveByIdPrefix<{ id: string }>(db, 'tasks', body.taskId, 'Task', 'id')
      if (isResolveFailure(task)) {
        res.status(task.status).json({ ok: false, error: task.error })
        return
      }
      let folderId: string | null = null
      if (typeof body.folderId === 'string' && body.folderId) {
        const folder = await resolveFolderPrefix(db, body.folderId, res)
        if (!folder) return
        folderId = folder.id
      }
      const artifact = await store().createArtifact(db, {
        taskId: task.row.id,
        title: body.title,
        folderId,
        renderMode: typeof body.renderMode === 'string' ? (body.renderMode as RenderMode) : undefined,
        content: typeof body.content === 'string' ? body.content : undefined
      })
      if (!artifact) {
        res.status(500).json({ ok: false, error: 'Failed to create artifact' })
        return
      }
      deps.notifyRenderer()
      res.json({ ok: true, data: artifact })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.patch('/api/artifacts/:id', async (req, res) => {
    const body = (req.body ?? {}) as {
      title?: unknown
      renderMode?: unknown
      folderId?: unknown
    }
    if (body.title === undefined && body.renderMode === undefined && body.folderId === undefined) {
      res
        .status(400)
        .json({ ok: false, error: 'Provide at least one of title, renderMode, folderId' })
      return
    }
    try {
      const db = deps.db
      const resolved = await resolveByIdPrefix<{ id: string }>(
        db,
        'task_artifacts',
        req.params.id,
        'Artifact',
        'id'
      )
      if (isResolveFailure(resolved)) {
        res.status(resolved.status).json({ ok: false, error: resolved.error })
        return
      }
      const input: Parameters<ReturnType<typeof store>['updateArtifact']>[1] = {
        id: resolved.row.id
      }
      if (typeof body.title === 'string') input.title = body.title
      if (body.renderMode !== undefined) {
        input.renderMode = typeof body.renderMode === 'string' ? (body.renderMode as RenderMode) : null
      }
      // Move target (CLI `mv`): resolve a folder id *prefix* to its full id
      // ("root"/empty/null → top level). `folderName` is echoed so the CLI can
      // render `-> <name>` without a second lookup.
      let folderName: string | null = null
      if (body.folderId !== undefined) {
        if (typeof body.folderId === 'string' && body.folderId && body.folderId !== 'root') {
          const folder = await resolveFolderPrefix(db, body.folderId, res)
          if (!folder) return
          input.folderId = folder.id
          folderName = folder.name
        } else {
          input.folderId = null
        }
      }
      const artifact = await store().updateArtifact(db, input)
      if (!artifact) {
        res.status(404).json({ ok: false, error: `Artifact not found: ${req.params.id}` })
        return
      }
      deps.notifyRenderer()
      res.json({ ok: true, data: { ...artifact, folderName } })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete('/api/artifacts/:id', async (req, res) => {
    try {
      const db = deps.db
      const resolved = await resolveByIdPrefix<{ id: string; title: string }>(
        db,
        'task_artifacts',
        req.params.id,
        'Artifact',
        'id, title'
      )
      if (isResolveFailure(resolved)) {
        res.status(resolved.status).json({ ok: false, error: resolved.error })
        return
      }
      const ok = await store().deleteArtifact(db, resolved.row.id)
      if (!ok) {
        res.status(404).json({ ok: false, error: `Artifact not found: ${req.params.id}` })
        return
      }
      deps.notifyRenderer()
      res.json({ ok: true, data: { id: resolved.row.id, title: resolved.row.title } })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/artifact-folders', async (req, res) => {
    const body = (req.body ?? {}) as { taskId?: unknown; name?: unknown; parentId?: unknown }
    if (typeof body.taskId !== 'string' || !body.taskId) {
      res.status(400).json({ ok: false, error: 'taskId required' })
      return
    }
    if (typeof body.name !== 'string' || !body.name.trim()) {
      res.status(400).json({ ok: false, error: 'name required' })
      return
    }
    try {
      const db = deps.db
      const task = await resolveByIdPrefix<{ id: string }>(db, 'tasks', body.taskId, 'Task', 'id')
      if (isResolveFailure(task)) {
        res.status(task.status).json({ ok: false, error: task.error })
        return
      }
      let parentId: string | null = null
      if (typeof body.parentId === 'string' && body.parentId) {
        const parent = await resolveFolderPrefix(db, body.parentId, res)
        if (!parent) return
        parentId = parent.id
      }
      const folder = await store().createFolder(db, { taskId: task.row.id, name: body.name, parentId })
      if (!folder) {
        res.status(500).json({ ok: false, error: 'Failed to create folder' })
        return
      }
      deps.notifyRenderer()
      res.json({ ok: true, data: folder })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete('/api/artifact-folders/:id', async (req, res) => {
    try {
      const db = deps.db
      const folder = await resolveFolderPrefix(db, req.params.id, res)
      if (!folder) return
      const ok = await store().deleteFolder(db, folder.id)
      if (!ok) {
        res.status(404).json({ ok: false, error: `Folder not found: ${req.params.id}` })
        return
      }
      deps.notifyRenderer()
      res.json({ ok: true, data: { id: folder.id, name: folder.name } })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  // Move a folder to another parent (or "root"). Body: { parentId: string|null }.
  // A null / "root" parentId promotes to top level. Guards against moving a
  // folder into its own descendant (CLI `mvdir` parity).
  app.patch('/api/artifact-folders/:id', async (req, res) => {
    const body = (req.body ?? {}) as { parentId?: unknown }
    if (!('parentId' in body)) {
      res.status(400).json({ ok: false, error: 'parentId required (string id or null for root)' })
      return
    }
    try {
      const db = deps.db
      const folder = await resolveFolderPrefix(db, req.params.id, res)
      if (!folder) return

      let targetParentId: string | null = null
      let parentName: string | null = null
      if (typeof body.parentId === 'string' && body.parentId && body.parentId !== 'root') {
        const parent = await resolveFolderPrefix(db, body.parentId, res)
        if (!parent) return
        targetParentId = parent.id
        parentName = parent.name
        // Cycle check: walk ancestors of the target — reject if source appears.
        let cur: string | null = targetParentId
        while (cur) {
          if (cur === folder.id) {
            res.status(400).json({ ok: false, error: 'Cannot move folder into its own descendant' })
            return
          }
          const row: { parent_id: string | null } | undefined = await db.get<{
            parent_id: string | null
          }>(`SELECT parent_id FROM artifact_folders WHERE id = ?`, [cur])
          cur = row?.parent_id ?? null
        }
      }

      const updated = await store().updateFolder(db, { id: folder.id, parentId: targetParentId })
      if (!updated) {
        res.status(404).json({ ok: false, error: `Folder not found: ${req.params.id}` })
        return
      }
      deps.notifyRenderer()
      // `parentName` (null for "root") echoed so the CLI can print `-> <name>`.
      res.json({ ok: true, data: { ...updated, parentName } })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
