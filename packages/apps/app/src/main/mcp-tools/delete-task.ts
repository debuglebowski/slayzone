import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ipcMain } from 'electron'
import { deleteTaskOp } from '@slayzone/task/main'
import { deleteTaskInputSchema } from '@slayzone/task/shared'
import type { McpToolsDeps } from './types'

export function registerDeleteTaskTool(server: McpServer, deps: McpToolsDeps): void {
  server.tool(
    'delete_task',
    "Permanently delete a task (soft-delete via deleted_at). Accepts a task id. In task terminals, source from $SLAYZONE_TASK_ID. Fails if the task is linked to an external provider.",
    deleteTaskInputSchema.shape,
    async ({ id }) => {
      let result
      try {
        result = deleteTaskOp(deps.db, id, {
          ipcMain,
          onMutation: deps.notifyRenderer,
        })
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: (err as Error).message }],
          isError: true,
        }
      }

      if (result === false) {
        return {
          content: [{ type: 'text' as const, text: `Task ${id} not found` }],
          isError: true,
        }
      }

      if (typeof result === 'object' && result.blocked) {
        return {
          content: [{
            type: 'text' as const,
            text: `Task ${id} cannot be deleted: linked to an external provider. Unlink first.`,
          }],
          isError: true,
        }
      }

      deps.notifyRenderer()
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ id, deleted: true }, null, 2),
        }],
      }
    },
  )
}
