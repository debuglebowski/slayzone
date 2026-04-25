import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ipcMain } from 'electron'
import { unarchiveTaskOp } from '@slayzone/task/main'
import { unarchiveInputSchema } from '@slayzone/task/shared'
import type { McpToolsDeps } from './types'

export function registerUnarchiveTaskTool(server: McpServer, deps: McpToolsDeps): void {
  server.tool(
    'unarchive_task',
    'Unarchive a task (restores from archive back to the kanban). Accepts a task id. In task terminals, source from $SLAYZONE_TASK_ID.',
    unarchiveInputSchema.shape,
    async ({ id }) => {
      let unarchived
      try {
        unarchived = await unarchiveTaskOp(deps.db, id, {
          ipcMain,
          onMutation: deps.notifyRenderer
        })
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: (err as Error).message }],
          isError: true
        }
      }
      if (!unarchived) {
        return {
          content: [{ type: 'text' as const, text: `Task ${id} not found` }],
          isError: true
        }
      }
      deps.notifyRenderer()
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(unarchived, null, 2)
        }]
      }
    }
  )
}
