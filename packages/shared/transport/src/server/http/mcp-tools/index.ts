import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpToolsDeps } from './types'
import { registerGetCurrentTaskIdTool } from './get-current-task-id'
import { registerUpdateTaskTool } from './update-task'
import { registerCreateSubtaskTool } from './create-subtask'
import { registerArchiveTaskTool } from './archive-task'
import { registerArchiveManyTaskTool } from './archive-many-task'
import { registerCreateTaskTool } from './create-task'
import { registerDeleteTaskTool } from './delete-task'
import { registerUnarchiveTaskTool } from './unarchive-task'

export type { McpToolsDeps } from './types'

export function registerMcpTools(server: McpServer, deps: McpToolsDeps): void {
  registerGetCurrentTaskIdTool(server, deps)
  registerUpdateTaskTool(server, deps)
  registerCreateSubtaskTool(server, deps)
  registerCreateTaskTool(server, deps)
  registerArchiveTaskTool(server, deps)
  registerArchiveManyTaskTool(server, deps)
  registerDeleteTaskTool(server, deps)
  registerUnarchiveTaskTool(server, deps)
}
