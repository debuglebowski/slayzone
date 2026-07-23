import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import express, { type Express } from 'express'
import { randomUUID } from 'node:crypto'
import { registerRestApi } from './rest-api'
import type { RestApiDeps } from './rest-api/types'
import { registerMcpTools } from './mcp-tools'

const SESSION_IDLE_TIMEOUT = 30 * 60 * 1000 // 30 min
const IDLE_CHECK_INTERVAL = 5 * 60 * 1000 // 5 min

function createMcpServer(deps: RestApiDeps): McpServer {
  const server = new McpServer({
    name: 'slayzone',
    version: '1.0.0'
  })

  registerMcpTools(server, {
    db: deps.db,
    notifyRenderer: deps.notifyRenderer,
    taskBus: deps.taskBus,
    menu: deps.menu,
    legacyBroadcast: deps.legacyBroadcast
  })
  return server
}

export type McpRestAppHandle = {
  app: Express
  /** Clears the session idle-eviction timer + closes live MCP transports. */
  dispose: () => void
}

/**
 * Builds the Express app carrying the `/mcp` endpoint (streamable-HTTP MCP
 * sessions) + the `/api/*` REST routes, WITHOUT binding a port. Callers mux it
 * onto their own HTTP listener: the standalone @slayzone/hub server and the
 * Electron host's bridge server both do this.
 */
export function createMcpRestApp(deps: RestApiDeps): McpRestAppHandle {
  const app = express()
  app.use(express.json())

  const transports = new Map<string, StreamableHTTPServerTransport>()
  const sessionActivity = new Map<string, number>()

  function touchSession(sid: string): void {
    sessionActivity.set(sid, Date.now())
  }

  function removeSession(sid: string): void {
    transports.delete(sid)
    sessionActivity.delete(sid)
  }

  // Evict sessions idle > 30 min
  const idleTimer = setInterval(() => {
    const now = Date.now()
    for (const [sid, lastActive] of sessionActivity) {
      if (now - lastActive > SESSION_IDLE_TIMEOUT) {
        try {
          transports.get(sid)?.close()
        } catch {
          /* already closed */
        }
        removeSession(sid)
      }
    }
  }, IDLE_CHECK_INTERVAL)

  app.post('/mcp', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined

      if (sessionId && transports.has(sessionId)) {
        touchSession(sessionId)
        const transport = transports.get(sessionId)!
        await transport.handleRequest(req, res, req.body)
        return
      }

      if (!sessionId && isInitializeRequest(req.body)) {
        const mcpServer = createMcpServer(deps)
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, transport)
            touchSession(sid)
          }
        })

        transport.onclose = () => {
          const sid = [...transports.entries()].find(([, t]) => t === transport)?.[0]
          if (sid) removeSession(sid)
        }

        await mcpServer.connect(transport)
        await transport.handleRequest(req, res, req.body)
        return
      }

      res
        .status(400)
        .json({ error: 'Invalid request — missing session or not an initialize request' })
    } catch (err) {
      console.error('[MCP] POST error:', err)
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' })
    }
  })

  app.get('/mcp', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined
      if (sessionId && transports.has(sessionId)) {
        touchSession(sessionId)
        const transport = transports.get(sessionId)!
        await transport.handleRequest(req, res)
        return
      }
      res.status(400).json({ error: 'Invalid session' })
    } catch (err) {
      console.error('[MCP] GET error:', err)
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' })
    }
  })

  app.delete('/mcp', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId)!
        await transport.handleRequest(req, res)
        removeSession(sessionId)
        return
      }
      res.status(400).json({ error: 'Invalid session' })
    } catch (err) {
      console.error('[MCP] DELETE error:', err)
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' })
    }
  })

  // REST API for CLI + agent hooks
  registerRestApi(app, deps)

  return {
    app,
    dispose: () => {
      clearInterval(idleTimer)
      for (const t of transports.values()) {
        try {
          t.close()
        } catch {
          /* already closed */
        }
      }
      transports.clear()
      sessionActivity.clear()
    }
  }
}
