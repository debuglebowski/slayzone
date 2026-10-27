/**
 * T-101 / T-105 / T-106, the owner-check leftovers, on a REAL hub with login
 * (`startServer()` in this process; see owner-checks-harness.ts). User A and user B are
 * ordinary accounts; the admin is the hub's bootstrap owner and owns a project too.
 *
 *   - Export (O-22): each caller's `exportAll` holds only their own projects and what
 *     hangs off them, their own settings view and the hub-wide library — the admin's
 *     only the admin's. Backups stay files on the hub's disk: metadata over the wire,
 *     and no route reads one back. An import never matches another user's tag or
 *     project name.
 *   - MCP sessions: one belongs to the account that opened it; B and the admin get 404
 *     (`MCP_SESSION_NOT_FOUND`, one audit line) for A's, exactly as for an unknown id.
 *   - Automations: the admin gets NOT_FOUND / 404 on A's (tRPC and REST, by id, prefix
 *     and project), B is refused by role; the admin's own still work.
 *   - Diagnostics: the admin's bundle holds no event about A's task or session.
 *
 * The id-by-id contract for every admin procedure and route (the admin gets NOT_FOUND on
 * each id A owns) is generated in owner-checks.test.ts / owner-checks-http.test.ts. The
 * hub without login is `owner-checks-admin-login-off.test.ts`.
 *
 * Run with: vitest (packages/shared/test-utils/vitest.harness.config.ts)
 */
import { afterAll, expect, test } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { recordDiagnosticEvent } from '@slayzone/diagnostics/server'
import { appRouter, getAutomationsEvents } from '@slayzone/transport/server'
import {
  asUser,
  bootInProcessHub,
  hubClient,
  ownedBy,
  procedureAt,
  seedOwned,
  seedShared,
  signedInUser,
  type InProcessHub
} from './owner-checks-harness.js'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const shows = (v: unknown, mark: string): boolean => JSON.stringify(v ?? null).includes(mark)

interface AuditLine {
  event: string
  actor: string | null
  targetId: string | null
  detail: Record<string, unknown>
}
const lines: AuditLine[] = []
setSecurityLogSink((l) => {
  try {
    lines.push(JSON.parse(l) as AuditLine)
  } catch {
    // not ours
  }
})
const denials = (from: number): AuditLine[] =>
  lines.slice(from).filter((l) => l.event === 'authz.denied')

type Client = ReturnType<typeof hubClient>['client']
const PROCS = appRouter._def.procedures as unknown as Record<string, { _def: { type: string } }>

/** A query or mutation by dotted path: its data, or the tRPC error code. */
async function call(
  client: Client,
  path: string,
  input?: unknown
): Promise<{ data?: unknown; code?: string }> {
  const proc = procedureAt(client, path)
  try {
    const isQuery = PROCS[path]!._def.type === 'query'
    return { data: isQuery ? await proc.query(input) : await proc.mutate(input) }
  } catch (e) {
    return { code: (e as { data?: { code?: string } }).data?.code ?? String(e) }
  }
}

// ── MCP over the real `/mcp` endpoint ─────────────────────────────────────────

function mcpFetch(
  hub: InProcessHub,
  method: 'POST' | 'GET' | 'DELETE',
  token: string,
  sid: string | null,
  body?: unknown
): Promise<Response> {
  return fetch(`http://127.0.0.1:${hub.port}/mcp`, {
    method,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      ...(sid ? { 'mcp-session-id': sid } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
}

async function mcpSession(hub: InProcessHub, token: string): Promise<string> {
  const init = await mcpFetch(hub, 'POST', token, null, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'owner-checks-admin', version: '1' }
    }
  })
  const sid = init.headers.get('mcp-session-id')
  await init.text()
  if (!sid) throw new Error(`mcp initialize: ${init.status}`)
  await (
    await mcpFetch(hub, 'POST', token, sid, { jsonrpc: '2.0', method: 'notifications/initialized' })
  ).text()
  return sid
}

const toolsList = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/list' })

// ── REST ──────────────────────────────────────────────────────────────────────

async function rest(
  hub: InProcessHub,
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; text: string }> {
  const r = await fetch(`http://127.0.0.1:${hub.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return { status: r.status, text: await r.text() }
}

// ── the test ──────────────────────────────────────────────────────────────────

const subs: { unsubscribe: () => void }[] = []

const hub = await bootInProcessHub({ login: true })
const a = await signedInUser(hub, 'a@example.com')
const b = await signedInUser(hub, 'b@example.com')
const adminId = hub.adminUserId!
const adminToken = hub.adminToken!
const A = ownedBy('A_SECRET', a.userId, hub.root)
const B = ownedBy('B_OWN', b.userId, hub.root)
const ADM = ownedBy('ADMIN_OWN', adminId, hub.root)
for (const o of [A, B, ADM]) seedOwned(hub.dbPath, o)
seedShared(hub.dbPath, A, B)
const raw = new Database(hub.dbPath)
const sql = (s: string, ...p: unknown[]): void => void raw.prepare(s).run(...p)
// A hub-wide library item; per-user settings; project-keyed hub settings; a secret.
sql(
  `INSERT INTO ai_config_items (id, type, scope, project_id, name, slug, content)
   VALUES ('lib-global', 'skill', 'global', NULL, 'GLOBAL_LIB_ITEM', 'global-lib', 'x')`
)
for (const [userId, mark] of [
  [a.userId, A.mark],
  [b.userId, B.mark],
  [adminId, ADM.mark]
] as const) {
  sql(
    `INSERT INTO user_settings (user_id, key, value) VALUES (?, 'sidebar_width', ?)`,
    userId,
    `${mark}_SETTING`
  )
}
for (const o of [A, B, ADM]) {
  sql(
    `INSERT INTO settings (key, value) VALUES (?, ?)`,
    `ai_providers:${o.project}`,
    `${o.mark}_PROVIDERS`
  )
}
sql(`INSERT INTO settings (key, value) VALUES ('integration:credential:x', 'INTERNAL_SECRET')`)

const ca = hubClient(hub, a.token)
const cb = hubClient(hub, b.token)
const cadmin = hubClient(hub, adminToken)
// The path-taking export/import forms are test-build only (`PLAYWRIGHT=1`, read per call).
process.env.PLAYWRIGHT = '1'
const out = realpathSync(mkdtempSync(join(tmpdir(), 'slz-t101-out-')))

afterAll(async () => {
  for (const s of subs) s.unsubscribe()
  delete process.env.PLAYWRIGHT
  raw.close()
  for (const c of [ca, cb, cadmin]) c.close()
  await hub.stop()
})

// ── T-101: export ──
const exportOf = async (client: Client, who: string): Promise<Record<string, unknown[]>> => {
  const file = join(out, `${who}.slay`)
  const r = await call(client, 'app.exportImport.testExportAllToPath', { filePath: file })
  expect(
    (r.data as { success?: boolean })?.success,
    `${who} export: ${JSON.stringify(r)}`
  ).toBeTruthy()
  return (JSON.parse(readFileSync(file, 'utf8')) as { data: Record<string, unknown[]> }).data
}

test("A's export holds A's content and none of B's or the admin's", async () => {
  const data = await exportOf(ca.client, 'a')
  expect(shows(data.projects, A.project), 'A’s rows').toBeTruthy()
  expect(shows(data.tasks, A.task), 'A’s rows').toBeTruthy()
  expect(shows(data.tags, `${A.mark}_TAG`), 'A’s tags, tabs').toBeTruthy()
  expect(shows(data.terminal_tabs, A.tab), 'A’s tags, tabs').toBeTruthy()
  expect(shows(data, B.mark), `others: ${JSON.stringify(data).slice(0, 300)}`).toBeFalsy()
  expect(shows(data, ADM.mark), `others: ${JSON.stringify(data).slice(0, 300)}`).toBeFalsy()
  // A's task blocks B's: a link to another user's task is not A's to export.
  expect((data.task_dependencies ?? []).length, 'cross-user dependency left out').toBe(0)
  expect(
    shows(data.ai_config_items, 'GLOBAL_LIB_ITEM'),
    'the hub-wide library is everyone’s'
  ).toBeTruthy()
  expect(shows(data.ai_config_items, `${A.mark}_SKILL_BODY`), 'A’s own skill').toBeTruthy()
  expect(shows(data.settings, `${A.mark}_SETTING`), 'A’s own settings').toBeTruthy()
  expect(shows(data.settings, `${A.mark}_PROVIDERS`), 'A’s project-keyed setting').toBeTruthy()
  expect(shows(data.settings, 'INTERNAL_SECRET'), 'no internal setting').toBeFalsy()
})

test("the admin's export holds only the admin's own content", async () => {
  const data = await exportOf(cadmin.client, 'admin')
  expect(shows(data.projects, ADM.project), 'admin’s project').toBeTruthy()
  expect(shows(data, A.mark), `others: ${JSON.stringify(data).slice(0, 300)}`).toBeFalsy()
  expect(shows(data, B.mark), `others: ${JSON.stringify(data).slice(0, 300)}`).toBeFalsy()
  expect(shows(data.settings, 'INTERNAL_SECRET'), 'no internal setting').toBeFalsy()
})

test("B's export holds none of A's", async () => {
  const data = await exportOf(cb.client, 'b')
  expect(shows(data.tasks, B.task), 'B’s rows').toBeTruthy()
  expect(shows(data, A.mark), JSON.stringify(data).slice(0, 300)).toBeFalsy()
  expect(shows(data, ADM.mark), JSON.stringify(data).slice(0, 300)).toBeFalsy()
})

test('exportAll is a user procedure now (it fails at the hub’s file dialog, not by role)', async () => {
  const r = await call(cb.client, 'app.exportImport.exportAll')
  expect(r.code, `B: ${JSON.stringify(r)}`).toBeUndefined()
  expect(shows(r, A.mark), 'no content in the answer').toBeFalsy()
})

test('backups: metadata over the wire, never readable back through a route', async () => {
  const created = await call(cadmin.client, 'app.backup.create', { name: 'n' })
  const file = (created.data as { filename?: string })?.filename
  expect(file, `admin creates a backup on the hub's disk: ${JSON.stringify(created)}`).toBeTruthy()
  const list = (await call(cadmin.client, 'app.backup.list')).data as Record<string, unknown>[]
  expect(Array.isArray(list), 'listed').toBeTruthy()
  expect(list.length, 'listed').toBeGreaterThanOrEqual(1)
  for (const row of list) {
    expect(Object.keys(row).sort().join(), `metadata only: ${Object.keys(row).join()}`).toBe(
      'filename,name,sizeBytes,timestamp,type'
    )
  }
  // The one admin route that reads a hub-host file by path refuses the backup.
  const before = lines.length
  const read = await call(cadmin.client, 'app.exportImport.testImportFromPath', {
    filePath: join(hub.root, 'backups', file!)
  })
  expect(read.code, JSON.stringify(read)).toBe('NOT_FOUND')
  expect(denials(before).length, JSON.stringify(read)).toBe(1)
  const byB = await call(cb.client, 'app.backup.list')
  expect(byB.code, `B: ${JSON.stringify(byB)}`).toBe('FORBIDDEN')
})

// ── T-105: MCP sessions ──
const sidA = await mcpSession(hub, a.token)
test("B and the admin get 404 MCP_SESSION_NOT_FOUND + one audit line on A's session", async () => {
  for (const [who, token, userId] of [
    ['B', b.token, b.userId],
    ['admin', adminToken, adminId]
  ] as const) {
    for (const [method, body] of [
      ['POST', toolsList(2)],
      ['GET', undefined],
      ['DELETE', undefined]
    ] as const) {
      const before = lines.length
      const r = await mcpFetch(hub, method, token, sidA, body)
      const text = await r.text()
      const d = denials(before)
      expect(r.status, `${who} ${method}: ${r.status} ${text} (${d.length} denials)`).toBe(404)
      expect(
        (JSON.parse(text) as { code?: string }).code,
        `${who} ${method}: ${r.status} ${text} (${d.length} denials)`
      ).toBe('MCP_SESSION_NOT_FOUND')
      expect(d.length, `${who} ${method}: ${r.status} ${text} (${d.length} denials)`).toBe(1)
      expect(d[0]!.actor, `${who} ${method}: ${r.status} ${text} (${d.length} denials)`).toBe(
        userId
      )
      expect(
        d[0]!.detail.resource,
        `${who} ${method}: ${r.status} ${text} (${d.length} denials)`
      ).toBe('mcp_session')
    }
  }
})

test('an unknown session id answers the same 404, without an audit line', async () => {
  const before = lines.length
  const r = await mcpFetch(hub, 'POST', b.token, randomUUID(), toolsList(3))
  const body = (await r.json()) as { code?: string }
  expect(r.status, `${r.status}`).toBe(404)
  expect(body.code, `${r.status}`).toBe('MCP_SESSION_NOT_FOUND')
  expect(denials(before).length, 'no audit for a miss').toBe(0)
})

test("A's session still works for A (B's DELETE did not close it)", async () => {
  const r = await mcpFetch(hub, 'POST', a.token, sidA, toolsList(4))
  const text = await r.text()
  expect(r.status, `${r.status} ${text.slice(0, 120)}`).toBe(200)
  expect(text, `${r.status} ${text.slice(0, 120)}`).toContain('create_task')
})

// ── T-106: automations ──
test("the admin gets NOT_FOUND on A's automations over tRPC; its own still work", async () => {
  const cases: [string, unknown][] = [
    ['automations.getByProject', { projectId: A.project }],
    ['automations.get', { id: A.automation }],
    ['automations.getRuns', { automationId: A.automation }],
    ['automations.runManual', { id: A.automation }],
    ['automations.toggle', { id: A.automation, enabled: false }],
    ['automations.delete', { id: A.automation }],
    ['automations.create', { project_id: A.project, name: 'x', trigger_config: {}, actions: [] }],
    ['automations.create', { name: 'no project', trigger_config: {}, actions: [] }]
  ]
  for (const [path, input] of cases) {
    const r = await call(cadmin.client, path, input)
    expect(r.code, `${path}: ${JSON.stringify(r)}`).toBe('NOT_FOUND')
    expect(shows(r, A.mark), `${path}: ${JSON.stringify(r)}`).toBeFalsy()
  }
  const still = raw.prepare('SELECT id FROM automations WHERE id = ?').get(A.automation)
  expect(still, "A's automation is untouched").toBeTruthy()
  const own = await call(cadmin.client, 'automations.getByProject', { projectId: ADM.project })
  expect(shows(own.data, ADM.automation), `admin's own: ${JSON.stringify(own)}`).toBeTruthy()
  const byB = await call(cb.client, 'automations.get', { id: A.automation })
  expect(byB.code, `B is refused by role: ${JSON.stringify(byB)}`).toBe('FORBIDDEN')
})

test("REST: the admin gets 404 on A's automations by project, id, prefix and run", async () => {
  for (const [method, path] of [
    ['GET', `/api/automations?project=${A.project}`],
    ['GET', '/api/automations?project=A_SECRET'],
    ['GET', `/api/automations/${A.automation}`],
    ['GET', `/api/automations/${A.automation.slice(0, 6)}`],
    ['GET', `/api/automations/${A.automation}/runs`],
    ['PATCH', `/api/automations/${A.automation}`],
    ['DELETE', `/api/automations/${A.automation}`],
    ['POST', `/api/automations/${A.automation}/run`]
  ] as const) {
    const r = await rest(
      hub,
      adminToken,
      method,
      path,
      method === 'PATCH' ? { name: 'x' } : undefined
    )
    expect(r.status, `${method} ${path}: ${r.status} ${r.text}`).toBe(404)
    expect(r.text, `${method} ${path}: ${r.status} ${r.text}`).not.toContain(A.mark)
  }
  const create = await rest(hub, adminToken, 'POST', '/api/automations', {
    project: A.project,
    name: 'x',
    trigger_config: { type: 'manual' },
    actions: [{ type: 'run_command', params: { command: 'true' } }]
  })
  expect(create.status, `create in A's project: ${create.status} ${create.text}`).toBe(404)
  // A prefix matching every automation resolves among the admin's own only.
  const any = await rest(hub, adminToken, 'GET', '/api/automations/%25')
  expect(any.status, `own: ${any.text}`).toBe(200)
  expect(any.text, `own: ${any.text}`).toContain(ADM.automation)
  expect(any.text, `wildcard: ${any.text}`).not.toContain(A.mark)
  expect(any.text, `wildcard: ${any.text}`).not.toContain(B.mark)
  const byB = await rest(hub, b.token, 'GET', `/api/automations/${A.automation}`)
  expect(byB.status, `B: ${byB.status} ${byB.text}`).toBe(403)
  expect(byB.text, `B: ${byB.status} ${byB.text}`).not.toContain(A.mark)
})

test('automations.onChanged: the admin gets its own pings, not one A caused', async () => {
  const got: unknown[] = []
  await new Promise<void>((resolve) => {
    const sub = procedureAt(cadmin.client, 'automations.onChanged').subscribe(undefined, {
      onStarted: () => resolve(),
      onData: (v) => got.push(v)
    })
    subs.push(sub)
  })
  const count = (): number => got.length
  asUser(a.userId, () => getAutomationsEvents().emit('changed'))
  await sleep(300)
  expect(count(), `A's ping reached the admin: ${count()}`).toBe(0)
  asUser(adminId, () => getAutomationsEvents().emit('changed'))
  await sleep(300)
  expect(count(), `the admin's own: ${count()}`).toBe(1)
})

// ── diagnostics ──
test("the admin's diagnostics bundle holds no event about A's task or session", async () => {
  recordDiagnosticEvent({
    level: 'info',
    source: 'server',
    event: 't101.task',
    taskId: A.task,
    message: 'A_SECRET_DIAG'
  })
  recordDiagnosticEvent({
    level: 'info',
    source: 'server',
    event: 't101.session',
    sessionId: `${A.task}:${A.tab}`,
    message: 'A_SECRET_SESSION_DIAG'
  })
  recordDiagnosticEvent({
    level: 'info',
    source: 'server',
    event: 't101.own',
    taskId: ADM.task,
    message: 'ADMIN_OWN_DIAG'
  })
  recordDiagnosticEvent({
    level: 'info',
    source: 'server',
    event: 't101.hub',
    message: 'HUB_LEVEL_DIAG'
  })
  const r = await call(cadmin.client, 'diagnostics.exportBundle', {
    fromTsMs: 0,
    toTsMs: Date.now() + 60_000,
    appVersion: 't'
  })
  const bundle = r.data as { events: unknown[]; summary: { total: number } } | null
  expect(bundle, `bundle: ${JSON.stringify(r)}`).toBeTruthy()
  expect(shows(bundle, A.mark), `A's events: ${JSON.stringify(bundle).slice(0, 400)}`).toBeFalsy()
  expect(shows(bundle?.events, 'ADMIN_OWN_DIAG'), 'kept').toBeTruthy()
  expect(shows(bundle?.events, 'HUB_LEVEL_DIAG'), 'kept').toBeTruthy()
  expect(bundle?.summary.total, 'summary recounted').toBe(bundle?.events.length)
})

// Last: the import gives the admin a project named like A's, which a name lookup
// above (`?project=A_SECRET`) would then rightly match.
test("an admin import neither reuses A's tag nor reveals A's project name", async () => {
  const bundle = join(out, 'import.slay')
  writeFileSync(
    bundle,
    JSON.stringify({
      meta: { version: 1, appVersion: 't', exportDate: '', scope: 'all', dbVersion: 36 },
      data: {
        projects: [{ id: 'src-p', name: `${A.mark}_PROJECT_NAME`, color: '#000000' }],
        tasks: [{ id: 'src-t', project_id: 'src-p', title: 'imported', provider_config: '{}' }],
        tags: [{ id: 'src-tag', project_id: 'src-p', name: `${A.mark}_TAG` }],
        task_tags: [{ task_id: 'src-t', tag_id: 'src-tag' }],
        task_dependencies: [],
        terminal_tabs: [],
        ai_config_items: [],
        ai_config_project_selections: [],
        ai_config_sources: [],
        settings: []
      }
    })
  )
  const r = await call(cadmin.client, 'app.exportImport.testImportFromPath', {
    filePath: bundle
  })
  const result = r.data as {
    success?: boolean
    importedProjects?: { id: string; name: string }[]
  }
  expect(result?.success, JSON.stringify(r)).toBeTruthy()
  const imported = result.importedProjects![0]!
  expect(imported.name, `renamed: ${imported.name}`).toBe(`${A.mark}_PROJECT_NAME`)
  const tag = raw
    .prepare(
      `SELECT g.id, g.project_id FROM task_tags tt JOIN tasks t ON t.id = tt.task_id
         JOIN tags g ON g.id = tt.tag_id WHERE t.project_id = ?`
    )
    .get(imported.id) as { id: string; project_id: string } | undefined
  expect(tag, JSON.stringify(tag)).toBeTruthy()
  expect(tag?.id, JSON.stringify(tag)).not.toBe(A.tag)
  expect(tag?.project_id, JSON.stringify(tag)).toBe(imported.id)
})
