/**
 * Capture MCP tool registrations without spinning up a real McpServer.
 * Stubs the `tool(name, description, schema, handler)` signature; tests can
 * then invoke handlers directly.
 *
 * Usage:
 *   const stub = captureMcpServer()
 *   registerCreateTaskTool(stub.server as never, { db, notifyRenderer })
 *   const res = await stub.invoke('create_task', { projectId, title: 'x' })
 */

type ToolHandler = (input: unknown, extra?: unknown) => unknown | Promise<unknown>

interface CapturedTool {
  name: string
  description: string
  schema: Record<string, unknown>
  handler: ToolHandler
}

export interface CapturedMcpServer {
  server: {
    tool(
      name: string,
      description: string,
      schema: Record<string, unknown>,
      handler: ToolHandler
    ): unknown
  }
  tools: Map<string, CapturedTool>
  invoke(name: string, input?: unknown, extra?: unknown): Promise<unknown>
  has(name: string): boolean
  get(name: string): CapturedTool | undefined
}

export function captureMcpServer(): CapturedMcpServer {
  const tools = new Map<string, CapturedTool>()

  const server = {
    tool(name: string, description: string, schema: Record<string, unknown>, handler: ToolHandler) {
      tools.set(name, { name, description, schema, handler })
      return undefined
    }
  }

  return {
    server,
    tools,
    has(name) { return tools.has(name) },
    get(name) { return tools.get(name) },
    async invoke(name, input, extra) {
      const tool = tools.get(name)
      if (!tool) throw new Error(`No tool registered: ${name}`)
      return await tool.handler(input ?? {}, extra)
    }
  }
}
