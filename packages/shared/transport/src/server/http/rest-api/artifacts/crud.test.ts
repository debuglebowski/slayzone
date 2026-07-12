/**
 * REST: /api/artifacts + /api/artifact-folders CRUD contract tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --experimental-loader ./packages/shared/test-utils/loader.ts packages/shared/transport/src/server/http/rest-api/artifacts/crud.test.ts
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

// Point the artifact store's on-disk root at a throwaway dir BEFORE importing
// the routes — createArtifact/upload place files under $SLAYZONE_DB_DIR/artifacts.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-artifacts-crud-'))
process.env.SLAYZONE_DB_DIR = tmpRoot

const { registerArtifactsCrudRoutes } = await import('./crud.js')

const h = await createTestHarness()

const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'Alpha', '#000', '/tmp/alpha')
const taskId = `66666666-${crypto.randomUUID().slice(9)}`
h.db
  .prepare('INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)')
  .run(taskId, projectId, 'ArtifactTask', 'todo', 3, 0)

let notifyCount = 0
const app = express()
app.use(express.json())
registerArtifactsCrudRoutes(app, {
  db: h.slayDb,
  notifyRenderer: () => {
    notifyCount++
  }
})
const rest = await mountRestApp(app)

interface Artifact {
  id: string
  task_id: string
  folder_id: string | null
  title: string
  render_mode: string | null
}
interface Folder {
  id: string
  task_id: string
  parent_id: string | null
  name: string
}
type ArtResp = { ok: boolean; data: Artifact & { folderName?: string | null }; error?: string }
type FolderResp = { ok: boolean; data: Folder & { parentName?: string | null }; error?: string }
type DelResp = { ok: boolean; data: { id: string; title?: string; name?: string }; error?: string }

let artifactId = ''
let rootFolderId = ''
let childFolderId = ''

await describe('/api/artifacts + /api/artifact-folders CRUD', () => {
  test('POST /api/artifact-folders: creates a root folder', async () => {
    notifyCount = 0
    const res = await rest.request<FolderResp>('POST', '/api/artifact-folders', {
      taskId: taskId.slice(0, 8),
      name: 'Docs'
    })
    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('Docs')
    expect(res.body.data.parent_id).toBeNull()
    expect(notifyCount).toBe(1)
    rootFolderId = res.body.data.id
  })

  test('POST /api/artifact-folders: creates a child folder', async () => {
    const res = await rest.request<FolderResp>('POST', '/api/artifact-folders', {
      taskId,
      name: 'Sub',
      parentId: rootFolderId
    })
    expect(res.status).toBe(200)
    expect(res.body.data.parent_id).toBe(rootFolderId)
    childFolderId = res.body.data.id
  })

  test('POST /api/artifacts: creates an artifact with content', async () => {
    const res = await rest.request<ArtResp>('POST', '/api/artifacts', {
      taskId,
      title: 'notes.md',
      content: '# hi'
    })
    expect(res.status).toBe(200)
    expect(res.body.data.title).toBe('notes.md')
    artifactId = res.body.data.id
    const row = h.db.prepare('SELECT title FROM task_artifacts WHERE id = ?').get(artifactId) as {
      title: string
    }
    expect(row.title).toBe('notes.md')
  })

  test('POST /api/artifacts 400: missing title', async () => {
    const res = await rest.request<ArtResp>('POST', '/api/artifacts', { taskId })
    expect(res.status).toBe(400)
  })

  test('POST /api/artifacts 404: unknown task', async () => {
    const res = await rest.request<ArtResp>('POST', '/api/artifacts', {
      taskId: 'ffffffff',
      title: 'x.md'
    })
    expect(res.status).toBe(404)
  })

  test('PATCH /api/artifacts/:id: moves artifact into a folder (id prefix + echoes folderName)', async () => {
    // Target folder addressed by an 8-char prefix — the CLI `mv` path.
    const res = await rest.request<ArtResp>('PATCH', `/api/artifacts/${artifactId.slice(0, 8)}`, {
      folderId: childFolderId.slice(0, 8)
    })
    expect(res.status).toBe(200)
    expect(res.body.data.folder_id).toBe(childFolderId)
    expect(res.body.data.folderName).toBe('Sub')
  })

  test('PATCH /api/artifacts/:id: folderId "root" clears folder + folderName null', async () => {
    const res = await rest.request<ArtResp>('PATCH', `/api/artifacts/${artifactId}`, {
      folderId: 'root'
    })
    expect(res.status).toBe(200)
    expect(res.body.data.folder_id).toBeNull()
    expect(res.body.data.folderName).toBeNull()
    // Re-nest for later delete assertions (leave it where the original test expected).
    await rest.request<ArtResp>('PATCH', `/api/artifacts/${artifactId}`, { folderId: childFolderId })
  })

  test('PATCH /api/artifacts/:id 404: unknown target folder', async () => {
    const res = await rest.request<ArtResp>('PATCH', `/api/artifacts/${artifactId}`, {
      folderId: 'ffffffff'
    })
    expect(res.status).toBe(404)
  })

  test('PATCH /api/artifacts/:id: renames + sets render mode', async () => {
    const res = await rest.request<ArtResp>('PATCH', `/api/artifacts/${artifactId}`, {
      title: 'renamed.md',
      renderMode: 'markdown'
    })
    expect(res.status).toBe(200)
    expect(res.body.data.title).toBe('renamed.md')
    expect(res.body.data.render_mode).toBe('markdown')
  })

  test('PATCH /api/artifacts/:id 400: no fields', async () => {
    const res = await rest.request<ArtResp>('PATCH', `/api/artifacts/${artifactId}`, {})
    expect(res.status).toBe(400)
  })

  test('PATCH /api/artifact-folders/:id: move child to root (parentName null)', async () => {
    const res = await rest.request<FolderResp>('PATCH', `/api/artifact-folders/${childFolderId}`, {
      parentId: 'root'
    })
    expect(res.status).toBe(200)
    expect(res.body.data.parent_id).toBeNull()
    expect(res.body.data.parentName).toBeNull()
  })

  test('PATCH /api/artifact-folders/:id: move under parent by prefix echoes parentName', async () => {
    const res = await rest.request<FolderResp>('PATCH', `/api/artifact-folders/${childFolderId}`, {
      parentId: rootFolderId.slice(0, 8)
    })
    expect(res.status).toBe(200)
    expect(res.body.data.parent_id).toBe(rootFolderId)
    expect(res.body.data.parentName).toBe('Docs')
    // Restore to root for the cycle test below (it re-nests itself first).
    await rest.request<FolderResp>('PATCH', `/api/artifact-folders/${childFolderId}`, {
      parentId: 'root'
    })
  })

  test('PATCH /api/artifact-folders/:id 400: cycle (into own descendant)', async () => {
    // Re-nest child under root, then try to move root under child → cycle.
    await rest.request<FolderResp>('PATCH', `/api/artifact-folders/${childFolderId}`, {
      parentId: rootFolderId
    })
    const res = await rest.request<FolderResp>('PATCH', `/api/artifact-folders/${rootFolderId}`, {
      parentId: childFolderId
    })
    expect(res.status).toBe(400)
  })

  test('DELETE /api/artifacts/:id: removes the artifact', async () => {
    const res = await rest.request<DelResp>('DELETE', `/api/artifacts/${artifactId}`)
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(artifactId)
    const row = h.db.prepare('SELECT 1 AS x FROM task_artifacts WHERE id = ?').get(artifactId)
    expect(Boolean(row)).toBe(false)
  })

  test('DELETE /api/artifacts/:id 404: unknown', async () => {
    const res = await rest.request<DelResp>('DELETE', '/api/artifacts/ffffffff')
    expect(res.status).toBe(404)
  })

  test('DELETE /api/artifact-folders/:id: removes folder', async () => {
    const res = await rest.request<DelResp>('DELETE', `/api/artifact-folders/${childFolderId}`)
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(childFolderId)
  })

  test('DELETE /api/artifact-folders/:id 404: unknown', async () => {
    const res = await rest.request<DelResp>('DELETE', '/api/artifact-folders/ffffffff')
    expect(res.status).toBe(404)
  })
})

await rest.close()
h.cleanup()
fs.rmSync(tmpRoot, { recursive: true, force: true })
