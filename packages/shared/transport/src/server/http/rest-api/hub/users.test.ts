/**
 * REST: `/api/hub/users` contract tests — the operator account-management
 * surface behind `slay hub users add|ls|disable|enable|role`.
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
 * "anyone who reaches the hub can create or disable accounts", defeating
 * `disableSignUp` entirely. The HTTP harness binds 127.0.0.1, so every peer it
 * can produce is loopback — which is why the auth-required matrix is asserted
 * directly against the pure function as well as through a request.
 */
import express from 'express'
import { test, expect, describe } from '../../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../test-utils/rest-harness.js'
import { currentSecurityContext, setSecurityLogSink } from '@slayzone/platform/security-log'
import { HubSwitchedOffError } from '@slayzone/platform/hub-switch-refusal'
import {
  hubUsersAuthDecision,
  isLoopbackAddress,
  registerHubUsersRoutes,
  SSO_MANAGED_ROLE_CODE
} from './users.js'
import type { RestApiDeps } from '../types.js'

const SERVICE_EMAIL = 'computers@slayzone.internal'

type HubUsers = NonNullable<RestApiDeps['hubUsers']>

/** A ready capability whose outcomes the individual tests dictate. */
function stubUsers(overrides: Partial<HubUsers> = {}): HubUsers {
  return {
    ready: () => true,
    create: async ({ email, name, role }) => ({
      ok: true as const,
      user: {
        id: 'u1',
        email,
        name: name ?? email.split('@')[0]!,
        role: role ?? 'user',
        password: 'generated-pw'
      }
    }),
    list: async () => [],
    disable: async () => 'ok' as const,
    enable: async () => 'ok' as const,
    setRole: async () => 'ok' as const,
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
            user: { id: 'u1', email: input.email, name: 'bob', role: 'user', password: 'pw' }
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
            user: { id: 'u1', email: input.email, name: 'bob', role: 'user', password: 'pw' }
          }
        }
      }),
      'POST',
      { email: 'bob@example.com', name: '   ' }
    )
    expect(seen!.name).toBeUndefined()
  })

  test('passes a role through, and 400 for anything but admin or user', async () => {
    let seen: { role?: string } | null = null
    const res = await call<{ data: { role: string } }>(
      stubUsers({
        create: async (input) => {
          seen = input
          return {
            ok: true as const,
            user: { id: 'u1', email: input.email, name: 'a', role: input.role!, password: 'pw' }
          }
        }
      }),
      'POST',
      { email: 'alice@example.com', role: 'admin' }
    )
    expect(res.status).toBe(200)
    expect(seen!.role).toBe('admin')
    expect(res.body.data.role).toBe('admin')
    for (const role of ['owner', '', 1, null]) {
      const bad = await call(stubUsers(), 'POST', { email: 'alice@example.com', role })
      expect(bad.status).toBe(400)
    }
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

await describe('POST /api/hub/users on a hub with Entra sign-in', () => {
  test('an admin account asked for: 409 with the stable code, not "already exists"', async () => {
    const res = await call<{ ok: boolean; code: string; error: string }>(
      stubUsers({ create: async () => ({ ok: false as const, reason: 'sso-managed' as const }) }),
      'POST',
      { email: 'alice@example.com', role: 'admin' }
    )
    expect(res.status).toBe(409)
    expect(res.body.code).toBe(SSO_MANAGED_ROLE_CODE)
    expect(res.body.error.includes('already exists')).toBe(false)
  })
})

await describe('POST /api/hub/users with password sign-in off (T-10)', () => {
  test('403 with the switch code and message, not a 500', async () => {
    const res = await call<{ ok: boolean; code: string; error: string }>(
      stubUsers({
        create: async () => {
          // What hub-auth's createHubUser throws (after its own audit line).
          throw new HubSwitchedOffError('HUB_PASSWORD_DISABLED')
        }
      }),
      'POST',
      { email: 'alice@example.com' }
    )
    expect(res.status).toBe(403)
    expect(res.body.ok).toBe(false)
    expect(res.body.code).toBe('HUB_PASSWORD_DISABLED')
    expect(res.body.error.includes('SLAYZONE_HUB_ENABLE_PASSWORD=0')).toBe(true)
  })
})

await describe('GET /api/hub/users', () => {
  test('lists accounts', async () => {
    const rows = [
      {
        id: 'u1',
        email: 'alice@example.com',
        name: 'Alice',
        role: 'admin' as const,
        disabledAt: null,
        createdAt: '2026-01-01T00:00:00.000Z'
      }
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

await describe('PATCH /api/hub/users', () => {
  /** Records which capability method a PATCH reached, with what. */
  function recording(outcome: 'ok' | 'not-found' | 'protected' | 'last-user' | 'last-admin') {
    const calls: string[] = []
    const users = stubUsers({
      disable: async (email) => {
        calls.push(`disable ${email}`)
        return outcome as never
      },
      enable: async (email) => {
        calls.push(`enable ${email}`)
        return outcome as never
      },
      setRole: async (email, role) => {
        calls.push(`role ${email} ${role}`)
        return outcome as never
      }
    })
    return { users, calls }
  }

  test('disabled:true disables, disabled:false enables, role sets the role', async () => {
    const { users, calls } = recording('ok')
    const disable = await call<{ data: unknown }>(users, 'PATCH', {
      email: 'alice@example.com',
      disabled: true
    })
    expect(disable.status).toBe(200)
    expect(disable.body.data).toEqual({ email: 'alice@example.com', disabled: true })
    expect(
      (await call(users, 'PATCH', { email: 'alice@example.com', disabled: false })).status
    ).toBe(200)
    const role = await call<{ data: unknown }>(users, 'PATCH', {
      email: 'alice@example.com',
      role: 'admin'
    })
    expect(role.body.data).toEqual({ email: 'alice@example.com', role: 'admin' })
    expect(calls).toEqual([
      'disable alice@example.com',
      'enable alice@example.com',
      'role alice@example.com admin'
    ])
  })

  test('400 unless exactly one valid change is sent', async () => {
    const { users, calls } = recording('ok')
    for (const body of [
      { email: 'alice@example.com' },
      { email: 'alice@example.com', disabled: 'yes' },
      { email: 'alice@example.com', role: 'owner' },
      { email: 'alice@example.com', disabled: true, role: 'admin' },
      { disabled: true }
    ]) {
      expect((await call(users, 'PATCH', body)).status).toBe(400)
    }
    expect(calls).toEqual([])
  })

  test('maps each refusal to a status and a reason', async () => {
    const cases = [
      ['not-found', { disabled: true }, 404, 'no user with email'],
      ['protected', { disabled: true }, 409, SERVICE_EMAIL],
      ['last-user', { disabled: true }, 409, 'last enabled account'],
      ['last-admin', { disabled: true }, 409, 'disable the last enabled admin'],
      ['last-admin', { role: 'user' }, 409, 'demote the last enabled admin']
    ] as const
    for (const [outcome, change, status, text] of cases) {
      const res = await call<{ ok: boolean; error: string }>(recording(outcome).users, 'PATCH', {
        email: 'alice@example.com',
        ...change
      })
      expect(res.status).toBe(status)
      expect(res.body.ok).toBe(false)
      expect(res.body.error.includes(text)).toBe(true)
    }
  })

  test('a role change on a hub with Entra sign-in: 409 with the stable code', async () => {
    const res = await call<{ ok: boolean; code: string; error: string }>(
      recording('sso-managed' as never).users,
      'PATCH',
      { email: 'alice@example.com', role: 'admin' }
    )
    expect(res.status).toBe(409)
    expect(res.body.ok).toBe(false)
    expect(res.body.code).toBe(SSO_MANAGED_ROLE_CODE)
    expect(res.body.error.includes('SlayZone.Admin')).toBe(true)
  })

  test('500 with a message when the domain layer throws', async () => {
    const res = await call<{ message: string }>(
      stubUsers({
        disable: async () => {
          throw new Error('sqlite exploded')
        }
      }),
      'PATCH',
      { email: 'alice@example.com', disabled: true }
    )
    expect(res.status).toBe(500)
    expect(res.body.message).toBe('sqlite exploded')
  })
})

await describe('DELETE /api/hub/users', () => {
  test('410: accounts are disabled, never removed — names the renamed command', async () => {
    const { users, calls } = (() => {
      const calls: string[] = []
      return {
        calls,
        users: stubUsers({
          disable: async () => {
            calls.push('disable')
            return 'ok' as const
          }
        })
      }
    })()
    const res = await call<{ ok: boolean; error: string }>(users, 'DELETE', {
      email: 'alice@example.com'
    })
    expect(res.status).toBe(410)
    expect(res.body.error.includes('renamed to `slay hub users disable <email>`')).toBe(true)
    expect(calls).toEqual([])
  })
})

await describe('the capability gate (slot absent / not ready)', () => {
  test('503 on every method when the slot is absent (e.g. the Electron host)', async () => {
    for (const [method, body] of [
      ['POST', { email: 'a@b.c' }],
      ['GET', undefined],
      ['PATCH', { email: 'a@b.c', disabled: true }],
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

  test('loopback caller on an auth-enforcing hub MUST present a bearer (disable, DELETE)', async () => {
    for (const [method, body] of [
      ['PATCH', { email: 'x@example.com', disabled: true }],
      ['DELETE', { email: 'x@example.com' }]
    ] as const) {
      const res = await call<{ ok: boolean }>(stubUsers(), method, body, {
        required: () => true,
        verifyBearer: async () => null
      })
      expect(res.status).toBe(401)
    }
  })

  test('loopback caller on an auth-enforcing hub administers WITH a valid bearer', async () => {
    const res = await call<{ ok: boolean }>(stubUsers(), 'GET', undefined, {
      required: () => true,
      verifyBearer: async () => ({ userId: 'u1', role: 'admin', scopes: ['full'] })
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
      verifyBearer: async () => ({ userId: 'u2', role: 'user', scopes: ['read', 'tasks'] })
    })
    expect(res.status).toBe(401)
  })

  test('a full bearer of a USER account gets 403 on every method; the domain is never called', async () => {
    const audit: Array<Record<string, unknown>> = []
    setSecurityLogSink((line) => audit.push(JSON.parse(line) as Record<string, unknown>))
    const calls: string[] = []
    const users = stubUsers({
      list: async () => {
        calls.push('list')
        return []
      },
      create: async () => {
        calls.push('create')
        return { ok: false as const, reason: 'exists' as const }
      },
      disable: async () => {
        calls.push('disable')
        return 'ok' as const
      },
      enable: async () => {
        calls.push('enable')
        return 'ok' as const
      },
      setRole: async () => {
        calls.push('setRole')
        return 'ok' as const
      }
    })
    const restAuth = {
      required: () => true,
      verifyBearer: async () => ({
        userId: 'u-user',
        role: 'user' as const,
        scopes: ['full' as const]
      })
    }
    try {
      for (const [method, body] of [
        ['GET', undefined],
        ['POST', { email: 'new@example.com', role: 'admin' }],
        ['PATCH', { email: 'other@example.com', disabled: true }],
        ['PATCH', { email: 'other@example.com', disabled: false }],
        // Promoting itself — the escalation this gate exists for.
        ['PATCH', { email: 'self@example.com', role: 'admin' }],
        ['DELETE', { email: 'other@example.com' }]
      ] as const) {
        const res = await call<{ ok: boolean; error: string; code?: string }>(
          users,
          method,
          body,
          restAuth
        )
        expect(res.status).toBe(403)
        expect(res.body.error.includes('needs an admin account')).toBe(true)
        expect(res.body.code).toBe('ADMIN_ONLY')
      }
    } finally {
      setSecurityLogSink()
    }
    expect(calls).toEqual([])
    expect(audit).toHaveLength(6)
    for (const line of audit) {
      expect(line.event).toBe('authz.denied')
      expect(line.actor).toBe('u-user')
      expect(line.detail).toEqual({ reason: 'not_admin', status: 403, code: 'ADMIN_ONLY' })
    }
  })

  test('a full bearer of an ADMIN account passes on every method', async () => {
    const restAuth = {
      required: () => true,
      verifyBearer: async () => ({
        userId: 'u-admin',
        role: 'admin' as const,
        scopes: ['full' as const]
      })
    }
    for (const [method, body, status] of [
      ['GET', undefined, 200],
      ['POST', { email: 'new@example.com' }, 200],
      ['PATCH', { email: 'other@example.com', role: 'admin' }, 200],
      ['DELETE', { email: 'other@example.com' }, 410]
    ] as const) {
      expect((await call(stubUsers(), method, body, restAuth)).status).toBe(status)
    }
  })

  test('a scoped web session of an ADMIN account still never passes (401, unchanged)', async () => {
    const res = await call<{ ok: boolean }>(stubUsers(), 'GET', undefined, {
      required: () => true,
      verifyBearer: async () => ({ userId: 'u-admin', role: 'admin', scopes: ['read', 'tasks'] })
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
    expect(
      hubUsersAuthDecision({ loopback: true, authRequired: false, bearerOk: false, admin: false })
    ).toBe('allow')
    expect(
      hubUsersAuthDecision({ loopback: false, authRequired: false, bearerOk: false, admin: false })
    ).toBe('forbid')
    // Even a caller that WOULD verify gets forbidden — no sessions exist to check.
    expect(
      hubUsersAuthDecision({ loopback: false, authRequired: false, bearerOk: true, admin: true })
    ).toBe('forbid')
  })

  test('auth REQUIRED: loopback is NOT special — a bearer is required either way', () => {
    // THE REGRESSION MATRIX — the old gate admitted any loopback peer
    // unconditionally, regardless of `authRequired`.
    expect(
      hubUsersAuthDecision({ loopback: true, authRequired: true, bearerOk: true, admin: true })
    ).toBe('allow')
    expect(
      hubUsersAuthDecision({ loopback: true, authRequired: true, bearerOk: false, admin: false })
    ).toBe('unauthorized')
  })

  test('auth REQUIRED: a valid full bearer of a non-admin account is not-admin, from anywhere', () => {
    for (const loopback of [true, false]) {
      expect(
        hubUsersAuthDecision({ loopback, authRequired: true, bearerOk: true, admin: false })
      ).toBe('not-admin')
    }
    // Admin without a valid full bearer is still a credential problem, not a role one.
    expect(
      hubUsersAuthDecision({ loopback: true, authRequired: true, bearerOk: false, admin: true })
    ).toBe('unauthorized')
    // Login off: no sessions, no roles — loopback alone decides, as before.
    expect(
      hubUsersAuthDecision({ loopback: true, authRequired: false, bearerOk: false, admin: false })
    ).toBe('allow')
  })

  test('off-box on an enforcing hub: valid bearer allows, missing/invalid is 401', () => {
    expect(
      hubUsersAuthDecision({ loopback: false, authRequired: true, bearerOk: true, admin: true })
    ).toBe('allow')
    expect(
      hubUsersAuthDecision({ loopback: false, authRequired: true, bearerOk: false, admin: false })
    ).toBe('unauthorized')
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

await describe('audit (T-03)', () => {
  test('a refusal writes authz.denied; account commands run as the verified caller', async () => {
    const audit: Array<Record<string, unknown>> = []
    setSecurityLogSink((line) => audit.push(JSON.parse(line) as Record<string, unknown>))
    const actors: Array<string | null | undefined> = []
    const users = stubUsers({
      create: async ({ email }) => {
        actors.push(currentSecurityContext()?.actor)
        return {
          ok: true as const,
          user: { id: 'u9', email, name: 'n', role: 'user', password: 'pw' }
        }
      },
      disable: async () => {
        actors.push(currentSecurityContext()?.actor)
        return 'ok' as const
      },
      enable: async () => {
        actors.push(currentSecurityContext()?.actor)
        return 'ok' as const
      },
      setRole: async () => {
        actors.push(currentSecurityContext()?.actor)
        return 'ok' as const
      }
    })
    let principal: { userId: string; role: 'admin'; scopes: Array<'full'> } | null = null
    const rest = await mount(users, { required: () => true, verifyBearer: async () => principal })
    try {
      expect(
        (await rest.request('POST', '/api/hub/users', { email: 'a@example.com' })).status
      ).toBe(401)
      principal = { userId: 'admin-1', role: 'admin', scopes: ['full'] }
      expect(
        (await rest.request('POST', '/api/hub/users', { email: 'a@example.com' })).status
      ).toBe(200)
      for (const change of [{ disabled: true }, { disabled: false }, { role: 'admin' }]) {
        expect(
          (await rest.request('PATCH', '/api/hub/users', { email: 'a@example.com', ...change }))
            .status
        ).toBe(200)
      }
    } finally {
      setSecurityLogSink()
      await rest.close()
    }
    expect(audit.map((l) => `${l.event}:${l.outcome}`)).toEqual(['authz.denied:denied'])
    expect(audit[0]!.route).toBe('POST /api/hub/users')
    expect((audit[0]!.detail as { reason: string }).reason).toBe('unauthenticated')
    expect(actors).toEqual(['admin-1', 'admin-1', 'admin-1', 'admin-1'])
    expect(JSON.stringify(audit)).not.toContain('a@example.com')
  })
})
