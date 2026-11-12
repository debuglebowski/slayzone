import { withMcpMoveLockGate } from '../move-lock-gates'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpToolsDeps } from './types'
import { withMcpAdminGate } from './admin-gate'
import { withMcpOwnerGate } from './owner-gate'
import { registerGetCurrentTaskIdTool } from './get-current-task-id'
import { registerUpdateTaskTool } from './update-task'
import { registerCreateSubtaskTool } from './create-subtask'
import { registerArchiveTaskTool } from './archive-task'
import { registerArchiveManyTaskTool } from './archive-many-task'
import { registerCreateTaskTool } from './create-task'
import { registerDeleteTaskTool } from './delete-task'
import { registerUnarchiveTaskTool } from './unarchive-task'

export type { McpToolsDeps } from './types'

export function registerMcpTools(rawServer: McpServer, deps: McpToolsDeps): void {
  // Every tool below checks the caller's role against `MCP_ADMIN_POLICY` (T-15), then
  // every id it is given against the caller's ownership (T-18, `MCP_OWNER_POLICY`).
  // Then the move lock: a tool writing to a task moving to another hub is refused.
  const server = withMcpMoveLockGate(
    withMcpOwnerGate(withMcpAdminGate(rawServer), deps.db),
    deps.db
  )
  registerGetCurrentTaskIdTool(server, deps)
  registerUpdateTaskTool(server, deps)
  registerCreateSubtaskTool(server, deps)
  registerCreateTaskTool(server, deps)
  registerArchiveTaskTool(server, deps)
  registerArchiveManyTaskTool(server, deps)
  registerDeleteTaskTool(server, deps)
  registerUnarchiveTaskTool(server, deps)
}
