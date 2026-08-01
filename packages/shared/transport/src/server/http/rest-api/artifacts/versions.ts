import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Express } from 'express'
import { createArtifactStore } from '@slayzone/task/server'
import type { AuthorContext, VersionRef } from '@slayzone/task-artifacts/shared'
import type { SlayzoneDb } from '@slayzone/platform'
import type { RestApiDeps } from '../types'
import { isResolveFailure, queryString, resolveByIdPrefix } from '../resolve'
import { getArtifactsDataRoot } from './shared'

/**
 * Artifact VERSION HISTORY over HTTP — the hub half of `slay tasks artifacts
 * write | append | versions *`. Every one of those subcommands used to open the
 * hub's SQLite file AND its blob store directly, so none of them worked against
 * a hub on another machine.
 *
 *   PUT    /api/artifacts/:id/content   [?mutateVersion=1|&mutateVersionRef=<ref>]  write
 *   POST   /api/artifacts/:id/content   (same query flags)                          append
 *   GET    /api/artifacts/:id/versions             [?limit&offset]        versions list
 *   GET    /api/artifacts/:id/versions/content     ?ref=<ref>             versions read
 *   GET    /api/artifacts/:id/versions/diff        ?a=<ref>[&b=<ref>]     versions diff
 *   GET    /api/artifacts/:id/versions/current                           versions current
 *   POST   /api/artifacts/:id/versions/current     { ref }                versions set-current
 *   POST   /api/artifacts/:id/versions             { name?, author* }     versions create
 *   PATCH  /api/artifacts/:id/versions             { ref, name|null }     versions rename
 *   POST   /api/artifacts/:id/versions/prune       { keepLast, … }        versions prune
 *
 * NOTHING here re-derives version semantics. History is content-addressed and
 * immutable, refs resolve through one shared resolver (int / hash prefix / name /
 * `-N` / `HEAD~N`), and the lock/branch rules live in
 * `@slayzone/task-artifacts`. Each route calls the artifact store
 * (`@slayzone/task/server`), i.e. the same `task-artifacts:*` named txns the app
 * itself uses, so the CLI and the UI cannot drift.
 *
 * CONTENT NEVER BECOMES A STRING, in either direction. `write`/`append` stage
 * the raw request body to a temp file and hand the store a `sourcePath` (the
 * pattern the streamed create/upload routes established); `versions/content`
 * resolves the ref to its row, then streams the BLOB FILE straight off disk by
 * `content_hash`. A JS string is utf-8, so any such hop would replace every
 * invalid byte sequence in an image/pdf version with U+FFFD.
 *
 * `VersionError`s (bad ref, taken/reserved name, missing blob) are CALLER
 * mistakes, so they answer 400 — never 500 — carrying `code` (machine-readable)
 * plus `error` pre-formatted as the CLI's long-standing `Error [CODE]: message`
 * line, which the CLI prints verbatim.
 */

function store(): ReturnType<typeof createArtifactStore> {
  return createArtifactStore(getArtifactsDataRoot())
}

// Handler req/res derived from Express's own registration signature, matching the
// sibling content.ts. Only reached from inline handlers, where Express has already
// narrowed the route's `:id`; these aliases lose that inference (params widen to
// `string | string[]`), so the id is passed separately rather than re-read here.
type Req = Parameters<Parameters<Express['post']>[1]>[0]
type Res = Parameters<Parameters<Express['post']>[1]>[1]

/** Resolve an artifact id prefix, writing the failure response itself. */
async function resolveArtifact(
  db: SlayzoneDb,
  prefix: string,
  res: Res
): Promise<{ id: string; task_id: string; title: string } | null> {
  const resolved = await resolveByIdPrefix<{ id: string; task_id: string; title: string }>(
    db,
    'task_artifacts',
    prefix,
    'Artifact',
    'id, task_id, title',
    // CLI resolveArtifact wording: `Ambiguous artifact id "<prefix>"`.
    { ambiguousLabel: 'artifact id' }
  )
  if (isResolveFailure(resolved)) {
    res.status(resolved.status).json({ ok: false, error: resolved.error })
    return null
  }
  return resolved.row
}

/**
 * The worker re-throws a `VersionError` as a plain `Error` whose message is
 * `[CODE] message` (its class identity does not survive the thread boundary —
 * see task/server/artifacts-txns.ts `wrapVersionError`). Recover the code here so
 * the route can answer 400 with a machine-readable `code`.
 */
const VERSION_ERROR_RE = /^\[([A-Z_]+)\]\s([\s\S]*)$/

function versionErrorOf(err: unknown): { code: string; message: string } | null {
  const raw = err instanceof Error ? err.message : String(err)
  const m = VERSION_ERROR_RE.exec(raw)
  if (!m) return null
  return { code: m[1], message: m[2] }
}

/**
 * One error mapping for every route here: a version-level failure is the
 * caller's (400), anything else is ours (500).
 *
 * `error` is emitted as `Error [CODE]: message` because that is the exact line
 * the CLI printed from its local `isVersionError(err)` branch and still prints
 * verbatim from the route's payload.
 */
function sendError(res: Res, err: unknown): void {
  const ve = versionErrorOf(err)
  if (ve) {
    res.status(400).json({ ok: false, code: ve.code, error: `Error [${ve.code}]: ${ve.message}` })
    return
  }
  res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
}

/**
 * A version ref off the wire. Numeric strings become NUMBERS so `resolveVersionRef`
 * treats them as version numbers / relative offsets rather than falling through
 * to its name+hash-prefix branches — the CLI passed the raw string and the
 * resolver's own `INT_RE` handled it, so both spellings resolve identically; this
 * just keeps the intent explicit for JSON bodies, where `ref` may already be a number.
 */
function parseRef(value: unknown): VersionRef | undefined {
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined
  if (typeof value !== 'string' || value === '') return undefined
  return value
}

/** Author context off the query string / body — the CLI's `cliAuthor()`, forwarded. */
function parseAuthor(type: unknown, id: unknown): AuthorContext | undefined {
  if (type !== 'user' && type !== 'agent') return undefined
  return { type, id: typeof id === 'string' && id ? id : null }
}

/**
 * Stage a request body to a temp file (constant memory) and return its path.
 * Callers MUST unlink it. Same helper shape as artifacts/content.ts's — kept
 * separate rather than exported across files because both are three lines and
 * the coupling would be for its own sake.
 */
async function stageRequestBody(req: Req): Promise<string> {
  const stagingDir = join(tmpdir(), 'slayzone-artifact-uploads')
  mkdirSync(stagingDir, { recursive: true })
  const tmpPath = join(stagingDir, randomUUID())
  await pipeline(req, createWriteStream(tmpPath))
  return tmpPath
}

/** Shared body for PUT (replace) and POST (append) on :id/content. */
async function writeContent(
  req: Req,
  res: Res,
  deps: RestApiDeps,
  idPrefix: string,
  append: boolean
): Promise<void> {
  let tmpPath: string | null = null
  try {
    const artifact = await resolveArtifact(deps.db, idPrefix, res)
    if (!artifact) {
      // Drain the body so the client isn't left mid-upload on a dead socket.
      req.resume()
      return
    }
    // Bare `--mutate-version` (autosave onto current) vs `--mutate-version <ref>`
    // (rewrite that version in place) are DIFFERENT operations, so they are two
    // params rather than one overloaded value — a query string cannot express
    // commander's "boolean or string" optional-argument shape unambiguously.
    const mutateRef = parseRef(queryString(req.query.mutateVersionRef))
    const mutateCurrent = queryString(req.query.mutateVersion) != null
    const author = parseAuthor(
      queryString(req.query.authorType),
      queryString(req.query.authorId)
    )

    tmpPath = await stageRequestBody(req)

    const { artifact: updated, version } = await store().writeArtifactContent(deps.db, {
      artifactId: artifact.id,
      sourcePath: tmpPath,
      append,
      mutateCurrent,
      mutateRef,
      author
    })
    deps.notifyRenderer()
    res.json({
      ok: true,
      data: { id: artifact.id, title: updated?.title ?? artifact.title, version }
    })
  } catch (err) {
    sendError(res, err)
  } finally {
    if (tmpPath) await unlink(tmpPath).catch(() => {})
  }
}

export function registerArtifactsVersionsRoutes(app: Express, deps: RestApiDeps): void {
  // --- write / append: the artifact's bytes ARE the request body ---
  app.put('/api/artifacts/:id/content', async (req, res) => {
    await writeContent(req, res, deps, req.params.id, false)
  })
  app.post('/api/artifacts/:id/content', async (req, res) => {
    await writeContent(req, res, deps, req.params.id, true)
  })

  // --- versions list ---
  app.get('/api/artifacts/:id/versions', async (req, res) => {
    try {
      const artifact = await resolveArtifact(deps.db, req.params.id, res)
      if (!artifact) return
      const limitRaw = queryString(req.query.limit)
      const offsetRaw = queryString(req.query.offset)
      const rows = await store().listArtifactVersions(deps.db, {
        artifactId: artifact.id,
        limit: limitRaw != null ? parseInt(limitRaw, 10) : undefined,
        offset: offsetRaw != null ? parseInt(offsetRaw, 10) : undefined
      })
      res.json({ ok: true, data: rows })
    } catch (err) {
      sendError(res, err)
    }
  })

  // --- versions read: stream the version's BLOB off disk, byte-exact ---
  //
  // Registered BEFORE `/versions/current` etc. is irrelevant (distinct literal
  // paths), but it must come before nothing else here — Express matches these
  // literals exactly.
  app.get('/api/artifacts/:id/versions/content', async (req, res) => {
    try {
      const artifact = await resolveArtifact(deps.db, req.params.id, res)
      if (!artifact) return
      const ref = parseRef(queryString(req.query.ref))
      if (ref === undefined) {
        res.status(400).json({ ok: false, error: 'ref query parameter required' })
        return
      }
      // Resolve to the ROW (+ its blob path) rather than reading bytes through
      // the worker: `readArtifactVersion` stringifies to utf-8, which corrupts a
      // binary version. The blob is content-addressed and immutable, so streaming
      // the file directly is safe.
      const { version, blobPath } = await store().resolveArtifactVersion(deps.db, {
        artifactId: artifact.id,
        versionRef: ref
      })
      if (!existsSync(blobPath)) {
        res.status(400).json({
          ok: false,
          code: 'BLOB_MISSING',
          error: `Error [BLOB_MISSING]: Blob not found: ${version.content_hash}`
        })
        return
      }
      res.setHeader('content-type', 'application/octet-stream')
      res.setHeader('content-length', String(statSync(blobPath).size))
      const stream = createReadStream(blobPath)
      stream.on('error', () => {
        if (!res.headersSent) res.status(500)
        res.destroy()
      })
      stream.pipe(res)
    } catch (err) {
      sendError(res, err)
    }
  })

  // --- versions diff ---
  app.get('/api/artifacts/:id/versions/diff', async (req, res) => {
    try {
      const artifact = await resolveArtifact(deps.db, req.params.id, res)
      if (!artifact) return
      const a = parseRef(queryString(req.query.a))
      if (a === undefined) {
        res.status(400).json({ ok: false, error: 'a query parameter required' })
        return
      }
      // `b` absent = "latest", which the domain op means by an undefined `b`.
      const b = parseRef(queryString(req.query.b))
      const result = await store().diffArtifactVersions(deps.db, {
        artifactId: artifact.id,
        a,
        b
      })
      res.json({ ok: true, data: result })
    } catch (err) {
      sendError(res, err)
    }
  })

  // --- versions current (read) ---
  app.get('/api/artifacts/:id/versions/current', async (req, res) => {
    try {
      const artifact = await resolveArtifact(deps.db, req.params.id, res)
      if (!artifact) return
      const version = await store().getCurrentArtifactVersion(deps.db, {
        artifactId: artifact.id
      })
      if (!version) {
        // Wording the CLI printed verbatim for this case.
        res.status(404).json({ ok: false, error: 'No versions for this artifact' })
        return
      }
      res.json({ ok: true, data: version })
    } catch (err) {
      sendError(res, err)
    }
  })

  // --- versions set-current ---
  app.post('/api/artifacts/:id/versions/current', async (req, res) => {
    try {
      const artifact = await resolveArtifact(deps.db, req.params.id, res)
      if (!artifact) return
      const ref = parseRef((req.body as { ref?: unknown } | undefined)?.ref)
      if (ref === undefined) {
        res.status(400).json({ ok: false, error: 'ref required' })
        return
      }
      // The store op also FLUSHES the selected version's bytes to the working
      // copy — the CLI did that itself, and an editor re-reading the file needs it.
      const version = await store().setCurrentArtifactVersion(deps.db, {
        artifactId: artifact.id,
        versionRef: ref
      })
      deps.notifyRenderer()
      res.json({ ok: true, data: version })
    } catch (err) {
      sendError(res, err)
    }
  })

  // --- versions prune ---
  app.post('/api/artifacts/:id/versions/prune', async (req, res) => {
    try {
      const artifact = await resolveArtifact(deps.db, req.params.id, res)
      if (!artifact) return
      const body = (req.body ?? {}) as {
        keepLast?: unknown
        keepNamed?: unknown
        keepCurrent?: unknown
        dryRun?: unknown
      }
      const report = await store().pruneArtifactVersions(deps.db, {
        artifactId: artifact.id,
        keepLast: typeof body.keepLast === 'number' ? body.keepLast : undefined,
        keepNamed: typeof body.keepNamed === 'boolean' ? body.keepNamed : undefined,
        keepCurrent: typeof body.keepCurrent === 'boolean' ? body.keepCurrent : undefined,
        dryRun: typeof body.dryRun === 'boolean' ? body.dryRun : undefined
      })
      res.json({ ok: true, data: report })
    } catch (err) {
      sendError(res, err)
    }
  })

  // --- versions create (from the working copy) ---
  app.post('/api/artifacts/:id/versions', async (req, res) => {
    try {
      const artifact = await resolveArtifact(deps.db, req.params.id, res)
      if (!artifact) return
      const body = (req.body ?? {}) as {
        name?: unknown
        authorType?: unknown
        authorId?: unknown
      }
      const version = await store().createArtifactVersion(deps.db, {
        artifactId: artifact.id,
        name: typeof body.name === 'string' ? body.name : null,
        author: parseAuthor(body.authorType, body.authorId)
      })
      res.json({ ok: true, data: version })
    } catch (err) {
      sendError(res, err)
    }
  })

  // --- versions rename ---
  //
  // PATCH with `{ ref, name }` rather than a path segment for the ref: a ref can
  // be `HEAD~2` or a name with slashes, which does not survive a path segment
  // cleanly, and the two other ref-taking writers (set-current, write) put it in
  // the body/query for the same reason.
  app.patch('/api/artifacts/:id/versions', async (req, res) => {
    try {
      const artifact = await resolveArtifact(deps.db, req.params.id, res)
      if (!artifact) return
      const body = (req.body ?? {}) as { ref?: unknown; name?: unknown }
      const ref = parseRef(body.ref)
      if (ref === undefined) {
        res.status(400).json({ ok: false, error: 'ref required' })
        return
      }
      if (!('name' in body)) {
        res.status(400).json({ ok: false, error: 'name required (string, or null to clear)' })
        return
      }
      const version = await store().renameArtifactVersion(deps.db, {
        artifactId: artifact.id,
        versionRef: ref,
        newName: typeof body.name === 'string' ? body.name : null
      })
      res.json({ ok: true, data: version })
    } catch (err) {
      sendError(res, err)
    }
  })
}
