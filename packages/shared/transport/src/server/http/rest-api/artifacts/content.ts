import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Express } from 'express'
import { createArtifactStore } from '@slayzone/task/server'
import type { RestApiDeps } from '../types'
import { isResolveFailure, queryString, resolveByIdPrefix } from '../resolve'
import { getArtifactsDataRoot, resolveArtifactFilePath } from './shared'

/**
 * Artifact content transfer. Mirrors `slay tasks artifacts read` / `upload`
 * (cli/src/commands/tasks/artifacts.ts), with the HTTP body streamed both ways
 * — neither route buffers the whole file in process memory:
 *
 * - GET  /api/artifacts/:id/content — stream the working-copy file from disk.
 * - POST /api/tasks/:id/artifacts?title=<name> — create a new artifact from a
 *   streamed request body (send with a non-JSON content type, e.g.
 *   application/octet-stream). The body streams to a temp file, then the shared
 *   artifact store's upload op (`task-artifacts:upload` worker txn) inserts the
 *   row, places the file, and seeds the v1 version — the exact op behind the
 *   app's own upload flow.
 */

interface ArtifactRow {
  id: string
  task_id: string
  title: string
}

export function registerArtifactsContentRoutes(app: Express, deps: RestApiDeps): void {
  app.get('/api/artifacts/:id/content', async (req, res) => {
    try {
      const resolved = await resolveByIdPrefix<ArtifactRow>(
        deps.db,
        'task_artifacts',
        req.params.id,
        'Artifact',
        'id, task_id, title'
      )
      if (isResolveFailure(resolved)) {
        res.status(resolved.status).json({ ok: false, error: resolved.error })
        return
      }
      const artifact = resolved.row
      const filePath = resolveArtifactFilePath(artifact.task_id, artifact.id, artifact.title)
      if (!existsSync(filePath)) {
        res.status(404).json({ ok: false, error: 'Artifact file not found on disk.' })
        return
      }

      const { size } = statSync(filePath)
      res.setHeader('content-type', 'application/octet-stream')
      res.setHeader('content-length', String(size))
      res.setHeader(
        'content-disposition',
        `attachment; filename="${artifact.title.replace(/["\\\r\n]/g, '_')}"`
      )
      const stream = createReadStream(filePath)
      stream.on('error', () => {
        if (!res.headersSent) res.status(500)
        res.destroy()
      })
      stream.pipe(res)
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/tasks/:id/artifacts', async (req, res) => {
    const title = queryString(req.query.title)
    if (!title || !title.trim()) {
      res.status(400).json({ ok: false, error: 'title query parameter required' })
      return
    }
    let tmpPath: string | null = null
    try {
      const db = deps.db
      const task = await resolveByIdPrefix<{ id: string }>(db, 'tasks', req.params.id, 'Task', 'id')
      if (isResolveFailure(task)) {
        // Drain the request so the client isn't left mid-upload on a dead socket.
        req.resume()
        res.status(task.status).json({ ok: false, error: task.error })
        return
      }

      // Stream the raw body to a temp staging file (constant memory).
      const stagingDir = join(tmpdir(), 'slayzone-artifact-uploads')
      mkdirSync(stagingDir, { recursive: true })
      tmpPath = join(stagingDir, randomUUID())
      await pipeline(req, createWriteStream(tmpPath))

      const store = createArtifactStore(getArtifactsDataRoot())
      const artifact = await store.uploadArtifact(db, {
        taskId: task.row.id,
        sourcePath: tmpPath,
        title: title.trim()
      })
      if (!artifact) {
        res.status(500).json({ ok: false, error: 'Upload failed' })
        return
      }

      deps.notifyRenderer()
      res.json({ ok: true, data: artifact })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      if (tmpPath) await unlink(tmpPath).catch(() => {})
    }
  })
}
