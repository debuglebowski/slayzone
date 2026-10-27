/**
 * T-18, the two-user contract over REST, MCP and agent hooks on a REAL hub with login
 * (`startServer()` in this process — its real auth, bearer gate, `/api/*` and `/mcp`;
 * see owner-checks-harness.ts for why in-process). User A and user B are ordinary
 * accounts signed in through `/api/auth`; the admin is the hub's bootstrap owner.
 *
 *   - B gets 404, with one `authz.denied` line, for A's ids on EVERY id-checked REST
 *     route and MCP tool. The cases are generated from `REST_OWNER_POLICY` /
 *     `MCP_OWNER_POLICY`: one per id the policy names, so a route or tool added to it
 *     is covered without editing this file. A passes the gate with the same input.
 *   - B's lists hold none of A's rows (and a cross-project blocker of B's task is cut);
 *     an id prefix or project name only ever reaches B's own rows.
 *   - B cannot fetch A's artifact file — by id, by prefix, by a crafted id, through a
 *     version, or by having an export WRITTEN into A's artifact directory.
 *   - A hook event naming A's task (or only an old session id), relayed by B's computer
 *     (or an unowned one), changes nothing — neither A's task nor B's — and is audited; A's own
 *     computer's event is processed and attributed to A. Same over `POST /api/agent-hook`.
 *   - REST refresh pings are attributed to their caller (T-17's stream filter).
 *   - The admin gets exactly what B gets of A's: nothing.
 *
 * The hub without login is `owner-checks-http-login-off.test.ts`; the exhaustiveness
 * of the policy is `transport/src/server/http-owner-policy.test.ts`.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/hub/src/owner-checks-http.test.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { currentSecurityContext, setSecurityLogSink } from '@slayzone/platform/security-log'
import {
  MCP_OWNER_POLICY,
  REST_ADMIN_POLICY,
  REST_OWNER_POLICY,
  createAccessScope,
  type HttpIdRef,
  type HttpOwnerRule,
  type RestApiDeps,
  type TerminalStateBridge
} from '@slayzone/transport/server'
import { createSlayzoneDbAdapter } from '../../../shared/test-utils/ipc-harness.js'
// Reached by path (the same module instances the hub runs: workspace symlinks resolve
// to these files) — the gates themselves, to show A passes them without side effects.
import { ownerRouteGuard } from '../../../shared/transport/src/server/http/rest-api/owner-routes.js'
import { withMcpOwnerGate } from '../../../shared/transport/src/server/http/mcp-tools/owner-gate.js'
import { bindRestPrincipal } from '../../../shared/transport/src/server/http/rest-api/principal.js'
import { mcpAuthInfo } from '../../../shared/transport/src/server/http/mcp-tools/admin-gate.js'
import { httpAccessRequest } from '../../../shared/transport/src/server/http/owner-scope.js'
import { relayAgentHook } from './agent-hook-relay-consumer.js'
import {
  bootInProcessHub,
  hubClient,
  ownedBy,
  procedureAt,
  seedOwned,
  seedShared,
  signedInUser,
  type InProcessHub,
  type Owned
} from './owner-checks-harness.js'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface AuditLine {
  event: string
  actor: string | null
  targetKind: string | null
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

const shows = (v: unknown, mark: string): boolean => JSON.stringify(v ?? null).includes(mark)

// ── requests ──────────────────────────────────────────────────────────────────

interface Req {
  method: string
  path: string
  params: Record<string, string>
  query: Record<string, string>
  body: Record<string, unknown> | undefined
}

/** The id a reference names in `o`'s fixtures. */
function idOf(o: Owned, ref: HttpIdRef): string {
  return o[ref.kind as keyof Owned] as string
}

/** Put `value` at a `body.x` / `body.x[]` / `query.x` / `params.x` location. */
function place(req: Req, at: string, value: string): void {
  const [where, field] = at.split('.') as [keyof Req, string]
  const isArray = field.endsWith('[]')
  const name = isArray ? field.slice(0, -2) : field
  if (where === 'params') req.params[name] = value
  else if (where === 'query') req.query[name] = value
  else (req.body ??= {})[name] = isArray ? [value] : value
}

/**
 * The request for `key` that names `whose` resource at `ref`, every other path
 * parameter filled with the caller's own (so the case isolates the one under test).
 */
function requestFor(
  key: string,
  rule: HttpOwnerRule,
  ref: HttpIdRef,
  whose: Owned,
  own: Owned
): Req {
  const [method, path] = key.split(' ') as [string, string]
  const req: Req = { method, path, params: {}, query: {}, body: undefined }
  for (const m of path.matchAll(/:([A-Za-z]+)/g)) {
    const other = rule.ids?.find((r) => r.at === `params.${m[1]}`)
    req.params[m[1]!] = other ? idOf(own, other) : 'x'
  }
  place(req, ref.at, idOf(whose, ref))
  return req
}

function urlOf(hub: InProcessHub, req: Req): string {
  const path = req.path.replace(/:([A-Za-z]+)/g, (_, n: string) =>
    encodeURIComponent(req.params[n]!)
  )
  const qs = new URLSearchParams(req.query).toString()
  return `http://127.0.0.1:${hub.port}${path}${qs ? `?${qs}` : ''}`
}

async function rest(
  hub: InProcessHub,
  token: string,
  req: Req
): Promise<{ status: number; body: unknown; text: string }> {
  const r = await fetch(urlOf(hub, req), {
    method: req.method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: req.method === 'GET' ? undefined : JSON.stringify(req.body ?? {})
  })
  const text = await r.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // not JSON (a file, a stream)
  }
  return { status: r.status, body, text }
}

const get = (path: string, query: Record<string, string> = {}): Req => ({
  method: 'GET',
  path,
  params: {},
  query,
  body: undefined
})

/** The guard alone, for the owner: does it let the request through? */
async function guardPasses(
  db: RestApiDeps['db'],
  key: string,
  userId: string,
  req: Req
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const fake = {
      method: req.method,
      url: req.path,
      params: req.params,
      query: req.query,
      body: req.body,
      headers: {},
      socket: {}
    }
    bindRestPrincipal(fake as never, { userId, role: 'user', scopes: ['full'] })
    const res = {
      statusCode: 200,
      headersSent: false,
      status(c: number) {
        this.statusCode = c
        return this
      },
      json() {
        resolve(false)
        return this
      }
    }
    ownerRouteGuard(key, db)(fake as never, res as never, () => resolve(true)).catch(reject)
  })
}

// ── MCP over the real `/mcp` endpoint ─────────────────────────────────────────

type ToolResult = { isError?: boolean; content: { text: string }[] }

async function mcpClient(
  hub: InProcessHub,
  token: string
): Promise<(name: string, args: Record<string, unknown>) => Promise<ToolResult>> {
  const url = `http://127.0.0.1:${hub.port}/mcp`
  let id = 0
  const post = async (sid: string | null, msg: unknown): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        ...(sid ? { 'mcp-session-id': sid } : {})
      },
      body: JSON.stringify(msg)
    })
  const parse = (text: string): { result?: ToolResult; error?: unknown } => {
    if (text.trim().startsWith('{')) return JSON.parse(text)
    const data = text
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6))
    return JSON.parse(data[data.length - 1]!)
  }
  const init = await post(null, {
    jsonrpc: '2.0',
    id: ++id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'owner-checks', version: '1' }
    }
  })
  const sid = init.headers.get('mcp-session-id')
  await init.text()
  if (!sid) throw new Error(`mcp initialize: ${init.status}`)
  await (await post(sid, { jsonrpc: '2.0', method: 'notifications/initialized' })).text()
  return async (name, args) => {
    const r = await post(sid, {
      jsonrpc: '2.0',
      id: ++id,
      method: 'tools/call',
      params: { name, arguments: args }
    })
    const msg = parse(await r.text())
    if (!msg.result) throw new Error(`${name}: ${JSON.stringify(msg.error ?? msg)}`)
    return msg.result
  }
}

/** Arguments a tool's schema requires, so a call reaches the gate. */
const MCP_REQUIRED: Record<string, (own: Owned) => Record<string, unknown>> = {
  create_task: (own) => ({ projectId: own.project, title: 't' }),
  create_subtask: () => ({ title: 't' })
}

function mcpArgsFor(
  name: string,
  ref: HttpIdRef,
  whose: Owned,
  own: Owned
): Record<string, unknown> {
  const args = { ...(MCP_REQUIRED[name]?.(own) ?? {}) }
  const field = ref.at.replace(/\[\]$/, '')
  args[field] = ref.at.endsWith('[]') ? [idOf(whose, ref)] : idOf(whose, ref)
  return args
}

// ── the test ──────────────────────────────────────────────────────────────────

describe('T-18 owner checks: REST, MCP and hooks for two users on a real hub with login', () => {
  let hub: InProcessHub
  let a: { userId: string; token: string }
  let b: { userId: string; token: string }
  let admin: { userId: string; token: string }
  let A: Owned
  let B: Owned
  let raw: Database.Database
  let db: RestApiDeps['db']
  let mcpA: Owned
  let mcpB: Owned
  const counts = { restIds: 0, mcpIds: 0 }

  beforeAll(async () => {
    hub = await bootInProcessHub({ login: true })
    a = await signedInUser(hub, 'a@example.com')
    b = await signedInUser(hub, 'b@example.com')
    admin = { userId: hub.adminUserId!, token: hub.adminToken! }
    A = ownedBy('A_SECRET', a.userId, hub.root)
    B = ownedBy('B_OWN', b.userId, hub.root)
    seedOwned(hub.dbPath, A)
    seedOwned(hub.dbPath, B)
    seedShared(hub.dbPath, A, B)
    // Real artifact files: `<ROOT>/artifacts/<taskId>/<artifactId>.txt` (title has no ext).
    for (const o of [A, B]) {
      mkdirSync(join(hub.root, 'artifacts', o.task), { recursive: true })
      writeFileSync(
        join(hub.root, 'artifacts', o.task, `${o.artifact}.txt`),
        `${o.mark}_FILE_BYTES`
      )
    }
    raw = new Database(hub.dbPath)
    db = createSlayzoneDbAdapter(raw)
    // The harness's second task (`<mark>_task_hibernated`) shares the `<mark>_task` prefix,
    // which a CLI prefix lookup would rightly call ambiguous: not needed here.
    raw
      .prepare(`DELETE FROM terminal_tabs WHERE task_id LIKE '%\\_task\\_hibernated' ESCAPE '\\'`)
      .run()
    raw.prepare(`DELETE FROM tasks WHERE id LIKE '%\\_task\\_hibernated' ESCAPE '\\'`).run()
    // Several MCP tools take a task id that must be a uuid (zod), checked before the gate.
    const uuidTask = (o: Owned, id: string): Owned => {
      raw
        .prepare(`INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?)`)
        .run(id, o.project, `${o.mark}_MCP_TASK`)
      return { ...o, task: id }
    }
    mcpA = uuidTask(A, '0a0a0a0a-0000-4000-8000-00000000000a')
    mcpB = uuidTask(B, '0b0b0b0b-0000-4000-8000-00000000000b')
    raw
      .prepare(
        `INSERT INTO computers (id, name, platform, version, capabilities_json, created_at, owner_user_id)
         VALUES (?, ?, 'linux', '1', '{}', 0, ?)`
      )
      .run('comp-a', 'a', a.userId)
    raw
      .prepare(
        `INSERT INTO computers (id, name, platform, version, capabilities_json, created_at, owner_user_id)
         VALUES (?, ?, 'linux', '1', '{}', 0, ?)`
      )
      .run('comp-b', 'b', b.userId)
    raw
      .prepare(
        `INSERT INTO computers (id, name, platform, version, capabilities_json, created_at, owner_user_id)
         VALUES (?, ?, 'linux', '1', '{}', 0, NULL)`
      )
      .run('comp-unowned', 'u')
  })

  afterAll(async () => {
    raw?.close()
    await hub?.stop()
    console.log(`\n  REST id cases: ${counts.restIds} · MCP id cases: ${counts.mcpIds}`)
  })

  // ── REST: every id the policy names ──
  test('REST: B and the admin get 404 + one audit line on every id A owns; A passes the gate', async () => {
    const failures: string[] = []
    for (const [key, rule] of Object.entries(REST_OWNER_POLICY)) {
      for (const ref of rule.ids ?? []) {
        counts.restIds++
        for (const [who, token, userId] of [
          ['B', b.token, b.userId],
          ['admin', admin.token, admin.userId]
        ] as const) {
          const before = lines.length
          const req = requestFor(key, rule, ref, A, B)
          const r = await rest(hub, token, req)
          const d = denials(before)
          if (who === 'B' && REST_ADMIN_POLICY[key] === 'admin') {
            // An `admin` route refuses B by role (403 ADMIN_ONLY) before any id is
            // read; the admin, next, by owner (T-106).
            if (r.status !== 403 || d[0]?.detail.reason !== 'not_admin' || r.text.includes(A.mark))
              failures.push(`B ${key} ${ref.at}: ${r.status} ${r.text.slice(0, 120)}`)
            continue
          }
          // The admin owns no companion either: its refusal may come at another id.
          const ok =
            r.status === 404 &&
            (r.body as { error?: string })?.error === 'Not found' &&
            d.length === 1 &&
            d[0]!.detail.reason === 'not_owner' &&
            (who === 'admin' || d[0]!.detail.at === ref.at) &&
            d[0]!.actor === userId &&
            !r.text.includes(A.mark)
          if (!ok)
            failures.push(
              `${who} ${key} ${ref.at}: ${r.status} ${r.text.slice(0, 120)} (${d.length} denials)`
            )
        }
        const before = lines.length
        const passes = await guardPasses(db, key, a.userId, requestFor(key, rule, ref, A, A))
        if (!passes || denials(before).length !== 0) failures.push(`A ${key} ${ref.at}: refused`)
      }
    }
    expect(failures).toEqual([])
    // REST id cases
    expect(counts.restIds).toBeGreaterThan(100)
  })

  test('REST: an id prefix or a project name only ever reaches the caller’s rows', async () => {
    // A's id prefix: someone else's → 404, never "ambiguous" with A's ids in it.
    const prefix = await rest(hub, b.token, get(`/api/tasks/${A.task.slice(0, 6)}`))
    expect(prefix.status, `prefix: ${prefix.text}`).toBe(404)
    expect(prefix.text).not.toContain(A.mark)
    // A prefix matching BOTH users' tasks (`%` matches any) resolves among B's only.
    const any = await rest(hub, b.token, get('/api/tasks/%25/progress'))
    // wildcard prefix must not leak
    expect(any.text).not.toContain(A.mark)
    // A project name substring of A's project: 404, and no "Available:" list of names.
    const byName = await rest(hub, b.token, get('/api/tags', { project: 'SECRET' }))
    expect(byName.status, `name: ${byName.text}`).toBe(404)
    expect(byName.text).not.toContain(A.mark)
    const miss = await rest(hub, b.token, get('/api/templates', { project: 'no-such-project' }))
    expect(miss.status, `miss: ${miss.text}`).toBe(404)
    expect(miss.text).not.toContain(A.mark)
    // B's own name and prefix still work.
    const own = await rest(hub, b.token, get('/api/tags', { project: 'B_OWN' }))
    expect(own.status, `own: ${own.text}`).toBe(200)
    expect(JSON.stringify(own.body ?? null)).toContain('B_OWN_TAG')
    const ownPrefix = await rest(hub, b.token, get(`/api/tasks/${B.task.slice(0, 7)}`))
    expect(ownPrefix.status, `own prefix: ${ownPrefix.text}`).toBe(200)
    expect(JSON.stringify(ownPrefix.body ?? null)).toContain(B.task)
  })

  // ── REST: lists ──
  test('REST: B’s and the admin’s lists hold none of A’s rows; A’s hold them', async () => {
    const lists: Req[] = [
      get('/api/projects'),
      get('/api/tasks'),
      get('/api/tasks', { limit: '1' }),
      get('/api/tasks/search', { q: 'task' }),
      get('/api/artifacts/search', { allTasks: '1', q: '_' })
    ]
    for (const req of lists) {
      const label = `${req.path}?${new URLSearchParams(req.query)}`
      const ra = await rest(hub, a.token, req)
      expect(ra.status, `A on ${label}`).toBe(200)
      expect(shows(ra.body, A.mark), `A sees own rows on ${label}: ${ra.text.slice(0, 200)}`).toBe(
        true
      )
      const rb = await rest(hub, b.token, req)
      expect(rb.status, `B on ${label}`).toBe(200)
      expect(shows(rb.body, A.mark), `B sees A on ${label}: ${rb.text.slice(0, 200)}`).toBe(false)
      expect(shows(rb.body, B.mark), `B sees own rows on ${label}: ${rb.text.slice(0, 200)}`).toBe(
        true
      )
      const rad = await rest(hub, admin.token, req)
      expect(shows(rad.body, A.mark), `admin sees A content on ${label}`).toBe(false)
      expect(shows(rad.body, B.mark), `admin sees B content on ${label}`).toBe(false)
    }
    const search = (
      await rest(hub, b.token, get('/api/artifacts/search', { allTasks: '1', q: '_' }))
    ).body as { data: { scannedCount: number } }
    // B scanned exactly its own artifact
    expect(search.data.scannedCount).toBe(1)
  })

  test('REST: a cross-project blocker (A’s task blocks B’s) is cut from B’s task', async () => {
    const dep = raw
      .prepare(
        'SELECT COUNT(*) AS n FROM task_dependencies WHERE task_id = ? AND blocks_task_id = ?'
      )
      .get(A.task, B.task) as { n: number }
    // the dependency exists
    expect(dep.n).toBe(1)
    for (const path of [
      `/api/tasks/${B.task}`,
      `/api/tasks/${B.task}/blockers`,
      `/api/tasks/${B.task}/blocked`
    ]) {
      const r = await rest(hub, b.token, get(path))
      expect(r.status, `${path}: ${r.text.slice(0, 200)}`).toBe(200)
      expect(r.text, path).not.toContain(A.mark)
    }
    const blocking = await rest(hub, a.token, get(`/api/tasks/${A.task}/blocking`))
    expect(blocking.status, `A's blocking: ${blocking.text}`).toBe(200)
    expect(blocking.text).not.toContain(B.mark)
  })

  test('REST: the pty and process lists are cut to the caller’s sessions and tasks', async () => {
    const scope = createAccessScope(db, httpAccessRequest(b.userId))
    const ptys = (await REST_OWNER_POLICY['GET /api/pty']!.output!(
      [{ sessionId: A.session }, { sessionId: B.session }, { sessionId: `${A.task}:${A.tab}` }],
      scope
    )) as unknown[]
    expect(ptys).toEqual([{ sessionId: B.session }])
    const procs = (await REST_OWNER_POLICY['GET /api/processes']!.output!(
      [
        { id: 'p1', taskId: A.task },
        { id: 'p2', taskId: B.task },
        { id: 'p3', projectId: A.project },
        { id: 'p4' }
      ],
      scope
    )) as { id: string }[]
    expect(procs.map((p) => p.id)).toEqual(['p2'])
  })

  // ── artifact files ──
  test('REST: B cannot fetch A’s artifact file by id, prefix, crafted id or version', async () => {
    const own = await rest(hub, a.token, get(`/api/artifacts/${A.artifact}/content`))
    // A reads own file
    expect(own.status).toBe(200)
    expect(own.text).toBe('A_SECRET_FILE_BYTES')
    const crafted = [
      A.artifact,
      A.artifact.slice(0, 5),
      `../${A.task}/${A.artifact}`,
      `..%2F..%2Fartifacts%2F${A.task}%2F${A.artifact}`,
      `${B.artifact}/../${A.artifact}`
    ]
    for (const id of crafted) {
      for (const path of [
        `/api/artifacts/${encodeURIComponent(id)}/content`,
        `/api/artifacts/${encodeURIComponent(id)}/versions/content?ref=1`
      ]) {
        const r = await fetch(`http://127.0.0.1:${hub.port}${path}`, {
          headers: { authorization: `Bearer ${b.token}` }
        })
        const text = await r.text()
        expect(text, path).not.toContain('A_SECRET_FILE_BYTES')
        expect(text, path).not.toContain(A.mark)
        expect([404, 400], `${path}: ${r.status}`).toContain(r.status)
      }
    }
    const ownB = await rest(hub, b.token, get(`/api/artifacts/${B.artifact}/content`))
    // B reads own file
    expect(ownB.text).toBe('B_OWN_FILE_BYTES')
  })

  test('REST: an export cannot be written into A’s artifact dir or the hub’s state', async () => {
    for (const outputPath of [
      join(hub.root, 'artifacts', A.task, 'planted.html'),
      join(A.path, 'planted.html'),
      join(hub.root, 'slayzone.data.sqlite')
    ]) {
      const before = lines.length
      const r = await rest(hub, b.token, {
        method: 'POST',
        path: '/api/artifacts/:id/export/html',
        params: { id: B.artifact },
        query: {},
        body: { outputPath }
      })
      expect(r.status, `${outputPath}: ${r.status} ${r.text}`).toBe(404)
      expect(denials(before), outputPath).toHaveLength(1)
    }
  })

  // ── MCP ──
  test('MCP: B and the admin get "Not found" + one audit line on every id A owns; A passes', async () => {
    const callB = await mcpClient(hub, b.token)
    const callAdmin = await mcpClient(hub, admin.token)
    const failures: string[] = []
    for (const [name, rule] of Object.entries(MCP_OWNER_POLICY)) {
      for (const ref of rule.ids ?? []) {
        counts.mcpIds++
        for (const [who, call, userId] of [
          ['B', callB, b.userId],
          ['admin', callAdmin, admin.userId]
        ] as const) {
          const before = lines.length
          const r = await call(name, mcpArgsFor(name, ref, mcpA, mcpB))
          const d = denials(before)
          const ok =
            r.isError === true &&
            r.content[0]?.text === 'Not found' &&
            d.length === 1 &&
            d[0]!.actor === userId &&
            (who === 'admin' || d[0]!.detail.at === ref.at)
          if (!ok)
            failures.push(`${who} ${name} ${ref.at}: ${JSON.stringify(r)} (${d.length} denials)`)
        }
        // A, through the gate alone (the tools mutate).
        const ran: string[] = []
        let handler: ((...x: unknown[]) => Promise<unknown>) | undefined
        withMcpOwnerGate(
          {
            tool: (_n: string, ...rest: unknown[]) =>
              void (handler = rest[rest.length - 1] as never)
          } as never,
          db
        ).tool(name, 'd', {}, async () => {
          ran.push(name)
          return { content: [] }
        })
        await handler!(mcpArgsFor(name, ref, mcpA, mcpA), {
          authInfo: mcpAuthInfo({ userId: a.userId, role: 'user', scopes: ['full'] })
        })
        if (ran.length !== 1) failures.push(`A ${name} ${ref.at}: refused`)
      }
    }
    expect(failures).toEqual([])
    // B's own call reaches the tool: B's task id is answered.
    const own = await callB('get_current_task_id', { task_id: B.task })
    expect(own.isError, `B's own: ${JSON.stringify(own)}`).toBeFalsy()
    expect(JSON.stringify(own)).toContain(B.task)
  })

  // ── hooks ──
  const hookEvents: { taskId?: string; actor: string | null | undefined }[] = []
  const lifecycle = new EventEmitter()
  lifecycle.on('event', (e: { taskId?: string }) =>
    hookEvents.push({ taskId: e.taskId, actor: currentSecurityContext()?.actor })
  )
  const transitions: string[] = []
  const bridge: TerminalStateBridge = {
    findSession: (taskId) => `pty-${taskId}`,
    transition: (sid) => {
      transitions.push(sid)
      return true
    },
    markActive: (sid) => {
      transitions.push(sid)
      return true
    }
  }
  const deps = (): RestApiDeps =>
    ({
      db,
      notifyRenderer: () => {},
      agentLifecycle: lifecycle
    }) as unknown as RestApiDeps
  const prompt = (o: Owned | null, mark: string, extra: Record<string, unknown> = {}) => ({
    agentId: 'claude-code',
    ctx: { v: 1, agentId: 'claude-code', ...(o ? { taskId: o.task } : {}), ...extra },
    raw: { hook_event_name: 'UserPromptSubmit', prompt: mark, session_id: `conv-${mark}` }
  })
  const promptsFor = (taskId: string): number =>
    (
      raw.prepare('SELECT COUNT(*) AS n FROM agent_prompts WHERE task_id = ?').get(taskId) as {
        n: number
      }
    ).n
  const turnMarked = (mark: string): boolean =>
    !!raw.prepare('SELECT 1 FROM session_turns WHERE conversation_id = ?').get(`conv-${mark}`)

  test('hooks: B’s computer cannot change A’s task, and a session id attributes nothing; audited', async () => {
    const aPrompts = promptsFor(A.task)
    const bPrompts = promptsFor(B.task)
    const cases: [string, unknown][] = [
      ['A task', prompt(A, 'H1')],
      // An agent booted by an older build named itself by session id; that names no
      // task any more, so it cannot be used to reach A's.
      ['A session (older agent)', prompt(null, 'H2', { slaySessionId: A.session })],
      ['nothing to attribute', prompt(null, 'H4')]
    ]
    for (const [label, payload] of cases) {
      const before = lines.length
      hookEvents.length = 0
      transitions.length = 0
      const r = await relayAgentHook('comp-b', payload, deps(), bridge)
      await sleep(50)
      expect(r, label).toBe('denied')
      // not processed
      expect(hookEvents, label).toEqual([])
      expect(transitions, label).toEqual([])
      const d = denials(before)
      expect(d, label).toHaveLength(1)
      expect(d[0]!.targetKind, label).toBe('computer')
      expect(d[0]!.targetId, label).toBe('comp-b')
      // reported as B
      expect(d[0]!.actor, label).toBe(b.userId)
    }
    // no prompt captured
    expect(promptsFor(A.task)).toBe(aPrompts)
    expect(promptsFor(B.task)).toBe(bPrompts)
    for (const m of ['H1', 'H2', 'H4']) expect(turnMarked(m), `${m} marked a turn`).toBe(false)
  })

  test('hooks: an unowned computer reports for nobody', async () => {
    const before = lines.length
    const r = await relayAgentHook('comp-unowned', prompt(A, 'H5'), deps(), bridge)
    expect(r).toBe('denied')
    expect(denials(before)).toHaveLength(1)
  })

  test('hooks: A’s computer reporting for A’s task is processed, as A', async () => {
    hookEvents.length = 0
    transitions.length = 0
    const aPrompts = promptsFor(A.task)
    const before = lines.length
    const r = await relayAgentHook('comp-a', prompt(A, 'H6'), deps(), bridge)
    await sleep(100)
    expect(r).toBe('ok')
    // lifecycle event, attributed to A
    expect(hookEvents).toEqual([{ taskId: A.task, actor: a.userId }])
    // state machine driven
    expect(transitions).toHaveLength(1)
    // prompt captured
    expect(promptsFor(A.task)).toBe(aPrompts + 1)
    // nothing refused
    expect(denials(before)).toEqual([])
  })

  test('hooks: POST /api/agent-hook is reported as the caller', async () => {
    const post = (token: string, payload: unknown) =>
      rest(hub, token, {
        method: 'POST',
        path: '/api/agent-hook',
        params: {},
        query: {},
        body: payload as never
      })
    const aPrompts = promptsFor(A.task)
    const before = lines.length
    const byB = await post(b.token, prompt(A, 'H7'))
    expect(byB.status, `B: ${byB.text}`).toBe(404)
    expect(denials(before)).toHaveLength(1)
    const byAdmin = await post(admin.token, prompt(A, 'H8'))
    expect(byAdmin.status, 'admin').toBe(404)
    const byA = await post(a.token, prompt(A, 'H9'))
    await sleep(100)
    expect(byA.status, `A: ${byA.text}`).toBe(200)
    // only A’s own prompt was captured
    expect(promptsFor(A.task)).toBe(aPrompts + 1)
  })

  // ── attribution of REST refresh pings ──
  test('REST: a refresh ping reaches its caller’s stream only (attributed)', async () => {
    const ca = hubClient(hub, a.token)
    const cb = hubClient(hub, b.token)
    const got: Record<string, number> = { A: 0, B: 0 }
    const subs = await Promise.all(
      (
        [
          ['A', ca],
          ['B', cb]
        ] as const
      ).map(
        ([who, c]) =>
          new Promise<{ unsubscribe: () => void }>((resolve, reject) => {
            const s = procedureAt(c.client, 'notify.onTasksChanged').subscribe(undefined, {
              onStarted: () => resolve(s),
              onData: () => got[who]!++,
              onError: reject
            })
          })
      )
    )
    await rest(hub, b.token, {
      method: 'POST',
      path: '/api/notify',
      params: {},
      query: {},
      body: {}
    })
    await rest(hub, b.token, {
      method: 'PATCH',
      path: '/api/tasks/:id',
      params: { id: B.task },
      query: {},
      body: { title: 'renamed by B' }
    })
    await sleep(400)
    for (const s of subs) s.unsubscribe()
    ca.close()
    cb.close()
    expect(got.B).toBeGreaterThanOrEqual(1)
    // A gets none of B's pings
    expect(got.A).toBe(0)
  })
})
