import type { SlayzoneDb } from '@slayzone/platform'
import { getSlayzoneHomeDir } from '@slayzone/platform'
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
   * trailing slash. The `slay` CLI + agent hooks inside the remote pty dial THIS
   * instead of loopback (loopback resolves on the runner machine, where no hub
   * runs). The provider MUST return `null` rather than an empty/invalid base.
   */
  hubBaseUrl: string
  /**
   * A short-lived bearer scoped to `{ taskId, runnerId }`, or `null` when the
   * minter is unavailable. Injected as `SLAYZONE_HUB_TOKEN`; the CLI's
   * `resolveHubTarget` already reads it and sends `Authorization: Bearer`.
   */
  token: string | null
}

/**
 * Resolves the remote hub target (base URL + a freshly-minted per-task token)
 * for a session that spawns on a runner. Injected by the
 * composition root; UNSET by default (so `resolveRemoteMcpEnv` short-circuits to
 * `null` and every spawn keeps today's loopback env). Kept a plain function so
 * `buildMcpEnv` itself stays a pure function of its inputs — the impurity (mint
 * a token, read the hub URL) lives behind this seam.
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
 *   SLAYZONE_AGENT_HOOK_URL  - URL for POST /api/agent-hook (loopback locally,
 *                              the hub's endpoint for a remote runner)
 *   SLAYZONE_AGENT_ID        - the mode itself (passed back in hook payload)
 *   SLAYZONE_ROOT            - resolved on-disk anchor; the `slay` CLI inside the
 *                              agent derives `<ROOT>/storage` (same DB the app uses)
 *
 * When `remote` is supplied (a task's pty routed to a runner), the loopback
 * hook URL is REPLACED by a hub-hosted one and `SLAYZONE_HUB_URL` (+ an optional
 * `SLAYZONE_HUB_TOKEN`) is added so the CLI dials the hub. With no `remote`
 * (the default) nothing about the local env changes.
 *
 * No port env var is injected here: the `slay` CLI resolves the local server port
 * from the sidecar's own `SLAYZONE_SERVER_PORT` (inherited via the pty's env) and
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

  if (remote) {
    // Remote runner: loopback is meaningless on the runner machine. Point the
    // CLI + hooks at the hub: the CLI resolves the hub via `SLAYZONE_HUB_URL` and
    // the hook uses the absolute `SLAYZONE_AGENT_HOOK_URL` below.
    env.SLAYZONE_HUB_URL = remote.hubBaseUrl
    if (remote.token) env.SLAYZONE_HUB_TOKEN = remote.token
    if (hookCapable) {
      env.SLAYZONE_AGENT_HOOK_URL = `${remote.hubBaseUrl}${AGENT_HOOK_PATH}`
      env.SLAYZONE_AGENT_ID = mode as string
      env.SLAYZONE_ROOT = getSlayzoneHomeDir()
    }
    return env
  }

  // Local (hub-local — today's only path): loopback. The port is used ONLY to
  // build the agent-hook URL below. No port var is injected — the CLI resolves
  // the server port itself (inherited SLAYZONE_SERVER_PORT, else settings.server_port).
  const serverPort = (globalThis as Record<string, unknown>).__serverPort as number | undefined

  if (serverPort && hookCapable) {
    env.SLAYZONE_AGENT_HOOK_URL = `http://127.0.0.1:${serverPort}${AGENT_HOOK_PATH}`
    env.SLAYZONE_AGENT_ID = mode as string
    env.SLAYZONE_ROOT = getSlayzoneHomeDir()
  }

  return env
}
