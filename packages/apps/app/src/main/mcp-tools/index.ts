import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpToolsDeps } from './types'
import { registerGetCurrentTaskIdTool } from './get-current-task-id'
import { registerUpdateTaskTool } from './update-task'
import { registerCreateSubtaskTool } from './create-subtask'

export type { McpToolsDeps } from './types'

export function registerMcpTools(server: McpServer, deps: McpToolsDeps): void {
  registerGetCurrentTaskIdTool(server, deps)
  registerUpdateTaskTool(server, deps)
  registerCreateSubtaskTool(server, deps)
}
