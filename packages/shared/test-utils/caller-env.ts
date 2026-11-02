/**
 * A test process owns no SlayZone wiring of the shell that started it.
 *
 * WHY: tests are run from SlayZone task terminals. Such a terminal carries the LIVE
 * wiring of the agent's own task: the hub to dial (`SLAYZONE_HUB_ADDRESS`), the
 * computer's CLI relay and its capability (`SLAYZONE_CLI_RELAY_ADDRESS` / `_TOKEN`),
 * the task identity (`SLAYZONE_TASK_ID`, `SLAYZONE_PROJECT_ID`), the hook endpoint
 * (`SLAYZONE_AGENT_HOOK_URL`) and the install root (`SLAYZONE_ROOT`). A test that sets
 * only SOME of these (say `SLAYZONE_HUB_ADDRESS` = its own test hub) and spreads
 * `...process.env` into a spawned `slay` inherits the rest — and the CLI's task-terminal
 * precedence sends the call through the inherited relay to the user's real hub. That
 * happened: CLI suites reached the live hub and listed its real projects.
 *
 * So every test runner strips EVERY inherited `SLAYZONE_*` before a suite loads (fail
 * closed: unlisted vars go too), and each test sets exactly what it needs. This is
 * deliberately stricter than `sanitizeSpawnEnv` (`@slayzone/platform/env-manifest`),
 * which keeps the `global` vars (`SLAYZONE_ROOT`, `SLAYZONE_DEV`, …) because a task
 * terminal must resolve the same install as its parent. A test must not: the caller's
 * ROOT is the user's live install.
 *
 * Applied at every root a test process starts from: `runners.sh` (`pnpm test:unit`,
 * CI), every vitest config (module load, in vitest's main process, before any worker
 * forks), the harness `setupFiles` (each worker) and the Playwright config (runner and
 * every worker). `caller-env.test.ts` pins all of them.
 *
 * Lean: node builtins only, no workspace imports — every config imports it relatively.
 */

/**
 * Caller-supplied test knobs that survive the strip. Each is a developer's opt-in for
 * one suite, naming a local fixture/binary or a strictness switch — never an endpoint,
 * a credential, an identity or an install root. Adding one here is a review decision:
 * anything that can name a hub, computer, relay or hook endpoint never belongs here.
 */
export const TEST_OPT_IN_ENV: ReadonlySet<string> = new Set([
  // client-settings-migration.realstore.test.ts: a COPY of a real store to migrate.
  'SLAYZONE_REAL_STORE_FIXTURE',
  // codex-protocol-drift.test.ts: turn drift notes into failures.
  'SLAYZONE_CODEX_DRIFT_STRICT',
  // e2e chat/186 (real Codex CLI): opt-in, the codex binary, its fixed work dir.
  'SLAYZONE_E2E_REAL_CODEX_HOME',
  'SLAYZONE_CODEX_BIN_PATH',
  'SLAYZONE_CODEX_RECORD_DIR'
])

/**
 * Delete every `SLAYZONE_*` key of `env` except {@link TEST_OPT_IN_ENV}, in place
 * (callers pass `process.env`, so children spawned later inherit the clean env).
 * Returns the removed names, sorted.
 */
export function stripCallerSlayzoneEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = []
  for (const key of Object.keys(env)) {
    if (key.startsWith('SLAYZONE_') && !TEST_OPT_IN_ENV.has(key)) {
      delete env[key]
      removed.push(key)
    }
  }
  return removed.sort()
}
