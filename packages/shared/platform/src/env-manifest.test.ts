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
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/platform/src/env-manifest.test.ts
 */
import { describe, expect, test } from 'vitest'
import { ENV_MANIFEST, NON_PREFIXED_INFRA, sanitizeSpawnEnv, type EnvScope } from './env-manifest'

describe('manifest shape', () => {
  test('every manifest value is a valid scope', () => {
    expect(Object.values(ENV_MANIFEST).every((s: EnvScope) =>
      ['global', 'infra', 'secret', 'identity'].includes(s)
    )).toBe(true)
  })

  test('SLAYZONE_HUB_URL is retired (absent from manifest)', () => {
    expect(ENV_MANIFEST).not.toHaveProperty('SLAYZONE_HUB_URL')
  })

  test('SLAYZONE_HUB_ADDRESS is infra', () => {
    expect(ENV_MANIFEST.SLAYZONE_HUB_ADDRESS).toBe('infra')
  })

  test('SLAYZONE_HUB_LISTEN_ADDRESS is infra', () => {
    expect(ENV_MANIFEST.SLAYZONE_HUB_LISTEN_ADDRESS).toBe('infra')
  })
  // SLAYZONE_MODE is gone (replaced by the per-hub switches). A leftover value is
  // ignored by the hub and stripped here by the fail-closed unmanifested default.
  test('SLAYZONE_MODE is retired (absent from manifest)', () => {
    expect(ENV_MANIFEST).not.toHaveProperty('SLAYZONE_MODE')
  })
  for (const sw of [
    'SLAYZONE_HUB_REQUIRE_LOGIN',
    'SLAYZONE_HUB_ENABLE_PASSWORD',
    'SLAYZONE_HUB_ENABLE_SSO',
    'SLAYZONE_HUB_ENABLE_PROCESSES',
    'SLAYZONE_HUB_ENABLE_INTEGRATIONS',
    'SLAYZONE_HUB_SSO_TENANT_ID',
    'SLAYZONE_HUB_SSO_CLIENT_ID',
    'SLAYZONE_HUB_SSO_CERT_PATH',
    'SLAYZONE_HUB_SSO_KEY_PATH',
    'SLAYZONE_HUB_SSO_REQUIRE_MFA'
  ]) {
    test(`${sw} is infra`, () => {
      expect(ENV_MANIFEST[sw]).toBe('infra')
    })
  }
  test('SLAYZONE_HUB_SSO_CLIENT_SECRET is secret', () => {
    expect(ENV_MANIFEST.SLAYZONE_HUB_SSO_CLIENT_SECRET).toBe('secret')
  })

  test('SLAYZONE_HUB_TOKEN is secret', () => {
    expect(ENV_MANIFEST.SLAYZONE_HUB_TOKEN).toBe('secret')
  })

  test('SLAYZONE_HUB_JOIN_TOKEN is secret', () => {
    expect(ENV_MANIFEST.SLAYZONE_HUB_JOIN_TOKEN).toBe('secret')
  })

  test('SLAYZONE_DESKTOP_BRIDGE_TOKEN is secret', () => {
    expect(ENV_MANIFEST.SLAYZONE_DESKTOP_BRIDGE_TOKEN).toBe('secret')
  })
  // The pre-rename name is RETIRED, not aliased. It never shipped: the published
  // computer betas (0.36.0-beta.2/3) read `SLAYZONE_JOIN_TOKEN`, so there is no
  // operator env anywhere carrying this name to keep working. Unmanifested → the
  // fail-closed default strips it, same as every other retired var.
  test('SLAYZONE_RUNNER_JOIN_TOKEN is retired (absent from manifest)', () => {
    expect(ENV_MANIFEST).not.toHaveProperty('SLAYZONE_RUNNER_JOIN_TOKEN')
  })
  // T-23: describes THIS hub, like the switches; a terminal-started hub must not inherit it.
  test('SLAYZONE_HUB_SESSION_RETENTION_DAYS is infra', () => {
    expect(ENV_MANIFEST.SLAYZONE_HUB_SESSION_RETENTION_DAYS).toBe('infra')
  })

  test('SLAYZONE_TASK_ID is identity', () => {
    expect(ENV_MANIFEST.SLAYZONE_TASK_ID).toBe('identity')
  })

  test('SLAYZONE_RELEASE_CHANNEL is global', () => {
    expect(ENV_MANIFEST.SLAYZONE_RELEASE_CHANNEL).toBe('global')
  })
  // INSTALL-IDENTITY vars: they name WHICH SlayZone install a process belongs to
  // (ROOT = the on-disk anchor dir, DEV = which DB filename inside it), never a
  // task/session. A child MUST resolve the SAME install as its parent, so both are
  // `global`. Tagging either infra/identity strips them and the `slay` CLI in a
  // task terminal then resolves the WRONG (or a nonexistent) database — see the
  // survival checks below.
  test('SLAYZONE_ROOT is global (install anchor)', () => {
    expect(ENV_MANIFEST.SLAYZONE_ROOT).toBe('global')
  })

  test('SLAYZONE_DEV is global (install DB selector)', () => {
    expect(ENV_MANIFEST.SLAYZONE_DEV).toBe('global')
  })

  test('ELECTRON_RUN_AS_NODE in NON_PREFIXED_INFRA', () => {
    expect(NON_PREFIXED_INFRA.has('ELECTRON_RUN_AS_NODE')).toBe(true)
  })

  test('PLAYWRIGHT in NON_PREFIXED_INFRA', () => {
    expect(NON_PREFIXED_INFRA.has('PLAYWRIGHT')).toBe(true)
  })
})

describe('`_URL` carve-out (CLAUDE.md § Env Var Naming rule 6)', () => {
  // Rule 5: a var carries AUTHORITY (`host[:port]`), never a full URL, so the
  // scheme derives from the host and a ws-vs-http reader mismatch (the
  // retired SLAYZONE_HUB_URL bug) is unrepresentable. Rule 6 is the ONE carve-out:
  // a loopback-only target has an invariant `http` scheme, so there is no
  // host-derived scheme to get wrong and rule 5 protects nothing.
  //
  // SLAYZONE_AGENT_HOOK_URL is that case — local = sidecar loopback, remote = the
  // COMPUTER's own loopback (it relays to the hub over its authed ws), never a
  // wss/https hub URL and never a bearer. It must stay a full URL because its only
  // reader is the deliberately logic-free shared `notify.sh`; an `_ADDRESS` form
  // would push scheme+path assembly back into that file, which is exactly the rot
  // the v3 benign-forwarder rewrite removed.
  //
  // This guard is what keeps the carve-out from widening by accident: any SECOND
  // `_URL` var lands here as a hard failure, forcing the author to justify it
  // against rule 6 (loopback-only + invariant scheme) or use `_ADDRESS`.
  const URL_SUFFIXED = Object.keys(ENV_MANIFEST).filter((k) => k.endsWith('_URL'))
  test('SLAYZONE_AGENT_HOOK_URL is the ONLY `_URL` manifest key (rule 6 carve-out)', () => {
    expect(URL_SUFFIXED.length, `found: ${JSON.stringify(URL_SUFFIXED)} — a new full-URL var must satisfy CLAUDE.md rule 6 (loopback-only, invariant http scheme) or carry authority as \`_ADDRESS\` instead`).toBe(1)
    expect(URL_SUFFIXED[0], `found: ${JSON.stringify(URL_SUFFIXED)} — a new full-URL var must satisfy CLAUDE.md rule 6 (loopback-only, invariant http scheme) or carry authority as \`_ADDRESS\` instead`).toBe('SLAYZONE_AGENT_HOOK_URL')
  })
  // Identity-scoped, so it is STRIPPED from the inherited base and re-added per
  // spawn by buildMcpEnv (local) or the computer's overlay (remote). Tagging it
  // `global` would let task A's hook URL — and on a computer, a stale port — bleed
  // into task B's terminal.
  test('SLAYZONE_AGENT_HOOK_URL is identity (stripped; overlay re-adds per spawn)', () => {
    expect(ENV_MANIFEST.SLAYZONE_AGENT_HOOK_URL).toBe('identity')
  })
  // Its sibling: same `AGENT_HOOK` subsystem prefix (rule 3 — one says WHERE to
  // post, one says WHO is posting), same identity scope for the same reason.
  test('SLAYZONE_AGENT_HOOK_CONTEXT is identity (sibling of _HOOK_URL)', () => {
    expect(ENV_MANIFEST.SLAYZONE_AGENT_HOOK_CONTEXT).toBe('identity')
  })
  // The pre-v4 name stays OUT of the manifest. notify.sh v4 reads it as a fallback
  // so an older release channel's app can feed the newer shared script, but that
  // value arrives via that app's per-spawn overlay — listing it here would instead
  // let a STALE inherited blob (task A's identity) survive into task B's terminal.
  test('SLAYZONE_HOOK_CONTEXT is retired (absent from manifest → stripped)', () => {
    expect(ENV_MANIFEST).not.toHaveProperty('SLAYZONE_HOOK_CONTEXT')
  })
  // Warm-pool agents named themselves by session id before they booted with a task id.
  // Every agent has SLAYZONE_TASK_ID now, so the session id is retired: unlisted, it is
  // stripped, and a stale inherited one can never point a terminal at another task.
  test('SLAYZONE_SESSION_ID is retired (absent from manifest)', () => {
    expect(ENV_MANIFEST).not.toHaveProperty('SLAYZONE_SESSION_ID')
  })
})

describe('sanitizeSpawnEnv behavior', () => {
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
    SLAYZONE_HUB_JOIN_TOKEN: 'jointoken',
    SLAYZONE_HUB_AUTH_SECRET: 'hmac',
    SLAYZONE_HUB_SSO_CLIENT_SECRET: 'entra-secret',
    SLAYZONE_DESKTOP_BRIDGE_TOKEN: 'cap-bearer',
    // infra — must be stripped
    SLAYZONE_HUB_ADDRESS: 'hub.example:8443',
    SLAYZONE_HUB_LISTEN_ADDRESS: '0.0.0.0:51100',
    SLAYZONE_HUB_REQUIRE_LOGIN: '1',
    SLAYZONE_HUB_ENABLE_SSO: '1',
    SLAYZONE_HUB_SSO_TENANT_ID: 'tenant',
    SLAYZONE_HUB_PORT: '51100',
    // retired SLAYZONE_MODE — unmanifested, so stripped by the fail-closed default
    SLAYZONE_MODE: 'remote',
    SLAYZONE_SUPERVISED: '1',
    // identity — must be stripped from the inherited base (overlay re-adds)
    SLAYZONE_TASK_ID: 'task-A',
    SLAYZONE_PROJECT_ID: 'proj-A',
    SLAYZONE_AGENT_HOOK_URL: 'http://127.0.0.1:51100/api/agent-hook',
    SLAYZONE_AGENT_HOOK_CONTEXT: '{"v":1,"taskId":"task-A"}',
    // retired pre-v4 ctx name — unmanifested, so stripped by the fail-closed default
    SLAYZONE_HOOK_CONTEXT: '{"v":1,"taskId":"task-A"}',
    // retired pre-rename join-token name — likewise unmanifested → stripped
    SLAYZONE_RUNNER_JOIN_TOKEN: 'jointoken-retired',
    // retired warm-agent session id — likewise unmanifested → stripped
    SLAYZONE_SESSION_ID: 'pool-sess-A',
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

  test('keeps PATH', () => {
    expect(out.PATH).toBe('/usr/bin:/bin')
  })

  test('keeps HOME', () => {
    expect(out.HOME).toBe('/home/dev')
  })

  test('keeps non-SlayZone user var (LANG)', () => {
    expect(out.LANG).toBe('en_US.UTF-8')
  })

  test('keeps global SLAYZONE_RELEASE_CHANNEL', () => {
    expect(out.SLAYZONE_RELEASE_CHANNEL).toBe('dev')
  })
  // Regression guard: stripping these made a bare `slay <cmd>` in a dev-app task
  // terminal exit 1 ("Database not found … Re-run with --dev") because the CLI
  // resolves its DB from ROOT + DEV (apps/cli/src/db.ts getDbPath).
  test('keeps install anchor SLAYZONE_ROOT', () => {
    expect(out.SLAYZONE_ROOT).toBe('/home/dev/.slayzone')
  })

  test('keeps install selector SLAYZONE_DEV', () => {
    expect(out.SLAYZONE_DEV).toBe('1')
  })

  test('strips retired SLAYZONE_SESSION_ID (fail closed)', () => {
    expect(out).not.toHaveProperty('SLAYZONE_SESSION_ID')
  })

  test('strips secret SLAYZONE_HUB_TOKEN', () => {
    expect(out).not.toHaveProperty('SLAYZONE_HUB_TOKEN')
  })

  test('strips secret SLAYZONE_HUB_JOIN_TOKEN', () => {
    expect(out).not.toHaveProperty('SLAYZONE_HUB_JOIN_TOKEN')
  })

  test('strips retired SLAYZONE_RUNNER_JOIN_TOKEN (fail closed)', () => {
    expect(out).not.toHaveProperty('SLAYZONE_RUNNER_JOIN_TOKEN')
  })

  test('strips secret SLAYZONE_HUB_AUTH_SECRET', () => {
    expect(out).not.toHaveProperty('SLAYZONE_HUB_AUTH_SECRET')
  })

  test('strips secret SLAYZONE_DESKTOP_BRIDGE_TOKEN', () => {
    expect(out).not.toHaveProperty('SLAYZONE_DESKTOP_BRIDGE_TOKEN')
  })

  test('strips infra SLAYZONE_HUB_ADDRESS', () => {
    expect(out).not.toHaveProperty('SLAYZONE_HUB_ADDRESS')
  })

  test('strips infra SLAYZONE_HUB_LISTEN_ADDRESS', () => {
    expect(out).not.toHaveProperty('SLAYZONE_HUB_LISTEN_ADDRESS')
  })

  test('strips infra SLAYZONE_HUB_REQUIRE_LOGIN', () => {
    expect(out).not.toHaveProperty('SLAYZONE_HUB_REQUIRE_LOGIN')
  })

  test('strips infra SLAYZONE_HUB_ENABLE_SSO', () => {
    expect(out).not.toHaveProperty('SLAYZONE_HUB_ENABLE_SSO')
  })

  test('strips infra SLAYZONE_HUB_SSO_TENANT_ID', () => {
    expect(out).not.toHaveProperty('SLAYZONE_HUB_SSO_TENANT_ID')
  })

  test('strips secret SLAYZONE_HUB_SSO_CLIENT_SECRET', () => {
    expect(out).not.toHaveProperty('SLAYZONE_HUB_SSO_CLIENT_SECRET')
  })

  test('strips infra SLAYZONE_HUB_PORT', () => {
    expect(out).not.toHaveProperty('SLAYZONE_HUB_PORT')
  })

  test('strips leftover SLAYZONE_MODE (fail closed)', () => {
    expect(out).not.toHaveProperty('SLAYZONE_MODE')
  })

  test('strips infra SLAYZONE_SUPERVISED', () => {
    expect(out).not.toHaveProperty('SLAYZONE_SUPERVISED')
  })

  test('strips identity SLAYZONE_TASK_ID', () => {
    expect(out).not.toHaveProperty('SLAYZONE_TASK_ID')
  })

  test('strips identity SLAYZONE_PROJECT_ID', () => {
    expect(out).not.toHaveProperty('SLAYZONE_PROJECT_ID')
  })
  // A leaked hook URL is worse than a stale id: on a computer it names a PORT, so an
  // inherited value would POST this agent's lifecycle events at whatever listens
  // there. The computer's per-spawn overlay (handlers/pty.ts) re-adds the right one.
  test('strips identity SLAYZONE_AGENT_HOOK_URL', () => {
    expect(out).not.toHaveProperty('SLAYZONE_AGENT_HOOK_URL')
  })
  // Same reasoning for the ctx blob: an inherited one attributes THIS agent's hooks
  // to the PARENT's task (the clobber class of bug). buildMcpEnv re-adds the right
  // one. Both the current name (manifested identity) and the retired pre-v4 name
  // (unmanifested → fail-closed default) must go.
  test('strips identity SLAYZONE_AGENT_HOOK_CONTEXT', () => {
    expect(out).not.toHaveProperty('SLAYZONE_AGENT_HOOK_CONTEXT')
  })

  test('strips retired SLAYZONE_HOOK_CONTEXT (fail closed)', () => {
    expect(out).not.toHaveProperty('SLAYZONE_HOOK_CONTEXT')
  })

  test('FAIL CLOSED: strips unmanifested SLAYZONE_FUTURE_SECRET', () => {
    expect(out).not.toHaveProperty('SLAYZONE_FUTURE_SECRET')
  })

  test('strips non-prefixed ELECTRON_RUN_AS_NODE', () => {
    expect(out).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
  })

  test('strips non-prefixed PLAYWRIGHT', () => {
    expect(out).not.toHaveProperty('PLAYWRIGHT')
  })

  test('strips non-prefixed NODE_PATH', () => {
    expect(out).not.toHaveProperty('NODE_PATH')
  })

  test('drops undefined-valued key (SOME_UNSET)', () => {
    expect(out).not.toHaveProperty('SOME_UNSET')
  })

  test('every output value is a string', () => {
    expect(Object.values(out).every((v) => typeof v === 'string')).toBe(true)
  })

  // Does not mutate the input.
  test('does not mutate the input base', () => {
    expect(base.SLAYZONE_HUB_TOKEN).toBe('sekret')
  })
})
