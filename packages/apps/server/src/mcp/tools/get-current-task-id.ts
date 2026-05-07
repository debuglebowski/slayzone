import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { resolveCurrentTaskId } from './shared'
import type { McpToolsDeps } from './types'

export function registerGetCurrentTaskIdTool(server: McpServer, deps: McpToolsDeps): void {
  server.tool(
    'get_current_task_id',
    'Preferred first step before other task tools. Returns the current task ID. Pass task_id explicitly (recommended from local $SLAYZONE_TASK_ID env var in task terminals).',
    {
      task_id: z.string().optional().describe('Optional explicit task ID (recommended: pass $SLAYZONE_TASK_ID)'),
    },
    async ({ task_id }) => {
      const resolvedTaskId = resolveCurrentTaskId(task_id)
      if (!resolvedTaskId) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No current task ID available. Pass task_id (recommended from $SLAYZONE_TASK_ID).'
          }],
          isError: true
        }
      }

      const exists = deps.db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(resolvedTaskId) as { 1: number } | undefined
      if (!exists) {
        return {
          content: [{
            type: 'text' as const,
            text: `Task ${resolvedTaskId} not found`
          }],
          isError: true
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ task_id: resolvedTaskId }, null, 2)
        }]
      }
    }
  )
}
