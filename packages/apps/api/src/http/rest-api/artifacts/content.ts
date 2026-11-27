import { readRelayBytes } from './relay-bytes'
import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Express, Response } from 'express'
import { retryByteSourceChanges } from '@slayzone/platform/bounded-reads'
import { getArtifactStorage, openArtifactReaderOf } from '@slayzone/task-artifacts/server'
import type { RenderMode } from '@slayzone/task-contracts'
import type { RestApiDeps } from '../types'
import { isResolveFailure, queryString, resolveByIdPrefix } from '../resolve'
import { getArtifactsDataRoot, resolveArtifactFilePath } from './shared'
import {
  contentRange,
  parseRange,
  resolveRange,
  unsatisfiedContentRange,
  type RangeAsk
} from '../byte-range'
import { streamChunks } from './stream-chunks'
import { respondFrameTooLarge } from '../computer-frame-limit'

/**
 * Artifact content transfer. Mirrors `slay tasks artifacts read` / `create` /
 * `upload` / `download` (cli/src/commands/tasks/artifacts.ts), with the HTTP body
 * streamed both ways — no route buffers the whole file in process memory:
 *
 * - GET  /api/artifacts/:id/content — stream the working-copy file from disk.
 *   Backs `read` (stdout) and `download --type raw` (file copy) as well as the
 *   per-file reads `download --type zip` assembles client-side, and the desktop's
 *   previews (one `Range` honoured, so a video or PDF can seek).
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
async function stageRequestBody(
  req: Parameters<Parameters<Express['post']>[1]>[0]
): Promise<string> {
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

    const storage = getArtifactStorage(getArtifactsDataRoot())
    const folders = folderId ? await storage.listFoldersByTask(db, task.row.id) : []
    const remote = folders.find((f) => f.id === folderId)?.storage
    const bytes = remote ? await readRelayBytes(req) : undefined
    if (!bytes) tmpPath = await stageRequestBody(req)

    let artifact = bytes
      ? await storage.uploadArtifactBlob(db, {
          taskId: task.row.id,
          title: title.trim(),
          folderId,
          bytes
        })
      : await storage.createArtifactFromStagedFile(
          db,
          {
            taskId: task.row.id,
            title: title.trim(),
            folderId,
            renderMode: queryString(req.query.renderMode) as RenderMode | undefined
          },
          tmpPath!
        )
    if (bytes && artifact && queryString(req.query.renderMode))
      artifact = await storage.updateArtifact(db, {
        id: artifact.id,
        renderMode: queryString(req.query.renderMode) as RenderMode
      })
    if (!artifact) {
      res.status(500).json({ ok: false, error: 'Failed to create artifact' })
      return
    }

    deps.notifyRenderer({ taskIds: [artifact.task_id] })
    res.json({ ok: true, data: artifact })
  } catch (err) {
    if (respondFrameTooLarge(res, err)) return
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
  } finally {
    if (tmpPath)
      await unlink(tmpPath).catch(() => {
        // Best-effort: createArtifact may already have consumed (moved) the
        // staging file, and a leftover temp file must never fail the response.
      })
  }
}

/**
 * Status and headers for an artifact body of `size` bytes, honouring one `Range`
 * (`byte-range.ts`): the slz-file preview handler forwards it, and a `<video>` or the
 * PDF viewer needs 206s to seek. Returns the `[start, end)` to send, or null after
 * answering 416.
 */
function startBody(
  res: Response,
  ask: RangeAsk,
  size: number,
  title: string
): { start: number; end: number } | null {
  res.setHeader('accept-ranges', 'bytes')
  const range = resolveRange(ask, size)
  if (!range) {
    res.setHeader('content-range', unsatisfiedContentRange(size))
    res.status(416).json({
      ok: false,
      code: 'RANGE_NOT_SATISFIABLE',
      error: `range not satisfiable for ${size} bytes`
    })
    return null
  }
  if (ask.kind !== 'none') {
    res.status(206)
    res.setHeader('content-range', contentRange(range, size))
  }
  res.setHeader('content-type', 'application/octet-stream')
  res.setHeader('content-length', String(range.end - range.start))
  // Two filename forms: the legacy quoted one, and the RFC5987 `filename*`,
  // which is percent-encoded and therefore LOSSLESS. `download` defaults its
  // output path to the artifact title, so a caller holding only an id prefix
  // must be able to recover the exact title — quotes, non-ASCII and all.
  // The quoted form is reduced to printable ASCII on purpose: HTTP header
  // values are latin-1, so a raw multi-byte char there is emitted mangled
  // anyway (and a CR/LF would be header injection).
  const asciiName = title.replace(/[^\x20-\x7e]|["\\]/g, '_')
  res.setHeader(
    'content-disposition',
    `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(title)}`
  )
  return range
}

/**
 * Select one HTTP range from a bounded whole-source reader. Keep one selected chunk back
 * until the source reaches EOF and completes its hash check, including unselected tail bytes.
 * Returning/throwing from this loop closes the source iterator; no file-sized buffer is kept.
 */
async function* selectedChunks(
  res: Response,
  chunks: AsyncIterable<Uint8Array>,
  range: { start: number; end: number },
  size: number
): AsyncGenerator<Uint8Array, void, void> {
  let offset = 0
  let pending: Uint8Array | undefined
  for await (const chunk of chunks) {
    if (res.destroyed) return
    const end = offset + chunk.byteLength
    if (end > size) throw new Error('Artifact reader exceeded its size')
    const from = Math.max(0, range.start - offset)
    const to = Math.min(chunk.byteLength, range.end - offset)
    if (to > from) {
      if (pending) yield pending
      pending = chunk.subarray(from, to)
    }
    offset = end
  }
  if (offset !== size) throw new Error('Artifact reader ended before its size')
  if (pending && !res.destroyed) yield pending
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
      const storage = getArtifactStorage(getArtifactsDataRoot())
      const artifact = (await storage.getArtifact(deps.db, resolved.row.id)) ?? resolved.row
      const ask = parseRange(queryString(req.headers.range))
      if ('storage' in artifact && artifact.storage) {
        // The reader covers the whole source for integrity; select the HTTP range without
        // assembling it. Older computers retain their whole read and the same range headers.
        const open = openArtifactReaderOf(storage)
        // A working copy written while it is read, before any byte went out: read it
        // again from its start (bounded). Once the headers are sent, a change ends the
        // response instead (streamChunks).
        await retryByteSourceChanges(async () => {
          const reader = open ? await open(deps.db, artifact.id, { kind: 'bytes' }) : null
          try {
            const bytes = reader ? null : await storage.readArtifactBytes(deps.db, artifact.id)
            const range = startBody(
              res,
              ask,
              reader ? reader.size : bytes!.byteLength,
              artifact.title
            )
            if (!range) return
            if (reader)
              await streamChunks(res, selectedChunks(res, reader.chunks, range, reader.size))
            else
              res.end(
                Buffer.from(bytes!.buffer, bytes!.byteOffset + range.start, range.end - range.start)
              )
          } finally {
            // Includes 416, header errors and an interrupted selection, before any body iteration.
            if (reader) await reader.chunks.return(undefined)
          }
        })
        return
      }
      const filePath = resolveArtifactFilePath(artifact.task_id, artifact.id, artifact.title)
      if (!existsSync(filePath)) {
        // `code` distinguishes "the artifact row exists, its working copy does
        // not" from "no such artifact" — both are 404s, but the CLI treats them
        // differently: `read` prints nothing and exits 0 for a missing working
        // copy (long-standing behavior), while `download` reports it as an error.
        // A machine-readable code keeps that fork off the human message text.
        res.status(404).json({
          ok: false,
          code: 'ARTIFACT_FILE_MISSING',
          error: 'Artifact file not found on disk.'
        })
        return
      }

      const range = startBody(res, ask, statSync(filePath).size, artifact.title)
      if (!range) return
      // An empty body (empty file): `createReadStream` has no empty `end`.
      if (range.end === range.start) {
        res.end()
        return
      }
      const stream = createReadStream(filePath, { start: range.start, end: range.end - 1 })
      stream.on('error', () => {
        if (!res.headersSent) res.status(500)
        res.destroy()
      })
      stream.pipe(res)
    } catch (err) {
      if (respondFrameTooLarge(res, err)) return
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

      const store = getArtifactStorage(getArtifactsDataRoot())
      const artifact = await store.uploadArtifact(db, {
        taskId: task.row.id,
        sourcePath: tmpPath,
        title: title.trim()
      })
      if (!artifact) {
        res.status(500).json({ ok: false, error: 'Upload failed' })
        return
      }

      deps.notifyRenderer({ taskIds: [artifact.task_id] })
      res.json({ ok: true, data: artifact })
    } catch (err) {
      if (respondFrameTooLarge(res, err)) return
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      if (tmpPath)
        await unlink(tmpPath).catch(() => {
          // Best-effort: uploadArtifact may already have consumed (moved) the
          // staging file, and a leftover temp file must never fail the response.
        })
    }
  })
}
