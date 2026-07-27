/**
 * Env scope manifest + sanitizeSpawnEnv — the strip applied at every
 * terminal-child spawn boundary so SlayZone infra/secret/identity vars never
 * leak from a parent process into a user terminal or agent subprocess.
 *
 * The load-bearing invariant: sanitizeSpawnEnv KEEPS the user's own env
 * (PATH/HOME/toolchains) + `global`-scoped SlayZone vars, and STRIPS every
 * infra/secret/identity var PLUS any unmanifested SLAYZONE_* (fail closed) PLUS
 * the non-prefixed infra keys. Per-spawn identity is re-added by the caller's
 * overlay AFTER this runs.
 *
 * Pure Node (no native deps) → runs under plain `npx tsx`.
 *
 * Run with: npx tsx packages/shared/platform/src/env-manifest.test.ts
 */
import { ENV_MANIFEST, NON_PREFIXED_INFRA, sanitizeSpawnEnv, type EnvScope } from './env-manifest'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? `\n    ${detail}` : ''}`)
  }
}

// ── manifest shape ───────────────────────────────────────────────────────────
check(
  'every manifest value is a valid scope',
  Object.values(ENV_MANIFEST).every((s: EnvScope) =>
    ['global', 'infra', 'secret', 'identity'].includes(s)
  )
)
check('SLAYZONE_HUB_URL is retired (absent from manifest)', !('SLAYZONE_HUB_URL' in ENV_MANIFEST))
check('SLAYZONE_HUB_ADDRESS is infra', ENV_MANIFEST.SLAYZONE_HUB_ADDRESS === 'infra')
check('SLAYZONE_HUB_TOKEN is secret', ENV_MANIFEST.SLAYZONE_HUB_TOKEN === 'secret')
check('SLAYZONE_RUNNER_JOIN_TOKEN is secret', ENV_MANIFEST.SLAYZONE_RUNNER_JOIN_TOKEN === 'secret')
check('SLAYZONE_TASK_ID is identity', ENV_MANIFEST.SLAYZONE_TASK_ID === 'identity')
check('SLAYZONE_RELEASE_CHANNEL is global', ENV_MANIFEST.SLAYZONE_RELEASE_CHANNEL === 'global')
// INSTALL-IDENTITY vars: they name WHICH SlayZone install a process belongs to
// (ROOT = the on-disk anchor dir, DEV = which DB filename inside it), never a
// task/session. A child MUST resolve the SAME install as its parent, so both are
// `global`. Tagging either infra/identity strips them and the `slay` CLI in a
// task terminal then resolves the WRONG (or a nonexistent) database — see the
// survival checks below.
check('SLAYZONE_ROOT is global (install anchor)', ENV_MANIFEST.SLAYZONE_ROOT === 'global')
check('SLAYZONE_DEV is global (install DB selector)', ENV_MANIFEST.SLAYZONE_DEV === 'global')
check('ELECTRON_RUN_AS_NODE in NON_PREFIXED_INFRA', NON_PREFIXED_INFRA.has('ELECTRON_RUN_AS_NODE'))
check('PLAYWRIGHT in NON_PREFIXED_INFRA', NON_PREFIXED_INFRA.has('PLAYWRIGHT'))

// ── sanitizeSpawnEnv behavior ────────────────────────────────────────────────
const base: NodeJS.ProcessEnv = {
  // user env — must survive
  PATH: '/usr/bin:/bin',
  HOME: '/home/dev',
  LANG: 'en_US.UTF-8',
  // global SlayZone — must survive
  SLAYZONE_RELEASE_CHANNEL: 'dev',
  // install identity — must survive (the child's `slay` must open the same DB)
  SLAYZONE_ROOT: '/home/dev/.slayzone',
  SLAYZONE_DEV: '1',
  // secret — must be stripped
  SLAYZONE_HUB_TOKEN: 'sekret',
  SLAYZONE_RUNNER_JOIN_TOKEN: 'jointoken',
  SLAYZONE_HUB_RUNNER_TRANSPORT_SECRET: 'hmac',
  // infra — must be stripped
  SLAYZONE_HUB_ADDRESS: 'hub.example:8443',
  SLAYZONE_HUB_PORT: '51100',
  SLAYZONE_MODE: 'remote',
  SLAYZONE_SUPERVISED: '1',
  // identity — must be stripped from the inherited base (overlay re-adds)
  SLAYZONE_TASK_ID: 'task-A',
  SLAYZONE_PROJECT_ID: 'proj-A',
  // unmanifested SLAYZONE_* — must be stripped (fail closed)
  SLAYZONE_FUTURE_SECRET: 'oops',
  // non-prefixed infra — must be stripped
  ELECTRON_RUN_AS_NODE: '1',
  PLAYWRIGHT: '1',
  NODE_PATH: '/some/unpacked/node_modules',
  // undefined value — must be dropped (produces a string-only record)
  SOME_UNSET: undefined
}

const out = sanitizeSpawnEnv(base)

check('keeps PATH', out.PATH === '/usr/bin:/bin')
check('keeps HOME', out.HOME === '/home/dev')
check('keeps non-SlayZone user var (LANG)', out.LANG === 'en_US.UTF-8')
check('keeps global SLAYZONE_RELEASE_CHANNEL', out.SLAYZONE_RELEASE_CHANNEL === 'dev')
// Regression guard: stripping these made a bare `slay <cmd>` in a dev-app task
// terminal exit 1 ("Database not found … Re-run with --dev") because the CLI
// resolves its DB from ROOT + DEV (apps/cli/src/db.ts getDbPath).
check('keeps install anchor SLAYZONE_ROOT', out.SLAYZONE_ROOT === '/home/dev/.slayzone')
check('keeps install selector SLAYZONE_DEV', out.SLAYZONE_DEV === '1')

check('strips secret SLAYZONE_HUB_TOKEN', !('SLAYZONE_HUB_TOKEN' in out))
check('strips secret SLAYZONE_RUNNER_JOIN_TOKEN', !('SLAYZONE_RUNNER_JOIN_TOKEN' in out))
check('strips secret SLAYZONE_HUB_RUNNER_TRANSPORT_SECRET', !('SLAYZONE_HUB_RUNNER_TRANSPORT_SECRET' in out))

check('strips infra SLAYZONE_HUB_ADDRESS', !('SLAYZONE_HUB_ADDRESS' in out))
check('strips infra SLAYZONE_HUB_PORT', !('SLAYZONE_HUB_PORT' in out))
check('strips infra SLAYZONE_MODE', !('SLAYZONE_MODE' in out))
check('strips infra SLAYZONE_SUPERVISED', !('SLAYZONE_SUPERVISED' in out))

check('strips identity SLAYZONE_TASK_ID', !('SLAYZONE_TASK_ID' in out))
check('strips identity SLAYZONE_PROJECT_ID', !('SLAYZONE_PROJECT_ID' in out))

check('FAIL CLOSED: strips unmanifested SLAYZONE_FUTURE_SECRET', !('SLAYZONE_FUTURE_SECRET' in out))

check('strips non-prefixed ELECTRON_RUN_AS_NODE', !('ELECTRON_RUN_AS_NODE' in out))
check('strips non-prefixed PLAYWRIGHT', !('PLAYWRIGHT' in out))
check('strips non-prefixed NODE_PATH', !('NODE_PATH' in out))

check('drops undefined-valued key (SOME_UNSET)', !('SOME_UNSET' in out))
check(
  'every output value is a string',
  Object.values(out).every((v) => typeof v === 'string')
)

// Does not mutate the input.
check('does not mutate the input base', base.SLAYZONE_HUB_TOKEN === 'sekret')

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
