/**
 * REST: `/api/hub/content-erasure` — the operator surface behind
 * `slay hub users erase-content|erasure-status|retry-erasure|erasure-receipt|…`.
 *
 * Its own path, NOT a query/body variant of `/api/hub/users`: that path is on the
 * break-glass allowlist (apps/hub rest-auth.ts `BREAK_GLASS_ROUTES`), and a break-glass
 * session only stops access (O-6). Behind the hub's ordinary bearer gate, so the caller
 * here is the principal the gate bound (`restPrincipalOf`). Read-only views are `GET`;
 * everything that changes or exports state is `POST`.
 *
 * The erasure service is a stub: its own rules (admin, disabled target, confirmation)
 * are covered in content-erasure's admin.test.ts. This layer owns who reaches it, which
 * method does what, and the status codes.
 */
import { afterEach, expect, test, vi } from 'vitest'
import express from 'express'
import { setHubAdminDeps } from '@slayzone/content-erasure/router'
import { AdminContentErasureError, type AdminContentErasure } from '@slayzone/content-erasure/admin'
import { mountRestApp } from '../../../../../../shared/test-utils/rest-harness.js'
import { bindRestPrincipal } from '../principal.js'
import type { RestApiDeps, RestPrincipal } from '../types.js'
import { registerHubContentErasureRoutes } from './content-erasure.js'
import { registerHubUsersRoutes } from './users.js'

afterEach(() => setHubAdminDeps(null))

const ADMIN: RestPrincipal = { userId: 'operator', role: 'admin', scopes: ['full'] }

function stubErasure(overrides: Partial<Record<keyof AdminContentErasure, unknown>> = {}) {
  const calls: string[] = []
  const fn = (name: string, result: unknown = { ok: name }) =>
    vi.fn(async (_input: unknown) => {
      calls.push(name)
      return result
    })
  const erasure = {
    preview: fn('preview', { counts: { projects: 1, tasks: 2, artifacts: 0, versions: 0 } }),
    reports: fn('reports', []),
    receipt: fn('receipt'),
    erase: fn('erase'),
    retry: fn('retry'),
    computerRequest: fn('computerRequest'),
    confirmComputer: fn('confirmComputer'),
    ...overrides
  }
  setHubAdminDeps({
    dataRoot: '/unused',
    users: { ready: () => true, list: async () => [], disable: async () => 'ok' as const },
    erasure: erasure as unknown as AdminContentErasure
  } as never)
  return { erasure, calls }
}

async function mount(principal: RestPrincipal | null) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    if (principal) bindRestPrincipal(req, principal)
    next()
  })
  const deps = { db: null, notifyRenderer: () => {} } as unknown as RestApiDeps
  registerHubContentErasureRoutes(app, deps)
  registerHubUsersRoutes(app, {
    ...deps,
    hubUsers: {
      ready: () => true,
      create: async () => ({ ok: false as const, reason: 'exists' as const }),
      list: async () => [],
      disable: async () => 'ok' as const,
      enable: async () => 'ok' as const,
      setRole: async () => 'ok' as const
    },
    restAuth: { required: () => true, verifyBearer: async () => principal }
  } as unknown as RestApiDeps)
  return mountRestApp(app)
}

async function call<T>(
  principal: RestPrincipal | null,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: T }> {
  const rest = await mount(principal)
  try {
    return await rest.request<T>(method, path, body)
  } finally {
    await rest.close()
  }
}

test('POST erase runs as the gate-verified admin and surfaces a refusal safely', async () => {
  const erase = vi.fn(async () => {
    throw new AdminContentErasureError(
      'USER_NOT_DISABLED',
      'Disable the user before erasing their content.'
    )
  })
  stubErasure({ erase })
  const res = await call<{ code: string }>(ADMIN, 'POST', '/api/hub/content-erasure', {
    action: 'erase-content',
    userId: 'alice',
    confirmation: 'alice@example.com'
  })
  expect(res.status).toBe(409)
  expect(res.body.code).toBe('USER_NOT_DISABLED')
  expect(erase).toHaveBeenCalledWith({
    actor: { userId: 'operator', role: 'admin', scopes: ['full'] },
    userId: 'alice',
    confirmation: 'alice@example.com'
  })
})

test('GET answers the read-only views: preview and reports', async () => {
  const { calls } = stubErasure()
  const preview = await call<{ ok: boolean; data: { counts: { tasks: number } } }>(
    ADMIN,
    'GET',
    '/api/hub/content-erasure?view=preview&userId=alice'
  )
  expect(preview.status).toBe(200)
  expect(preview.body.data.counts.tasks).toBe(2)
  const reports = await call<{ data: unknown[] }>(
    ADMIN,
    'GET',
    '/api/hub/content-erasure?view=reports&userId=alice'
  )
  expect(reports.status).toBe(200)
  expect(reports.body.data).toEqual([])
  expect(calls).toEqual(['preview', 'reports'])
})

test('GET never erases, retries or exports: those are POST only', async () => {
  const { calls } = stubErasure()
  for (const view of [
    'erase-content&userId=alice&confirmation=alice%40example.com',
    'retry-erasure&jobId=j',
    'receipt&jobId=j',
    'computer-erasure-request&jobId=j&computerId=c&hubUrl=wss%3A%2F%2Fh%2Fcomputers',
    'confirm-computer-erasure'
  ]) {
    const res = await call(ADMIN, 'GET', `/api/hub/content-erasure?view=${view}`)
    expect(res.status, view).toBe(400)
  }
  expect(calls).toEqual([])
})

test('POST runs every state-changing action', async () => {
  const { erasure } = stubErasure()
  const post = (body: unknown) => call(ADMIN, 'POST', '/api/hub/content-erasure', body)
  expect((await post({ action: 'retry-erasure', jobId: 'j' })).status).toBe(200)
  expect(erasure.retry).toHaveBeenCalledWith({ actor: ADMIN, jobId: 'j' })
  expect((await post({ action: 'receipt', jobId: 'j' })).status).toBe(200)
  expect(erasure.receipt).toHaveBeenCalledWith({ actor: ADMIN, jobId: 'j' })
  const request = { jobId: 'j', computerId: 'c', hubUrl: 'wss://h/computers' }
  expect((await post({ action: 'computer-erasure-request', ...request })).status).toBe(200)
  expect(erasure.computerRequest).toHaveBeenCalledWith({ actor: ADMIN, ...request })
  expect((await post({ action: 'confirm-computer-erasure', receipt: { x: 1 } })).status).toBe(200)
  expect(erasure.confirmComputer).toHaveBeenCalledWith({ actor: ADMIN, receipt: { x: 1 } })
  expect((await post({ action: 'preview', userId: 'alice' })).status).toBe(400)
})

test('only an admin with a full session reaches erasure', async () => {
  const { calls } = stubErasure()
  const principals: Array<RestPrincipal | null> = [
    null,
    { ...ADMIN, role: 'user' },
    { ...ADMIN, scopes: ['tasks'] }
  ]
  for (const principal of principals) {
    const get = await call(principal, 'GET', '/api/hub/content-erasure?view=preview&userId=a')
    expect(get.status, JSON.stringify(principal)).toBe(403)
    const post = await call(principal, 'POST', '/api/hub/content-erasure', {
      action: 'erase-content',
      userId: 'a',
      confirmation: 'a@example.com'
    })
    expect(post.status, JSON.stringify(principal)).toBe(403)
  }
  expect(calls).toEqual([])
})

test('the account routes no longer carry erasure: 410 naming the new route, nothing runs', async () => {
  const { calls } = stubErasure()
  const get = await call<{ error: string }>(
    ADMIN,
    'GET',
    '/api/hub/users?erasure=preview&userId=alice'
  )
  expect(get.status).toBe(410)
  expect(get.body.error).toContain('/api/hub/content-erasure')
  const patch = await call<{ error: string }>(ADMIN, 'PATCH', '/api/hub/users', {
    action: 'erase-content',
    userId: 'alice',
    confirmation: 'alice@example.com'
  })
  expect(patch.status).toBe(410)
  expect(calls).toEqual([])
})
