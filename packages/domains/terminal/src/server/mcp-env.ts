import type { SlayzoneDb } from '@slayzone/platform'
import { getSlayzoneChannel, getSlayzoneHomeDir } from '@slayzone/platform'
import { HOOK_SUPPORTED_AGENT_IDS, type AgentId, type TerminalMode } from '../shared'

/** Path the agent lifecycle hook (notify.sh) POSTs to — see agent-hook.ts. */
export const AGENT_HOOK_PATH = '/api/agent-hook'

/**
 * A resolved REMOTE hub target for a task whose PTY runs on a runner
 * (hub/runner split, Model A). Built by the caller (pty-manager, via an injected
 * provider) and passed IN so `buildMcpEnv` stays a pure function of its inputs.
 *
 * `null`/absent (today's only path, and every local spawn) => the loopback env
 * below is byte-identical to before this seam existed.
 */
export interface RemoteMcpEnv {
  /** Non-empty runner id this session's OS process spawns on. */
  runnerId: string
  /**
   * The hub's externally-reachable HTTP base URL (e.g. `https://hub:8443`), no
   * trailing slash. The `slay` CLI inside the remote pty dials THIS to reach the
   * hub's REST surface (loopback resolves on the runner machine, where no hub
   * runs). The provider MUST return `null` rather than an empty/invalid base.
   *
   * NOTE: the AGENT HOOK no longer uses this. The hook posts to the RUNNER's own
   * loopback `/api/agent-hook`, and the runner relays to the hub over its
   * authenticated ws channel (so the agent env is byte-identical local vs
   * remote and carries no per-agent hub bearer). This field remains only for the
   * `slay` CLI's hub REST access.
   */
  hubBaseUrl: string
}

/**
 * Resolves the remote hub target (base URL) for a session that spawns on a
 * runner. Injected by the composition root; UNSET by default (so
 * `resolveRemoteMcpEnv` short-circuits to `null` and every spawn keeps today's
 * loopback env). Kept a plain function so `buildMcpEnv` itself stays a pure
 * function of its inputs — the impurity (read the hub URL) lives behind this
 * seam.
 */
export type RemoteMcpEnvProvider = (args: {
  taskId: string | undefined
  runnerId: string
  mode?: TerminalMode
}) => Promise<RemoteMcpEnv | null> | RemoteMcpEnv | null

/**
 * Resolve the remote target for a spawn: `null` for a hub-local session
 * (`runnerId == null` — today's only path) or when no provider is wired. Only a
 * `runnerId != null` session with a provider mints/reads a target. Never throws
 * — a provider error degrades to `null` (spawn continues; the remote backend's
 * own routing surfaces a hard failure if the runner is truly unreachable).
 */
export async function resolveRemoteMcpEnv(
  provider: RemoteMcpEnvProvider | null | undefined,
  args: { taskId: string | undefined; runnerId: string | null; mode?: TerminalMode }
): Promise<RemoteMcpEnv | null> {
  if (args.runnerId == null || !provider) return null
  try {
    const resolved = await provider({
      taskId: args.taskId,
      runnerId: args.runnerId,
      mode: args.mode
    })
    if (!resolved) return null
    // Enforce the provider contract defensively: a blank base URL would inject
    // SLAYZONE_HUB_URL='' + a relative hook URL (both broken on the runner), so
    // treat it as "no valid remote target" rather than emit a poisoned env.
    if (resolved.hubBaseUrl.trim() === '') return null
    return resolved
  } catch {
    return null
  }
}

/**
 * Build MCP env vars for AI agent subprocesses (PTY shells + chat-mode SDK spawns).
 * Both transports must inject the same set so `slay` CLI and MCP tools resolve the
 * current task identically. Keep PTY + chat in sync by routing through this helper.
 *
 * When `mode` is supplied AND the agent supports hook lifecycle events
 * (claude-code initially; see HOOK_SUPPORTED_AGENT_IDS), also injects:
 *   SLAYZONE_AGENT_HOOK_URL  - URL for POST /api/agent-hook. LOCAL only: the
 *                              loopback URL. On a REMOTE runner it is NOT set
 *                              here — the runner overlays its OWN loopback URL at
 *                              spawn (see runner handlers/pty.ts) and relays to
 *                              the hub over its ws channel, so the agent env is
 *                              byte-identical local vs remote.
 *   SLAYZONE_AGENT_ID        - the mode itself (passed back in the hook envelope)
 *   SLAYZONE_ROOT            - resolved on-disk anchor; the `slay` CLI inside the
 *                              agent derives `<ROOT>/storage` (same DB the app uses)
 *   SLAYZONE_HOOK_CONTEXT    - an OPAQUE JSON blob carrying every identity field
 *                              the server needs to attribute a hook (taskId,
 *                              slaySessionId, projectId, agentId, channel). The
 *                              benign `notify.sh` forwards it VERBATIM without
 *                              naming any field — so adding a new identity field
 *                              later touches only this function + the server,
 *                              never the shared shell script (the file that rots
 *                              when an older channel clobbers it).
 *
 * `remote` (a task's pty routed to a runner) only suppresses the loopback hook
 * URL (the runner supplies it). It injects NO hub URL and NO bearer: the hook
 * posts to runner loopback, and the `slay` CLI reaches the hub via its own
 * `hub.json` (see apps/cli/hub-config.ts). With no `remote` (the default)
 * nothing about the local env changes.
 *
 * No port env var is injected here: the `slay` CLI resolves the local server port
 * from the sidecar's own `SLAYZONE_HUB_PORT` (inherited via the pty's env) and
 * falls back to `settings.server_port` in the DB (written by the server at boot).
 */
export async function buildMcpEnv(
  db: SlayzoneDb | null | undefined,
  taskId: string | undefined,
  mode?: TerminalMode,
  /** Runtime session id for a pre-warmed POOLED agent (plans/agent-sessions.md
   *  slice 4/B). Such an agent has NO task at launch, so `SLAYZONE_TASK_ID` is
   *  absent; the `slay` CLI + the conversation hook fall back to this id to
   *  resolve the task once the pool binds the session. Harmless to set for a
   *  normal agent too (the task env wins), but only pooled spawns pass it. */
  sessionId?: string,
  /** Explicit project id — set when the caller already knows it without a task
   *  (the warm pool spawns per-project, before any task exists). Takes priority
   *  over the task-derived lookup so `SLAYZONE_PROJECT_ID` is always present,
   *  regardless of whether a task is bound yet. */
  projectId?: string,
  /** Resolved remote hub target when this session runs on a runner.
   *  Absent/`null` => local loopback env (byte-identical to before the seam). */
  remote?: RemoteMcpEnv | null
): Promise<Record<string, string>> {
  const env: Record<string, string> = {}
  if (taskId) env.SLAYZONE_TASK_ID = taskId
  const resolvedProjectId =
    projectId ??
    (taskId
      ? (
          await db?.get<{ project_id?: string }>('SELECT project_id FROM tasks WHERE id = ?', [
            taskId
          ])
        )?.project_id
      : undefined)
  if (resolvedProjectId) env.SLAYZONE_PROJECT_ID = resolvedProjectId
  if (sessionId) env.SLAYZONE_SESSION_ID = sessionId

  const hookCapable = Boolean(mode && HOOK_SUPPORTED_AGENT_IDS.has(mode as AgentId))

  // The opaque identity blob the benign notify.sh forwards verbatim. Built ONLY
  // for hook-capable spawns (it rides the hook env). Carries every field the
  // server needs to resolve/attribute a hook — the per-field list lives HERE, in
  // TypeScript, never in the shared shell script (which is what rotted). `v` is
  // the envelope version; `channel` is attribution-only (which SlayZone channel
  // fired the hook), so a future cross-channel clobber is visible in Diagnostics.
  function setHookIdentity(): void {
    env.SLAYZONE_AGENT_ID = mode as string
    env.SLAYZONE_ROOT = getSlayzoneHomeDir()
    const ctx: Record<string, unknown> = { v: 1, agentId: mode, channel: getSlayzoneChannel() }
    if (taskId) ctx.taskId = taskId
    if (sessionId) ctx.slaySessionId = sessionId
    if (resolvedProjectId) ctx.projectId = resolvedProjectId
    env.SLAYZONE_HOOK_CONTEXT = JSON.stringify(ctx)
  }

  if (remote) {
    // Remote runner: the agent posts to the RUNNER's own loopback /api/agent-hook
    // (the runner overlays SLAYZONE_AGENT_HOOK_URL at spawn and relays to the hub
    // over its ws channel). So we set NO hub URL, NO bearer, and NO hook URL here
    // — the identity env is byte-identical to a local spawn. `remote.hubBaseUrl`
    // is used only by the `slay` CLI's own hub.json path, not the hook.
    if (hookCapable) setHookIdentity()
    return env
  }

  // Local (hub-local — today's only path): loopback. The port is used ONLY to
  // build the agent-hook URL below. No port var is injected — the CLI resolves
  // the server port itself (inherited SLAYZONE_HUB_PORT, else settings.server_port).
  const serverPort = (globalThis as Record<string, unknown>).__serverPort as number | undefined

  if (serverPort && hookCapable) {
    env.SLAYZONE_AGENT_HOOK_URL = `http://127.0.0.1:${serverPort}${AGENT_HOOK_PATH}`
    setHookIdentity()
  }

  return env
}
