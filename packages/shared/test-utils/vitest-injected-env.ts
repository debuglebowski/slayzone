/**
 * The env vitest injects into the harness run, which the old per-suite runners never set.
 *
 * vitest sets `TEST=true` and, when unset, `NODE_ENV=test` — in its own process
 * (`process.env.NODE_ENV ??= "test"`) and in every worker it forks. better-auth reads
 * both: `nodeENV` is captured ONCE when `@better-auth/core/env` loads, and
 * `isTest() = nodeENV === "test" || toBoolean(env.TEST)` then defaults
 * `skipOriginCheck` to true and skips the default-secret check. So in-process hubs —
 * and every bin spawned with the inherited env — would run with a weaker auth
 * boundary than production. Linux CI has no NODE_ENV of its own, so vitest's `test`
 * lands there; a shell that already exports one (e.g. `development`) hides the bug.
 *
 * `NODE_ENV=test` is indistinguishable from a caller who set it on purpose; no suite
 * relies on it, and the old runners never had it.
 */
export function stripVitestInjectedEnv(env: NodeJS.ProcessEnv): void {
  delete env.TEST
  if (env.NODE_ENV === 'test') delete env.NODE_ENV
}
