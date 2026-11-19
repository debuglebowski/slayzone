/**
 * Every test that drives the chat transport fails when the lifecycle model and
 * the runtime disagree (`chat.lifecycle_shadow_*`), or when the model gives up.
 * The model is the authority, so any disagreement in a
 * test is a bug in one of them. A test that causes one on purpose (a broken or
 * deliberately different model) says so with `allowLifecycleDisagreement()`.
 * Imported by `chat-transport-testkit.ts`; `chat-lifecycle-strict.test.ts`
 * checks every transport test file loads it.
 */
import { afterEach, beforeEach } from 'vitest'
import { __observeLifecycleReports, type LifecycleShadowReport } from './chat-lifecycle-shadow'

let reports: LifecycleShadowReport[] = []
let allowed = false
__observeLifecycleReports((record) => reports.push(record))

beforeEach(() => {
  reports = []
  allowed = false
})

afterEach(() => {
  const seen = reports
  reports = []
  if (allowed || !seen.length) return
  throw new Error(
    `The lifecycle model and the runtime disagreed (${seen.length}):\n` +
      seen.map((r) => JSON.stringify(r)).join('\n')
  )
})

/** This test makes the model and the runtime disagree on purpose. */
export function allowLifecycleDisagreement(): void {
  allowed = true
}
