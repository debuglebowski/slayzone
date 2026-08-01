/**
 * REST: GET /api/artifacts/search — the hub half of `slay tasks artifacts search`.
 *
 * The command scans artifact TITLES and the CURRENT VERSION's content of every
 * artifact in scope, which means reading the hub's blob store — the one thing a
 * CLI on another machine cannot do. The route owns the whole scan (matching,
 * snippet/context extraction, the large-artifact skip, the limit/truncation
 * bookkeeping) and returns exactly the `SearchResult[]` the CLI's `--json`
 * printed, so both output modes are byte-identical to the sqlite version.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --experimental-loader ./packages/shared/test-utils/loader.ts packages/shared/transport/src/server/http/rest-api/artifacts/search.test.ts
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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-artifacts-search-'))
process.env.SLAYZONE_ROOT = tmpRoot

const { registerArtifactsSearchRoute } = await import('./search.js')
const { registerArtifactsContentRoutes } = await import('./content.js')
const { registerArtifactsCrudRoutes } = await import('./crud.js')

const h = await createTestHarness()

const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'Search', '#000', '/tmp/search')
const taskA = `aaaaaaaa-${crypto.randomUUID().slice(9)}`
const taskB = `bbbbbbbb-${crypto.randomUUID().slice(9)}`
const insTask = h.db.prepare(
  'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
)
insTask.run(taskA, projectId, 'TaskA', 'todo', 3, 0)
insTask.run(taskB, projectId, 'TaskB', 'todo', 3, 1)

const app = express()
app.use(express.json())
const deps = { db: h.slayDb, notifyRenderer: () => {} }
// ORDER MATTERS: the fixed /api/artifacts/search path must beat /api/artifacts/:id.
registerArtifactsSearchRoute(app, deps)
registerArtifactsContentRoutes(app, deps)
registerArtifactsCrudRoutes(app, deps)
const rest = await mountRestApp(app)

interface SearchMatch {
  type: 'title' | 'content'
  line?: number
  snippet: string
  contextBefore?: string | null
  contextAfter?: string | null
}
interface SearchResult {
  artifactId: string
  taskId: string
  title: string
  matches: SearchMatch[]
}
type SearchResp = {
  ok: boolean
  data: { results: SearchResult[]; scannedCount: number; truncated: boolean }
  error?: string
}

/** Create through the streamed create route so v1 is seeded from the same bytes. */
async function makeArtifact(
  taskId: string,
  title: string,
  content: string | Buffer,
  extra: Record<string, string> = {}
): Promise<{ id: string }> {
  const qs = new URLSearchParams({ taskId, title, ...extra })
  const res = await fetch(`${rest.url}/api/artifacts?${qs}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: (typeof content === 'string' ? Buffer.from(content) : content) as unknown as BodyInit
  })
  const body = (await res.json()) as { ok: boolean; data: { id: string }; error?: string }
  if (!body.ok) throw new Error(`create failed: ${body.error}`)
  return body.data
}

let alphaId = ''
let betaId = ''
let otherTaskId = ''
let folderId = ''

await describe('GET /api/artifacts/search', () => {
  test('setup fixtures', async () => {
    alphaId = (
      await makeArtifact(taskA, 'alpha-notes.md', 'first line\nNEEDLE here\nthird line\n')
    ).id
    betaId = (await makeArtifact(taskA, 'beta.md', 'nothing to see\nneedle lowercase\n')).id
    otherTaskId = (await makeArtifact(taskB, 'gamma-NEEDLE.md', 'no body match\n')).id
    const folderRes = await rest.request<{ data: { id: string } }>(
      'POST',
      '/api/artifact-folders',
      { taskId: taskA, name: 'Nested' }
    )
    folderId = folderRes.body.data.id
    await makeArtifact(taskA, 'in-folder.md', 'NEEDLE inside a folder\n', {
      folderId
    })
    expect(alphaId.length).toBeGreaterThan(0)
  })

  test('scopes to one task by id prefix and matches content with line + context', async () => {
    const res = await rest.request<SearchResp>(
      'GET',
      `/api/artifacts/search?q=NEEDLE&taskId=${taskA.slice(0, 8)}`
    )
    expect(res.status).toBe(200)
    const ids = res.body.data.results.map((r) => r.artifactId)
    expect(ids.includes(alphaId)).toBe(true)
    // Case-INSENSITIVE by default, so beta's "needle" matches too.
    expect(ids.includes(betaId)).toBe(true)
    // Other task is out of scope.
    expect(ids.includes(otherTaskId)).toBe(false)

    const alpha = res.body.data.results.find((r) => r.artifactId === alphaId)!
    const m = alpha.matches.find((x) => x.type === 'content')!
    expect(m.line).toBe(2)
    expect(m.snippet).toBe('NEEDLE here')
    expect(m.contextBefore).toBe('first line')
    expect(m.contextAfter).toBe('third line')
  })

  test('allTasks=1 spans every task', async () => {
    const res = await rest.request<SearchResp>('GET', '/api/artifacts/search?q=NEEDLE&allTasks=1')
    expect(res.status).toBe(200)
    const ids = res.body.data.results.map((r) => r.artifactId)
    expect(ids.includes(otherTaskId)).toBe(true)
    expect(ids.includes(alphaId)).toBe(true)
  })

  test('title matches carry type=title with no line number', async () => {
    const res = await rest.request<SearchResp>('GET', '/api/artifacts/search?q=gamma&allTasks=1')
    const hit = res.body.data.results.find((r) => r.artifactId === otherTaskId)!
    expect(hit.matches[0].type).toBe('title')
    expect(hit.matches[0].snippet).toBe('gamma-NEEDLE.md')
    expect(hit.matches[0].line).toBeUndefined()
  })

  test('titlesOnly skips the content scan; contentOnly skips titles', async () => {
    const titles = await rest.request<SearchResp>(
      'GET',
      `/api/artifacts/search?q=NEEDLE&taskId=${taskA}&titlesOnly=1`
    )
    // No artifact on task A has NEEDLE in its TITLE.
    expect(titles.body.data.results.length).toBe(0)

    const contentOnly = await rest.request<SearchResp>(
      'GET',
      `/api/artifacts/search?q=gamma&allTasks=1&contentOnly=1`
    )
    expect(contentOnly.body.data.results.length).toBe(0)
  })

  test('folderId narrows to one folder (id prefix)', async () => {
    const res = await rest.request<SearchResp>(
      'GET',
      `/api/artifacts/search?q=NEEDLE&taskId=${taskA}&folderId=${folderId.slice(0, 8)}`
    )
    expect(res.status).toBe(200)
    expect(res.body.data.results.length).toBe(1)
    expect(res.body.data.results[0].title).toBe('in-folder.md')
  })

  test('caseSensitive=1 excludes the lowercase hit', async () => {
    const res = await rest.request<SearchResp>(
      'GET',
      `/api/artifacts/search?q=NEEDLE&taskId=${taskA}&caseSensitive=1`
    )
    const ids = res.body.data.results.map((r) => r.artifactId)
    expect(ids.includes(alphaId)).toBe(true)
    expect(ids.includes(betaId)).toBe(false)
  })

  test('regex=1 treats q as a JS RegExp; an invalid one is a 400', async () => {
    const ok = await rest.request<SearchResp>(
      'GET',
      `/api/artifacts/search?q=${encodeURIComponent('NEE.LE')}&taskId=${taskA}&regex=1`
    )
    expect(ok.status).toBe(200)
    expect(ok.body.data.results.length).toBeGreaterThan(0)

    const bad = await rest.request<{ error: string }>(
      'GET',
      `/api/artifacts/search?q=${encodeURIComponent('[unclosed')}&taskId=${taskA}&regex=1`
    )
    expect(bad.status).toBe(400)
    // Wording the CLI printed verbatim from its own compileMatcher.
    expect(bad.body.error.startsWith('Invalid regex: ')).toBe(true)
  })

  test('maxMatches caps content matches per artifact', async () => {
    const many = await makeArtifact(taskA, 'many.md', 'NEEDLE\nNEEDLE\nNEEDLE\nNEEDLE\n')
    const res = await rest.request<SearchResp>(
      'GET',
      `/api/artifacts/search?q=NEEDLE&taskId=${taskA}&maxMatches=2`
    )
    const hit = res.body.data.results.find((r) => r.artifactId === many.id)!
    expect(hit.matches.filter((m) => m.type === 'content').length).toBe(2)
  })

  test('limit caps artifacts and sets truncated', async () => {
    const res = await rest.request<SearchResp>(
      'GET',
      `/api/artifacts/search?q=NEEDLE&taskId=${taskA}&limit=1`
    )
    expect(res.body.data.results.length).toBe(1)
    expect(res.body.data.truncated).toBe(true)
    // scannedCount is the size of the addressable set, which the CLI's human
    // footer prints ("Scanned N artifacts").
    expect(res.body.data.scannedCount).toBeGreaterThan(1)
  })

  test('binary render modes are skipped entirely (never decoded)', async () => {
    // A PNG whose bytes happen to contain the ASCII needle: the scan must skip
    // it because its render mode is binary, exactly as the CLI did.
    const bin = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]),
      Buffer.from('NEEDLE'),
      Buffer.from([0x00, 0x80])
    ])
    const png = await makeArtifact(taskA, 'shot.png', bin)
    const res = await rest.request<SearchResp>(
      'GET',
      `/api/artifacts/search?q=NEEDLE&taskId=${taskA}&limit=100`
    )
    expect(res.body.data.results.some((r) => r.artifactId === png.id)).toBe(false)
  })

  test('no matches → empty results, scannedCount still reported', async () => {
    const res = await rest.request<SearchResp>(
      'GET',
      `/api/artifacts/search?q=zzzznotpresent&taskId=${taskA}`
    )
    expect(res.status).toBe(200)
    expect(res.body.data.results.length).toBe(0)
    expect(res.body.data.truncated).toBe(false)
    expect(res.body.data.scannedCount).toBeGreaterThan(0)
  })

  test('400 empty q; 400 titlesOnly+contentOnly; 400 allTasks with taskId/folderId', async () => {
    const emptyQ = await rest.request<{ error: string }>(
      'GET',
      `/api/artifacts/search?q=%20&taskId=${taskA}`
    )
    expect(emptyQ.status).toBe(400)
    expect(emptyQ.body.error).toBe('Provide a non-empty query.')

    const both = await rest.request<{ error: string }>(
      'GET',
      `/api/artifacts/search?q=x&taskId=${taskA}&titlesOnly=1&contentOnly=1`
    )
    expect(both.status).toBe(400)
    expect(both.body.error).toBe('--titles-only and --content-only are mutually exclusive.')

    const clash = await rest.request<{ error: string }>(
      'GET',
      `/api/artifacts/search?q=x&allTasks=1&taskId=${taskA}`
    )
    expect(clash.status).toBe(400)
    expect(clash.body.error).toBe('--all-tasks cannot combine with --task or --folder.')
  })

  test('404 unknown task / unknown folder', async () => {
    const task = await rest.request<{ error: string }>(
      'GET',
      '/api/artifacts/search?q=x&taskId=ffffffff'
    )
    expect(task.status).toBe(404)
    expect(task.body.error).toBe('Task not found: ffffffff')

    const folder = await rest.request<{ error: string }>(
      'GET',
      `/api/artifacts/search?q=x&taskId=${taskA}&folderId=ffffffff`
    )
    expect(folder.status).toBe(404)
    expect(folder.body.error).toBe('Folder not found: ffffffff')
  })

  test('400 when neither taskId nor allTasks is given', async () => {
    const res = await rest.request<{ error: string }>('GET', '/api/artifacts/search?q=x')
    expect(res.status).toBe(400)
  })
})

await rest.close()
h.cleanup()
fs.rmSync(tmpRoot, { recursive: true, force: true })
