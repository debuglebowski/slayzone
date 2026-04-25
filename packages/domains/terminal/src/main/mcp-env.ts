import type { Database } from 'better-sqlite3'

/**
 * Build MCP env vars for AI agent subprocesses (PTY shells + chat-mode SDK spawns).
 * Both transports must inject the same set so `slay` CLI and MCP tools resolve the
 * current task identically. Keep PTY + chat in sync by routing through this helper.
 */
export function buildMcpEnv(db: Database | null | undefined, taskId: string | undefined): Record<string, string> {
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
  return env
}
