/**
 * REST: `/api/hub/users` contract tests — the operator account-management
 * surface behind `slay hub users add|ls|rm`.
 *
 * The `hubUsers` capability is a STUB here, deliberately: the real logic lives in
 * `@slayzone/hub-auth`'s users.ts (covered against real better-auth in its own
 * users.test.ts), and this package has no hub-auth dependency. Stubbing keeps the
 * test honest about that boundary and isolates what this layer actually owns —
 * status codes, body validation, and the peer/bearer/slot/ready gate.
 *
 * WHO MAY CALL is its own axis, decided by the pure `hubUsersAuthDecision`: on a
 * hub with NO auth (no `restAuth` slot — the Electron host's shape) loopback is
 * the sole authority. On a hub that ENFORCES auth (every standalone hub now —
 * `server.ts`'s `hubAuthRequired = !supervised`), a bearer is required from
 * EVERYONE, loopback included — the route used to trust any loopback peer
 * unconditionally, which a reverse proxy in front of a standalone hub turns into
 * "anyone who reaches the hub can create or delete accounts", defeating
 * `disableSignUp` entirely. The HTTP harness binds 127.0.0.1, so every peer it
 * can produce is loopback — which is why the auth-required matrix is asserted
 * directly against the pure function as well as through a request.
 */
import express from 'express'
import { test, expect, describe } from '../../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../test-utils/rest-harness.js'
import { hubUsersAuthDecision, isLoopbackAddress, registerHubUsersRoutes } from './users.js'
import type { RestApiDeps } from '../types.js'

const SERVICE_EMAIL = 'computers@slayzone.internal'

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
 * Mount the routes with the given capability slot (+ optional `restAuth`, for the
 * auth-required matrix below). `db` is irrelevant to these routes (they never
 * touch it) so a cast keeps the harness out — no Electron ABI needed, unlike the
 * sibling join-token suite.
 */
function mount(hubUsers: RestApiDeps['hubUsers'], restAuth?: RestApiDeps['restAuth']) {
  const app = express()
  app.use(express.json())
  registerHubUsersRoutes(app, {
    db: null as unknown as RestApiDeps['db'],
    notifyRenderer: () => {},
    hubUsers,
    ...(restAuth ? { restAuth } : {})
  })
  return mountRestApp(app)
}

/** Drive one request against a freshly mounted app, always closing it. */
async function call<T>(
  hubUsers: RestApiDeps['hubUsers'],
  method: string,
  body?: unknown,
  restAuth?: RestApiDeps['restAuth']
): Promise<{ status: number; body: T }> {
  const rest = await mount(hubUsers, restAuth)
  try {
    return await rest.request<T>(method, '/api/hub/users', body)
  } finally {
    await rest.close()
  }
}

await describe('POST /api/hub/users', () => {
  test('creates an account and returns the generated password once', async () => {
    const res = await call<{
      ok: boolean
      data: { email: string; name: string; password: string }
    }>(stubUsers(), 'POST', { email: 'alice@example.com', name: 'Alice' })
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

  test('400 for the reserved computer service identity, never reaching the domain layer', async () => {
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
      { email: 'Computers@SlayZone.Internal' }
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

  test('409 for the protected computer service identity', async () => {
    const res = await call<{ ok: boolean; error: string }>(
      stubUsers({ remove: async () => 'protected' as const }),
      'DELETE',
      { email: SERVICE_EMAIL }
    )
    expect(res.status).toBe(409)
    expect(res.body.error.includes('computer service identity')).toBe(true)
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
    const res = await call<{ ok: boolean; error: string }>(stubUsers({ ready: () => false }), 'GET')
    expect(res.status).toBe(503)
    // The failure is often PERMANENT (createHubAuth threw and was swallowed into a
    // diagnostic), so the message must not merely imply "retry".
    expect(res.body.error.includes('computer.init_failed')).toBe(true)
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

/**
 * WHO MAY CALL — through a real request. Extends the capability-gate suite above
 * with the peer/bearer axis: on a hub with NO `restAuth` slot, loopback still
 * administers unconditionally (unchanged, the Electron-host shape). Once
 * `restAuth` is present and `required()` is true, a loopback caller is no longer
 * special — this is the regression fix (see `hubUsersAuthDecision` below).
 */
await describe('the peer/bearer gate (auth-required matrix, through a real request)', () => {
  test('with no restAuth slot, loopback administers with no bearer check', async () => {
    const res = await call<{ ok: boolean }>(stubUsers(), 'GET')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  test('loopback caller on an auth-enforcing hub MUST present a bearer (create)', async () => {
    let verifyCalls = 0
    const res = await call<{ ok: boolean }>(
      stubUsers(),
      'POST',
      { email: 'intruder@example.com' },
      {
        required: () => true,
        verifyBearer: async () => {
          verifyCalls++
          return null
        }
      }
    )
    expect(res.status).toBe(401)
    expect(res.body.ok).toBe(false)
    expect(verifyCalls).toBe(1)
  })

  test('loopback caller on an auth-enforcing hub MUST present a bearer (list)', async () => {
    const res = await call<{ ok: boolean }>(stubUsers(), 'GET', undefined, {
      required: () => true,
      verifyBearer: async () => null
    })
    expect(res.status).toBe(401)
  })

  test('loopback caller on an auth-enforcing hub MUST present a bearer (remove)', async () => {
    const res = await call<{ ok: boolean }>(
      stubUsers(),
      'DELETE',
      { email: 'x@example.com' },
      { required: () => true, verifyBearer: async () => null }
    )
    expect(res.status).toBe(401)
  })

  test('loopback caller on an auth-enforcing hub administers WITH a valid bearer', async () => {
    const res = await call<{ ok: boolean }>(stubUsers(), 'GET', undefined, {
      required: () => true,
      verifyBearer: async () => ({ userId: 'u1', scopes: ['full'] })
    })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  test('loopback caller on an auth-enforcing hub is REFUSED with a scoped (non-full) bearer', async () => {
    // A szw_ web session must not be able to administer accounts even though
    // it presents a genuinely valid credential — this gate checks for `full`
    // specifically, not merely "verifyBearer resolved something".
    const res = await call<{ ok: boolean }>(stubUsers(), 'GET', undefined, {
      required: () => true,
      verifyBearer: async () => ({ userId: 'u2', scopes: ['read', 'tasks'] })
    })
    expect(res.status).toBe(401)
  })
})

/**
 * WHO MAY ADMINISTER — the pure decision, exhaustively. Mirrors the sibling
 * `computers/join-token.test.ts`'s `joinTokenAuthDecision` matrix on purpose: the
 * same reverse-proxy shape threatened both routes, fixed the same way, and they
 * must not be allowed to diverge silently.
 */
await describe('hubUsersAuthDecision', () => {
  test('auth NOT required (supervised): loopback allows, off-box is forbidden', () => {
    expect(hubUsersAuthDecision({ loopback: true, authRequired: false, bearerOk: false })).toBe(
      'allow'
    )
    expect(hubUsersAuthDecision({ loopback: false, authRequired: false, bearerOk: false })).toBe(
      'forbid'
    )
    // Even a caller that WOULD verify gets forbidden — no sessions exist to check.
    expect(hubUsersAuthDecision({ loopback: false, authRequired: false, bearerOk: true })).toBe(
      'forbid'
    )
  })

  test('auth REQUIRED: loopback is NOT special — a bearer is required either way', () => {
    // THE REGRESSION MATRIX — the old gate admitted any loopback peer
    // unconditionally, regardless of `authRequired`.
    expect(hubUsersAuthDecision({ loopback: true, authRequired: true, bearerOk: true })).toBe(
      'allow'
    )
    expect(hubUsersAuthDecision({ loopback: true, authRequired: true, bearerOk: false })).toBe(
      'unauthorized'
    )
  })

  test('off-box on an enforcing hub: valid bearer allows, missing/invalid is 401', () => {
    expect(hubUsersAuthDecision({ loopback: false, authRequired: true, bearerOk: true })).toBe(
      'allow'
    )
    expect(hubUsersAuthDecision({ loopback: false, authRequired: true, bearerOk: false })).toBe(
      'unauthorized'
    )
  })
})

await describe('isLoopbackAddress (the loopback-only decision, no restAuth slot)', () => {
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
