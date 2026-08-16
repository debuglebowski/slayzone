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
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
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
    create: publicProcedure.query(() => 'create-ok')
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
  return { db: {} as never, dataRoot: '/tmp', principal }
}

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
      const caller = testRouter.createCaller(ctx({ userId: 'u1', scopes: ['full'] }))
      await expect(caller.pty.write()).resolves.toBe('write-ok')
      await expect(caller.pty.create()).resolves.toBe('create-ok') // never-classified, full bypasses it
      await expect(caller.brandNewRouter.brandNewProcedure()).resolves.toBe('unclassified-ok')
    })

    test('agent scope reaches pty.write but is FORBIDDEN on pty.create', async () => {
      const caller = testRouter.createCaller(ctx({ userId: 'u2', scopes: ['agent'] }))
      await expect(caller.pty.write()).resolves.toBe('write-ok')
      await expect(caller.pty.create()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    })

    test('read+tasks does NOT reach an agent-only path', async () => {
      const caller = testRouter.createCaller(ctx({ userId: 'u3', scopes: ['read', 'tasks'] }))
      await expect(caller.pty.write()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    })

    test('an UNCLASSIFIED path is FORBIDDEN even for a scope that would otherwise qualify', async () => {
      const caller = testRouter.createCaller(
        ctx({ userId: 'u4', scopes: ['read', 'tasks', 'agent'] })
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
})
