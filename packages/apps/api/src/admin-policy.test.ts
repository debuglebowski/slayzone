/**
 * The account-role gate (T-15), table-driven over the LIVE surfaces:
 *
 *   - exhaustiveness: every tRPC procedure, REST route and MCP tool that exists is
 *     classified, and nothing classified is gone — an unclassified item fails here by
 *     name (same guarantee as `scopes.test.ts`);
 *   - a non-admin account is refused every `admin` item, with the stable code and one
 *     audit line, over tRPC, REST and MCP; an admin account is not;
 *   - `open` is exactly what needs no session today (nothing new is opened);
 *   - a hub without login (the desktop app's) is untouched;
 *   - the `CONDITIONAL_ADMIN` items refuse a non-admin only for the inputs listed.
 *
 * Handlers are never meant to succeed here: there is no database (`NO_DB` throws on
 * any use). "Passed the gate" means the call failed, if at all, with anything but
 * the role refusal.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { TRPCError } from '@trpc/server'
import { appRouter } from './router'
import { setAuthGate, isAdminOnlyError, type TrpcContext } from '@slayzone/trpc-server'
import {
  ADMIN_ONLY,
  CONDITIONAL_ADMIN,
  MCP_ADMIN_POLICY,
  REST_ADMIN_POLICY,
  TRPC_ADMIN_POLICY,
  roleAllows,
  type AccessClass
} from './admin-policy'
import { registerRestApi } from './http/rest-api'
import { adminRouteGuard, restRouteKey, withAdminGate } from './http/rest-api/admin-routes'
import { bindRestPrincipal } from './http/rest-api/principal'
import type { RestApiDeps, RestPrincipal } from './http/rest-api/types'
import { registerMcpTools } from './http/mcp-tools'
import { mcpAuthInfo, withMcpAdminGate } from './http/mcp-tools/admin-gate'
import { settingWriteNeedsAdmin } from './routers/settings-admin'
import { withoutPtyOutput } from './routers/diagnostics'

const NO_DB = new Proxy(
  {},
  {
    get() {
      throw new Error('no database in this test')
    }
  }
) as TrpcContext['db']

const USER: RestPrincipal = { userId: 'u-user', role: 'user', scopes: ['full'] }
const ADMIN: RestPrincipal = { userId: 'u-admin', role: 'admin', scopes: ['full'] }

const ofClass = (policy: Record<string, AccessClass>, cls: AccessClass): string[] =>
  Object.keys(policy)
    .filter((k) => policy[k] === cls)
    .sort()

/** Live items the policy does not classify. The exhaustiveness check, as a function,
 *  so it can itself be shown to catch an unclassified item. */
const unclassified = (live: string[], policy: Record<string, AccessClass>): string[] =>
  live.filter((k) => !(k in policy))

// ── the live surfaces ────────────────────────────────────────────────────────

const LIVE_TRPC = Object.keys(appRouter._def.procedures).sort()

function liveRestKeys(): string[] {
  const keys: string[] = []
  const app: Record<string, unknown> = {}
  for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
    app[m] = (path: string) => {
      keys.push(restRouteKey(m, path))
    }
  }
  registerRestApi(app as never, { db: NO_DB, notifyRenderer: () => {} })
  return keys.sort()
}
const LIVE_REST = liveRestKeys()

/** Registers the real tools on a stub server; returns name → the handler the SDK
 *  would call (already behind the role gate). */
function liveMcpTools(): Map<string, (...args: unknown[]) => unknown> {
  const tools = new Map<string, (...args: unknown[]) => unknown>()
  const stub = {
    tool: (name: string, ...rest: unknown[]) => {
      tools.set(name, rest[rest.length - 1] as (...args: unknown[]) => unknown)
    }
  }
  registerMcpTools(stub as never, { db: NO_DB, notifyRenderer: () => {} })
  return tools
}
const LIVE_MCP = [...liveMcpTools().keys()].sort()

describe('exhaustiveness: every live item is classified, nothing stale', () => {
  const surfaces: Array<[string, string[], Record<string, AccessClass>]> = [
    ['tRPC procedure', LIVE_TRPC, TRPC_ADMIN_POLICY],
    ['REST route', LIVE_REST, REST_ADMIN_POLICY],
    ['MCP tool', LIVE_MCP, MCP_ADMIN_POLICY]
  ]
  for (const [surface, live, policy] of surfaces) {
    test(`every live ${surface} is classified`, () => {
      const missing = unclassified(live, policy)
      expect(missing, `unclassified (add to the policy): ${missing.join(', ')}`).toEqual([])
    })
    test(`no ${surface} entry names something that no longer exists`, () => {
      const stale = Object.keys(policy).filter((k) => !live.includes(k))
      expect(stale, `stale (remove from the policy): ${stale.join(', ')}`).toEqual([])
    })
  }

  test('the check names an unclassified item', () => {
    expect(unclassified([...LIVE_TRPC, 'brandNew.procedure'], TRPC_ADMIN_POLICY)).toEqual([
      'brandNew.procedure'
    ])
    expect(unclassified([...LIVE_REST, 'POST /api/brand-new'], REST_ADMIN_POLICY)).toEqual([
      'POST /api/brand-new'
    ])
  })

  test('the surfaces are the size the policy was written against', () => {
    // A sanity floor, not a pin: the harness above found the real surfaces.
    expect(LIVE_TRPC.length).toBeGreaterThan(600)
    expect(LIVE_REST.length).toBeGreaterThan(100)
    expect(LIVE_MCP.length).toBeGreaterThan(5)
  })

  test('every CONDITIONAL_ADMIN item is a live `user` item', () => {
    for (const key of Object.keys(CONDITIONAL_ADMIN)) {
      expect(TRPC_ADMIN_POLICY[key] ?? REST_ADMIN_POLICY[key], key).toBe('user')
    }
  })
})

describe('classification: the admin items the hub needs', () => {
  const admin: string[] = [
    'hub.setLabel',
    'computers.mintJoinToken',
    'computers.claim',
    'computers.unrevoke',
    'diagnostics.getConfig',
    'diagnostics.setConfig',
    'diagnostics.exportBundle',
    'aiConfig.marketplace.addRegistry',
    'aiConfig.marketplace.removeRegistry',
    'aiConfig.marketplace.toggleRegistry',
    'app.backup.restore',
    'app.exportImport.import',
    'testPanel.saveProfile'
  ]
  for (const path of admin) {
    test(`${path} is admin`, () => expect(TRPC_ADMIN_POLICY[path]).toBe('admin'))
  }

  test('every automations.* and app.backup.* procedure is admin', () => {
    const paths = LIVE_TRPC.filter(
      (p) => p.startsWith('automations.') || p.startsWith('app.backup.')
    )
    expect(paths.length).toBeGreaterThan(15)
    for (const p of paths) expect(TRPC_ADMIN_POLICY[p], p).toBe('admin')
  })

  const user: string[] = [
    // Installing skills from a registry stays open to every user (O-10).
    'aiConfig.marketplace.installSkill',
    'aiConfig.marketplace.updateSkill',
    'aiConfig.marketplace.listEntries',
    // Each client writes its own diagnostics events.
    'diagnostics.recordClientError',
    'diagnostics.recordClientEvent',
    // Per-user settings must stay writable, or nobody can save their own view state.
    'settings.set',
    'settings.get',
    'app.exportImport.exportProject',
    // O-22 (T-101): every user exports their own content; nobody the whole hub.
    'app.exportImport.exportAll',
    'app.exportImport.testExportAllToPath'
  ]
  for (const path of user) {
    test(`${path} is user`, () => expect(TRPC_ADMIN_POLICY[path]).toBe('user'))
  }

  test('REST: automations, join-token and account management are admin', () => {
    const admins = ofClass(REST_ADMIN_POLICY, 'admin')
    expect(admins).toContain('POST /api/computers/join-token')
    expect(admins).toContain('POST /api/hub/users')
    expect(admins).toContain('POST /api/automations/:id/run')
    for (const k of LIVE_REST.filter((k) => k.includes('/api/automations'))) {
      expect(REST_ADMIN_POLICY[k], k).toBe('admin')
    }
  })

  test('open is exactly what needs no session today', () => {
    expect(ofClass(TRPC_ADMIN_POLICY, 'open')).toEqual(['hub.describe'])
    expect(ofClass(REST_ADMIN_POLICY, 'open')).toEqual(['POST /api/auth/web-login'])
    expect(ofClass(MCP_ADMIN_POLICY, 'open')).toEqual([])
  })

  test('roleAllows: admin reaches everything, user only user/open, unknown needs admin', () => {
    for (const cls of ['admin', 'user', 'open', undefined] as const) {
      expect(roleAllows(cls, 'admin')).toBe(true)
    }
    expect(roleAllows('user', 'user')).toBe(true)
    expect(roleAllows('open', 'user')).toBe(true)
    expect(roleAllows('admin', 'user')).toBe(false)
    expect(roleAllows(undefined, 'user')).toBe(false)
  })
})

// ── tRPC ─────────────────────────────────────────────────────────────────────

function trpcCtx(principal: RestPrincipal | null): TrpcContext {
  return {
    db: NO_DB,
    dataRoot: '/tmp',
    principal,
    req: { socket: { remoteAddress: '203.0.113.7' } } as never
  }
}

/** Call a procedure by dotted path. Settles to the error, or `'pending'` when the
 *  handler is still running after a short wait (i.e. it got past every gate). */
async function callPath(
  principal: RestPrincipal | null,
  path: string,
  input?: unknown
): Promise<unknown> {
  const caller = appRouter.createCaller(trpcCtx(principal)) as unknown as Record<string, unknown>
  const fn = path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], caller)
  const run = Promise.resolve()
    .then(() => (fn as (i: unknown) => unknown)(input))
    .then(
      () => 'ok',
      (err: unknown) => err
    )
  return Promise.race([run, new Promise((r) => setTimeout(() => r('pending'), 250))])
}

const isRoleRefusal = (r: unknown): boolean =>
  r instanceof TRPCError && r.code === 'FORBIDDEN' && isAdminOnlyError(r.cause)

let audit: Array<Record<string, unknown>> = []
beforeEach(() => {
  audit = []
  setSecurityLogSink((line) => audit.push(JSON.parse(line) as Record<string, unknown>))
})
afterEach(() => {
  setSecurityLogSink()
  setAuthGate(() => false)
})

describe('tRPC, on a hub that requires login', () => {
  beforeEach(() => setAuthGate(() => true))

  const ADMIN_PATHS = ofClass(TRPC_ADMIN_POLICY, 'admin')

  test('there are admin procedures to check', () => expect(ADMIN_PATHS.length).toBe(33))

  for (const path of ADMIN_PATHS) {
    test(`${path}: a user account is FORBIDDEN (ADMIN_ONLY, one audit line); an admin passes`, async () => {
      const refused = await callPath(USER, path)
      expect(isRoleRefusal(refused), String(refused)).toBe(true)
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({
        event: 'authz.denied',
        outcome: 'denied',
        actor: 'u-user',
        targetKind: 'procedure',
        targetId: path,
        detail: { reason: 'not_admin', code: ADMIN_ONLY }
      })
      expect(isRoleRefusal(await callPath(ADMIN, path))).toBe(false)
    })
  }

  test('a user account passes the role gate on every user and open procedure', async () => {
    // The gate decision alone: running ~640 real handlers with no database would test
    // the handlers, not the gate. The middleware itself is driven above and below.
    for (const path of LIVE_TRPC.filter((p) => TRPC_ADMIN_POLICY[p] !== 'admin')) {
      expect(roleAllows(TRPC_ADMIN_POLICY[path], 'user'), path).toBe(true)
    }
  })

  test('no session: every procedure but the open ones is UNAUTHORIZED, the open ones are reachable', async () => {
    for (const path of LIVE_TRPC) {
      const r = await callPath(null, path)
      const unauthorized = r instanceof TRPCError && r.code === 'UNAUTHORIZED'
      expect(unauthorized, `${path} (${TRPC_ADMIN_POLICY[path]}): ${String(r)}`).toBe(
        TRPC_ADMIN_POLICY[path] !== 'open'
      )
    }
  })

  test('the refusal reaches the client as data.appCode ADMIN_ONLY', async () => {
    const refused = (await callPath(USER, 'hub.setLabel', { label: 'x' })) as TRPCError
    const formatter = appRouter._def._config.errorFormatter
    const shape = formatter({
      error: refused,
      type: 'mutation',
      path: 'hub.setLabel',
      input: undefined,
      ctx: undefined,
      shape: { message: refused.message, code: -32003, data: { code: 'FORBIDDEN' } }
    } as never) as { data: { appCode?: string } }
    expect(shape.data.appCode).toBe(ADMIN_ONLY)
  })
})

describe('tRPC, on a hub without login (the desktop app)', () => {
  test('no principal reaches every admin procedure past the gates, and nothing is audited', async () => {
    setAuthGate(() => false)
    for (const path of ofClass(TRPC_ADMIN_POLICY, 'admin')) {
      const r = await callPath(null, path)
      expect(isRoleRefusal(r), path).toBe(false)
      expect(r instanceof TRPCError && r.code === 'UNAUTHORIZED', path).toBe(false)
    }
    expect(audit.filter((l) => l.event === 'authz.denied')).toEqual([])
  })
})

describe('tRPC CONDITIONAL_ADMIN: refused to a non-admin only for the listed inputs', () => {
  beforeEach(() => setAuthGate(() => true))

  /** A database that answers only the ownership queries, as told. */
  function ownershipDb(owner: { computer: boolean; host: { total: number; mine: number } }) {
    return {
      get: async (sql: string) => {
        if (sql.includes('AS total')) return owner.host
        // canAccess on a `computer` (T-19): its owner row.
        if (sql.startsWith('SELECT owner_user_id FROM computers')) {
          return { owner_user_id: owner.computer ? USER.userId : 'someone-else' }
        }
        // The computer exists (an admin's management check, and the store read).
        if (sql.includes('FROM computers WHERE id = ?')) return { id: 'c1' }
        throw new Error('not modelled')
      },
      all: async () => {
        throw new Error('not modelled')
      },
      run: async () => {
        throw new Error('not modelled')
      }
    } as unknown as TrpcContext['db']
  }

  async function call(
    principal: RestPrincipal,
    db: TrpcContext['db'],
    path: string,
    input: unknown
  ): Promise<unknown> {
    const caller = appRouter.createCaller({ ...trpcCtx(principal), db }) as unknown as Record<
      string,
      unknown
    >
    const fn = path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], caller)
    return (fn as (i: unknown) => Promise<unknown>)(input).then(
      () => 'ok',
      (e: unknown) => e
    )
  }

  const lifecycle = ['computers.revokeComputer', 'computers.delete', 'computers.setVisibility']
  for (const path of lifecycle) {
    const input = { computerId: 'c1', visibility: 'private' }
    test(`${path}: someone else's (or an unowned) computer needs an admin`, async () => {
      const notMine = ownershipDb({ computer: false, host: { total: 0, mine: 0 } })
      const mine = ownershipDb({ computer: true, host: { total: 0, mine: 0 } })
      expect(isRoleRefusal(await call(USER, notMine, path, input))).toBe(true)
      expect(isRoleRefusal(await call(USER, mine, path, input))).toBe(false)
      expect(isRoleRefusal(await call(ADMIN, notMine, path, input))).toBe(false)
    })
  }

  test('computers.renameMachine: a machine the caller does not wholly own needs an admin', async () => {
    const input = { hostId: 'h1', name: 'x' }
    const shared = ownershipDb({ computer: false, host: { total: 2, mine: 1 } })
    const none = ownershipDb({ computer: false, host: { total: 0, mine: 0 } })
    const mine = ownershipDb({ computer: true, host: { total: 2, mine: 2 } })
    expect(isRoleRefusal(await call(USER, shared, 'computers.renameMachine', input))).toBe(true)
    expect(isRoleRefusal(await call(USER, none, 'computers.renameMachine', input))).toBe(true)
    expect(isRoleRefusal(await call(USER, mine, 'computers.renameMachine', input))).toBe(false)
    expect(isRoleRefusal(await call(ADMIN, shared, 'computers.renameMachine', input))).toBe(false)
  })

  test('settings.set: hub-wide and internal keys need an admin, per-user keys do not', async () => {
    // A project-keyed key is also its project's (T-108, owner gate first): here the
    // caller owns `p1`, so only the role decides.
    const ownsP1 = (p: RestPrincipal) =>
      ({
        get: async () => ({ owner_user_id: p.userId }),
        all: async () => []
      }) as unknown as TrpcContext['db']
    for (const key of [
      'hub_label',
      'default_terminal_mode',
      'ai_providers:p1',
      'integration:credential:linear'
    ]) {
      expect(settingWriteNeedsAdmin(key), key).toBe(true)
      expect(
        isRoleRefusal(await call(USER, ownsP1(USER), 'settings.set', { key, value: 'v' })),
        key
      ).toBe(true)
      expect(
        isRoleRefusal(await call(ADMIN, ownsP1(ADMIN), 'settings.set', { key, value: 'v' })),
        key
      ).toBe(false)
    }
    for (const key of ['viewState', 'panel_config', 'sidebar_width']) {
      expect(settingWriteNeedsAdmin(key), key).toBe(false)
      expect(isRoleRefusal(await call(USER, NO_DB, 'settings.set', { key, value: 'v' })), key).toBe(
        false
      )
    }
  })
})

// ── REST ─────────────────────────────────────────────────────────────────────

describe('REST guard, per route', () => {
  function run(
    key: string,
    principal: RestPrincipal | null
  ): { next: boolean; status?: number; body?: unknown } {
    const out: { next: boolean; status?: number; body?: unknown } = { next: false }
    const req = { method: key.split(' ')[0], url: key.split(' ')[1], socket: {}, headers: {} }
    if (principal) bindRestPrincipal(req as never, principal)
    const res = {
      status(code: number) {
        out.status = code
        return { json: (body: unknown) => void (out.body = body) }
      }
    }
    adminRouteGuard(key)(req as never, res as never, () => {
      out.next = true
    })
    return out
  }

  test('a user account is refused exactly the admin routes, with ADMIN_ONLY', () => {
    for (const key of LIVE_REST) {
      const r = run(key, USER)
      if (REST_ADMIN_POLICY[key] === 'admin') {
        expect(r.status, key).toBe(403)
        expect(r.body, key).toMatchObject({ ok: false, code: ADMIN_ONLY })
      } else {
        expect(r.next, key).toBe(true)
      }
    }
  })

  test('an admin account, and a request with no principal (no login), pass every route', () => {
    for (const key of LIVE_REST) {
      expect(run(key, ADMIN).next, key).toBe(true)
      expect(run(key, null).next, key).toBe(true)
    }
  })

  test('an unclassified route is refused to a user account (fail closed)', () => {
    expect(run('POST /api/brand-new', USER).status).toBe(403)
    expect(run('POST /api/brand-new', ADMIN).next).toBe(true)
  })

  test('a route registered with a non-string path cannot slip past the gate', () => {
    const app = withAdminGate({ get: () => undefined } as never)
    expect(() => app.get(/regex/ as never, () => undefined)).toThrow(/string path/)
  })
})

describe('REST, over HTTP through registerRestApi', () => {
  let server: Server
  let base = ''
  let principal: RestPrincipal | null = null

  beforeEach(async () => {
    const app = express()
    app.use(express.json())
    // Stands in for the hub's bearer gate (`withRestAuth`), which binds the verified
    // principal the same way.
    app.use((req, _res, next) => {
      if (principal) bindRestPrincipal(req, principal)
      next()
    })
    const deps: RestApiDeps = {
      db: NO_DB,
      notifyRenderer: () => {},
      // The two self-guarded admin routes verify the caller themselves.
      restAuth: { required: () => true, verifyBearer: async () => principal }
    }
    registerRestApi(app, deps)
    server = createServer(app)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    principal = null
    await new Promise((r) => server.close(r))
  })

  async function request(key: string): Promise<{ status: number; code?: string }> {
    const [method, path] = key.split(' ')
    const res = await fetch(base + path!.replace(/:[A-Za-z]+/g, 'x'), {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify({ email: 'a@b.c' })
    })
    const body = (await res.json().catch(() => ({}))) as { code?: string }
    return { status: res.status, code: body.code }
  }

  const ADMIN_ROUTES = ofClass(REST_ADMIN_POLICY, 'admin')

  test('there are admin routes to check', () => expect(ADMIN_ROUTES.length).toBe(13))

  for (const key of ADMIN_ROUTES) {
    test(`${key}: a user account gets 403 ADMIN_ONLY and one audit line; an admin does not`, async () => {
      principal = USER
      expect(await request(key)).toEqual({ status: 403, code: ADMIN_ONLY })
      const denied = audit.filter((l) => l.event === 'authz.denied')
      expect(denied).toHaveLength(1)
      expect(denied[0]).toMatchObject({
        actor: 'u-user',
        detail: { reason: 'not_admin', code: ADMIN_ONLY, status: 403 }
      })
      principal = ADMIN
      expect((await request(key)).code).not.toBe(ADMIN_ONLY)
    })
  }
})

// ── MCP ──────────────────────────────────────────────────────────────────────

describe('MCP tools', () => {
  const extraFor = (p: RestPrincipal | null) => (p ? { authInfo: mcpAuthInfo(p) } : {})

  test('no live tool is admin today, so a user account reaches every one', () => {
    expect(ofClass(MCP_ADMIN_POLICY, 'admin')).toEqual([])
    for (const name of LIVE_MCP) expect(roleAllows(MCP_ADMIN_POLICY[name], 'user'), name).toBe(true)
  })

  test('every live tool is registered through the gate: classify one admin and it is refused', async () => {
    const saved = MCP_ADMIN_POLICY.delete_task
    MCP_ADMIN_POLICY.delete_task = 'admin'
    try {
      const handler = liveMcpTools().get('delete_task')!
      const r = (await handler({ task_id: 't1' }, extraFor(USER))) as {
        isError?: boolean
        content: Array<{ text: string }>
      }
      expect(r.isError).toBe(true)
      expect(r.content[0]!.text.startsWith(ADMIN_ONLY)).toBe(true)
      expect(audit.filter((l) => l.event === 'authz.denied')).toHaveLength(1)
    } finally {
      MCP_ADMIN_POLICY.delete_task = saved!
    }
  })

  test('the gate: admin tool refused to a user, run for an admin and with no login; unclassified needs admin', async () => {
    const calls: string[] = []
    const handlers = new Map<string, (...a: unknown[]) => unknown>()
    const stub = {
      tool: (name: string, ...rest: unknown[]) =>
        handlers.set(name, rest[rest.length - 1] as (...a: unknown[]) => unknown)
    }
    const gated = withMcpAdminGate(stub as never, { secret_tool: 'admin', plain_tool: 'user' })
    for (const name of ['secret_tool', 'plain_tool', 'unclassified_tool']) {
      gated.tool(name, 'd', {}, async () => {
        calls.push(name)
        return { content: [] }
      })
    }
    const refused = (await handlers.get('secret_tool')!({}, extraFor(USER))) as {
      isError?: boolean
    }
    expect(refused.isError).toBe(true)
    await handlers.get('secret_tool')!({}, extraFor(ADMIN))
    await handlers.get('secret_tool')!({}, extraFor(null))
    await handlers.get('plain_tool')!({}, extraFor(USER))
    expect(
      ((await handlers.get('unclassified_tool')!({}, extraFor(USER))) as { isError?: boolean })
        .isError
    ).toBe(true)
    expect(calls).toEqual(['secret_tool', 'secret_tool', 'plain_tool'])
  })
})

// ── admin is management, never a read path ───────────────────────────────────

describe('diagnostics export on a hub with login drops captured terminal output', () => {
  test('pty.data bytes are replaced by their length; other events are untouched', () => {
    const bundle = {
      meta: { appVersion: '1', platform: 'linux', exportedAtTsMs: 0, config: {} },
      incidentWindow: { fromTsMs: 0, toTsMs: 1 },
      events: [
        { event: 'pty.data', payload: { length: 5, data: 'hello' } },
        { event: 'pty.data', payload: { length: 5, included: false } },
        { event: 'renderer.error', payload: { message: 'm' } }
      ],
      summary: {},
      redaction: { version: 1, includePtyOutput: true }
    } as never
    const out = withoutPtyOutput(bundle)!
    expect(out.events.map((e) => e.payload)).toEqual([
      { length: 5, included: false },
      { length: 5, included: false },
      { message: 'm' }
    ])
    expect(out.redaction.includePtyOutput).toBe(false)
    expect(withoutPtyOutput(null)).toBeNull()
  })
})
