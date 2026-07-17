/**
 * Unit tests for buildMcpEnv + resolveRemoteMcpEnv — the per-PTY env injected
 * for AI-agent subprocesses (hub/runner split, wave 3).
 *
 * The load-bearing invariant: a LOCAL spawn (`runnerId == null`, or no remote
 * target) gets EXACTLY today's loopback env — loopback SLAYZONE_AGENT_HOOK_URL,
 * SLAYZONE_MCP_PORT, and NO SLAYZONE_HUB_URL/TOKEN. A REMOTE spawn instead points
 * the CLI + hooks at the hub (SLAYZONE_HUB_URL + hub hook URL + a scoped bearer)
 * with NO loopback port.
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
// `globalThis.__mcpPort` (set by the server host at boot).
const MCP_PORT = 54321
;(globalThis as Record<string, unknown>).__mcpPort = MCP_PORT

const REMOTE: RemoteMcpEnv = {
  runnerId: 'runner-xyz',
  hubBaseUrl: 'https://hub.example:8443',
  token: 'sztt1.faketoken.sig'
}

// ── LOCAL (runnerId == null): byte-identical to today's loopback env ─────────

// 1. Local hook-capable agent → loopback hook URL + MCP port, no hub env.
{
  const env = await buildMcpEnv(null, 'task-1', 'claude-code')
  assert(
    env.SLAYZONE_AGENT_HOOK_URL === `http://127.0.0.1:${MCP_PORT}${AGENT_HOOK_PATH}`,
    `local hook URL must be loopback, got: ${env.SLAYZONE_AGENT_HOOK_URL}`
  )
  assert(env.SLAYZONE_MCP_PORT === String(MCP_PORT), 'local must set SLAYZONE_MCP_PORT')
  assert(env.SLAYZONE_AGENT_ID === 'claude-code', 'local must set SLAYZONE_AGENT_ID')
  assert('SLAYZONE_HOME_DIR' in env, 'local hook-capable must set SLAYZONE_HOME_DIR')
  assert(!('SLAYZONE_HUB_URL' in env), 'local must NOT set SLAYZONE_HUB_URL')
  assert(!('SLAYZONE_HUB_TOKEN' in env), 'local must NOT set SLAYZONE_HUB_TOKEN')
  assert(env.SLAYZONE_TASK_ID === 'task-1', 'task id present')
}

// 2. Local, explicit `remote = null` → identical to omitting it entirely.
{
  const a = await buildMcpEnv(null, 'task-2', 'claude-code')
  const b = await buildMcpEnv(null, 'task-2', 'claude-code', undefined, undefined, null)
  assert(JSON.stringify(a) === JSON.stringify(b), 'remote=null must equal remote omitted')
}

// 3. Local non-hook-capable mode → MCP port but NO hook URL (unchanged behavior).
{
  const env = await buildMcpEnv(null, 'task-3', 'some-unknown-mode' as never)
  assert(env.SLAYZONE_MCP_PORT === String(MCP_PORT), 'MCP port still set for non-hook mode')
  assert(!('SLAYZONE_AGENT_HOOK_URL' in env), 'no hook URL for non-hook-capable mode')
  assert(!('SLAYZONE_HUB_URL' in env), 'still no hub env locally')
}

// ── REMOTE (runnerId != null + provider): hub env, no loopback ───────────────

// 4. Remote hook-capable → hub URL + hub hook URL + bearer, NO loopback port.
{
  const env = await buildMcpEnv(null, 'task-r1', 'claude-code', undefined, undefined, REMOTE)
  assert(env.SLAYZONE_HUB_URL === REMOTE.hubBaseUrl, 'remote must set SLAYZONE_HUB_URL')
  assert(env.SLAYZONE_HUB_TOKEN === REMOTE.token, 'remote must inject the scoped bearer')
  assert(
    env.SLAYZONE_AGENT_HOOK_URL === `${REMOTE.hubBaseUrl}${AGENT_HOOK_PATH}`,
    `remote hook URL must point at hub, got: ${env.SLAYZONE_AGENT_HOOK_URL}`
  )
  assert(!('SLAYZONE_MCP_PORT' in env), 'remote must NOT set loopback SLAYZONE_MCP_PORT')
  assert(!env.SLAYZONE_AGENT_HOOK_URL.includes('127.0.0.1'), 'remote hook URL must not be loopback')
  assert(env.SLAYZONE_AGENT_ID === 'claude-code', 'remote still sets SLAYZONE_AGENT_ID')
}

// 5. Remote with a null token → hub URL set, but no SLAYZONE_HUB_TOKEN key.
{
  const env = await buildMcpEnv(null, 'task-r2', 'claude-code', undefined, undefined, {
    ...REMOTE,
    token: null
  })
  assert(env.SLAYZONE_HUB_URL === REMOTE.hubBaseUrl, 'hub URL set even without a token')
  assert(!('SLAYZONE_HUB_TOKEN' in env), 'null token must NOT set SLAYZONE_HUB_TOKEN')
}

// 6. Remote non-hook-capable → hub URL/token but no hook URL.
{
  const env = await buildMcpEnv(null, 'task-r3', 'some-unknown-mode' as never, undefined, undefined, REMOTE)
  assert(env.SLAYZONE_HUB_URL === REMOTE.hubBaseUrl, 'hub URL set for non-hook remote')
  assert(!('SLAYZONE_AGENT_HOOK_URL' in env), 'no hook URL for non-hook remote mode')
  assert(!('SLAYZONE_MCP_PORT' in env), 'still no loopback port remotely')
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
