/**
 * The scope + auth gate middleware chain, exercised via a tiny standalone
 * router — not the full `appRouter`, which needs the entire server composition
 * (`ops()` registries, DB, etc.) wired to do anything past the gate. This
 * isolates the MIDDLEWARE, which is what needs to be right; the per-procedure
 * classification is `scopes.test.ts`'s job.
 *
 * THE PATHS ARE NOT COSMETIC. The test router's top-level keys are literally
 * `pty` and `hub`, with `write`/`create`/`describe` procedures — so a call
 * through `createCaller` produces the EXACT dotted paths (`pty.write`,
 * `pty.create`, `hub.describe`) that the REAL `SCOPE_POLICY` in `scopes.ts`
 * classifies. That means this test exercises the ACTUAL gate against the
 * ACTUAL policy, with lightweight stand-in handlers — not a mechanism test
 * against fabricated paths that happen to always resolve to `never`.
 *
 * Covers exactly the matrix the plan calls for:
 *   - full reaches a never-classified path (desktop/CLI unaffected)
 *   - a scoped principal reaches its granted path, FORBIDDEN on a denied one
 *   - an UNKNOWN path is FORBIDDEN even for an otherwise-qualifying scope
 *   - principal == null with the gate on still 401s (unchanged from before
 *     scopes existed)
 *   - gate off → everything passes, no principal needed at all
 *   - every refusal writes one `authz.denied` audit line (T-03), and a procedure
 *     runs with the caller as the acting user for the audit lines below it
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { currentSecurityContext, setSecurityLogSink } from '@slayzone/platform/security-log'
import { publicProcedure, openProcedure, router } from './trpc'
import { setAuthGate } from './app-deps'
import type { TrpcContext } from './context'

// `pty.write` -> 'agent' and `pty.create` -> 'never' in the REAL SCOPE_POLICY
// (see scopes.ts / scopes.test.ts). `hub.describe` is real too, but reachable
// via `openProcedure` regardless of scope — included to prove that stays true
// even when this test's OWN router puts it behind a gated builder by mistake
// would be caught, since it's declared with `openProcedure` here exactly as
// the real router declares it.
const testRouter = router({
  pty: router({
    write: publicProcedure.query(() => 'write-ok'),
    create: publicProcedure.query(() => 'create-ok'),
    // Not in SCOPE_POLICY; called only by `full` principals or with the gate off.
    whoami: publicProcedure.query(() => currentSecurityContext() ?? null)
  }),
  hub: router({
    describe: openProcedure.query(() => 'describe-ok')
  }),
  // No SCOPE_POLICY entry exists for this path at all — stands in for "a
  // procedure added tomorrow that nobody has classified yet".
  brandNewRouter: router({
    brandNewProcedure: publicProcedure.query(() => 'unclassified-ok')
  })
})

function ctx(principal: TrpcContext['principal']): TrpcContext {
  return {
    db: {} as never,
    dataRoot: '/tmp',
    principal,
    req: { socket: { remoteAddress: '203.0.113.7' } } as never
  }
}

/** Audit lines written while the test runs. */
let audit: Array<Record<string, unknown>> = []
beforeEach(() => {
  audit = []
  setSecurityLogSink((line) => audit.push(JSON.parse(line) as Record<string, unknown>))
})
afterEach(() => setSecurityLogSink())

describe('trpc auth + scope gate', () => {
  afterEach(() => {
    setAuthGate(() => false) // restore the default (off) after every test
  })

  describe('gate OFF (local / supervised / e2e — the default)', () => {
    beforeEach(() => setAuthGate(() => false))

    test('every path passes with no principal at all', async () => {
      const caller = testRouter.createCaller(ctx(null))
      await expect(caller.pty.write()).resolves.toBe('write-ok')
      await expect(caller.pty.create()).resolves.toBe('create-ok')
      await expect(caller.brandNewRouter.brandNewProcedure()).resolves.toBe('unclassified-ok')
      await expect(caller.hub.describe()).resolves.toBe('describe-ok')
    })
  })

  describe('gate ON', () => {
    beforeEach(() => setAuthGate(() => true))

    test('principal == null still 401s (unchanged from before scopes existed)', async () => {
      const caller = testRouter.createCaller(ctx(null))
      await expect(caller.pty.write()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    })

    test('full reaches every path, including one classified never', async () => {
      const caller = testRouter.createCaller(ctx({ userId: 'u1', role: 'user', scopes: ['full'] }))
      await expect(caller.pty.write()).resolves.toBe('write-ok')
      await expect(caller.pty.create()).resolves.toBe('create-ok') // never-classified, full bypasses it
      await expect(caller.brandNewRouter.brandNewProcedure()).resolves.toBe('unclassified-ok')
    })

    test('agent scope reaches pty.write but is FORBIDDEN on pty.create', async () => {
      const caller = testRouter.createCaller(ctx({ userId: 'u2', role: 'user', scopes: ['agent'] }))
      await expect(caller.pty.write()).resolves.toBe('write-ok')
      await expect(caller.pty.create()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    })

    test('read+tasks does NOT reach an agent-only path', async () => {
      const caller = testRouter.createCaller(
        ctx({ userId: 'u3', role: 'user', scopes: ['read', 'tasks'] })
      )
      await expect(caller.pty.write()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    })

    test('an UNCLASSIFIED path is FORBIDDEN even for a scope that would otherwise qualify', async () => {
      const caller = testRouter.createCaller(
        ctx({ userId: 'u4', role: 'user', scopes: ['read', 'tasks', 'agent'] })
      )
      await expect(caller.brandNewRouter.brandNewProcedure()).rejects.toMatchObject({
        code: 'FORBIDDEN'
      })
    })

    test('openProcedure bypasses BOTH gates even with no principal at all', async () => {
      const caller = testRouter.createCaller(ctx(null))
      await expect(caller.hub.describe()).resolves.toBe('describe-ok')
    })
  })

  describe('audit (T-03)', () => {
    beforeEach(() => setAuthGate(() => true))

    test('a 401 writes one authz.denied line: no actor, peer ip, the procedure', async () => {
      const caller = testRouter.createCaller(ctx(null))
      await expect(caller.pty.write()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({
        type: 'security',
        event: 'authz.denied',
        outcome: 'denied',
        level: 'warn',
        actor: null,
        ip: '203.0.113.7',
        targetKind: 'procedure',
        targetId: 'pty.write',
        route: 'trpc pty.write',
        detail: { reason: 'unauthenticated' }
      })
    })

    test('a scope refusal writes authz.denied with the actor and the scopes held', async () => {
      const caller = testRouter.createCaller(ctx({ userId: 'u2', role: 'user', scopes: ['agent'] }))
      await expect(caller.pty.create()).rejects.toMatchObject({ code: 'FORBIDDEN' })
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({
        event: 'authz.denied',
        actor: 'u2',
        targetId: 'pty.create',
        detail: { reason: 'scope', scopes: ['agent'] }
      })
    })

    test('an allowed call writes nothing', async () => {
      const caller = testRouter.createCaller(ctx({ userId: 'u1', role: 'user', scopes: ['full'] }))
      await expect(caller.pty.write()).resolves.toBe('write-ok')
      expect(audit).toHaveLength(0)
    })

    test('a procedure runs with the caller as the acting user', async () => {
      const caller = testRouter.createCaller(ctx({ userId: 'u1', role: 'user', scopes: ['full'] }))
      await expect(caller.pty.whoami()).resolves.toEqual({
        actor: 'u1',
        ip: '203.0.113.7',
        route: 'trpc pty.whoami'
      })
    })

    test('gate off: nothing is refused, so nothing is written', async () => {
      setAuthGate(() => false)
      const caller = testRouter.createCaller(ctx(null))
      await expect(caller.pty.create()).resolves.toBe('create-ok')
      expect(audit).toHaveLength(0)
    })
  })
})
