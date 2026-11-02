/**
 * The env a hub-requested process starts with — shared by the pty and proc
 * handlers, so a terminal and a chat agent can never disagree about it.
 *
 * @module computer/handlers/spawn-env
 */
import { mergePathLists, resolveUserShell } from '@slayzone/platform'
import { sanitizeSpawnEnv } from '@slayzone/platform/env-manifest'
import { userInfo } from 'node:os'
import { pickHubPtyEnv } from '@slayzone/computer-transport/shared'
import type { HandlerContext } from './types'
import type { CliRelayCapability } from '../cli-relay'

export function buildSpawnEnv(
  ctx: HandlerContext,
  overrides?: Record<string, string>,
  capability?: CliRelayCapability
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
  // Never accept relay credentials from the hub or an inherited shell. Only the
  // computer can issue a capability for this particular spawned session.
  delete merged.SLAYZONE_CLI_RELAY_ADDRESS
  delete merged.SLAYZONE_CLI_RELAY_TOKEN
  if (capability && ctx.cliRelay) {
    delete merged.SLAYZONE_HUB_TOKEN
    merged.SLAYZONE_CLI_RELAY_ADDRESS = new URL(ctx.cliRelay.url).host
    merged.SLAYZONE_CLI_RELAY_TOKEN = capability.token
  }
  delete merged.SLAYZONE_COMPUTER_HOOK_DIR
  if (ctx.hookDirectory) merged.SLAYZONE_COMPUTER_HOOK_DIR = ctx.hookDirectory.replace(/\\/g, '/')
  // Last, so it wins over whichever channel supplied PATH (inherited or a hub
  // override): a configured override dir resolves before anything else. Node
  // looks a bare command up on `env.PATH`, so this is what an agent spawn resolves.
  if (ctx.config.binOverrideDir) {
    merged.PATH = mergePathLists(ctx.config.binOverrideDir, merged.PATH)
  }
  return merged
}

export function buildPtySpawnEnv(
  ctx: HandlerContext,
  hubEnv?: Record<string, string>,
  capability?: CliRelayCapability
): Record<string, string> {
  const env = buildSpawnEnv(ctx, pickHubPtyEnv(hubEnv), capability)
  // Supervisors may launch this service with a synthetic HOME/USER/SHELL.
  // The account database, not those inherited values, owns process identity.
  const account = userInfo()
  env.HOME = account.homedir
  env.USER = account.username
  env.LOGNAME = account.username
  env.SHELL = resolveUserShell()
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  return env
}
