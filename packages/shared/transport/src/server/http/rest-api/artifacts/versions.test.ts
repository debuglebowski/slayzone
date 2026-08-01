/**
 * REST: artifact VERSION-HISTORY routes + the write/append content routes.
 *
 * These back the last `slay tasks artifacts` subcommands that still opened the
 * hub's SQLite file directly (`write`, `append`, every `versions:*`). Version
 * history is content-addressed and immutable, so every route here delegates to
 * the SAME domain ops the app uses (`@slayzone/task/server`'s artifact store →
 * `task-artifacts:*` named txns) — nothing re-derives version semantics.
 *
 * Byte-exactness is the load-bearing property: `write`/`append` carry the
 * artifact's bytes as the raw request body and `versions/content` streams the
 * blob back, so the fixtures below are deliberately NOT valid utf-8 (0xff 0xfe)
 * and carry embedded NULs + CRLF. Any string hop replaces those with U+FFFD, and
 * every assertion compares HEX.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --experimental-loader ./packages/shared/test-utils/loader.ts packages/shared/transport/src/server/http/rest-api/artifacts/versions.test.ts
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

// Artifact files live at <ROOT>/storage/artifacts, blobs at <ROOT>/storage/blobs.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-artifacts-versions-'))
process.env.SLAYZONE_ROOT = tmpRoot
const storageDir = path.join(tmpRoot, 'storage')

const { registerArtifactsVersionsRoutes } = await import('./versions.js')
const { registerArtifactsContentRoutes } = await import('./content.js')
const { registerArtifactsCrudRoutes } = await import('./crud.js')

const h = await createTestHarness()

const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'Versions', '#000', '/tmp/versions')
const taskId = `33333333-${crypto.randomUUID().slice(9)}`
h.db
  .prepare(
    'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
  )
  .run(taskId, projectId, 'VersionTask', 'todo', 3, 0)

let notifyCount = 0
const app = express()
app.use(express.json())
const deps = {
  db: h.slayDb,
  notifyRenderer: () => {
    notifyCount++
  }
}
registerArtifactsVersionsRoutes(app, deps)
registerArtifactsContentRoutes(app, deps)
registerArtifactsCrudRoutes(app, deps)
const rest = await mountRestApp(app)

/** Bytes that are NOT valid utf-8, plus NUL + CRLF — a utf-8 hop mangles these. */
const BINARY = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x00, 0x01, 0x7f, 0x80
])
const BINARY2 = Buffer.from([0x00, 0xfe, 0xff, 0x0d, 0x0a, 0x42])

interface ArtifactRow {
  id: string
  task_id: string
  title: string
  current_version_id: string | null
}
interface VersionRow {
  id: string
  artifact_id: string
  version_num: number
  content_hash: string
  size: number
  name: string | null
  author_type: string | null
  author_id: string | null
  parent_id: string | null
}

/** Raw (non-JSON-decoded) request so binary bodies/responses compare byte-wise. */
async function raw(
  method: string,
  urlPath: string,
  body?: Buffer
): Promise<{ status: number; bytes: Buffer }> {
  const res = await fetch(`${rest.url}${urlPath}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/octet-stream' } : undefined,
    body: body as unknown as BodyInit | undefined
  })
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) }
}

function json<T>(bytes: Buffer): T {
  return JSON.parse(bytes.toString('utf-8')) as T
}

/** Create an artifact through the streamed create route (byte-safe). */
async function makeArtifact(title: string, bytes: Buffer): Promise<ArtifactRow> {
  const res = await raw(
    'POST',
    `/api/artifacts?taskId=${taskId}&title=${encodeURIComponent(title)}`,
    bytes
  )
  if (res.status !== 200) throw new Error(`create failed: ${res.bytes.toString('utf-8')}`)
  return json<{ data: ArtifactRow }>(res.bytes).data
}

let binArtifact: ArtifactRow
let textArtifact: ArtifactRow

await describe('PUT/POST /api/artifacts/:id/content — write + append', () => {
  test('PUT replaces content byte-exact and creates a new version', async () => {
    binArtifact = await makeArtifact('shot.png', Buffer.from('seed'))
    notifyCount = 0
    const res = await raw(
      'PUT',
      `/api/artifacts/${binArtifact.id.slice(0, 8)}/content?authorType=agent&authorId=claude-code`,
      BINARY
    )
    expect(res.status).toBe(200)
    const body = json<{ ok: boolean; data: { id: string; title: string; version: VersionRow } }>(
      res.bytes
    )
    expect(body.ok).toBe(true)
    expect(body.data.id).toBe(binArtifact.id)
    expect(body.data.title).toBe('shot.png')
    // v1 was the seed; the replace is v2.
    expect(body.data.version.version_num).toBe(2)
    expect(body.data.version.size).toBe(BINARY.length)
    // Author rides the query string — the hub cannot read the CLI's env.
    expect(body.data.version.author_type).toBe('agent')
    expect(body.data.version.author_id).toBe('claude-code')
    expect(notifyCount).toBeGreaterThanOrEqual(1)

    const onDisk = fs.readFileSync(
      path.join(storageDir, 'artifacts', taskId, `${binArtifact.id}.png`)
    )
    expect(onDisk.toString('hex')).toBe(BINARY.toString('hex'))
  })

  test('the version BLOB is byte-exact too (not a utf-8 round trip)', () => {
    const row = h.db
      .prepare('SELECT current_version_id FROM task_artifacts WHERE id = ?')
      .get(binArtifact.id) as { current_version_id: string }
    const v = h.db
      .prepare('SELECT content_hash FROM artifact_versions WHERE id = ?')
      .get(row.current_version_id) as { content_hash: string }
    const blob = path.join(
      storageDir,
      'blobs',
      v.content_hash.slice(0, 2),
      v.content_hash.slice(2)
    )
    expect(fs.readFileSync(blob).toString('hex')).toBe(BINARY.toString('hex'))
  })

  test('POST appends bytes to the existing file byte-exact', async () => {
    const res = await raw('POST', `/api/artifacts/${binArtifact.id}/content`, BINARY2)
    expect(res.status).toBe(200)
    const body = json<{ data: { version: VersionRow } }>(res.bytes)
    expect(body.data.version.version_num).toBe(3)
    expect(body.data.version.size).toBe(BINARY.length + BINARY2.length)
    const onDisk = fs.readFileSync(
      path.join(storageDir, 'artifacts', taskId, `${binArtifact.id}.png`)
    )
    expect(onDisk.toString('hex')).toBe(Buffer.concat([BINARY, BINARY2]).toString('hex'))
  })

  test('mutateVersion=1 (bare) autosaves onto current instead of adding a row', async () => {
    const before = h.db
      .prepare('SELECT COUNT(*) AS n FROM artifact_versions WHERE artifact_id = ?')
      .get(binArtifact.id) as { n: number }
    const res = await raw(
      'PUT',
      `/api/artifacts/${binArtifact.id}/content?mutateVersion=1`,
      Buffer.from('autosaved')
    )
    expect(res.status).toBe(200)
    const after = h.db
      .prepare('SELECT COUNT(*) AS n FROM artifact_versions WHERE artifact_id = ?')
      .get(binArtifact.id) as { n: number }
    // Current is the tip and unnamed → mutated in place, no new row.
    expect(after.n).toBe(before.n)
    expect(json<{ data: { version: VersionRow } }>(res.bytes).data.version.version_num).toBe(3)
  })

  test('mutateVersionRef targets an older version in place (lock bypass)', async () => {
    const res = await raw(
      'PUT',
      `/api/artifacts/${binArtifact.id}/content?mutateVersionRef=1`,
      Buffer.from('rewritten v1')
    )
    expect(res.status).toBe(200)
    expect(json<{ data: { version: VersionRow } }>(res.bytes).data.version.version_num).toBe(1)
    const v1 = h.db
      .prepare('SELECT size FROM artifact_versions WHERE artifact_id = ? AND version_num = 1')
      .get(binArtifact.id) as { size: number }
    expect(v1.size).toBe('rewritten v1'.length)
  })

  test('a bad version ref is a 400 carrying the [CODE] message wording', async () => {
    const res = await raw(
      'PUT',
      `/api/artifacts/${binArtifact.id}/content?mutateVersionRef=999`,
      Buffer.from('x')
    )
    expect(res.status).toBe(400)
    const body = json<{ ok: boolean; code: string; error: string }>(res.bytes)
    expect(body.code).toBe('NOT_FOUND')
    // The CLI prints `error` verbatim; its long-standing wording is
    // `Error [CODE]: message`, so the route carries that string.
    expect(body.error).toBe('Error [NOT_FOUND]: Version not found: 999')
  })

  test('404 unknown artifact / 400 ambiguous prefix (CLI wording)', async () => {
    const missing = await raw('PUT', '/api/artifacts/deadbeef/content', Buffer.from('x'))
    expect(missing.status).toBe(404)
    expect(json<{ error: string }>(missing.bytes).error).toBe('Artifact not found: deadbeef')

    const idA = `1d1d1d1d-${crypto.randomUUID().slice(9)}`
    const idB = `1d1d1d1d-${crypto.randomUUID().slice(9)}`
    const ins = h.db.prepare(
      'INSERT INTO task_artifacts (id, task_id, title, "order") VALUES (?, ?, ?, ?)'
    )
    ins.run(idA, taskId, 'amb-v1.md', 40)
    ins.run(idB, taskId, 'amb-v2.md', 41)
    const amb = await raw('PUT', '/api/artifacts/1d1d1d1d/content', Buffer.from('x'))
    expect(amb.status).toBe(400)
    expect(
      json<{ error: string }>(amb.bytes).error.startsWith('Ambiguous artifact id "1d1d1d1d"')
    ).toBe(true)
  })
})

await describe('GET /api/artifacts/:id/versions — list', () => {
  test('newest first, with limit + offset', async () => {
    const res = await rest.request<{ ok: boolean; data: VersionRow[] }>(
      'GET',
      `/api/artifacts/${binArtifact.id.slice(0, 8)}/versions`
    )
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(3)
    expect(res.body.data[0].version_num).toBe(3)

    const limited = await rest.request<{ data: VersionRow[] }>(
      'GET',
      `/api/artifacts/${binArtifact.id}/versions?limit=1&offset=1`
    )
    expect(limited.body.data.length).toBe(1)
    expect(limited.body.data[0].version_num).toBe(2)
  })

  test('empty list for an artifact with no versions', async () => {
    const ghost = crypto.randomUUID()
    h.db
      .prepare('INSERT INTO task_artifacts (id, task_id, title, "order") VALUES (?, ?, ?, ?)')
      .run(ghost, taskId, 'novers.md', 50)
    const res = await rest.request<{ data: VersionRow[] }>(
      'GET',
      `/api/artifacts/${ghost}/versions`
    )
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(0)
  })
})

await describe('GET /api/artifacts/:id/versions/content — streamed read', () => {
  test('streams a version blob byte-exact (ref = int)', async () => {
    // v2 is the pure BINARY fixture written above.
    const res = await raw('GET', `/api/artifacts/${binArtifact.id}/versions/content?ref=2`)
    expect(res.status).toBe(200)
    expect(res.bytes.toString('hex')).toBe(BINARY.toString('hex'))
  })

  test('accepts a hash prefix, a relative ref, and HEAD~N', async () => {
    const v2 = h.db
      .prepare('SELECT content_hash FROM artifact_versions WHERE artifact_id = ? AND version_num = 2')
      .get(binArtifact.id) as { content_hash: string }
    const byHash = await raw(
      'GET',
      `/api/artifacts/${binArtifact.id}/versions/content?ref=${v2.content_hash.slice(0, 8)}`
    )
    expect(byHash.bytes.toString('hex')).toBe(BINARY.toString('hex'))

    // current is v3 → HEAD~1 walks the parent chain to v2.
    const tilde = await raw(
      'GET',
      `/api/artifacts/${binArtifact.id}/versions/content?ref=${encodeURIComponent('HEAD~1')}`
    )
    expect(tilde.bytes.toString('hex')).toBe(BINARY.toString('hex'))

    const relative = await raw('GET', `/api/artifacts/${binArtifact.id}/versions/content?ref=-1`)
    expect(relative.bytes.toString('hex')).toBe(BINARY.toString('hex'))
  })

  test('400 with the [CODE] wording for an unknown ref', async () => {
    const res = await raw('GET', `/api/artifacts/${binArtifact.id}/versions/content?ref=987`)
    expect(res.status).toBe(400)
    expect(json<{ error: string }>(res.bytes).error).toBe(
      'Error [NOT_FOUND]: Version not found: 987'
    )
  })

  test('400 when ref is missing', async () => {
    const res = await raw('GET', `/api/artifacts/${binArtifact.id}/versions/content`)
    expect(res.status).toBe(400)
  })
})

await describe('versions current / set-current', () => {
  test('GET .../versions/current returns the HEAD row', async () => {
    const res = await rest.request<{ data: VersionRow }>(
      'GET',
      `/api/artifacts/${binArtifact.id}/versions/current`
    )
    expect(res.status).toBe(200)
    expect(res.body.data.version_num).toBe(3)
  })

  test('GET .../versions/current 404s with the CLI wording when there are none', async () => {
    const ghost = crypto.randomUUID()
    h.db
      .prepare('INSERT INTO task_artifacts (id, task_id, title, "order") VALUES (?, ?, ?, ?)')
      .run(ghost, taskId, 'headless.md', 51)
    const res = await rest.request<{ error: string }>(
      'GET',
      `/api/artifacts/${ghost}/versions/current`
    )
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('No versions for this artifact')
  })

  test('POST .../versions/current switches HEAD and flushes bytes to disk', async () => {
    notifyCount = 0
    const res = await rest.request<{ data: VersionRow }>(
      'POST',
      `/api/artifacts/${binArtifact.id}/versions/current`,
      { ref: 2 }
    )
    expect(res.status).toBe(200)
    expect(res.body.data.version_num).toBe(2)
    expect(notifyCount).toBeGreaterThanOrEqual(1)
    // The switched version's bytes land on the working copy byte-exact.
    const onDisk = fs.readFileSync(
      path.join(storageDir, 'artifacts', taskId, `${binArtifact.id}.png`)
    )
    expect(onDisk.toString('hex')).toBe(BINARY.toString('hex'))
  })

  test('POST .../versions/current 400s on a bad ref, 400s with no ref', async () => {
    const bad = await rest.request<{ error: string; code: string }>(
      'POST',
      `/api/artifacts/${binArtifact.id}/versions/current`,
      { ref: 'nope-name' }
    )
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('Error [NOT_FOUND]: Version not found: nope-name')

    const none = await rest.request<{ error: string }>(
      'POST',
      `/api/artifacts/${binArtifact.id}/versions/current`,
      {}
    )
    expect(none.status).toBe(400)
  })
})

await describe('POST /api/artifacts/:id/versions — create from working copy', () => {
  test('creates a row even when content is unchanged (honorUnchanged) and records the author', async () => {
    textArtifact = await makeArtifact('notes.md', Buffer.from('line one\nline two\n'))
    const res = await rest.request<{ data: VersionRow }>(
      'POST',
      `/api/artifacts/${textArtifact.id.slice(0, 8)}/versions`,
      { name: 'baseline', authorType: 'agent', authorId: 'codex' }
    )
    expect(res.status).toBe(200)
    expect(res.body.data.version_num).toBe(2)
    expect(res.body.data.name).toBe('baseline')
    expect(res.body.data.author_type).toBe('agent')
    expect(res.body.data.author_id).toBe('codex')
  })

  test('400 with the [CODE] wording when the name is taken', async () => {
    const res = await rest.request<{ code: string; error: string }>(
      'POST',
      `/api/artifacts/${textArtifact.id}/versions`,
      { name: 'baseline' }
    )
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('NAME_TAKEN')
    expect(res.body.error.startsWith('Error [NAME_TAKEN]: ')).toBe(true)
  })
})

await describe('PATCH /api/artifacts/:id/versions — rename', () => {
  test('sets a name by ref', async () => {
    const res = await rest.request<{ data: VersionRow }>(
      'PATCH',
      `/api/artifacts/${textArtifact.id}/versions`,
      { ref: 1, name: 'first' }
    )
    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('first')
    expect(res.body.data.version_num).toBe(1)
  })

  test('clears a name with null', async () => {
    const res = await rest.request<{ data: VersionRow }>(
      'PATCH',
      `/api/artifacts/${textArtifact.id}/versions`,
      { ref: 1, name: null }
    )
    expect(res.status).toBe(200)
    expect(res.body.data.name).toBeNull()
  })

  test('400 when ref is absent', async () => {
    const res = await rest.request<{ error: string }>(
      'PATCH',
      `/api/artifacts/${textArtifact.id}/versions`,
      { name: 'x' }
    )
    expect(res.status).toBe(400)
  })

  test('400 for a reserved name, with the [CODE] wording', async () => {
    const res = await rest.request<{ code: string; error: string }>(
      'PATCH',
      `/api/artifacts/${textArtifact.id}/versions`,
      { ref: 1, name: 'HEAD' }
    )
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('NAME_RESERVED')
  })
})

await describe('GET /api/artifacts/:id/versions/diff', () => {
  test('text diff returns hunks with add/del/ctx line kinds', async () => {
    // Working copy currently "line one\nline two\n"; write a changed v3.
    await raw('PUT', `/api/artifacts/${textArtifact.id}/content`, Buffer.from('line one\nCHANGED\n'))
    const res = await rest.request<{
      data: { kind: string; hunks: { lines: { kind: string; text: string }[] }[] }
    }>('GET', `/api/artifacts/${textArtifact.id}/versions/diff?a=1`)
    expect(res.status).toBe(200)
    expect(res.body.data.kind).toBe('text')
    const kinds = res.body.data.hunks.flatMap((hk) => hk.lines.map((l) => l.kind))
    expect(kinds.includes('add')).toBe(true)
    expect(kinds.includes('del')).toBe(true)
  })

  test('explicit b, and binary pair reported as kind=binary', async () => {
    const res = await rest.request<{ data: { kind: string; a: { size: number } } }>(
      'GET',
      `/api/artifacts/${binArtifact.id}/versions/diff?a=1&b=2`
    )
    expect(res.status).toBe(200)
    // v2 is the BINARY fixture (contains NUL) → binary diff.
    expect(res.body.data.kind).toBe('binary')
  })

  test('400 when a is missing; 400 with [CODE] wording for a bad ref', async () => {
    const noA = await rest.request<{ error: string }>(
      'GET',
      `/api/artifacts/${textArtifact.id}/versions/diff`
    )
    expect(noA.status).toBe(400)

    const bad = await rest.request<{ error: string }>(
      'GET',
      `/api/artifacts/${textArtifact.id}/versions/diff?a=555`
    )
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('Error [NOT_FOUND]: Version not found: 555')
  })
})

await describe('POST /api/artifacts/:id/versions/prune', () => {
  test('dry run reports without deleting', async () => {
    const before = h.db
      .prepare('SELECT COUNT(*) AS n FROM artifact_versions WHERE artifact_id = ?')
      .get(textArtifact.id) as { n: number }
    const res = await rest.request<{
      data: { deletedVersions: number; deletedBlobs: number; keptNamed: number }
    }>('POST', `/api/artifacts/${textArtifact.id}/versions/prune`, { dryRun: true, keepLast: 1 })
    expect(res.status).toBe(200)
    expect(res.body.data.deletedVersions).toBeGreaterThan(0)
    const after = h.db
      .prepare('SELECT COUNT(*) AS n FROM artifact_versions WHERE artifact_id = ?')
      .get(textArtifact.id) as { n: number }
    expect(after.n).toBe(before.n)
  })

  test('keepNamed:false + keepCurrent:false actually delete', async () => {
    const res = await rest.request<{ data: { deletedVersions: number } }>(
      'POST',
      `/api/artifacts/${textArtifact.id}/versions/prune`,
      { keepLast: 1, keepNamed: false, keepCurrent: false }
    )
    expect(res.status).toBe(200)
    expect(res.body.data.deletedVersions).toBeGreaterThan(0)
    const after = h.db
      .prepare('SELECT COUNT(*) AS n FROM artifact_versions WHERE artifact_id = ?')
      .get(textArtifact.id) as { n: number }
    expect(after.n).toBe(1)
  })
})

await describe('PATCH /api/artifacts/:id — update echoes the RAW row (CLI --json parity)', () => {
  test('carries every stored column, incl. the version/view ones', async () => {
    const res = await rest.request<{
      data: Record<string, unknown> & { folderName: string | null }
    }>('PATCH', `/api/artifacts/${textArtifact.id}`, { title: 'renamed.md' })
    expect(res.status).toBe(200)
    const keys = Object.keys(res.body.data)
    for (const col of [
      'id',
      'task_id',
      'title',
      'type',
      'language',
      'order',
      'created_at',
      'updated_at',
      'render_mode',
      'folder_id',
      'view_mode',
      'readability_override',
      'width_override',
      'current_version_id'
    ]) {
      expect(keys.includes(col)).toBe(true)
    }
    expect(res.body.data.title).toBe('renamed.md')
  })

  test('an extension change renames the on-disk file BYTE-EXACT (binary safe)', async () => {
    const artifact = await makeArtifact('blob.bin', BINARY)
    const oldPath = path.join(storageDir, 'artifacts', taskId, `${artifact.id}.bin`)
    expect(fs.readFileSync(oldPath).toString('hex')).toBe(BINARY.toString('hex'))

    const res = await rest.request<{ data: { title: string } }>(
      'PATCH',
      `/api/artifacts/${artifact.id}`,
      { title: 'blob.dat' }
    )
    expect(res.status).toBe(200)
    expect(res.body.data.title).toBe('blob.dat')
    const newPath = path.join(storageDir, 'artifacts', taskId, `${artifact.id}.dat`)
    expect(fs.existsSync(oldPath)).toBe(false)
    // The old rename read the file as utf-8 and wrote it back as utf-8 —
    // every invalid sequence became U+FFFD. Hex, not eyeballing.
    expect(fs.readFileSync(newPath).toString('hex')).toBe(BINARY.toString('hex'))
  })
})

await rest.close()
h.cleanup()
fs.rmSync(tmpRoot, { recursive: true, force: true })
