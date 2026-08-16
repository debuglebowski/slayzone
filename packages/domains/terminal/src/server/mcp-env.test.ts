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
 *
 * Run with: npx tsx packages/domains/terminal/src/server/mcp-env.test.ts
 */
import { buildMcpEnv, resolveRemoteMcpEnv, AGENT_HOOK_PATH, type RemoteMcpEnv } from './mcp-env'

let pass = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
  pass++
}

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
function assertNoHubEnv(env: Record<string, string>, where: string): void {
  for (const key of HUB_ENV_KEYS) {
    assert(!(key in env), `${where} must NOT set ${key}`)
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
function assertLocalHubEnv(env: Record<string, string>, where: string, port: number): void {
  assert(
    env.SLAYZONE_HUB_ADDRESS === `127.0.0.1:${port}`,
    `${where} must pin the loopback hub authority, got: ${env.SLAYZONE_HUB_ADDRESS}`
  )
  for (const key of RETIRED_HUB_ENV_KEYS) {
    assert(!(key in env), `${where} must NOT set the retired ${key}`)
  }
  assert(!('SLAYZONE_HUB_TOKEN' in env), `${where} must NOT inject a bearer`)
}

// A fixed port so the loopback assertions are exact. buildMcpEnv reads
// `globalThis.__serverPort` (set by the server host at boot).
const MCP_PORT = 54321
;(globalThis as Record<string, unknown>).__serverPort = MCP_PORT

const REMOTE: RemoteMcpEnv = {
  computerId: 'computer-xyz',
  hubBaseUrl: 'https://hub.example:8443'
}

// ── LOCAL (computerId == null): byte-identical to today's loopback env ─────────

// 1. Local hook-capable agent → loopback hook URL, no port env, no hub env.
{
  const env = await buildMcpEnv(null, 'task-1', 'claude-code')
  assert(
    env.SLAYZONE_AGENT_HOOK_URL === `http://127.0.0.1:${MCP_PORT}${AGENT_HOOK_PATH}`,
    `local hook URL must be loopback, got: ${env.SLAYZONE_AGENT_HOOK_URL}`
  )
  assert(env.SLAYZONE_AGENT_ID === 'claude-code', 'local must set SLAYZONE_AGENT_ID')
  assert('SLAYZONE_ROOT' in env, 'local hook-capable must set SLAYZONE_ROOT')
  // Tell the child which app it belongs to, so `slay` never has to go probing.
  assertLocalHubEnv(env, 'local', MCP_PORT)
  assert(env.SLAYZONE_TASK_ID === 'task-1', 'task id present')
  // The opaque context blob the benign notify.sh forwards verbatim. All identity
  // fields the server needs to attribute a hook live HERE — never named in the script.
  assert(
    'SLAYZONE_AGENT_HOOK_CONTEXT' in env,
    'local hook-capable must set SLAYZONE_AGENT_HOOK_CONTEXT'
  )
  // The pre-rename name is NEVER written: notify.sh reads it only as a fallback so
  // an OLDER release channel's app can still feed a NEWER shared script.
  assert(!('SLAYZONE_HOOK_CONTEXT' in env), 'the retired SLAYZONE_HOOK_CONTEXT must NOT be written')
  const ctx = JSON.parse(env.SLAYZONE_AGENT_HOOK_CONTEXT!)
  assert(ctx.v === 1, `ctx envelope version must be 1, got ${ctx.v}`)
  assert(ctx.taskId === 'task-1', 'ctx carries taskId')
  assert(ctx.agentId === 'claude-code', 'ctx carries agentId')
  // `releaseChannel` (not `channel`) — the field names WHICH release channel fired
  // the hook, so a cross-release-channel clobber is visible in Diagnostics.
  assert(
    typeof ctx.releaseChannel === 'string' && ctx.releaseChannel !== '',
    `ctx carries releaseChannel (attribution/diagnostic), got: ${JSON.stringify(ctx.releaseChannel)}`
  )
}

// 1b. Pooled (taskless) spawn → ctx carries slaySessionId + projectId, no taskId.
{
  const env = await buildMcpEnv(null, undefined, 'claude-code', 'sess-123', 'proj-9')
  assert(
    'SLAYZONE_AGENT_HOOK_CONTEXT' in env,
    'pooled spawn still sets SLAYZONE_AGENT_HOOK_CONTEXT'
  )
  const ctx = JSON.parse(env.SLAYZONE_AGENT_HOOK_CONTEXT!)
  assert(ctx.slaySessionId === 'sess-123', 'ctx carries slaySessionId for a pooled agent')
  assert(ctx.projectId === 'proj-9', 'ctx carries projectId')
  assert(ctx.taskId === undefined, 'ctx has no taskId for a taskless pooled spawn')
}

// 1c. Non-hook-capable mode → NO ctx blob (the blob only rides the hook env).
{
  const env = await buildMcpEnv(null, 'task-x', 'some-unknown-mode' as never)
  assert(
    !('SLAYZONE_AGENT_HOOK_CONTEXT' in env),
    'non-hook mode must NOT set SLAYZONE_AGENT_HOOK_CONTEXT'
  )
}

// 2. Local, explicit `remote = null` → identical to omitting it entirely.
{
  const a = await buildMcpEnv(null, 'task-2', 'claude-code')
  const b = await buildMcpEnv(null, 'task-2', 'claude-code', undefined, undefined, null)
  assert(JSON.stringify(a) === JSON.stringify(b), 'remote=null must equal remote omitted')
}

// 3. Local non-hook-capable mode → no hook URL, but STILL a pinned address.
// A plain shell is where `slay` is typed by hand, so it is the case that most
// needs pinning — and the one that previously fell through to a port probe.
{
  const env = await buildMcpEnv(null, 'task-3', 'some-unknown-mode' as never)
  assert(!('SLAYZONE_AGENT_HOOK_URL' in env), 'no hook URL for non-hook-capable mode')
  assertLocalHubEnv(env, 'local non-hook mode', MCP_PORT)
}

// 3a. A bare shell (no task, no mode) is pinned too.
{
  const env = await buildMcpEnv(null, undefined, undefined)
  assertLocalHubEnv(env, 'plain shell', MCP_PORT)
}

// 3b. SLAYZONE_ROOT is set for EVERY spawn, not only hook-capable ones —
// including a plain shell with no mode at all. Regression guard for the
// channel-scoped layout: a pty routed through the co-located local computer
// inherits THAT computer's own role-scoped SLAYZONE_ROOT through the base env
// (the manifest tags the var `global`, so sanitizeSpawnEnv keeps it). The hub's
// value must override it at the spawn boundary, or `slay` inside a plain
// terminal resolves the computer's credential dir instead of the hub's DB.
{
  for (const [label, env] of [
    ['non-hook mode', await buildMcpEnv(null, 'task-3b', 'some-unknown-mode' as never)],
    ['plain shell (no mode)', await buildMcpEnv(null, undefined, undefined)],
    [
      'remote non-hook mode',
      await buildMcpEnv(null, 'task-3b', 'some-unknown-mode' as never, undefined, undefined, REMOTE)
    ]
  ] as const) {
    assert(
      typeof env.SLAYZONE_ROOT === 'string' && env.SLAYZONE_ROOT !== '',
      `${label} must still set SLAYZONE_ROOT (hub is authoritative for the on-disk anchor)`
    )
  }
}

// ── REMOTE (computerId != null + provider): agent posts to COMPUTER LOOPBACK ──────
//
// New topology: the agent env is byte-identical local vs remote. The agent
// ALWAYS posts to computer loopback; the COMPUTER overlays SLAYZONE_AGENT_HOOK_URL
// (it owns its own loopback port) and relays to the hub over its ws channel.
// So buildMcpEnv's remote branch sets NO hub URL, NO bearer, and NO hook URL
// (the computer supplies it) — only the agent id + ROOT + the opaque ctx blob.

// 4. Remote hook-capable → agent id + ROOT + ctx blob; NO hub env, NO hook URL.
{
  const env = await buildMcpEnv(null, 'task-r1', 'claude-code', undefined, undefined, REMOTE)
  assertNoHubEnv(env, 'remote (agent posts to computer loopback)')
  assert(!('SLAYZONE_HUB_TOKEN' in env), 'remote must NOT inject a bearer (loopback is unauthed)')
  assert(
    !('SLAYZONE_AGENT_HOOK_URL' in env),
    'remote buildMcpEnv must NOT set the hook URL — the computer overlays its own loopback URL'
  )
  assert(env.SLAYZONE_AGENT_ID === 'claude-code', 'remote still sets SLAYZONE_AGENT_ID')
  assert('SLAYZONE_ROOT' in env, 'remote hook-capable still sets SLAYZONE_ROOT')
  assert('SLAYZONE_AGENT_HOOK_CONTEXT' in env, 'remote hook-capable still sets the ctx blob')
  const ctx = JSON.parse(env.SLAYZONE_AGENT_HOOK_CONTEXT!)
  assert(ctx.taskId === 'task-r1', 'remote ctx carries taskId')
}

// 5. Remote hook env matches local hook env for identity (no hub-specific keys).
{
  const local = await buildMcpEnv(null, 'task-same', 'claude-code')
  const remote = await buildMcpEnv(null, 'task-same', 'claude-code', undefined, undefined, REMOTE)
  // Same identity blob + agent id. Two deliberate differences, both loopback-shaped
  // and neither an identity field: local carries the hook URL (remote defers to the
  // computer overlay) and local carries the hub authority (remote must not — it would
  // ship this hub's address to another box).
  assert(remote.SLAYZONE_AGENT_ID === local.SLAYZONE_AGENT_ID, 'agent id identical local vs remote')
  assert(!('SLAYZONE_HUB_ADDRESS' in remote), 'remote must NOT carry this hub address')
  assert(
    remote.SLAYZONE_AGENT_HOOK_CONTEXT === local.SLAYZONE_AGENT_HOOK_CONTEXT,
    'ctx blob identical local vs remote'
  )
  assert('SLAYZONE_AGENT_HOOK_URL' in local, 'local sets the loopback hook URL')
  assert(!('SLAYZONE_AGENT_HOOK_URL' in remote), 'remote leaves the hook URL to the computer')
}

// 6. Remote non-hook-capable → nothing hook-related, no hub env.
{
  const env = await buildMcpEnv(
    null,
    'task-r3',
    'some-unknown-mode' as never,
    undefined,
    undefined,
    REMOTE
  )
  assertNoHubEnv(env, 'non-hook remote')
  assert(!('SLAYZONE_AGENT_HOOK_URL' in env), 'no hook URL for non-hook remote mode')
  assert(!('SLAYZONE_AGENT_HOOK_CONTEXT' in env), 'no ctx blob for non-hook remote mode')
}

// ── resolveRemoteMcpEnv: the seam that gates remote vs local ─────────────────

// 7. computerId == null → null regardless of provider (local, today's only path).
{
  let called = false
  const provider = () => {
    called = true
    return REMOTE
  }
  const r = await resolveRemoteMcpEnv(provider, {
    taskId: 't',
    computerId: null,
    mode: 'claude-code'
  })
  assert(r === null, 'computerId null must resolve to null')
  assert(called === false, 'provider must NOT be called for a local (null-computer) spawn')
}

// 8. computerId != null + no provider → null (computer off / provider unset).
{
  const r = await resolveRemoteMcpEnv(null, { taskId: 't', computerId: 'r1', mode: 'claude-code' })
  assert(r === null, 'no provider must resolve to null even with a computerId')
}

// 9. computerId != null + provider → the provider's resolved target, args forwarded.
{
  let seen: { taskId?: string; computerId?: string; mode?: string } | null = null
  const provider = (args: { taskId: string | undefined; computerId: string; mode?: string }) => {
    seen = args
    return REMOTE
  }
  const r = await resolveRemoteMcpEnv(provider, {
    taskId: 'task-9',
    computerId: 'computer-xyz',
    mode: 'claude-code'
  })
  assert(r === REMOTE, 'provider result is returned verbatim')
  assert(seen !== null && seen!.taskId === 'task-9', 'taskId forwarded to provider')
  assert(seen!.computerId === 'computer-xyz', 'computerId forwarded to provider')
  assert(seen!.mode === 'claude-code', 'mode forwarded to provider')
}

// 10. A throwing provider degrades to null (spawn continues) — never bubbles.
{
  const provider = () => {
    throw new Error('mint failed')
  }
  const r = await resolveRemoteMcpEnv(provider, {
    taskId: 't',
    computerId: 'r1',
    mode: 'claude-code'
  })
  assert(r === null, 'a throwing provider must degrade to null')
}

// 11. A provider returning null (e.g. hub URL not yet bound) → null.
{
  const r = await resolveRemoteMcpEnv(() => null, {
    taskId: 't',
    computerId: 'r1',
    mode: 'claude-code'
  })
  assert(r === null, 'provider returning null resolves to null')
}

// 12. A provider returning a blank hubBaseUrl → null (contract enforced), so
//     buildMcpEnv never emits a blank hub target + a relative hook URL.
{
  const blank = await resolveRemoteMcpEnv(() => ({ ...REMOTE, hubBaseUrl: '' }), {
    taskId: 't',
    computerId: 'r1',
    mode: 'claude-code'
  })
  assert(blank === null, 'blank hubBaseUrl must resolve to null')
  const ws = await resolveRemoteMcpEnv(() => ({ ...REMOTE, hubBaseUrl: '   ' }), {
    taskId: 't',
    computerId: 'r1',
    mode: 'claude-code'
  })
  assert(ws === null, 'whitespace-only hubBaseUrl must resolve to null')
}

// ── SLAYZONE_HUB_TOKEN: the owner-file fallback for a standalone hub's own
//    spawns (§0.4 — a standalone hub now requires auth from EVERY caller,
//    including one it spawned itself) ─────────────────────────────────────────
{
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const priorRoot = process.env.SLAYZONE_ROOT
  const priorSupervised = process.env.SLAYZONE_SUPERVISED
  const dataRoot = mkdtempSync(join(tmpdir(), 'mcp-env-owner-'))
  process.env.SLAYZONE_ROOT = dataRoot

  try {
    // 13. Standalone hub, owner file present with a token → the token is injected
    //     alongside SLAYZONE_HUB_ADDRESS, reusing the CLI's existing env channel.
    delete process.env.SLAYZONE_SUPERVISED
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
    const env = await buildMcpEnv(null, 'task-owner-1', 'claude-code')
    assert(
      env.SLAYZONE_HUB_ADDRESS === `127.0.0.1:${MCP_PORT}`,
      `still pins the hub address, got: ${env.SLAYZONE_HUB_ADDRESS}`
    )
    assert(
      env.SLAYZONE_HUB_TOKEN === 'szw_test_token',
      `owner token injected for a plain spawn, got: ${env.SLAYZONE_HUB_TOKEN}`
    )

    // 14. Same file, but a NON-hook-capable mode (a plain shell) — the token must
    //     still be present. This is exactly the "an in-task `slay` typed by hand"
    //     case the fallback exists for, and it is NOT gated on hook capability.
    const plain = await buildMcpEnv(null, 'task-owner-2', 'bash' as never)
    assert(
      plain.SLAYZONE_HUB_TOKEN === 'szw_test_token',
      `plain-shell spawn also gets the token, got: ${plain.SLAYZONE_HUB_TOKEN}`
    )

    // 15. Supervised hub → NEVER read the file, even if one happens to exist on
    //     disk (e.g. a leftover from a prior standalone run at the same root).
    //     Supervised has no auth requirement and the Electron host never
    //     provisions this file, so this must be a hard no-op.
    process.env.SLAYZONE_SUPERVISED = '1'
    const supervised = await buildMcpEnv(null, 'task-owner-3', 'claude-code')
    assert(
      !('SLAYZONE_HUB_TOKEN' in supervised),
      'supervised must never inject the owner token, even if the file exists'
    )
    delete process.env.SLAYZONE_SUPERVISED

    // 16. No owner file at all (the file was never provisioned, or belongs to a
    //     different OS user and is unreadable) → silently absent, never throws.
    rmSync(join(dataRoot, 'hub.owner.json'))
    const noFile = await buildMcpEnv(null, 'task-owner-4', 'claude-code')
    assert(
      !('SLAYZONE_HUB_TOKEN' in noFile),
      'missing owner file degrades to no token, not a throw'
    )
    assert(
      noFile.SLAYZONE_HUB_ADDRESS === `127.0.0.1:${MCP_PORT}`,
      `hub address is still set with no owner file, got: ${noFile.SLAYZONE_HUB_ADDRESS}`
    )
  } finally {
    if (priorRoot === undefined) delete process.env.SLAYZONE_ROOT
    else process.env.SLAYZONE_ROOT = priorRoot
    if (priorSupervised === undefined) delete process.env.SLAYZONE_SUPERVISED
    else process.env.SLAYZONE_SUPERVISED = priorSupervised
    rmSync(dataRoot, { recursive: true, force: true })
  }
}

console.log(`OK — buildMcpEnv / resolveRemoteMcpEnv ${pass} checks passed`)
