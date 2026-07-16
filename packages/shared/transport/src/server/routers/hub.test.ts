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
import { setAppDeps, setHubDescribeDeps, type AppDeps } from '../app-deps.js'
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
