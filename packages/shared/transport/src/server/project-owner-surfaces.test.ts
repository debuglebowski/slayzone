/**
 * Every way a project comes into existence stores who created it (T-16):
 *
 *   - tRPC `projects.create` (desktop renderer, web UI)    → `ctx.principal`
 *   - REST `POST /api/projects` (`slay projects create`)    → the bound REST principal
 *   - import (`app.exportImport.import` + its path form)   → the importing request's user
 *
 * and stores NULL when the request carries no user — a hub without login, i.e. the
 * desktop app's, which keeps working exactly as before. MCP has no project-create
 * tool (pinned below, so adding one fails here until it stamps an owner too); there
 * are no project templates and no seeded/default project anywhere in the hub.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *   --experimental-loader ./packages/shared/test-utils/loader.ts \
 *   packages/shared/transport/src/server/project-owner-surfaces.test.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { TypedEmitter } from '@slayzone/platform/events'
import { createTestHarness, describe, test, expect } from '../../../test-utils/ipc-harness.js'
import { captureMcpServer } from '../../../test-utils/mcp-harness.js'
import { mountRestApp } from '../../../test-utils/rest-harness.js'
import { setNotifyEvents, type NotifyEventMap } from './app-deps'
import { createAccessScope } from './access'
import { buildExportImportOps } from './export-import'
import { bindRestPrincipal } from './http/rest-api/principal'
import { registerProjectsCrudRoutes } from './http/rest-api/projects/crud'
import { registerMcpTools } from './http/mcp-tools'
import { projectsRouter } from './routers/projects'

const h = await createTestHarness()
const dataRoot = mkdtempSync(join(tmpdir(), 'project-owner-surfaces-'))
setNotifyEvents(new TypedEmitter<NotifyEventMap>())

const ownerOf = (id: string): string | null =>
  (
    h.db.prepare('SELECT owner_user_id FROM projects WHERE id = ?').get(id) as {
      owner_user_id: string | null
    }
  ).owner_user_id
const ownerByName = (name: string): string | null =>
  (
    h.db.prepare('SELECT owner_user_id FROM projects WHERE name = ?').get(name) as {
      owner_user_id: string | null
    }
  ).owner_user_id
const principal = (userId: string) => ({ userId, role: 'user' as const, scopes: ['full' as const] })

// --- tRPC -------------------------------------------------------------------
await describe('tRPC', () => {
  test('tRPC projects.create: owner = the signed-in user', async () => {
    const caller = projectsRouter.createCaller({
      db: h.slayDb,
      dataRoot,
      principal: principal('u-a')
    })
    const p = await caller.create({ name: 'trpc-owned', color: '#111111' })
    expect(p.owner_user_id).toBe('u-a')
    expect(ownerOf(p.id)).toBe('u-a')
  })

  test('tRPC projects.create without a user (hub without login, the desktop): NULL, as before', async () => {
    const caller = projectsRouter.createCaller({ db: h.slayDb, dataRoot })
    const p = await caller.create({ name: 'trpc-desktop', color: '#111111' })
    expect(p.owner_user_id).toBeNull()
    // ...and it lists alongside everything else, unfiltered.
    const names = (await caller.list()).map((x) => x.name)
    expect(names.includes('trpc-desktop') && names.includes('trpc-owned')).toBe(true)
  })
})

// --- REST -------------------------------------------------------------------
// The hub's bearer gate binds the verified principal to the request
// (rest-auth.ts, pinned in apps/hub rest-auth.test.ts); this stands in for it.
const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  const user = req.headers['x-test-user']
  if (typeof user === 'string') bindRestPrincipal(req, principal(user))
  next()
})
registerProjectsCrudRoutes(app, { db: h.slayDb, notifyRenderer: () => {} })
const rest = await mountRestApp(app)
const post = async (body: unknown, user?: string) => {
  const res = await fetch(`${rest.url}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
    body: JSON.stringify(body)
  })
  return (await res.json()) as { ok: boolean; data: { id: string; owner_user_id: string | null } }
}

await describe('REST', () => {
  test('REST POST /api/projects (slay projects create): owner = the bound principal', async () => {
    const res = await post({ name: 'rest-owned' }, 'u-b')
    expect(res.ok).toBe(true)
    expect(res.data.owner_user_id).toBe('u-b')
    expect(ownerOf(res.data.id)).toBe('u-b')
  })

  test('REST POST /api/projects with no principal (hub without login): NULL', async () => {
    const res = await post({ name: 'rest-desktop' })
    expect(res.ok).toBe(true)
    expect(ownerOf(res.data.id)).toBeNull()
  })

  test('REST: a client cannot choose the owner', async () => {
    const res = await post(
      { name: 'rest-spoof', owner_user_id: 'u-evil', ownerUserId: 'u-evil' },
      'u-b'
    )
    expect(ownerOf(res.data.id)).toBe('u-b')
  })
})

// --- Import -------------------------------------------------------------------
function bundleFile(projects: Record<string, unknown>[]): string {
  const file = join(dataRoot, `bundle-${projects.map((p) => p.name).join('-')}.slay`)
  const data = {
    projects,
    tasks: projects.map((p, i) => ({
      id: `task-${i}-${String(p.id)}`,
      project_id: p.id,
      title: 'imported task',
      status: 'todo',
      priority: 3,
      provider_config: '{}'
    })),
    tags: [],
    task_tags: [],
    task_dependencies: [],
    terminal_tabs: [],
    ai_config_items: [],
    ai_config_project_selections: [],
    ai_config_sources: [],
    settings: []
  }
  writeFileSync(file, JSON.stringify({ meta: { version: 1, scope: 'project' }, data }))
  return file
}

const imported = (result: { success: boolean; error?: string }): void => {
  if (!result.success) throw new Error(`import failed: ${result.error}`)
}

/** The importing request: its user; the scope only matters to an export. */
const caller = (userId: string | null) => ({
  userId,
  scope: createAccessScope(h.slayDb, {
    authRequired: userId !== null,
    principal: userId ? { userId } : null
  })
})

await describe('import', () => {
  test('import: imported projects belong to the importer, whatever the bundle says', async () => {
    const file = bundleFile([
      // Exported from another hub: its owner id means nothing here.
      { id: 'src-1', name: 'import-foreign', color: '#222222', owner_user_id: 'u-other-hub' },
      // Exported by a build from before ownership: no column at all.
      { id: 'src-2', name: 'import-legacy', color: '#333333' }
    ])
    const ops = buildExportImportOps(h.slayDb, caller('u-c'), true)
    imported(await ops.testImportFromPath!(file))
    expect(ownerByName('import-foreign')).toBe('u-c')
    expect(ownerByName('import-legacy')).toBe('u-c')
    const tasks = h.db
      .prepare(
        `SELECT count(*) AS n FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE p.name IN ('import-foreign', 'import-legacy')`
      )
      .get() as { n: number }
    expect(tasks.n).toBe(2)
  })

  test('import with no user (hub without login): NULL', async () => {
    const file = bundleFile([
      { id: 'src-3', name: 'import-desktop', color: '#444444', owner_user_id: 'u-other-hub' }
    ])
    imported(await buildExportImportOps(h.slayDb, caller(null), true).testImportFromPath!(file))
    expect(ownerByName('import-desktop')).toBeNull()
  })
})

// --- MCP ----------------------------------------------------------------------
await describe('MCP', () => {
  test('MCP has no project-create tool (add one → it must stamp the owner, and this fails)', () => {
    const stub = captureMcpServer()
    registerMcpTools(stub.server as never, { db: h.slayDb, notifyRenderer: () => {} })
    const names = [...stub.tools.keys()]
    expect(names.length > 0).toBe(true)
    expect(names.filter((n) => /project/i.test(n))).toEqual([])
  })
})

await rest.close()
h.cleanup()
