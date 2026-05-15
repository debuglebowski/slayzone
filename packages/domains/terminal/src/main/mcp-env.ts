import type { Database } from 'better-sqlite3'
import { getSlayzoneHomeDir } from '@slayzone/platform'
import { HOOK_SUPPORTED_AGENT_IDS, type AgentId, type TerminalMode } from '../shared'

/**
 * Build MCP env vars for AI agent subprocesses (PTY shells + chat-mode SDK spawns).
 * Both transports must inject the same set so `slay` CLI and MCP tools resolve the
 * current task identically. Keep PTY + chat in sync by routing through this helper.
 *
 * When `mode` is supplied AND the agent supports hook lifecycle events
 * (claude-code initially; see HOOK_SUPPORTED_AGENT_IDS), also injects:
 *   SLAYZONE_AGENT_HOOK_URL  - loopback URL for POST /api/agent-hook
 *   SLAYZONE_AGENT_ID        - the mode itself (passed back in hook payload)
 *   SLAYZONE_HOME_DIR        - resolved ~/.slayzone (script lookup base)
 */
export function buildMcpEnv(
  db: Database | null | undefined,
  taskId: string | undefined,
  mode?: TerminalMode,
): Record<string, string> {
  const env: Record<string, string> = {}
  if (taskId) {
    env.SLAYZONE_TASK_ID = taskId
    const row = db?.prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId) as
      | { project_id?: string }
      | undefined
    if (row?.project_id) env.SLAYZONE_PROJECT_ID = row.project_id
  }
  const mcpPort = (globalThis as Record<string, unknown>).__mcpPort as number | undefined
  if (mcpPort) env.SLAYZONE_MCP_PORT = String(mcpPort)

  if (mcpPort && mode && HOOK_SUPPORTED_AGENT_IDS.has(mode as AgentId)) {
    env.SLAYZONE_AGENT_HOOK_URL = `http://127.0.0.1:${mcpPort}/api/agent-hook`
    env.SLAYZONE_AGENT_ID = mode
    env.SLAYZONE_HOME_DIR = getSlayzoneHomeDir()
  }

  return env
}
