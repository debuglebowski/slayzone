/**
 * REST: artifact CONTENT transfer contract tests — the byte-exactness half of
 * the `slay tasks artifacts` cutover (read / create / upload / download raw).
 *
 * The whole point of these routes is that artifact BYTES cross the wire
 * untouched: `slay tasks artifacts read` on an image must emit the same bytes a
 * `cat` of the file would, and `create --copy-from <binary>` must store them
 * unchanged. A utf-8 round-trip anywhere in the path silently replaces every
 * invalid sequence with U+FFFD, so the fixtures below deliberately carry bytes
 * that are NOT valid utf-8 (0xff 0xfe) plus embedded NULs and CRLF.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --experimental-loader ./packages/shared/test-utils/loader.ts packages/shared/transport/src/server/http/rest-api/artifacts/content.test.ts
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import express from 'express'
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../test-utils/rest-harness.js'

// The artifact store roots its on-disk files at <ROOT>/storage/artifacts — point
// ROOT at a throwaway dir BEFORE importing the routes (they read it lazily, but
// the store's blob dir is derived per call, so set it up front regardless).
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-artifacts-content-'))
process.env.SLAYZONE_ROOT = tmpRoot
const artifactsDir = path.join(tmpRoot, 'storage', 'artifacts')

const { registerArtifactsContentRoutes } = await import('./content.js')
const { registerArtifactsCrudRoutes } = await import('./crud.js')

const h = await createTestHarness()

const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'Alpha', '#000', '/tmp/alpha')
const taskId = `55555555-${crypto.randomUUID().slice(9)}`
h.db
  .prepare(
    'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
  )
  .run(taskId, projectId, 'ContentTask', 'todo', 3, 0)

let notifyCount = 0
const app = express()
app.use(express.json())
registerArtifactsContentRoutes(app, {
  db: h.slayDb,
  notifyRenderer: () => {
    notifyCount++
  }
})
registerArtifactsCrudRoutes(app, {
  db: h.slayDb,
  notifyRenderer: () => {
    notifyCount++
  }
})
const rest = await mountRestApp(app)

/** Bytes that are NOT valid utf-8, plus NUL + CRLF — a utf-8 hop mangles these. */
const BINARY = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x00, 0x01, 0x7f, 0x80
])

interface ArtifactRow {
  id: string
  task_id: string
  folder_id: string | null
  title: string
  render_mode: string | null
  order: number
  current_version_id: string | null
}
type ArtResp = { ok: boolean; data: ArtifactRow; error?: string }

/** Raw (non-JSON-decoded) request so binary responses can be compared byte-wise. */
async function raw(
  method: string,
  urlPath: string,
  body?: Buffer,
  contentType = 'application/octet-stream'
): Promise<{ status: number; headers: Headers; bytes: Buffer }> {
  const res = await fetch(`${rest.url}${urlPath}`, {
    method,
    headers: body !== undefined ? { 'content-type': contentType } : undefined,
    body: body as unknown as BodyInit | undefined
  })
  return {
    status: res.status,
    headers: res.headers,
    bytes: Buffer.from(await res.arrayBuffer())
  }
}

function fileOnDisk(artifact: ArtifactRow): Buffer {
  const ext = path.extname(artifact.title) || '.txt'
  return fs.readFileSync(path.join(artifactsDir, artifact.task_id, `${artifact.id}${ext}`))
}

let binaryArtifact: ArtifactRow

await describe('POST /api/artifacts — streamed body (query params) create', () => {
  test('creates from a raw streamed body, bytes byte-exact on disk', async () => {
    notifyCount = 0
    const res = await raw(
      'POST',
      `/api/artifacts?taskId=${taskId.slice(0, 8)}&title=${encodeURIComponent('shot.png')}`,
      BINARY
    )
    expect(res.status).toBe(200)
    const parsed = JSON.parse(res.bytes.toString('utf-8')) as ArtResp
    expect(parsed.ok).toBe(true)
    binaryArtifact = parsed.data
    expect(binaryArtifact.title).toBe('shot.png')
    // The bytes that landed on disk must be IDENTICAL — this is the assertion
    // that fails if the create path ever routes content through a utf-8 string.
    expect(fileOnDisk(binaryArtifact).toString('hex')).toBe(BINARY.toString('hex'))
    expect(notifyCount).toBeGreaterThanOrEqual(1)
  })

  test('seeds a v1 version whose blob is byte-exact too', () => {
    const row = h.db
      .prepare('SELECT current_version_id FROM task_artifacts WHERE id = ?')
      .get(binaryArtifact.id) as { current_version_id: string | null }
    expect(row.current_version_id).not.toBeNull()
    const version = h.db
      .prepare('SELECT content_hash, size, version_num FROM artifact_versions WHERE id = ?')
      .get(row.current_version_id) as { content_hash: string; size: number; version_num: number }
    expect(version.version_num).toBe(1)
    expect(version.size).toBe(BINARY.length)
    const blob = path.join(
      tmpRoot,
      'storage',
      'blobs',
      version.content_hash.slice(0, 2),
      version.content_hash.slice(2)
    )
    expect(fs.readFileSync(blob).toString('hex')).toBe(BINARY.toString('hex'))
  })

  test('honors folderId + renderMode query params (folder-scoped order)', async () => {
    const folderRes = await rest.request<{ ok: boolean; data: { id: string } }>(
      'POST',
      '/api/artifact-folders',
      { taskId, name: 'Docs' }
    )
    expect(folderRes.status).toBe(200)
    const folderId = folderRes.body.data.id

    const qs = new URLSearchParams({
      taskId,
      title: 'in-folder.md',
      folderId: folderId.slice(0, 8),
      renderMode: 'mermaid-preview'
    })
    const res = await raw('POST', `/api/artifacts?${qs}`, Buffer.from('graph TD;'))
    expect(res.status).toBe(200)
    const created = (JSON.parse(res.bytes.toString('utf-8')) as ArtResp).data
    expect(created.folder_id).toBe(folderId)
    expect(created.render_mode).toBe('mermaid-preview')
    // First artifact in that folder → order 0, NOT "one past the task-wide max"
    // (the CLI `create` allocated per-folder; `upload` allocated task-wide).
    expect(created.order).toBe(0)
  })

  test('404 unknown task (streamed body drained, not left hanging)', async () => {
    const res = await raw('POST', '/api/artifacts?taskId=ffffffff&title=x.md', BINARY)
    expect(res.status).toBe(404)
    expect(JSON.parse(res.bytes.toString('utf-8')).error.includes('Task not found')).toBe(true)
  })

  test('400 missing title', async () => {
    const res = await raw('POST', `/api/artifacts?taskId=${taskId}`, BINARY)
    expect(res.status).toBe(400)
  })

  test('JSON body form is untouched (inline content string)', async () => {
    const res = await rest.request<ArtResp>('POST', '/api/artifacts', {
      taskId,
      title: 'json-form.md',
      content: '# still works'
    })
    expect(res.status).toBe(200)
    expect(fileOnDisk(res.body.data).toString('utf-8')).toBe('# still works')
  })
})

await describe('GET /api/artifacts/:id/content', () => {
  test('streams binary bytes unchanged', async () => {
    const res = await raw('GET', `/api/artifacts/${binaryArtifact.id}/content`)
    expect(res.status).toBe(200)
    expect(res.bytes.toString('hex')).toBe(BINARY.toString('hex'))
    expect(res.headers.get('content-length')).toBe(String(BINARY.length))
  })

  test('resolves by id prefix', async () => {
    const res = await raw('GET', `/api/artifacts/${binaryArtifact.id.slice(0, 8)}/content`)
    expect(res.status).toBe(200)
    expect(res.bytes.toString('hex')).toBe(BINARY.toString('hex'))
  })

  test('content-disposition carries a lossless RFC5987 filename*', async () => {
    // A title with a double quote + a non-ASCII char: the plain `filename=""`
    // form has to sanitize both, so the CLI's default download filename can only
    // be recovered from `filename*`.
    const title = 'we"ird ünicode.md'
    const res = await raw(
      'POST',
      `/api/artifacts?taskId=${taskId}&title=${encodeURIComponent(title)}`,
      Buffer.from('x')
    )
    const created = (JSON.parse(res.bytes.toString('utf-8')) as ArtResp).data
    const got = await raw('GET', `/api/artifacts/${created.id}/content`)
    const cd = got.headers.get('content-disposition') ?? ''
    expect(cd.includes(`filename*=UTF-8''${encodeURIComponent(title)}`)).toBe(true)
    // The legacy quoted form stays present, reduced to plain ASCII — HTTP header
    // values are latin-1, so a raw multi-byte char there would be emitted mangled.
    expect(cd.includes('filename="we_ird _nicode.md"')).toBe(true)
  })

  test('404 unknown artifact', async () => {
    const res = await raw('GET', '/api/artifacts/ffffffff/content')
    expect(res.status).toBe(404)
    expect(JSON.parse(res.bytes.toString('utf-8')).error.includes('Artifact not found')).toBe(true)
  })

  test('400 ambiguous prefix uses the CLI’s "artifact id" wording', async () => {
    const idA = `9a9a9a9a-${crypto.randomUUID().slice(9)}`
    const idB = `9a9a9a9a-${crypto.randomUUID().slice(9)}`
    const ins = h.db.prepare(
      'INSERT INTO task_artifacts (id, task_id, title, "order") VALUES (?, ?, ?, ?)'
    )
    ins.run(idA, taskId, 'amb-a.md', 90)
    ins.run(idB, taskId, 'amb-b.md', 91)
    const res = await raw('GET', '/api/artifacts/9a9a9a9a/content')
    expect(res.status).toBe(400)
    const msg = JSON.parse(res.bytes.toString('utf-8')).error as string
    expect(msg.startsWith('Ambiguous artifact id "9a9a9a9a". Matches: ')).toBe(true)
  })

  test('404 when the row exists but the working file is gone', async () => {
    const orphan = crypto.randomUUID()
    h.db
      .prepare('INSERT INTO task_artifacts (id, task_id, title, "order") VALUES (?, ?, ?, ?)')
      .run(orphan, taskId, 'ghost.md', 95)
    const res = await raw('GET', `/api/artifacts/${orphan}/content`)
    expect(res.status).toBe(404)
    // Wording the CLI's `download --type raw` prints verbatim.
    expect(JSON.parse(res.bytes.toString('utf-8')).error).toBe('Artifact file not found on disk.')
  })
})

await describe('POST /api/tasks/:id/artifacts — streamed upload (unchanged)', () => {
  test('binary body round-trips byte-exact', async () => {
    const res = await raw(
      'POST',
      `/api/tasks/${taskId.slice(0, 8)}/artifacts?title=${encodeURIComponent('upload.bin')}`,
      BINARY
    )
    expect(res.status).toBe(200)
    const created = (JSON.parse(res.bytes.toString('utf-8')) as ArtResp).data
    expect(created.title).toBe('upload.bin')
    expect(fileOnDisk(created).toString('hex')).toBe(BINARY.toString('hex'))
  })

  test('404 unknown task', async () => {
    const res = await raw('POST', '/api/tasks/ffffffff/artifacts?title=x.md', BINARY)
    expect(res.status).toBe(404)
  })
})

await rest.close()
h.cleanup()
fs.rmSync(tmpRoot, { recursive: true, force: true })
