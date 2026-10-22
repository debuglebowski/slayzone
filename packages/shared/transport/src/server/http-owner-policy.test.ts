/**
 * The owner-check classification for REST routes and MCP tools (T-18), against the
 * LIVE registrations:
 *
 *   - exhaustiveness: every `user` REST route and MCP tool (T-15's admin-policy.ts) is
 *     marked id-checked, list-filtered or no-owned-input, nothing else is, and nothing
 *     marked is gone — an unmarked new one fails here by name;
 *   - each mark carries what the gate needs, a `params.x` id is a segment of its
 *     route's path, and an MCP id is an argument of its tool's schema, so a typo cannot
 *     silently check nothing;
 *   - at runtime an unmarked `user` route or tool is refused on a hub with login (fail
 *     closed), and a hub without login (the desktop app's) reads no rule at all;
 *   - reading ids out of a request refuses what is not an id.
 *
 * The decisions themselves run on a real hub in `apps/hub/src/owner-checks-http.test.ts`.
 */
import { afterEach, describe, expect, test } from 'vitest'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { setAuthGate } from './app-deps'
import { MCP_ADMIN_POLICY, REST_ADMIN_POLICY } from './admin-policy'
import { MCP_OWNER_POLICY, REST_OWNER_POLICY, type HttpOwnerRule } from './http-owner-policy'
import { registerRestApi } from './http/rest-api'
import { restRouteKey } from './http/rest-api/admin-routes'
import { ownerRouteGuard } from './http/rest-api/owner-routes'
import { bindRestPrincipal } from './http/rest-api/principal'
import { registerMcpTools } from './http/mcp-tools'
import { withMcpOwnerGate } from './http/mcp-tools/owner-gate'
import { mcpAuthInfo } from './http/mcp-tools/admin-gate'
import { idValuesAt } from './http/owner-scope'
import type { TrpcContext } from './context'

const NO_DB = new Proxy(
  {},
  {
    get() {
      throw new Error('no database in this test')
    }
  }
) as TrpcContext['db']

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

/** name → the raw argument shape the tool registered (zod raw shape). */
function liveMcpTools(): Map<string, Record<string, unknown>> {
  const tools = new Map<string, Record<string, unknown>>()
  const stub = {
    tool: (name: string, ...rest: unknown[]) => {
      const shape = rest.find((r, i) => i < rest.length - 1 && typeof r === 'object' && r)
      tools.set(name, (shape ?? {}) as Record<string, unknown>)
    }
  }
  registerMcpTools(stub as never, { db: NO_DB, notifyRenderer: () => {} })
  return tools
}

const LIVE_REST_USER = liveRestKeys().filter((k) => REST_ADMIN_POLICY[k] === 'user')
const MCP_TOOLS = liveMcpTools()
const LIVE_MCP_USER = [...MCP_TOOLS.keys()].filter((t) => MCP_ADMIN_POLICY[t] === 'user').sort()

const unmarked = (live: string[], policy: Record<string, HttpOwnerRule>): string[] =>
  live.filter((k) => !(k in policy))

afterEach(() => {
  setAuthGate(() => false)
  setSecurityLogSink()
})

describe('exhaustiveness', () => {
  const surfaces: Array<[string, string[], Record<string, HttpOwnerRule>]> = [
    ['REST route', LIVE_REST_USER, REST_OWNER_POLICY],
    ['MCP tool', LIVE_MCP_USER, MCP_OWNER_POLICY]
  ]
  for (const [label, live, policy] of surfaces) {
    test(`every live user ${label} is marked`, () => {
      const missing = unmarked(live, policy)
      expect(missing, `unmarked (add to http-owner-policy.ts): ${missing.join(', ')}`).toEqual([])
    })
    test(`nothing but live user ${label}s is marked`, () => {
      const extra = Object.keys(policy).filter((k) => !live.includes(k))
      expect(extra, `not a live user ${label}: ${extra.join(', ')}`).toEqual([])
    })
  }

  test('the check names an unmarked route or tool', () => {
    expect(unmarked([...LIVE_REST_USER, 'POST /api/brand-new'], REST_OWNER_POLICY)).toEqual([
      'POST /api/brand-new'
    ])
    expect(unmarked([...LIVE_MCP_USER, 'brand_new_tool'], MCP_OWNER_POLICY)).toEqual([
      'brand_new_tool'
    ])
  })

  test('the surface is the size the policy was written against', () => {
    // Floors, not pins: the registrations above are the real ones.
    expect(LIVE_REST_USER.length).toBeGreaterThan(90)
    expect(LIVE_MCP_USER.length).toBe(8)
  })
})

function checkMark(rule: HttpOwnerRule): void {
  if (rule.mark === 'id-checked') {
    expect((rule.ids?.length ?? 0) > 0 || !!rule.checkedInHandler, 'ids').toBe(true)
  }
  if (rule.mark === 'list-filtered') {
    expect(!!rule.output || !!rule.scopedInHandler, 'output or scopedInHandler').toBe(true)
    expect(rule.ids ?? []).toEqual([])
  }
  if (rule.mark === 'no-owned-input') {
    expect(rule.why).toBeTruthy()
    expect(rule.ids ?? []).toEqual([])
    expect(rule.output).toBeUndefined()
  }
  for (const r of rule.ids ?? []) expect(['exact', 'prefix', 'projectRef']).toContain(r.match)
}

describe('each mark carries what the gate needs', () => {
  for (const key of LIVE_REST_USER) {
    const rule = REST_OWNER_POLICY[key]
    if (!rule) continue
    test(`${key} (${rule.mark})`, () => {
      checkMark(rule)
      const path = key.split(' ')[1]!
      for (const r of rule.ids ?? []) {
        const [where, name] = r.at.split('.')
        expect(['params', 'query', 'body'], r.at).toContain(where)
        if (where === 'params') expect(path, r.at).toContain(`:${name}`)
      }
    })
  }
  for (const name of LIVE_MCP_USER) {
    const rule = MCP_OWNER_POLICY[name]
    if (!rule) continue
    test(`mcp ${name} (${rule.mark})`, () => {
      checkMark(rule)
      const shape = MCP_TOOLS.get(name)!
      for (const r of rule.ids ?? []) {
        const head = r.at.split('.')[0]!.replace(/\[\]$/, '')
        expect(Object.keys(shape), `${r.at} in ${name}`).toContain(head)
      }
    })
  }
})

describe('reading ids out of a request', () => {
  test('dotted paths, arrays, and an array where one id goes', () => {
    expect(idValuesAt({ params: { id: 't1' } }, 'params.id')).toEqual({
      values: ['t1'],
      invalid: false
    })
    expect(idValuesAt({ body: { ids: ['a', 'b'] } }, 'body.ids[]').values).toEqual(['a', 'b'])
    // `?taskId=a&taskId=b` reaches a handler as an array: every element is decided.
    expect(idValuesAt({ query: { taskId: ['a', 'b'] } }, 'query.taskId').values).toEqual(['a', 'b'])
    expect(idValuesAt({ body: { ids: 'a' } }, 'body.ids[]').values).toEqual(['a'])
  })

  test('absent and null are skipped; anything else that is not an id is refused', () => {
    expect(idValuesAt({ body: {} }, 'body.taskId')).toEqual({ values: [], invalid: false })
    expect(idValuesAt({ body: { parentId: null } }, 'body.parentId').invalid).toBe(false)
    expect(idValuesAt({ body: { taskId: 7 } }, 'body.taskId').invalid).toBe(true)
    expect(idValuesAt({ body: { taskId: { $gt: '' } } }, 'body.taskId').invalid).toBe(true)
    expect(idValuesAt({ body: { ids: [['nested']] } }, 'body.ids[]').invalid).toBe(true)
  })

  test('literal non-ids are skipped', () => {
    expect(idValuesAt({ body: { folderId: 'root' } }, 'body.folderId', ['root']).values).toEqual([])
  })
})

// ── runtime: fail closed with login, inert without ────────────────────────────

const USER = { userId: 'u-user', role: 'user' as const, scopes: ['full' as const] }

function runGuard(
  key: string,
  policy: Record<string, HttpOwnerRule>,
  classes: Record<string, 'user' | 'admin' | 'open'>
): Promise<{ next: boolean; status?: number; body?: unknown }> {
  return new Promise((resolve) => {
    const req = { method: 'GET', url: '/x', params: {}, query: {}, headers: {}, socket: {} }
    bindRestPrincipal(req as never, USER)
    const res = {
      statusCode: 200,
      headersSent: false,
      status(code: number) {
        this.statusCode = code
        return this
      },
      json(body: unknown) {
        resolve({ next: false, status: this.statusCode, body })
        return this
      }
    }
    void ownerRouteGuard(
      key,
      NO_DB,
      policy,
      classes
    )(req as never, res as never, () => resolve({ next: true }))
  })
}

describe('REST guard at runtime', () => {
  test('a hub with login refuses an unmarked user route, with one audit line', async () => {
    setAuthGate(() => true)
    const lines: { event: string; detail: { reason: string } }[] = []
    setSecurityLogSink((l) => lines.push(JSON.parse(l)))
    const r = await runGuard('GET /api/brand-new', {}, { 'GET /api/brand-new': 'user' })
    expect(r.next).toBe(false)
    expect(r.status).toBe(403)
    expect(lines.filter((l) => l.event === 'authz.denied')).toHaveLength(1)
    expect(lines[0]!.detail.reason).toBe('owner_unclassified')
  })

  test('admin and open routes are not owner questions', async () => {
    setAuthGate(() => true)
    expect((await runGuard('GET /x', {}, { 'GET /x': 'admin' })).next).toBe(true)
    expect((await runGuard('GET /x', {}, { 'GET /x': 'open' })).next).toBe(true)
  })

  test('without login the guard reads no rule and no database', async () => {
    setAuthGate(() => false)
    const throwing = new Proxy(
      {},
      {
        get() {
          throw new Error('policy read on a hub without login')
        }
      }
    ) as Record<string, HttpOwnerRule>
    for (const key of LIVE_REST_USER) {
      expect((await runGuard(key, throwing, REST_ADMIN_POLICY)).next, key).toBe(true)
    }
  })
})

describe('MCP gate at runtime', () => {
  function gatedTool(name: string, policy: Record<string, HttpOwnerRule>) {
    let handler: ((...a: unknown[]) => unknown) | undefined
    const calls: string[] = []
    const stub = {
      tool: (_n: string, ...rest: unknown[]) => {
        handler = rest[rest.length - 1] as (...a: unknown[]) => unknown
      }
    }
    withMcpOwnerGate(stub as never, NO_DB, policy, { [name]: 'user' }).tool(
      name,
      'd',
      {},
      async () => {
        calls.push(name)
        return { content: [] }
      }
    )
    return { handler: handler!, calls }
  }

  test('a hub with login refuses an unmarked user tool', async () => {
    setAuthGate(() => true)
    const { handler, calls } = gatedTool('brand_new_tool', {})
    const r = (await handler({}, { authInfo: mcpAuthInfo(USER) })) as { isError?: boolean }
    expect(r.isError).toBe(true)
    expect(calls).toEqual([])
  })

  test('without login every tool runs, no rule read', async () => {
    setAuthGate(() => false)
    const throwing = new Proxy(
      {},
      {
        get() {
          throw new Error('policy read on a hub without login')
        }
      }
    ) as Record<string, HttpOwnerRule>
    const { handler, calls } = gatedTool('any_tool', throwing)
    await handler({ task_id: 'someone-elses' }, {})
    expect(calls).toEqual(['any_tool'])
  })
})
