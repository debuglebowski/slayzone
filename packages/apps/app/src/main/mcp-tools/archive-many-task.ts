import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ipcMain } from 'electron'
import { archiveManyTasksOp } from '@slayzone/task/main'
import { archiveManyInputSchema } from '@slayzone/task/shared'
import type { McpToolsDeps } from './types'

export function registerArchiveManyTaskTool(server: McpServer, deps: McpToolsDeps): void {
  server.tool(
    'archive_many_task',
    'Archive many tasks at once (hides from kanban, preserves in DB). Accepts an array of task ids. Also archives sub-tasks of any given parents.',
    archiveManyInputSchema.shape,
    async ({ ids }) => {
      try {
        await archiveManyTasksOp(deps.db, ids, {
          ipcMain,
          onMutation: deps.notifyRenderer
        })
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: (err as Error).message }],
          isError: true
        }
      }
      deps.notifyRenderer()
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ archived: ids.length, ids }, null, 2)
        }]
      }
    }
  )
}
