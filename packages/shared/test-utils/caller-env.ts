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
 * The strip alone does not cover a test that DELETES `SLAYZONE_HUB_ADDRESS` to test
 * the CLI's fallback: with no address, `slay` reads the hub target stored under
 * `$HOME/.slayzone/cli` and probes the desktop app's fixed loopback port — the
 * developer's live install either way. So {@link isolateFromCaller} also gives the
 * process a throwaway `HOME` and moves the hub port block (paths.ts
 * `TEST_HUB_PORT_BLOCK_START_ENV`) off the shipped one. That is what every runner
 * calls; the strip is one step of it.
 *
 * Lean: node builtins only, no workspace imports — every config imports it relatively.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

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

/**
 * `SLAYZONE_TEST_HUB_PORT_BLOCK_START` — paths.ts `TEST_HUB_PORT_BLOCK_START_ENV`, the
 * first port of the hub port block (`caller-env.test.ts` pins the two equal).
 */
export const TEST_HUB_PORT_BLOCK_ENV = 'SLAYZONE_TEST_HUB_PORT_BLOCK_START'

/**
 * The `SLAYZONE_*` vars {@link isolateFromCaller} SETS. A test that hands a child an
 * env with every `SLAYZONE_*` dropped must keep these, or the child is back on the
 * shipped hub port block (`caller-env.test.ts` enforces it over every test source).
 */
export const TEST_ISOLATION_ENV: ReadonlySet<string> = new Set([TEST_HUB_PORT_BLOCK_ENV])

/** Name prefix of a run's throwaway home, directly under `os.tmpdir()`. */
const HOME_PREFIX = 'slz-test-home-'

/** Ports per hub port block (paths.ts). */
const BLOCK_SIZE = 100

/**
 * Where a run's hub port blocks go: below every OS's ephemeral range (Linux starts at
 * 32768, macOS/Windows at 49152), so no `listen(0)` server lands inside one, and far
 * from the shipped block (51100-51199). The run's own block is a random one of
 * {@link RUN_BLOCK_STARTS}; each vitest worker then takes the slot its pool id names
 * above it (see {@link isolateFromCaller} `slot`), up to {@link MAX_SLOTS} (pool ids
 * past it wrap). Highest port: 20000 + 93*100 + 33*100 - 1 = 32599.
 */
const RUN_BLOCK_STARTS = { first: 20_000, count: 94 }
const MAX_SLOTS = 32

/**
 * Tool caches that default under `$HOME` and that a run must keep finding after HOME
 * moves: `pnpm` is a corepack shim here (an empty home would re-download it), and the
 * Playwright browsers live in the user cache. Pinned to where they resolve now, and
 * only when that exists. Neither holds anything of SlayZone's.
 */
function toolCachePins(env: NodeJS.ProcessEnv): Record<string, string> {
  const home = env.HOME ?? env.USERPROFILE
  if (!home) return {}
  const cache = env.XDG_CACHE_HOME || join(home, '.cache')
  const local = env.LOCALAPPDATA
  const candidates: Record<string, string | undefined> = {
    COREPACK_HOME:
      process.platform === 'win32' && local
        ? join(local, 'node', 'corepack')
        : join(cache, 'node', 'corepack'),
    PLAYWRIGHT_BROWSERS_PATH:
      process.platform === 'darwin'
        ? join(home, 'Library', 'Caches', 'ms-playwright')
        : process.platform === 'win32'
          ? local && join(local, 'ms-playwright')
          : join(cache, 'ms-playwright')
  }
  const pins: Record<string, string> = {}
  for (const [key, dir] of Object.entries(candidates)) {
    if (!env[key] && dir && existsSync(dir)) pins[key] = dir
  }
  return pins
}

/** The block start `raw` names, or null when it names none. */
function parseBlockStart(raw: string | undefined): number | null {
  return raw && /^\d+$/.test(raw) ? Number(raw) : null
}

export interface CallerIsolation {
  /** The throwaway home this process now has (`HOME`, `USERPROFILE`); with `keepHome`, the caller's. */
  home: string
  /** The `SLAYZONE_*` vars stripped (see {@link stripCallerSlayzoneEnv}). */
  removed: string[]
  /** Every var SET, by name. A shell runner exports exactly these. */
  set: Record<string, string>
  /** Every non-`SLAYZONE_*` var deleted (the caller's XDG dirs). */
  unset: string[]
  /** Remove the throwaway home. */
  cleanup: () => void
}

/**
 * Isolate a test process from the shell that started it, in place on `env` (callers
 * pass `process.env`, so every child spawned later inherits it):
 *   1. {@link stripCallerSlayzoneEnv} — no inherited SlayZone wiring;
 *   2. a fresh empty `HOME` (and `USERPROFILE`; on Windows `APPDATA`/`LOCALAPPDATA`
 *      under it), with the caller's `XDG_CONFIG/STATE/DATA/CACHE_HOME` deleted so
 *      they derive from it — every path SlayZone (CLI hub target, `~/.slayzone`, the
 *      app state dir, agent settings) derives from `HOME`/`os.homedir()`/XDG;
 *   3. its own hub port block ({@link TEST_HUB_PORT_BLOCK_ENV}), off the shipped one,
 *      so a fallback probe or sweep cannot reach the developer's running app.
 * The caller's values are REPLACED, never trusted: whatever the caller set is the
 * thing being isolated from. A test that needs its own home or block sets it on the
 * child it spawns, as before.
 *
 * `slot` (a vitest worker's pool id, from the harness setupFiles) puts this process in
 * its own block above the run's — the block the config already set, read back from
 * `env` — so concurrently running files never share stand-in ports. Without it a
 * fresh run block is drawn.
 *
 * `cleanupOnExit` (default true) removes the home when this process exits; a shell
 * runner that only computes the values passes false and removes it itself.
 *
 * `keepHome` skips step 2. ONLY the Playwright config passes it (caller-env.test.ts
 * pins that): the app under test confines its computer's file and pty access to
 * `homedir()` (computer config.ts path jail) and its `slz-file://` loads to `$HOME`,
 * and the specs drive projects and fixtures under the real home, so an e2e app on a
 * throwaway home refuses every spec. The fixture (e2e/fixtures/electron.ts) redirects
 * each SlayZone path under HOME on its own instead, and `cliEnv()` gives every `slay`
 * a spec spawns a throwaway home.
 */
export function isolateFromCaller(
  env: NodeJS.ProcessEnv = process.env,
  opts: { slot?: number; cleanupOnExit?: boolean; keepHome?: boolean } = {}
): CallerIsolation {
  const runBlock = parseBlockStart(env[TEST_HUB_PORT_BLOCK_ENV])
  const pins = toolCachePins(env)
  const removed = stripCallerSlayzoneEnv(env)

  const set: Record<string, string> = {}
  let home = env.HOME ?? ''
  let unset: string[] = []
  if (!opts.keepHome) {
    // A worker's home goes INSIDE its run's (the one the config made, inherited here):
    // vitest kills its forks, so no exit hook of theirs runs, while the run's main
    // process does exit normally and its cleanup takes every worker home with it.
    const inherited = env.HOME
    const inRun =
      opts.slot !== undefined &&
      inherited !== undefined &&
      dirname(inherited) === tmpdir() &&
      basename(inherited).startsWith(HOME_PREFIX)
    home = inRun ? mkdtempSync(join(inherited, 'file-')) : mkdtempSync(join(tmpdir(), HOME_PREFIX))
    Object.assign(set, pins, { HOME: home, USERPROFILE: home })
    if (process.platform === 'win32') {
      set.APPDATA = join(home, 'AppData', 'Roaming')
      set.LOCALAPPDATA = join(home, 'AppData', 'Local')
    }
    unset = ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'].filter(
      (key) => key in env
    )
  }

  let start: number
  if (opts.slot !== undefined && runBlock !== null) {
    start = runBlock + BLOCK_SIZE * (1 + (opts.slot % MAX_SLOTS))
  } else {
    // A fresh run block whose worker slots never cover the caller's block either: the
    // caller's ports are the thing being isolated from. At most 34 of the 94 starts
    // are excluded, so this ends.
    const span = BLOCK_SIZE * (MAX_SLOTS + 1)
    do {
      start =
        RUN_BLOCK_STARTS.first + BLOCK_SIZE * Math.floor(Math.random() * RUN_BLOCK_STARTS.count)
    } while (runBlock !== null && runBlock < start + span && start < runBlock + BLOCK_SIZE)
  }
  set[TEST_HUB_PORT_BLOCK_ENV] = String(start)

  for (const key of unset) delete env[key]
  Object.assign(env, set)

  const cleanup = (): void => {
    if (!opts.keepHome) rmSync(home, { recursive: true, force: true })
  }
  if (opts.cleanupOnExit !== false) process.once('exit', cleanup)
  return { home, removed, set, unset, cleanup }
}
