/**
 * The env a hub-requested process starts with — shared by the pty and proc
 * handlers, so a terminal and a chat agent can never disagree about it.
 *
 * @module computer/handlers/spawn-env
 */
import { sanitizeSpawnEnv } from '@slayzone/platform/env-manifest'
import type { HandlerContext } from './types'

export function buildSpawnEnv(
  ctx: HandlerContext,
  overrides?: Record<string, string>
): Record<string, string> {
  // Base channel: the computer inherits its parent (supervisor) process.env, so
  // sanitize it through the shared manifest — keep the user env (PATH/HOME/
  // toolchains) but strip every SlayZone infra/secret/identity var (and any
  // unmanifested SLAYZONE_*, fail closed) so nothing the computer was configured
  // with leaks into a spawned agent, which would reinterpret it. The hub's
  // per-spawn `overrides` (the identity overlay) apply AFTER and are the
  // authoritative source for anything an agent legitimately needs.
  const merged: Record<string, string> = overrides
    ? { ...sanitizeSpawnEnv(process.env), ...overrides }
    : sanitizeSpawnEnv(process.env)
  // Override channel: force the agent's lifecycle hook to the computer's OWN
  // loopback relay (which forwards to the hub over the authed ws channel), and
  // strip any hub bearer the hub baked into `overrides` — no per-agent token in
  // subprocess env, and the agent env is byte-identical to a local spawn's hook
  // wiring. Distinct from the base sanitize above: this guards a token the HUB
  // passed in, which sanitizeSpawnEnv (base-only) never sees. Without it a
  // computer-hosted CHAT agent would post its hooks at a hub URL that does not
  // resolve from this machine — no spinner, no unread dot.
  if (ctx.agentHookUrl) {
    merged.SLAYZONE_AGENT_HOOK_URL = ctx.agentHookUrl
    delete merged.SLAYZONE_HUB_TOKEN
  }
  // Which hub `slay` in this process belongs to: the one that asked for it, as this
  // box reaches it. Without it a task terminal's `slay` fell through to the hub
  // target stored by `slay hub use/login` — a remote sign-in silently retargeted
  // every agent toolbox on the machine.
  if (ctx.hubAddress) merged.SLAYZONE_HUB_ADDRESS = ctx.hubAddress
  return merged
}
