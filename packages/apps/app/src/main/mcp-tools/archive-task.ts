import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ipcMain } from 'electron'
import { archiveTaskOp } from '@slayzone/task/main'
import { ArchiveTaskInput } from '@slayzone/task/shared'
import type { McpToolsDeps } from './types'

export function registerArchiveTaskTool(server: McpServer, deps: McpToolsDeps): void {
  server.tool(
    'archive_task',
    'Archive a task (hides from kanban, preserves in DB). Accepts a task id. In task terminals, source from $SLAYZONE_TASK_ID.',
    ArchiveTaskInput.shape,
    async ({ id }) => {
      let archived
      try {
        archived = await archiveTaskOp(deps.db, id, {
          ipcMain,
          onMutation: deps.notifyRenderer
        })
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: (err as Error).message }],
          isError: true
        }
      }
      if (!archived) {
        return {
          content: [{ type: 'text' as const, text: `Task ${id} not found` }],
          isError: true
        }
      }
      deps.notifyRenderer()
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(archived, null, 2)
        }]
      }
    }
  )
}
