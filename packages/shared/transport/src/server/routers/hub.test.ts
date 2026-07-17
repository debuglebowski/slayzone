/**
 * hub router contract tests (multi-hub federation, Phase 1) — exercise
 * `describe` + `setLabel` via tRPC createCaller against the in-memory harness DB.
 *
 * Covers the graceful-degrade contract: `describe` must work with NO
 * HubDescribeDeps wired (plain local sidecar — multi_hub off), reporting
 * fingerprint:null + authRequired:false, and must reflect the wired deps +
 * the stored `hub_label` k/v when present.
 *
 * Run with: electron + experimental-loader (see test-utils/run-all.sh).
 */
import { createTestHarness, test, expect } from '../../../../test-utils/ipc-harness.js'
import { setAppDeps, setHubDescribeDeps, setAuthGate, type AppDeps } from '../app-deps.js'
import { hubRouter } from './hub.js'

const h = await createTestHarness()
const ctx = { db: h.slayDb }
const caller = hubRouter.createCaller(ctx as never)

// Only appGetVersion is read by hub.describe.
setAppDeps({ appGetVersion: () => '9.9.9-test' } as unknown as AppDeps)

test('hub.describe degrades gracefully with no deps wired (local sidecar)', async () => {
  const d = await caller.describe()
  expect(d.version).toBe('9.9.9-test')
  expect(d.fingerprint).toBeNull()
  expect(d.authRequired).toBe(false)
  expect(d.label).toBeNull()
})

test('hub.setLabel persists a label that describe then reports', async () => {
  await caller.setLabel({ label: '  Prod EU  ' })
  const d = await caller.describe()
  expect(d.label).toBe('Prod EU') // trimmed on write
})

test('hub.describe reflects wired identity deps (fingerprint + authRequired)', async () => {
  setHubDescribeDeps({
    getFingerprint: () => 'ab12cd',
    getAuthRequired: () => true
  })
  const d = await caller.describe()
  expect(d.fingerprint).toBe('ab12cd')
  expect(d.authRequired).toBe(true)
  // Reset so the unwired-default is not leaked into other suites in-process.
  setHubDescribeDeps({ getFingerprint: () => null, getAuthRequired: () => false })
})

// ── Auth gate (Phase 6 enforcement) ──────────────────────────────────────────

test('auth gate OFF: gated procedures run without a principal (byte-identical)', async () => {
  setAuthGate(() => false)
  // setLabel is a gated (publicProcedure) call — must succeed when the gate is off.
  await caller.setLabel({ label: 'no-auth-ok' })
  expect((await caller.describe()).label).toBe('no-auth-ok')
})

test('auth gate ON + no principal: gated proc 401s, but open describe still works', async () => {
  setAuthGate(() => true)
  // describe is openProcedure → reachable for discovery even without a principal.
  const d = await caller.describe()
  expect(d.label).toBe('no-auth-ok')
  // setLabel is gated → UNAUTHORIZED (ctx has no principal).
  let caught: unknown = null
  try {
    await caller.setLabel({ label: 'should-not-persist' })
  } catch (e) {
    caught = e
  }
  expect(caught).not.toBeNull()
  // TRPCError carries `.code` (string) + the message we set.
  const err = caught as { code?: string; message?: string }
  expect(err.code === 'UNAUTHORIZED' || (err.message ?? '').includes('requires authentication')).toBe(
    true
  )
  // The rejected write did not persist.
  expect((await caller.describe()).label).toBe('no-auth-ok')
})

test('auth gate ON + principal present: gated proc runs', async () => {
  setAuthGate(() => true)
  const authedCaller = hubRouter.createCaller({
    db: h.slayDb,
    principal: { userId: 'u1', orgId: null }
  } as never)
  await authedCaller.setLabel({ label: 'authed-write' })
  expect((await authedCaller.describe()).label).toBe('authed-write')
  // Reset the gate so other in-process suites are unaffected.
  setAuthGate(() => false)
})
