import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ipcMain } from 'electron'
import { createTaskOp } from '@slayzone/task/main'
import { CreateTaskInputSchema } from '@slayzone/task/shared'
import type { McpToolsDeps } from './types'

export function registerCreateTaskTool(server: McpServer, deps: McpToolsDeps): void {
  server.tool(
    'create_task',
    "Create a task in a project. Requires projectId + title. Optional: description, status, priority, dueDate, assignee, terminalMode, parentId, *Flags, templateId, isTemporary, repoName. Returns the created task.",
    CreateTaskInputSchema.shape,
    async (input) => {
      try {
        const task = await createTaskOp(deps.db, input, { ipcMain, onMutation: deps.notifyRenderer })
        if (!task) {
          return { content: [{ type: 'text' as const, text: 'Failed to create task' }], isError: true }
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(task) }] }
      } catch (err) {
        return { content: [{ type: 'text' as const, text: (err as Error).message }], isError: true }
      }
    }
  )
}
