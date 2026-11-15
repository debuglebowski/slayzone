/**
 * `GET /api/files/raw` — a workspace file's raw bytes, from the machine that owns it.
 *
 * The desktop's `slz-file://` handler serves previews (images, PDFs, HTML and the
 * assets an HTML page loads) by reading the file. For a workspace on a computer that
 * is not the desktop's own disk that read cannot happen locally ("Access denied"), so
 * the desktop fetches the bytes here instead: the hub routes the read to the owning
 * computer exactly like `fileEditor.readFile` — same target fields, same resolution
 * (`WorkspaceDeps.resolveComputer`), same path scope, same jail on the computer.
 *
 * Query:
 *   rootPath   absolute workspace root ON THE TARGET MACHINE (required)
 *   path       file path relative to `rootPath`, forward slashes (required)
 *   taskId | projectId   the path scope (one required, as for every fileEditor call)
 *   computerId           optional explicit computer (wins over the scope's binding)
 *
 * The file is never held whole: it is pulled from the computer in `fs.readBytes`
 * slices (`WORKSPACE_READ_BYTES_MAX_CHUNK`), one at a time, each written before the
 * next is asked for and only once the socket has drained; a client that goes away
 * stops the pulling. One `Range` (`a-b`, `a-`, `-n`) is honoured (206 / 416);
 * `ETag` (size + mtime) answers `If-None-Match` with 304. Every slice must come from
 * the same file version (size + mtime): a file that changes mid-stream destroys the
 * response rather than send a mix of two versions.
 *
 * Errors are JSON `{ ok: false, code, error }`: 400 bad query / no scope, 404
 * `FILE_NOT_FOUND` (missing, or not a regular file) or an unknown task/project, 403
 * `PATH_REFUSED` (leaves the root, or the computer's jail refused it), 503
 * `NO_COMPUTER_CONNECTED` / `COMPUTER_OFFLINE` / `COMPUTER_UPDATE_PENDING` (a computer
 * older than `fs.readBytes`).
 *
 * @module api/http/rest-api/files/raw
 */
import type { Express, Request, Response } from 'express'
import {
  getWorkspaceDeps,
  isPathTraversalError,
  WORKSPACE_READ_BYTES_MAX_CHUNK,
  type ReadBytesResult
} from '@slayzone/file-editor/hub'
import { contentTypeForPath } from '@slayzone/platform/mime-types'
import {
  inPathScopeOf,
  isComputerRefusal,
  PathScopeRequiredError,
  UnknownScopeError
} from '@slayzone/platform/path-scope'
import { isHubSwitchedOffError, refuseNoComputer } from '@slayzone/platform/hub-switch-refusal'
import type { RestApiDeps } from '../types'
import { queryString } from '../resolve'
import { contentRange, parseRange, resolveRange, unsatisfiedContentRange } from '../byte-range'

const CHUNK = WORKSPACE_READ_BYTES_MAX_CHUNK

/** JSON-RPC codes the gateway rejects with when the computer is not there (structural: no computer-transport import). */
const UNKNOWN_COMPUTER_RPC_CODE = -32004
/** Errors that mean "the computer's connection is gone", by name across module copies. */
const CONNECTION_LOSS_ERRORS = new Set(['RpcDisposedError', 'RpcTimeoutError'])
/** The fs's own "there is no such regular file" answers, in-process or routed (`data.errno`). */
const NOT_FOUND_ERRNOS = new Set(['ENOENT', 'ENOTDIR', 'EISDIR'])

type Fail = { status: number; code: string; error: string }

const fail = (res: Response, f: Fail): void => {
  res.status(f.status).json({ ok: false, code: f.code, error: f.error })
}

/** Map a read's failure to its REST answer. */
function classify(err: unknown): Fail {
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof PathScopeRequiredError)
    return { status: 400, code: 'PATH_SCOPE_REQUIRED', error: message }
  if (err instanceof UnknownScopeError) return { status: 404, code: 'NOT_FOUND', error: message }
  if (isPathTraversalError(err) || isComputerRefusal(err))
    return { status: 403, code: 'PATH_REFUSED', error: message }
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string' && NOT_FOUND_ERRNOS.has(code))
    return { status: 404, code: 'FILE_NOT_FOUND', error: message }
  if (isHubSwitchedOffError(err))
    return {
      status: err.code === 'NO_COMPUTER_CONNECTED' ? 503 : 403,
      code: err.code,
      error: message
    }
  if (err instanceof Error) {
    if (err.name === 'ComputerUpdatePendingError')
      return { status: 503, code: 'COMPUTER_UPDATE_PENDING', error: message }
    if (
      CONNECTION_LOSS_ERRORS.has(err.name) ||
      (err.name === 'RpcError' && code === UNKNOWN_COMPUTER_RPC_CODE)
    )
      return { status: 503, code: 'COMPUTER_OFFLINE', error: message }
  }
  return { status: 500, code: 'INTERNAL', error: message }
}

const etagOf = (r: Pick<ReadBytesResult, 'size' | 'mtimeMs'>): string =>
  `W/"${r.size.toString(16)}-${Math.floor(r.mtimeMs).toString(16)}"`

/** Weak comparison (RFC 9110 §13.1.2): `*` or any listed tag equal to `etag` ignoring `W/`. */
function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false
  const bare = (t: string) => t.trim().replace(/^W\//, '')
  return header.split(',').some((t) => t.trim() === '*' || bare(t) === bare(etag))
}

/** Resolves true once `res` can take more, false if it closed first. */
function drained(res: Response): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      res.off('drain', onDrain)
      res.off('close', onClose)
      resolve(ok)
    }
    const onDrain = () => done(true)
    const onClose = () => done(false)
    res.on('drain', onDrain)
    res.on('close', onClose)
  })
}

async function serveRaw(req: Request, res: Response, deps: RestApiDeps): Promise<void> {
  const rootPath = queryString(req.query.rootPath)
  const filePath = queryString(req.query.path)
  const taskId = queryString(req.query.taskId) || undefined
  const projectId = queryString(req.query.projectId) || undefined
  const computerId = queryString(req.query.computerId) || undefined
  if (!rootPath || !filePath) {
    fail(res, { status: 400, code: 'BAD_REQUEST', error: 'rootPath and path are required' })
    return
  }
  if (!taskId && !projectId) {
    fail(res, {
      status: 400,
      code: 'PATH_SCOPE_REQUIRED',
      error: 'name the task or project whose files these are (taskId / projectId)'
    })
    return
  }
  const target = { taskId, projectId, computerId }

  // Every `fs.readBytes` below is sent inside the call's path scope (the gateway
  // stamps it), so the computer confines `rootPath` to the scope's own folders.
  await inPathScopeOf(deps.db, target, 'files.raw', async () => {
    const workspace = getWorkspaceDeps()
    const computer =
      (await workspace.resolveComputer(target)) ?? refuseNoComputer({ op: 'files.raw' })
    const read = (offset: number, length: number) =>
      workspace.fs.readBytes(computer, rootPath, filePath, offset, length)

    let closed = false
    res.once('close', () => {
      closed = true
    })

    const ask = parseRange(queryString(req.headers.range))
    const ifNoneMatch = queryString(req.headers['if-none-match'])
    // A revalidation or a suffix range needs the size/version before it knows what
    // to send: probe with one byte rather than pull a whole slice it may not use.
    const firstStart = ask.kind === 'from' ? ask.start : 0
    const probe = ifNoneMatch !== undefined || ask.kind === 'suffix'
    const first = await read(firstStart, probe ? 1 : CHUNK)
    const version = { size: first.size, mtimeMs: first.mtimeMs }
    const etag = etagOf(version)

    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('ETag', etag)
    if (etagMatches(ifNoneMatch, etag)) {
      res.status(304).end()
      return
    }
    const range = resolveRange(ask, version.size)
    if (!range) {
      res.setHeader('Content-Range', unsatisfiedContentRange(version.size))
      fail(res, {
        status: 416,
        code: 'RANGE_NOT_SATISFIABLE',
        error: `range not satisfiable for ${version.size} bytes`
      })
      return
    }

    res.status(ask.kind === 'none' ? 200 : 206)
    if (ask.kind !== 'none') res.setHeader('Content-Range', contentRange(range, version.size))
    res.setHeader('Content-Type', contentTypeForPath(filePath))
    res.setHeader('Content-Length', String(range.end - range.start))
    res.flushHeaders()

    let offset = range.start
    // The probe/first slice already holds bytes at `firstStart`: use them when they
    // are where the body starts.
    let pending: Uint8Array | null =
      firstStart === range.start ? first.bytes.subarray(0, range.end - range.start) : null
    while (offset < range.end) {
      if (closed) return
      let bytes: Uint8Array
      if (pending && pending.length > 0) {
        bytes = pending
        pending = null
      } else {
        const slice = await read(offset, Math.min(CHUNK, range.end - offset))
        if (closed) return
        if (
          slice.size !== version.size ||
          slice.mtimeMs !== version.mtimeMs ||
          !slice.bytes.length
        ) {
          // Changed (or shrank) mid-stream: never splice two versions into one body.
          res.destroy(new Error('file changed while it was being read'))
          return
        }
        bytes = slice.bytes.subarray(0, range.end - offset)
      }
      offset += bytes.length
      if (!res.write(bytes) && !(await drained(res))) return
    }
    res.end()
  })
}

export function registerFilesRawRoute(app: Express, deps: RestApiDeps): void {
  app.get('/api/files/raw', async (req, res) => {
    try {
      await serveRaw(req, res, deps)
    } catch (err) {
      if (res.headersSent) {
        res.destroy(err instanceof Error ? err : new Error(String(err)))
        return
      }
      fail(res, classify(err))
    }
  })
}
