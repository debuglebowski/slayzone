/**
 * `settings.set` per key, for a scoped session (#164).
 *
 * The scope gate is per procedure, but `settings` holds two kinds of keys: a user's
 * own UI state (view state, layout), which the web shell must be able to save, and
 * hub-wide config the hub ACTS on (`test_profiles` are commands it runs). A web
 * session (`read`, `tasks`, `agent`) may write the first and never the second —
 * not even an admin's, since the scope is about the credential, not the account.
 *
 * A stand-in router at the real path `settings.set`, so the real `SCOPE_POLICY`
 * and the real `settingsWriteProcedure` decide; the handler is a stub.
 */
// The gate chain's tables, as `router.ts` registers them for the real app router.
import '../procedure-policy'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { router, setAuthGate, type TrpcContext } from '@slayzone/trpc-server'
import type { Scope } from '@slayzone/transport/scopes'
import { settingsWriteProcedure } from './settings-admin'

const testRouter = router({
  settings: router({
    set: settingsWriteProcedure
      .input(z.object({ key: z.string(), value: z.string() }))
      .mutation(() => 'ok')
  })
})

const WEB: readonly Scope[] = ['read', 'tasks', 'agent']

function set(scopes: readonly Scope[], role: 'admin' | 'user', key: string): Promise<unknown> {
  const ctx = {
    // The owner gate checks a project key (`ai_providers:p1`) first: the caller owns it,
    // so only the scope decides.
    db: { get: async () => ({ owner_user_id: 'u1' }), all: async () => [] },
    principal: { userId: 'u1', role, orgId: null, scopes }
  } as unknown as TrpcContext
  return testRouter
    .createCaller(ctx)
    .settings.set({ key, value: 'v' })
    .then(
      (r) => r,
      (err: unknown) => err
    )
}

const isScopeRefusal = (r: unknown): boolean =>
  r instanceof TRPCError && r.code === 'FORBIDDEN' && r.message.includes('scope')

let audit: Array<Record<string, unknown>> = []
beforeEach(() => {
  audit = []
  setSecurityLogSink((line) => audit.push(JSON.parse(line) as Record<string, unknown>))
  setAuthGate(() => true)
})
afterEach(() => {
  setSecurityLogSink()
  setAuthGate(() => false)
})

describe('settings.set for a web session', () => {
  test('saves its own UI state', async () => {
    for (const key of ['viewState', 'panel_config', 'sidebar_width']) {
      expect(await set(WEB, 'user', key), key).toBe('ok')
    }
    expect(audit).toEqual([])
  })

  test('never writes a hub-wide or internal key, even on an admin account', async () => {
    for (const key of [
      'test_profiles',
      'default_terminal_mode',
      'worktree_copy_paths',
      'ai_providers:p1',
      'integration:credential:linear'
    ]) {
      expect(isScopeRefusal(await set(WEB, 'admin', key)), key).toBe(true)
    }
    // One `authz.denied` line per refusal, naming the setting and the scopes held
    // (as `setting`: the security log drops any field named `key`).
    expect(audit).toHaveLength(5)
    expect(audit[0]).toMatchObject({
      event: 'authz.denied',
      targetId: 'settings.set',
      detail: { reason: 'scope', setting: 'test_profiles', scopes: WEB }
    })
  })

  test('a full session is unchanged: an admin writes a hub-wide key', async () => {
    expect(await set(['full'], 'admin', 'test_profiles')).toBe('ok')
  })

  test('gate off (a hub without login): nothing is refused', async () => {
    setAuthGate(() => false)
    expect(await set(WEB, 'user', 'test_profiles')).toBe('ok')
  })
})
