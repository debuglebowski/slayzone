import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Express } from 'express'
import { createArtifactStore } from '@slayzone/task/server'
import type { RenderMode } from '@slayzone/task/shared'
import type { RestApiDeps } from '../types'
import { isResolveFailure, queryString, resolveByIdPrefix } from '../resolve'
import { getArtifactsDataRoot, resolveArtifactFilePath } from './shared'

/**
 * Artifact content transfer. Mirrors `slay tasks artifacts read` / `create` /
 * `upload` / `download` (cli/src/commands/tasks/artifacts.ts), with the HTTP body
 * streamed both ways — no route buffers the whole file in process memory:
 *
 * - GET  /api/artifacts/:id/content — stream the working-copy file from disk.
 *   Backs `read` (stdout) and `download --type raw` (file copy) as well as the
 *   per-file reads `download --type zip` assembles client-side.
 * - POST /api/artifacts?taskId=&title=[&folderId=&renderMode=] — create from a
 *   streamed request body (`create`).
 * - POST /api/tasks/:id/artifacts?title=<name> — upload from a streamed request
 *   body (`upload`).
 *
 * BOTH create paths are query-parameterized rather than JSON-bodied, because the
 * body IS the bytes: the sibling `POST /api/artifacts` in crud.ts takes a JSON
 * `content` STRING, which utf-8-decodes anything binary (a PNG round-tripped
 * through a JS string has every invalid sequence replaced with U+FFFD). Both
 * stage the body to a temp file and hand the shared artifact store a
 * `sourcePath`, so bytes never become a string. Express's `express.json()` only
 * consumes `application/json`, so a non-JSON content type (e.g.
 * application/octet-stream) leaves `req` unread and streamable.
 *
 * Content-type dispatch on `POST /api/artifacts` (one path, two encodings):
 * crud.ts registers the JSON handler FIRST, and it delegates here whenever the
 * request is not JSON — so `{ taskId, title, content }` keeps working unchanged
 * while a streamed body takes the binary-safe path.
 */

interface ArtifactRow {
  id: string
  task_id: string
  title: string
}

/**
 * Stage a request body to a temp file (constant memory) and return its path.
 * Callers MUST unlink it — both create routes do so in a `finally`.
 */
async function stageRequestBody(req: Parameters<Parameters<Express['post']>[1]>[0]): Promise<string> {
  const stagingDir = join(tmpdir(), 'slayzone-artifact-uploads')
  mkdirSync(stagingDir, { recursive: true })
  const tmpPath = join(stagingDir, randomUUID())
  await pipeline(req, createWriteStream(tmpPath))
  return tmpPath
}

/**
 * `POST /api/artifacts` with a NON-JSON body: `taskId`/`title` (+ optional
 * `folderId`/`renderMode`) ride the query string, the body is the raw bytes.
 * Exported so crud.ts's JSON handler can delegate — one route path, two body
 * encodings, and the CLI's `create` uses this one so `--copy-from <binary>` and
 * piped binary stdin survive byte-exact.
 */
export async function createArtifactFromStream(
  req: Parameters<Parameters<Express['post']>[1]>[0],
  res: Parameters<Parameters<Express['post']>[1]>[1],
  deps: RestApiDeps
): Promise<void> {
  const taskRef = queryString(req.query.taskId)
  const title = queryString(req.query.title)
  if (!taskRef) {
    req.resume()
    res.status(400).json({ ok: false, error: 'taskId required' })
    return
  }
  if (!title || !title.trim()) {
    req.resume()
    res.status(400).json({ ok: false, error: 'title required' })
    return
  }
  let tmpPath: string | null = null
  try {
    const db = deps.db
    const task = await resolveByIdPrefix<{ id: string }>(db, 'tasks', taskRef, 'Task', 'id')
    if (isResolveFailure(task)) {
      // Drain the request so the client isn't left mid-upload on a dead socket.
      req.resume()
      res.status(task.status).json({ ok: false, error: task.error })
      return
    }
    const folderRef = queryString(req.query.folderId)
    let folderId: string | null = null
    if (folderRef && folderRef !== 'root') {
      const folder = await resolveByIdPrefix<{ id: string }>(
        db,
        'artifact_folders',
        folderRef,
        'Folder',
        'id'
      )
      if (isResolveFailure(folder)) {
        req.resume()
        res.status(folder.status).json({ ok: false, error: folder.error })
        return
      }
      folderId = folder.row.id
    }

    tmpPath = await stageRequestBody(req)

    const artifact = await createArtifactStore(getArtifactsDataRoot()).createArtifact(db, {
      taskId: task.row.id,
      title: title.trim(),
      folderId,
      renderMode: queryString(req.query.renderMode) as RenderMode | undefined,
      sourcePath: tmpPath
    })
    if (!artifact) {
      res.status(500).json({ ok: false, error: 'Failed to create artifact' })
      return
    }

    deps.notifyRenderer()
    res.json({ ok: true, data: artifact })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
  } finally {
    if (tmpPath) await unlink(tmpPath).catch(() => {})
  }
}

export function registerArtifactsContentRoutes(app: Express, deps: RestApiDeps): void {
  app.get('/api/artifacts/:id/content', async (req, res) => {
    try {
      const resolved = await resolveByIdPrefix<ArtifactRow>(
        deps.db,
        'task_artifacts',
        req.params.id,
        'Artifact',
        'id, task_id, title',
        // The CLI's resolveArtifact said `Ambiguous artifact id "<prefix>"`; the
        // default wording ("id prefix") would silently change that message.
        { ambiguousLabel: 'artifact id' }
      )
      if (isResolveFailure(resolved)) {
        res.status(resolved.status).json({ ok: false, error: resolved.error })
        return
      }
      const artifact = resolved.row
      const filePath = resolveArtifactFilePath(artifact.task_id, artifact.id, artifact.title)
      if (!existsSync(filePath)) {
        // `code` distinguishes "the artifact row exists, its working copy does
        // not" from "no such artifact" — both are 404s, but the CLI treats them
        // differently: `read` prints nothing and exits 0 for a missing working
        // copy (long-standing behavior), while `download` reports it as an error.
        // A machine-readable code keeps that fork off the human message text.
        res
          .status(404)
          .json({ ok: false, code: 'ARTIFACT_FILE_MISSING', error: 'Artifact file not found on disk.' })
        return
      }

      const { size } = statSync(filePath)
      res.setHeader('content-type', 'application/octet-stream')
      res.setHeader('content-length', String(size))
      // Two filename forms: the legacy quoted one, and the RFC5987 `filename*`,
      // which is percent-encoded and therefore LOSSLESS. `download` defaults its
      // output path to the artifact title, so a caller holding only an id prefix
      // must be able to recover the exact title — quotes, non-ASCII and all.
      // The quoted form is reduced to printable ASCII on purpose: HTTP header
      // values are latin-1, so a raw multi-byte char there is emitted mangled
      // anyway (and a CR/LF would be header injection).
      const asciiName = artifact.title.replace(/[^\x20-\x7e]|["\\]/g, '_')
      res.setHeader(
        'content-disposition',
        `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(artifact.title)}`
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
      tmpPath = await stageRequestBody(req)

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
