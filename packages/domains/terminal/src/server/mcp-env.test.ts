/**
 * Unit tests for buildMcpEnv + resolveRemoteMcpEnv — the per-PTY env injected
 * for AI-agent subprocesses (hub/runner split, wave 3).
 *
 * The load-bearing invariant: a LOCAL spawn (`runnerId == null`, or no remote
 * target) gets the loopback SLAYZONE_AGENT_HOOK_URL and NO SLAYZONE_HUB_URL/TOKEN.
 * No port env var is injected — the CLI reads the port from the DB. A REMOTE
 * spawn instead points the CLI + hooks at the hub (SLAYZONE_HUB_URL + hub hook
 * URL + a scoped bearer).
 *
 * Run with: npx tsx packages/domains/terminal/src/server/mcp-env.test.ts
 */
import {
  buildMcpEnv,
  resolveRemoteMcpEnv,
  AGENT_HOOK_PATH,
  type RemoteMcpEnv
} from './mcp-env'

let pass = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
  pass++
}

// A fixed port so the loopback assertions are exact. buildMcpEnv reads
// `globalThis.__serverPort` (set by the server host at boot).
const MCP_PORT = 54321
;(globalThis as Record<string, unknown>).__serverPort = MCP_PORT

const REMOTE: RemoteMcpEnv = {
  runnerId: 'runner-xyz',
  hubBaseUrl: 'https://hub.example:8443'
}

// ── LOCAL (runnerId == null): byte-identical to today's loopback env ─────────

// 1. Local hook-capable agent → loopback hook URL, no port env, no hub env.
{
  const env = await buildMcpEnv(null, 'task-1', 'claude-code')
  assert(
    env.SLAYZONE_AGENT_HOOK_URL === `http://127.0.0.1:${MCP_PORT}${AGENT_HOOK_PATH}`,
    `local hook URL must be loopback, got: ${env.SLAYZONE_AGENT_HOOK_URL}`
  )
  assert(!('SLAYZONE_HUB_PORT' in env), 'local must NOT set SLAYZONE_HUB_PORT (CLI reads DB)')
  assert(env.SLAYZONE_AGENT_ID === 'claude-code', 'local must set SLAYZONE_AGENT_ID')
  assert('SLAYZONE_ROOT' in env, 'local hook-capable must set SLAYZONE_ROOT')
  assert(!('SLAYZONE_HUB_URL' in env), 'local must NOT set SLAYZONE_HUB_URL')
  assert(!('SLAYZONE_HUB_TOKEN' in env), 'local must NOT set SLAYZONE_HUB_TOKEN')
  assert(env.SLAYZONE_TASK_ID === 'task-1', 'task id present')
  // The opaque context blob the benign notify.sh forwards verbatim. All identity
  // fields the server needs to attribute a hook live HERE — never named in the script.
  assert('SLAYZONE_HOOK_CONTEXT' in env, 'local hook-capable must set SLAYZONE_HOOK_CONTEXT')
  const ctx = JSON.parse(env.SLAYZONE_HOOK_CONTEXT!)
  assert(ctx.v === 1, `ctx envelope version must be 1, got ${ctx.v}`)
  assert(ctx.taskId === 'task-1', 'ctx carries taskId')
  assert(ctx.agentId === 'claude-code', 'ctx carries agentId')
  assert('channel' in ctx, 'ctx carries channel (attribution/diagnostic)')
}

// 1b. Pooled (taskless) spawn → ctx carries slaySessionId + projectId, no taskId.
{
  const env = await buildMcpEnv(null, undefined, 'claude-code', 'sess-123', 'proj-9')
  assert('SLAYZONE_HOOK_CONTEXT' in env, 'pooled spawn still sets SLAYZONE_HOOK_CONTEXT')
  const ctx = JSON.parse(env.SLAYZONE_HOOK_CONTEXT!)
  assert(ctx.slaySessionId === 'sess-123', 'ctx carries slaySessionId for a pooled agent')
  assert(ctx.projectId === 'proj-9', 'ctx carries projectId')
  assert(ctx.taskId === undefined, 'ctx has no taskId for a taskless pooled spawn')
}

// 1c. Non-hook-capable mode → NO ctx blob (the blob only rides the hook env).
{
  const env = await buildMcpEnv(null, 'task-x', 'some-unknown-mode' as never)
  assert(!('SLAYZONE_HOOK_CONTEXT' in env), 'non-hook mode must NOT set SLAYZONE_HOOK_CONTEXT')
}

// 2. Local, explicit `remote = null` → identical to omitting it entirely.
{
  const a = await buildMcpEnv(null, 'task-2', 'claude-code')
  const b = await buildMcpEnv(null, 'task-2', 'claude-code', undefined, undefined, null)
  assert(JSON.stringify(a) === JSON.stringify(b), 'remote=null must equal remote omitted')
}

// 3. Local non-hook-capable mode → no hook URL, no port env (unchanged behavior).
{
  const env = await buildMcpEnv(null, 'task-3', 'some-unknown-mode' as never)
  assert(!('SLAYZONE_HUB_PORT' in env), 'no port env for non-hook mode either')
  assert(!('SLAYZONE_AGENT_HOOK_URL' in env), 'no hook URL for non-hook-capable mode')
  assert(!('SLAYZONE_HUB_URL' in env), 'still no hub env locally')
}

// ── REMOTE (runnerId != null + provider): agent posts to RUNNER LOOPBACK ──────
//
// New topology: the agent env is byte-identical local vs remote. The agent
// ALWAYS posts to runner loopback; the RUNNER overlays SLAYZONE_AGENT_HOOK_URL
// (it owns its own loopback port) and relays to the hub over its ws channel.
// So buildMcpEnv's remote branch sets NO hub URL, NO bearer, and NO hook URL
// (the runner supplies it) — only the agent id + ROOT + the opaque ctx blob.

// 4. Remote hook-capable → agent id + ROOT + ctx blob; NO hub env, NO hook URL.
{
  const env = await buildMcpEnv(null, 'task-r1', 'claude-code', undefined, undefined, REMOTE)
  assert(!('SLAYZONE_HUB_URL' in env), 'remote must NOT set SLAYZONE_HUB_URL (agent posts to runner loopback)')
  assert(!('SLAYZONE_HUB_TOKEN' in env), 'remote must NOT inject a bearer (loopback is unauthed)')
  assert(
    !('SLAYZONE_AGENT_HOOK_URL' in env),
    'remote buildMcpEnv must NOT set the hook URL — the runner overlays its own loopback URL'
  )
  assert(!('SLAYZONE_HUB_PORT' in env), 'remote must NOT set loopback SLAYZONE_HUB_PORT')
  assert(env.SLAYZONE_AGENT_ID === 'claude-code', 'remote still sets SLAYZONE_AGENT_ID')
  assert('SLAYZONE_ROOT' in env, 'remote hook-capable still sets SLAYZONE_ROOT')
  assert('SLAYZONE_HOOK_CONTEXT' in env, 'remote hook-capable still sets the ctx blob')
  const ctx = JSON.parse(env.SLAYZONE_HOOK_CONTEXT!)
  assert(ctx.taskId === 'task-r1', 'remote ctx carries taskId')
}

// 5. Remote hook env matches local hook env for identity (no hub-specific keys).
{
  const local = await buildMcpEnv(null, 'task-same', 'claude-code')
  const remote = await buildMcpEnv(null, 'task-same', 'claude-code', undefined, undefined, REMOTE)
  // Same identity blob + agent id; the only difference is the hook URL (local has
  // the loopback one, remote defers to the runner overlay).
  assert(remote.SLAYZONE_AGENT_ID === local.SLAYZONE_AGENT_ID, 'agent id identical local vs remote')
  assert(remote.SLAYZONE_HOOK_CONTEXT === local.SLAYZONE_HOOK_CONTEXT, 'ctx blob identical local vs remote')
  assert('SLAYZONE_AGENT_HOOK_URL' in local, 'local sets the loopback hook URL')
  assert(!('SLAYZONE_AGENT_HOOK_URL' in remote), 'remote leaves the hook URL to the runner')
}

// 6. Remote non-hook-capable → nothing hook-related, no hub env.
{
  const env = await buildMcpEnv(null, 'task-r3', 'some-unknown-mode' as never, undefined, undefined, REMOTE)
  assert(!('SLAYZONE_HUB_URL' in env), 'no hub URL for non-hook remote')
  assert(!('SLAYZONE_AGENT_HOOK_URL' in env), 'no hook URL for non-hook remote mode')
  assert(!('SLAYZONE_HOOK_CONTEXT' in env), 'no ctx blob for non-hook remote mode')
  assert(!('SLAYZONE_HUB_PORT' in env), 'still no loopback port remotely')
}

// ── resolveRemoteMcpEnv: the seam that gates remote vs local ─────────────────

// 7. runnerId == null → null regardless of provider (local, today's only path).
{
  let called = false
  const provider = () => {
    called = true
    return REMOTE
  }
  const r = await resolveRemoteMcpEnv(provider, { taskId: 't', runnerId: null, mode: 'claude-code' })
  assert(r === null, 'runnerId null must resolve to null')
  assert(called === false, 'provider must NOT be called for a local (null-runner) spawn')
}

// 8. runnerId != null + no provider → null (runner off / provider unset).
{
  const r = await resolveRemoteMcpEnv(null, { taskId: 't', runnerId: 'r1', mode: 'claude-code' })
  assert(r === null, 'no provider must resolve to null even with a runnerId')
}

// 9. runnerId != null + provider → the provider's resolved target, args forwarded.
{
  let seen: { taskId?: string; runnerId?: string; mode?: string } | null = null
  const provider = (args: { taskId: string | undefined; runnerId: string; mode?: string }) => {
    seen = args
    return REMOTE
  }
  const r = await resolveRemoteMcpEnv(provider, {
    taskId: 'task-9',
    runnerId: 'runner-xyz',
    mode: 'claude-code'
  })
  assert(r === REMOTE, 'provider result is returned verbatim')
  assert(seen !== null && seen!.taskId === 'task-9', 'taskId forwarded to provider')
  assert(seen!.runnerId === 'runner-xyz', 'runnerId forwarded to provider')
  assert(seen!.mode === 'claude-code', 'mode forwarded to provider')
}

// 10. A throwing provider degrades to null (spawn continues) — never bubbles.
{
  const provider = () => {
    throw new Error('mint failed')
  }
  const r = await resolveRemoteMcpEnv(provider, { taskId: 't', runnerId: 'r1', mode: 'claude-code' })
  assert(r === null, 'a throwing provider must degrade to null')
}

// 11. A provider returning null (e.g. hub URL not yet bound) → null.
{
  const r = await resolveRemoteMcpEnv(() => null, {
    taskId: 't',
    runnerId: 'r1',
    mode: 'claude-code'
  })
  assert(r === null, 'provider returning null resolves to null')
}

// 12. A provider returning a blank hubBaseUrl → null (contract enforced), so
//     buildMcpEnv never emits SLAYZONE_HUB_URL='' + a relative hook URL.
{
  const blank = await resolveRemoteMcpEnv(() => ({ ...REMOTE, hubBaseUrl: '' }), {
    taskId: 't',
    runnerId: 'r1',
    mode: 'claude-code'
  })
  assert(blank === null, 'blank hubBaseUrl must resolve to null')
  const ws = await resolveRemoteMcpEnv(() => ({ ...REMOTE, hubBaseUrl: '   ' }), {
    taskId: 't',
    runnerId: 'r1',
    mode: 'claude-code'
  })
  assert(ws === null, 'whitespace-only hubBaseUrl must resolve to null')
}

console.log(`OK — buildMcpEnv / resolveRemoteMcpEnv ${pass} checks passed`)
