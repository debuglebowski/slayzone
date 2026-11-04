import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createTaskOp } from '@slayzone/task/server'
import { z } from 'zod'
import { CreateTaskInputSchema } from '@slayzone/task-contracts'
import { resolveAgentIdAlias } from '../agent-id-alias'
import { NOOP_TASK_BUS } from '../rest-api/types'
import type { McpToolsDeps } from './types'

export function registerCreateTaskTool(server: McpServer, deps: McpToolsDeps): void {
  server.tool(
    'create_task',
    'Create a task in a project. Requires projectId + title. Optional: description, status, priority, dueDate, assignee, agentId, parentId, *Flags, templateId, isTemporary, repoName, externalId, externalProvider. Returns the created task.',
    {
      ...CreateTaskInputSchema.shape,
      terminalMode: z
        .string()
        .min(1)
        .optional()
        .describe('Deprecated old name of agentId; prefer agentId')
    },
    async (rawInput) => {
      const body: Record<string, unknown> = { ...rawInput }
      const alias = resolveAgentIdAlias(body)
      if (!alias.ok) {
        return { content: [{ type: 'text' as const, text: alias.error }], isError: true }
      }
      try {
        const input = CreateTaskInputSchema.parse(body)
        const task = await createTaskOp(deps.db, input, {
          ipcMain: deps.taskBus ?? NOOP_TASK_BUS,
          onMutation: deps.notifyRenderer
        })
        if (!task) {
          return {
            content: [{ type: 'text' as const, text: 'Failed to create task' }],
            isError: true
          }
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(task) }] }
      } catch (err) {
        return { content: [{ type: 'text' as const, text: (err as Error).message }], isError: true }
      }
    }
  )
}
