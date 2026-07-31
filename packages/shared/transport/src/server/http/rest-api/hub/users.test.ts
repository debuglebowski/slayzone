/**
 * REST: `/api/hub/users` contract tests — the loopback-only operator account
 * surface behind `slay hub users add|ls|rm`.
 *
 * The `hubUsers` capability is a STUB here, deliberately: the real logic lives in
 * `@slayzone/hub-auth`'s users.ts (covered against real better-auth in its own
 * users.test.ts), and this package has no hub-auth dependency. Stubbing keeps the
 * test honest about that boundary and isolates what this layer actually owns —
 * status codes, body validation, and the three-step loopback/slot/ready gate.
 *
 * The 403 is NOT reachable through the HTTP harness (it binds 127.0.0.1, so every
 * peer is loopback), which is why `isLoopbackAddress` is exported and asserted
 * directly at the bottom.
 */
import express from 'express'
import { test, expect, describe } from '../../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../test-utils/rest-harness.js'
import { isLoopbackAddress, registerHubUsersRoutes } from './users.js'
import type { RestApiDeps } from '../types.js'

const SERVICE_EMAIL = 'runners@slayzone.internal'

type HubUsers = NonNullable<RestApiDeps['hubUsers']>

/** A ready capability whose outcomes the individual tests dictate. */
function stubUsers(overrides: Partial<HubUsers> = {}): HubUsers {
  return {
    ready: () => true,
    create: async ({ email, name }) => ({
      ok: true as const,
      user: { id: 'u1', email, name: name ?? email.split('@')[0]!, password: 'generated-pw' }
    }),
    list: async () => [],
    remove: async () => 'ok' as const,
    ...overrides
  }
}

/**
 * Mount the routes with the given capability slot. `db` is irrelevant to these
 * routes (they never touch it) so a cast keeps the harness out — no Electron ABI
 * needed, unlike the sibling join-token suite.
 */
function mount(hubUsers: RestApiDeps['hubUsers']) {
  const app = express()
  app.use(express.json())
  registerHubUsersRoutes(app, {
    db: null as unknown as RestApiDeps['db'],
    notifyRenderer: () => {},
    hubUsers
  })
  return mountRestApp(app)
}

/** Drive one request against a freshly mounted app, always closing it. */
async function call<T>(
  hubUsers: RestApiDeps['hubUsers'],
  method: string,
  body?: unknown
): Promise<{ status: number; body: T }> {
  const rest = await mount(hubUsers)
  try {
    return await rest.request<T>(method, '/api/hub/users', body)
  } finally {
    await rest.close()
  }
}

await describe('POST /api/hub/users', () => {
  test('creates an account and returns the generated password once', async () => {
    const res = await call<{ ok: boolean; data: { email: string; name: string; password: string } }>(
      stubUsers(),
      'POST',
      { email: 'alice@example.com', name: 'Alice' }
    )
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.email).toBe('alice@example.com')
    expect(res.body.data.name).toBe('Alice')
    expect(res.body.data.password).toBe('generated-pw')
  })

  test('passes no name through when omitted, so the domain layer defaults it', async () => {
    let seen: { email: string; name?: string } | null = null
    const res = await call<{ data: { name: string } }>(
      stubUsers({
        create: async (input) => {
          seen = input
          return {
            ok: true as const,
            user: { id: 'u1', email: input.email, name: 'bob', password: 'pw' }
          }
        }
      }),
      'POST',
      { email: 'bob@example.com' }
    )
    expect(res.status).toBe(200)
    expect(seen!.name).toBeUndefined()
    expect(res.body.data.name).toBe('bob')
  })

  test('a blank name is treated as absent, not as an empty display name', async () => {
    let seen: { email: string; name?: string } | null = null
    await call(
      stubUsers({
        create: async (input) => {
          seen = input
          return {
            ok: true as const,
            user: { id: 'u1', email: input.email, name: 'bob', password: 'pw' }
          }
        }
      }),
      'POST',
      { email: 'bob@example.com', name: '   ' }
    )
    expect(seen!.name).toBeUndefined()
  })

  test('409 when the account already exists', async () => {
    const res = await call<{ ok: boolean; error: string }>(
      stubUsers({ create: async () => ({ ok: false as const, reason: 'exists' as const }) }),
      'POST',
      { email: 'alice@example.com' }
    )
    expect(res.status).toBe(409)
    expect(res.body.ok).toBe(false)
  })

  test('400 for a missing / blank / malformed email', async () => {
    for (const body of [
      {},
      { email: '' },
      { email: '   ' },
      { email: 'no-at-sign' },
      { email: 'has space@example.com' },
      { email: 42 }
    ]) {
      const res = await call<{ error: string }>(stubUsers(), 'POST', body)
      expect(res.status).toBe(400)
    }
  })

  test('400 for the reserved runner service identity, never reaching the domain layer', async () => {
    let called = false
    const res = await call<{ error: string }>(
      stubUsers({
        create: async () => {
          called = true
          return { ok: false as const, reason: 'exists' as const }
        }
      }),
      'POST',
      // Mixed case: the guard must normalize before comparing, or it is bypassable.
      { email: 'Runners@SlayZone.Internal' }
    )
    expect(res.status).toBe(400)
    expect(called).toBe(false)
  })

  test('500 with a message when the domain layer throws', async () => {
    const res = await call<{ ok: boolean; message: string }>(
      stubUsers({
        create: async () => {
          throw new Error('sqlite exploded')
        }
      }),
      'POST',
      { email: 'alice@example.com' }
    )
    expect(res.status).toBe(500)
    expect(res.body.message).toBe('sqlite exploded')
  })
})

await describe('GET /api/hub/users', () => {
  test('lists accounts', async () => {
    const rows = [
      { id: 'u1', email: 'alice@example.com', name: 'Alice', createdAt: '2026-01-01T00:00:00.000Z' }
    ]
    const res = await call<{ ok: boolean; data: typeof rows }>(
      stubUsers({ list: async () => rows }),
      'GET'
    )
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual(rows)
  })

  test('an empty hub lists nothing rather than erroring', async () => {
    const res = await call<{ ok: boolean; data: unknown[] }>(stubUsers(), 'GET')
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  test('500 when the domain layer throws', async () => {
    const res = await call<{ ok: boolean }>(
      stubUsers({
        list: async () => {
          throw new Error('nope')
        }
      }),
      'GET'
    )
    expect(res.status).toBe(500)
  })
})

await describe('DELETE /api/hub/users', () => {
  test('removes the named account (email travels in the body, not the path)', async () => {
    let seen = ''
    const res = await call<{ ok: boolean; data: { email: string } }>(
      stubUsers({
        remove: async (email) => {
          seen = email
          return 'ok' as const
        }
      }),
      'DELETE',
      { email: 'alice@example.com' }
    )
    expect(res.status).toBe(200)
    expect(seen).toBe('alice@example.com')
    expect(res.body.data.email).toBe('alice@example.com')
  })

  test('404 for an unknown account', async () => {
    const res = await call<{ ok: boolean }>(
      stubUsers({ remove: async () => 'not-found' as const }),
      'DELETE',
      { email: 'nobody@example.com' }
    )
    expect(res.status).toBe(404)
  })

  test('409 for the protected runner service identity', async () => {
    const res = await call<{ ok: boolean; error: string }>(
      stubUsers({ remove: async () => 'protected' as const }),
      'DELETE',
      { email: SERVICE_EMAIL }
    )
    expect(res.status).toBe(409)
    expect(res.body.error.includes('runner service identity')).toBe(true)
  })

  test('409 when it would remove the last remaining account', async () => {
    const res = await call<{ ok: boolean; error: string }>(
      stubUsers({ remove: async () => 'last-user' as const }),
      'DELETE',
      { email: 'alice@example.com' }
    )
    expect(res.status).toBe(409)
    expect(res.body.error.includes('unauthenticatable')).toBe(true)
  })

  test('400 for a missing email', async () => {
    const res = await call<{ error: string }>(stubUsers(), 'DELETE', {})
    expect(res.status).toBe(400)
  })
})

await describe('the capability gate (slot absent / not ready)', () => {
  test('503 on every method when the slot is absent (e.g. the Electron host)', async () => {
    for (const [method, body] of [
      ['POST', { email: 'a@b.c' }],
      ['GET', undefined],
      ['DELETE', { email: 'a@b.c' }]
    ] as const) {
      const res = await call<{ ok: boolean; error: string }>(undefined, method, body)
      expect(res.status).toBe(503)
    }
  })

  test('503 while hub-auth is not ready, naming where to look', async () => {
    const res = await call<{ ok: boolean; error: string }>(
      stubUsers({ ready: () => false }),
      'GET'
    )
    expect(res.status).toBe(503)
    // The failure is often PERMANENT (createHubAuth threw and was swallowed into a
    // diagnostic), so the message must not merely imply "retry".
    expect(res.body.error.includes('runner.init_failed')).toBe(true)
  })

  test('not-ready short-circuits before the domain layer is called', async () => {
    let called = false
    await call(
      stubUsers({
        ready: () => false,
        list: async () => {
          called = true
          return []
        }
      }),
      'GET'
    )
    expect(called).toBe(false)
  })
})

await describe('isLoopbackAddress (the 403 decision)', () => {
  test('accepts every loopback form node reports', () => {
    for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.53', '127.1.2.3']) {
      expect(isLoopbackAddress(addr)).toBe(true)
    }
  })

  test('rejects off-box peers and an unknown address (fails closed)', () => {
    for (const addr of ['10.0.0.5', '1.2.3.4', '192.168.1.10', '::ffff:10.0.0.5', '', undefined]) {
      expect(isLoopbackAddress(addr)).toBe(false)
    }
  })

  test('is not fooled by an address merely CONTAINING a loopback literal', () => {
    // Prefix-anchored, so a public address that happens to embed 127.0.0.1 is not
    // mistaken for loopback.
    expect(isLoopbackAddress('9.127.0.0.1')).toBe(false)
    expect(isLoopbackAddress('212.127.0.1')).toBe(false)
  })
})
