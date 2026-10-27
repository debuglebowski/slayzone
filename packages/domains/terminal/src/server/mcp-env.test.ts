/**
 * Unit tests for buildMcpEnv + resolveRemoteMcpEnv — the per-PTY env injected
 * for AI-agent subprocesses (hub/computer split, wave 3).
 *
 * The load-bearing invariant: NEITHER a local nor a remote spawn injects hub
 * dial/auth env. A LOCAL spawn (`computerId == null`, or no remote target) gets the
 * loopback SLAYZONE_AGENT_HOOK_URL and no hub env; no port var either — the CLI
 * reads the port from the DB. A REMOTE spawn is byte-identical for identity: the
 * agent posts to the COMPUTER's loopback, and the computer overlays the hook URL and
 * relays to the hub over its own ws channel.
 *
 * `HUB_ENV_KEYS` below pins both the live dial var (SLAYZONE_HUB_ADDRESS) and the
 * retired one (SLAYZONE_HUB_URL) so the guard can't silently go dead if a name
 * changes again.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { buildMcpEnv, resolveRemoteMcpEnv, AGENT_HOOK_PATH, type RemoteMcpEnv } from './mcp-env'

type Env = Record<string, string>

/** Retired hub-address names. NEVER written, local or remote — listed so a
 *  reintroduced old name can't slip through a current-names-only guard. */
const RETIRED_HUB_ENV_KEYS = ['SLAYZONE_HUB_URL', 'SLAYZONE_HUB_HOST', 'SLAYZONE_HUB_PORT'] as const

/** Every key that could point a child at a hub, live name included. */
const HUB_ENV_KEYS = ['SLAYZONE_HUB_ADDRESS', ...RETIRED_HUB_ENV_KEYS] as const

/**
 * No hub dial env AT ALL — the REMOTE invariant.
 *
 * A remote spawn runs on someone else's computer box, so handing it the hub's
 * address is a leak; the computer already owns its own relay. Unchanged.
 */
function assertNoHubEnv(env: Env, where: string): void {
  for (const key of HUB_ENV_KEYS) {
    expect(env, `${where} must NOT set ${key}`).not.toHaveProperty([key])
  }
}

/**
 * The LOCAL invariant, narrowed on purpose.
 *
 * This used to be "no hub address anywhere", justified by "the CLI reads
 * settings.server_port from the DB". That justification is dead — the CLI stopped
 * reading that row, which left `slay` inside a pty with no pinned address at all.
 * It then fell back to probing the fixed per-channel port, which answers for
 * whichever install holds it: under e2e, the developer's live app. A blanket ban
 * on the address was therefore protecting nothing and causing a data-safety hole.
 *
 * What the invariant actually protects is preserved and still asserted:
 *   - no credential is ever injected (SLAYZONE_HUB_TOKEN), local or remote;
 *   - no retired name is ever written;
 *   - a REMOTE spawn still gets no hub address (see assertNoHubEnv).
 * A loopback authority for the app that spawned you is not a credential.
 */
function assertLocalHubEnv(env: Env, where: string, port: number): void {
  expect(env.SLAYZONE_HUB_ADDRESS, `${where} must pin the loopback hub authority`).toBe(
    `127.0.0.1:${port}`
  )
  for (const key of RETIRED_HUB_ENV_KEYS) {
    expect(env, `${where} must NOT set the retired ${key}`).not.toHaveProperty([key])
  }
  expect(env, `${where} must NOT inject a bearer`).not.toHaveProperty(['SLAYZONE_HUB_TOKEN'])
}

// A fixed port so the loopback assertions are exact. buildMcpEnv reads
// `globalThis.__serverPort` (set by the server host at boot).
const MCP_PORT = 54321
;(globalThis as Record<string, unknown>).__serverPort = MCP_PORT

const REMOTE: RemoteMcpEnv = {
  computerId: 'computer-xyz',
  hubBaseUrl: 'https://hub.example:8443'
}

const LOOPBACK_HOOK_URL = `http://127.0.0.1:${MCP_PORT}${AGENT_HOOK_PATH}`

// A db that knows `terminal_modes` rows (id → declared `type`) and nothing else —
// enough for buildMcpEnv to resolve the agent a mode runs. Built-in rows are listed
// too, so a test proves a built-in is NOT re-resolved through its `type`.
function dbWithModes(types: Record<string, string>): never {
  return {
    get: async (sql: string, params: unknown[] = []) => {
      if (!sql.includes('FROM terminal_modes')) return undefined
      const type = types[params[0] as string]
      return type ? { type } : undefined
    }
  } as never
}
const MODES = dbWithModes({
  'my-claude': 'claude-code',
  'my-shell': 'terminal',
  'my-cursor': 'cursor-agent',
  'claude-chat': 'claude-code',
  'codex-chat': 'codex'
})

// ── LOCAL (computerId == null): byte-identical to today's loopback env ─────────

// 1. Local hook-capable agent → loopback hook URL, no port env, no hub env.
describe('1. local hook-capable agent', () => {
  let env: Env
  let ctx: Record<string, unknown>
  beforeAll(async () => {
    env = await buildMcpEnv(null, 'task-1', 'claude-code')
    ctx = JSON.parse(env.SLAYZONE_AGENT_HOOK_CONTEXT!)
  })
  test('local hook URL must be loopback', () => {
    expect(env.SLAYZONE_AGENT_HOOK_URL).toBe(LOOPBACK_HOOK_URL)
  })
  test('local must set SLAYZONE_AGENT_ID', () => {
    expect(env.SLAYZONE_AGENT_ID).toBe('claude-code')
  })
  test('local hook-capable must set SLAYZONE_ROOT', () => {
    expect(env).toHaveProperty(['SLAYZONE_ROOT'])
  })
  // Tell the child which app it belongs to, so `slay` never has to go probing.
  test('local pins the loopback hub authority, no retired names, no bearer', () => {
    assertLocalHubEnv(env, 'local', MCP_PORT)
  })
  test('task id present', () => {
    expect(env.SLAYZONE_TASK_ID).toBe('task-1')
  })
  // The opaque context blob the benign notify.sh forwards verbatim. All identity
  // fields the server needs to attribute a hook live HERE — never named in the script.
  test('local hook-capable must set SLAYZONE_AGENT_HOOK_CONTEXT', () => {
    expect(env).toHaveProperty(['SLAYZONE_AGENT_HOOK_CONTEXT'])
  })
  // The pre-rename name is NEVER written: notify.sh reads it only as a fallback so
  // an OLDER release channel's app can still feed a NEWER shared script.
  test('the retired SLAYZONE_HOOK_CONTEXT must NOT be written', () => {
    expect(env).not.toHaveProperty(['SLAYZONE_HOOK_CONTEXT'])
  })
  test('ctx envelope version must be 1', () => {
    expect(ctx.v).toBe(1)
  })
  test('ctx carries taskId', () => {
    expect(ctx.taskId).toBe('task-1')
  })
  test('ctx carries agentId', () => {
    expect(ctx.agentId).toBe('claude-code')
  })
  // `releaseChannel` (not `channel`) — the field names WHICH release channel fired
  // the hook, so a cross-release-channel clobber is visible in Diagnostics.
  test('ctx carries releaseChannel (attribution/diagnostic)', () => {
    expect(typeof ctx.releaseChannel).toBe('string')
    expect(ctx.releaseChannel).not.toBe('')
  })
})

// 1b. Warm (pooled) spawn → its reserved task id + an explicit project id (there is
// no task row to derive the project from yet), and never a session id.
describe('1b. warm (pooled) spawn', () => {
  let env: Env
  let ctx: Record<string, unknown>
  beforeAll(async () => {
    env = await buildMcpEnv(null, 'reserved-task-1', 'claude-code', 'proj-9')
    ctx = JSON.parse(env.SLAYZONE_AGENT_HOOK_CONTEXT!)
  })
  test('warm agent knows its task id', () => {
    expect(env.SLAYZONE_TASK_ID).toBe('reserved-task-1')
  })
  test('explicit project id wins without a task row', () => {
    expect(env.SLAYZONE_PROJECT_ID).toBe('proj-9')
  })
  test('no agent is ever given a session id', () => {
    expect(env).not.toHaveProperty(['SLAYZONE_SESSION_ID'])
  })
  test('ctx carries the reserved taskId', () => {
    expect(ctx.taskId).toBe('reserved-task-1')
  })
  test('ctx carries projectId', () => {
    expect(ctx.projectId).toBe('proj-9')
  })
  test('ctx carries no slaySessionId', () => {
    expect(ctx).not.toHaveProperty(['slaySessionId'])
  })
})

// 1c. Non-hook-capable mode → NO ctx blob (the blob only rides the hook env).
test('1c. non-hook mode must NOT set SLAYZONE_AGENT_HOOK_CONTEXT', async () => {
  const env = await buildMcpEnv(null, 'task-x', 'some-unknown-mode' as never)
  expect(env).not.toHaveProperty(['SLAYZONE_AGENT_HOOK_CONTEXT'])
})

// 1d. User-defined provider wrapping a hook-capable agent → hook-capable.
//     Regression guard: gating on the MODE id made every user-defined provider
//     hook-incapable, so its conversation was never captured and every restart
//     started an empty session.
describe('1d. user-defined provider wrapping a hook-capable agent', () => {
  let env: Env
  let ctx: Record<string, unknown>
  beforeAll(async () => {
    env = await buildMcpEnv(MODES, 'task-c', 'my-claude')
    ctx = JSON.parse(env.SLAYZONE_AGENT_HOOK_CONTEXT!)
  })
  test('a provider wrapping claude-code must get the hook URL', () => {
    expect(env.SLAYZONE_AGENT_HOOK_URL).toBe(LOOPBACK_HOOK_URL)
  })
  // notify.sh sends this as the envelope's top-level `agentId`, which the server
  // accepts only when it names a known agent.
  test('SLAYZONE_AGENT_ID must be the wrapped AGENT', () => {
    expect(env.SLAYZONE_AGENT_ID).toBe('claude-code')
  })
  test('ctx.agentId must be the wrapped agent', () => {
    expect(ctx.agentId).toBe('claude-code')
  })
  test("ctx.mode must carry the provider's own mode (the ledger key)", () => {
    expect(ctx.mode).toBe('my-claude')
  })
})

// 1e. Built-in mode → ctx has NO `mode` key: every existing hook payload is unchanged.
test('1e. a built-in ctx must omit `mode`', async () => {
  const env = await buildMcpEnv(MODES, 'task-b', 'claude-code')
  const ctx = JSON.parse(env.SLAYZONE_AGENT_HOOK_CONTEXT!)
  expect(ctx).not.toHaveProperty(['mode'])
})

// 1f. Built-in CHAT modes stay as they are, although their `type` names a
//     hook-capable agent: a built-in mode is its own agent, never re-resolved.
describe.each(['claude-chat', 'codex-chat'])('1f. built-in chat mode %s', (mode) => {
  let env: Env
  beforeAll(async () => {
    env = await buildMcpEnv(MODES, 'task-chat', mode)
  })
  test(`${mode} must NOT become hook-capable`, () => {
    expect(env).not.toHaveProperty(['SLAYZONE_AGENT_HOOK_URL'])
  })
  test(`${mode} must NOT set SLAYZONE_AGENT_ID`, () => {
    expect(env).not.toHaveProperty(['SLAYZONE_AGENT_ID'])
  })
})

// 1g. User-defined provider whose `type` is not a hook-capable agent → no hook env.
test.each(['my-shell', 'my-cursor'])('1g. %s must NOT become hook-capable', async (mode) => {
  const env = await buildMcpEnv(MODES, 'task-d', mode)
  expect(env).not.toHaveProperty(['SLAYZONE_AGENT_HOOK_CONTEXT'])
})

// 1h. No db (pre-init spawn) → a user-defined provider cannot be resolved, so it
//     keeps the pre-fix behavior (no hook env) instead of guessing.
test('1h. unresolvable provider must NOT get the hook URL', async () => {
  const env = await buildMcpEnv(null, 'task-e', 'my-claude')
  expect(env).not.toHaveProperty(['SLAYZONE_AGENT_HOOK_URL'])
})

// 2. Local, explicit `remote = null` → identical to omitting it entirely.
test('2. remote=null must equal remote omitted', async () => {
  const a = await buildMcpEnv(null, 'task-2', 'claude-code')
  const b = await buildMcpEnv(null, 'task-2', 'claude-code', undefined, null)
  // Byte-identical, key order included (the old check compared JSON.stringify).
  expect(JSON.stringify(b)).toBe(JSON.stringify(a))
})

// 3. Local non-hook-capable mode → no hook URL, but STILL a pinned address.
// A plain shell is where `slay` is typed by hand, so it is the case that most
// needs pinning — and the one that previously fell through to a port probe.
describe('3. local non-hook-capable mode', () => {
  let env: Env
  beforeAll(async () => {
    env = await buildMcpEnv(null, 'task-3', 'some-unknown-mode' as never)
  })
  test('no hook URL for non-hook-capable mode', () => {
    expect(env).not.toHaveProperty(['SLAYZONE_AGENT_HOOK_URL'])
  })
  test('still pins the loopback hub authority, no retired names, no bearer', () => {
    assertLocalHubEnv(env, 'local non-hook mode', MCP_PORT)
  })
})

// 3a. A bare shell (no task, no mode) is pinned too.
test('3a. plain shell pins the loopback hub authority, no retired names, no bearer', async () => {
  const env = await buildMcpEnv(null, undefined, undefined)
  assertLocalHubEnv(env, 'plain shell', MCP_PORT)
})

// 3b. SLAYZONE_ROOT is set for EVERY spawn, not only hook-capable ones —
// including a plain shell with no mode at all. Regression guard for the
// channel-scoped layout: a pty routed through the co-located local computer
// inherits THAT computer's own role-scoped SLAYZONE_ROOT through the base env
// (the manifest tags the var `global`, so sanitizeSpawnEnv keeps it). The hub's
// value must override it at the spawn boundary, or `slay` inside a plain
// terminal resolves the computer's credential dir instead of the hub's DB.
test.each([
  ['non-hook mode', () => buildMcpEnv(null, 'task-3b', 'some-unknown-mode' as never)],
  ['plain shell (no mode)', () => buildMcpEnv(null, undefined, undefined)],
  [
    'remote non-hook mode',
    () => buildMcpEnv(null, 'task-3b', 'some-unknown-mode' as never, undefined, REMOTE)
  ]
] as const)(
  '3b. %s must still set SLAYZONE_ROOT (hub is authoritative for the on-disk anchor)',
  async (_label, make) => {
    const env = await make()
    expect(typeof env.SLAYZONE_ROOT).toBe('string')
    expect(env.SLAYZONE_ROOT).not.toBe('')
  }
)

// ── REMOTE (computerId != null + provider): agent posts to COMPUTER LOOPBACK ──────
//
// New topology: the agent env is byte-identical local vs remote. The agent
// ALWAYS posts to computer loopback; the COMPUTER overlays SLAYZONE_AGENT_HOOK_URL
// (it owns its own loopback port) and relays to the hub over its ws channel.
// So buildMcpEnv's remote branch sets NO hub URL, NO bearer, and NO hook URL
// (the computer supplies it) — only the agent id + ROOT + the opaque ctx blob.

// 4. Remote hook-capable → agent id + ROOT + ctx blob; NO hub env, NO hook URL.
describe('4. remote hook-capable', () => {
  let env: Env
  beforeAll(async () => {
    env = await buildMcpEnv(null, 'task-r1', 'claude-code', undefined, REMOTE)
  })
  test('remote (agent posts to computer loopback) sets no hub env', () => {
    assertNoHubEnv(env, 'remote (agent posts to computer loopback)')
  })
  test('remote must NOT inject a bearer (loopback is unauthed)', () => {
    expect(env).not.toHaveProperty(['SLAYZONE_HUB_TOKEN'])
  })
  test('remote buildMcpEnv must NOT set the hook URL — the computer overlays its own loopback URL', () => {
    expect(env).not.toHaveProperty(['SLAYZONE_AGENT_HOOK_URL'])
  })
  test('remote still sets SLAYZONE_AGENT_ID', () => {
    expect(env.SLAYZONE_AGENT_ID).toBe('claude-code')
  })
  test('remote hook-capable still sets SLAYZONE_ROOT', () => {
    expect(env).toHaveProperty(['SLAYZONE_ROOT'])
  })
  test('remote hook-capable still sets the ctx blob', () => {
    expect(env).toHaveProperty(['SLAYZONE_AGENT_HOOK_CONTEXT'])
  })
  test('remote ctx carries taskId', () => {
    const ctx = JSON.parse(env.SLAYZONE_AGENT_HOOK_CONTEXT!)
    expect(ctx.taskId).toBe('task-r1')
  })
})

// 5. Remote hook env matches local hook env for identity (no hub-specific keys).
describe('5. remote hook env matches local hook env for identity', () => {
  let local: Env
  let remote: Env
  beforeAll(async () => {
    local = await buildMcpEnv(null, 'task-same', 'claude-code')
    remote = await buildMcpEnv(null, 'task-same', 'claude-code', undefined, REMOTE)
  })
  // Same identity blob + agent id. Two deliberate differences, both loopback-shaped
  // and neither an identity field: local carries the hook URL (remote defers to the
  // computer overlay) and local carries the hub authority (remote must not — it would
  // ship this hub's address to another box).
  test('agent id identical local vs remote', () => {
    expect(remote.SLAYZONE_AGENT_ID).toBe(local.SLAYZONE_AGENT_ID)
  })
  test('remote must NOT carry this hub address', () => {
    expect(remote).not.toHaveProperty(['SLAYZONE_HUB_ADDRESS'])
  })
  test('ctx blob identical local vs remote', () => {
    expect(remote.SLAYZONE_AGENT_HOOK_CONTEXT).toBe(local.SLAYZONE_AGENT_HOOK_CONTEXT)
  })
  test('local sets the loopback hook URL', () => {
    expect(local).toHaveProperty(['SLAYZONE_AGENT_HOOK_URL'])
  })
  test('remote leaves the hook URL to the computer', () => {
    expect(remote).not.toHaveProperty(['SLAYZONE_AGENT_HOOK_URL'])
  })
})

// 6. Remote non-hook-capable → nothing hook-related, no hub env.
describe('6. remote non-hook-capable', () => {
  let env: Env
  beforeAll(async () => {
    env = await buildMcpEnv(null, 'task-r3', 'some-unknown-mode' as never, undefined, REMOTE)
  })
  test('non-hook remote sets no hub env', () => {
    assertNoHubEnv(env, 'non-hook remote')
  })
  test('no hook URL for non-hook remote mode', () => {
    expect(env).not.toHaveProperty(['SLAYZONE_AGENT_HOOK_URL'])
  })
  test('no ctx blob for non-hook remote mode', () => {
    expect(env).not.toHaveProperty(['SLAYZONE_AGENT_HOOK_CONTEXT'])
  })
})

// 6b. Remote user-defined provider wrapping claude-code → same identity as local
//     (the computer relays the ctx blob verbatim), still no loopback hook URL.
describe('6b. remote user-defined provider wrapping claude-code', () => {
  let env: Env
  beforeAll(async () => {
    env = await buildMcpEnv(MODES, 'task-r4', 'my-claude', undefined, REMOTE)
  })
  test('remote user-defined provider sets no hub env', () => {
    assertNoHubEnv(env, 'remote user-defined provider')
  })
  test('remote must NOT set the hub-loopback hook URL', () => {
    expect(env).not.toHaveProperty(['SLAYZONE_AGENT_HOOK_URL'])
  })
  test('remote SLAYZONE_AGENT_ID is the wrapped agent', () => {
    expect(env.SLAYZONE_AGENT_ID).toBe('claude-code')
  })
  test('remote ctx.mode must carry the provider mode', () => {
    const ctx = JSON.parse(env.SLAYZONE_AGENT_HOOK_CONTEXT!)
    expect(ctx.mode).toBe('my-claude')
  })
})

// ── resolveRemoteMcpEnv: the seam that gates remote vs local ─────────────────

// 7. computerId == null → null regardless of provider (local, today's only path).
describe('7. computerId == null', () => {
  let called = false
  let r: RemoteMcpEnv | null
  beforeAll(async () => {
    const provider = () => {
      called = true
      return REMOTE
    }
    r = await resolveRemoteMcpEnv(provider, {
      taskId: 't',
      computerId: null,
      mode: 'claude-code'
    })
  })
  test('computerId null must resolve to null', () => {
    expect(r).toBe(null)
  })
  test('provider must NOT be called for a local (null-computer) spawn', () => {
    expect(called).toBe(false)
  })
})

// 8. computerId != null + no provider → null (computer off / provider unset).
test('8. no provider must resolve to null even with a computerId', async () => {
  const r = await resolveRemoteMcpEnv(null, { taskId: 't', computerId: 'r1', mode: 'claude-code' })
  expect(r).toBe(null)
})

// 9. computerId != null + provider → the provider's resolved target, args forwarded.
describe('9. computerId != null + provider', () => {
  // Initializer typed (not annotated) so TS does not narrow to `null`: the closure assigns it.
  let seen = null as { taskId?: string; computerId?: string; mode?: string } | null
  let r: RemoteMcpEnv | null
  beforeAll(async () => {
    const provider = (args: { taskId: string | undefined; computerId: string; mode?: string }) => {
      seen = args
      return REMOTE
    }
    r = await resolveRemoteMcpEnv(provider, {
      taskId: 'task-9',
      computerId: 'computer-xyz',
      mode: 'claude-code'
    })
  })
  test('provider result is returned verbatim', () => {
    expect(r).toBe(REMOTE)
  })
  test('taskId forwarded to provider', () => {
    expect(seen).not.toBe(null)
    expect(seen!.taskId).toBe('task-9')
  })
  test('computerId forwarded to provider', () => {
    expect(seen!.computerId).toBe('computer-xyz')
  })
  test('mode forwarded to provider', () => {
    expect(seen!.mode).toBe('claude-code')
  })
})

// 10. A throwing provider degrades to null (spawn continues) — never bubbles.
test('10. a throwing provider must degrade to null', async () => {
  const provider = () => {
    throw new Error('mint failed')
  }
  const r = await resolveRemoteMcpEnv(provider, {
    taskId: 't',
    computerId: 'r1',
    mode: 'claude-code'
  })
  expect(r).toBe(null)
})

// 11. A provider returning null (e.g. hub URL not yet bound) → null.
test('11. provider returning null resolves to null', async () => {
  const r = await resolveRemoteMcpEnv(() => null, {
    taskId: 't',
    computerId: 'r1',
    mode: 'claude-code'
  })
  expect(r).toBe(null)
})

// 12. A provider returning a blank hubBaseUrl → null (contract enforced), so
//     buildMcpEnv never emits a blank hub target + a relative hook URL.
describe('12. blank hubBaseUrl', () => {
  test('blank hubBaseUrl must resolve to null', async () => {
    const blank = await resolveRemoteMcpEnv(() => ({ ...REMOTE, hubBaseUrl: '' }), {
      taskId: 't',
      computerId: 'r1',
      mode: 'claude-code'
    })
    expect(blank).toBe(null)
  })
  test('whitespace-only hubBaseUrl must resolve to null', async () => {
    const ws = await resolveRemoteMcpEnv(() => ({ ...REMOTE, hubBaseUrl: '   ' }), {
      taskId: 't',
      computerId: 'r1',
      mode: 'claude-code'
    })
    expect(ws).toBe(null)
  })
})

// ── SLAYZONE_HUB_TOKEN: the owner-file fallback for a standalone hub's own
//    spawns (§0.4 — a standalone hub now requires auth from EVERY caller,
//    including one it spawned itself) ─────────────────────────────────────────
// The steps below run in declaration order and share env/file state, exactly as
// the original sequential block did.
describe('SLAYZONE_HUB_TOKEN owner-file fallback', () => {
  const priorRoot = process.env.SLAYZONE_ROOT
  const priorSupervised = process.env.SLAYZONE_SUPERVISED
  const priorLogin = process.env.SLAYZONE_HUB_REQUIRE_LOGIN
  let dataRoot: string

  beforeAll(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'mcp-env-owner-'))
    process.env.SLAYZONE_ROOT = dataRoot
  })
  afterAll(() => {
    if (priorRoot === undefined) delete process.env.SLAYZONE_ROOT
    else process.env.SLAYZONE_ROOT = priorRoot
    if (priorSupervised === undefined) delete process.env.SLAYZONE_SUPERVISED
    else process.env.SLAYZONE_SUPERVISED = priorSupervised
    if (priorLogin === undefined) delete process.env.SLAYZONE_HUB_REQUIRE_LOGIN
    else process.env.SLAYZONE_HUB_REQUIRE_LOGIN = priorLogin
    rmSync(dataRoot, { recursive: true, force: true })
  })

  // 13. A hub that requires login (SLAYZONE_HUB_REQUIRE_LOGIN=1), owner file present
  //     with a token → the token is injected alongside SLAYZONE_HUB_ADDRESS,
  //     reusing the CLI's existing env channel.
  describe('13. login required + owner file with a token', () => {
    let env: Env
    beforeAll(async () => {
      delete process.env.SLAYZONE_SUPERVISED
      process.env.SLAYZONE_HUB_REQUIRE_LOGIN = '1'
      writeFileSync(
        join(dataRoot, 'hub.owner.json'),
        JSON.stringify({
          userId: 'u1',
          email: 'owner@hub.slayzone.local',
          password: 'unused-here',
          token: 'szw_test_token',
          createdAt: Date.now()
        })
      )
      env = await buildMcpEnv(null, 'task-owner-1', 'claude-code')
    })
    test('still pins the hub address', () => {
      expect(env.SLAYZONE_HUB_ADDRESS).toBe(`127.0.0.1:${MCP_PORT}`)
    })
    test('owner token injected for a plain spawn', () => {
      expect(env.SLAYZONE_HUB_TOKEN).toBe('szw_test_token')
    })
  })

  // 14. Same file, but a NON-hook-capable mode (a plain shell) — the token must
  //     still be present. This is exactly the "an in-task `slay` typed by hand"
  //     case the fallback exists for, and it is NOT gated on hook capability.
  test('14. plain-shell spawn also gets the token', async () => {
    const plain = await buildMcpEnv(null, 'task-owner-2', 'bash' as never)
    expect(plain.SLAYZONE_HUB_TOKEN).toBe('szw_test_token')
  })

  // 15. Login NOT required (the default; what the desktop app sets explicitly) →
  //     NEVER read the file, even if one happens to exist on disk (e.g. a leftover
  //     from a prior login-required run at the same root). That hub has no auth
  //     requirement and never provisions this file, so this must be a hard no-op.
  test('15. a hub with login off must never inject the owner token, even if the file exists', async () => {
    process.env.SLAYZONE_HUB_REQUIRE_LOGIN = '0'
    const loginOff = await buildMcpEnv(null, 'task-owner-3', 'claude-code')
    expect(loginOff).not.toHaveProperty(['SLAYZONE_HUB_TOKEN'])
  })
  test('15. login switch unset (default off) must not inject the owner token either', async () => {
    delete process.env.SLAYZONE_HUB_REQUIRE_LOGIN
    const loginUnset = await buildMcpEnv(null, 'task-owner-3b', 'claude-code')
    expect(loginUnset).not.toHaveProperty(['SLAYZONE_HUB_TOKEN'])
  })

  // 15b. SUPERVISED no longer decides this: it only means "started by the desktop
  //      app". A supervised hub that DID require login would need the bearer.
  test('15b. the login switch, not SLAYZONE_SUPERVISED, decides whether the owner token is injected', async () => {
    process.env.SLAYZONE_SUPERVISED = '1'
    process.env.SLAYZONE_HUB_REQUIRE_LOGIN = '1'
    const supervisedLogin = await buildMcpEnv(null, 'task-owner-3c', 'claude-code')
    expect(supervisedLogin.SLAYZONE_HUB_TOKEN).toBe('szw_test_token')
    delete process.env.SLAYZONE_SUPERVISED
  })

  // 16. No owner file at all (the file was never provisioned, or belongs to a
  //     different OS user and is unreadable) → silently absent, never throws.
  describe('16. no owner file at all', () => {
    let noFile: Env
    beforeAll(async () => {
      process.env.SLAYZONE_HUB_REQUIRE_LOGIN = '1'
      rmSync(join(dataRoot, 'hub.owner.json'))
      noFile = await buildMcpEnv(null, 'task-owner-4', 'claude-code')
    })
    test('missing owner file degrades to no token, not a throw', () => {
      expect(noFile).not.toHaveProperty(['SLAYZONE_HUB_TOKEN'])
    })
    test('hub address is still set with no owner file', () => {
      expect(noFile.SLAYZONE_HUB_ADDRESS).toBe(`127.0.0.1:${MCP_PORT}`)
    })
  })
})
