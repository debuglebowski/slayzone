import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import express, { type Express } from 'express'
import type { Server } from 'node:http'
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
 * sessions) + the `/api/*` REST routes, WITHOUT binding a port. Host decides:
 * the Electron main listens on its own port via `startMcpServer` below; the
 * standalone server muxes this app onto its existing HTTP server.
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

// ---------------------------------------------------------------------------
// Standalone-listener lifecycle (Electron-main host path). Module-singleton,
// matching the pre-move behavior 1:1: preferred-port lookup, EADDRINUSE
// fallback to a dynamic port, `settings.mcp_server_port` discovery write,
// `globalThis.__mcpPort` for in-process consumers.
// ---------------------------------------------------------------------------

let httpServer: Server | null = null
let appHandle: McpRestAppHandle | null = null

export function stopMcpServer(): void {
  if (appHandle) {
    appHandle.dispose()
    appHandle = null
  }
  if (httpServer) {
    httpServer.close()
    httpServer = null
  }
}

async function getPreferredPort(db: RestApiDeps['db']): Promise<number> {
  try {
    const row = (await db
      .prepare("SELECT value FROM settings WHERE key = 'mcp_preferred_port' LIMIT 1")
      .get()) as { value: string } | undefined
    const port = parseInt(row?.value ?? '', 10)
    return port >= 1024 && port <= 65535 ? port : 0
  } catch {
    return 0
  }
}

export async function startMcpServer(
  deps: RestApiDeps,
  opts: { writePort?: boolean } = {}
): Promise<{ port: number }> {
  // writePort=false: bind + serve, but DON'T claim `settings.mcp_server_port`.
  // The slice-9 host keeps a REST server only as a reverse-proxy target; the
  // side-car owns the discoverable port (CLI/agents/external MCP hit it).
  const writePort = opts.writePort ?? true
  const port = await getPreferredPort(deps.db)

  stopMcpServer()
  const handle = createMcpRestApp(deps)
  appHandle = handle

  return await new Promise<{ port: number }>((resolve) => {
    const onListening = async (): Promise<void> => {
      const addr = httpServer!.address()
      const actualPort = typeof addr === 'object' && addr ? addr.port : port
      // Only the CANONICAL server claims the discovery globals/settings. The
      // slice-9 host runs writePort:false purely as a reverse-proxy target, so it
      // must NOT set `__mcpPort` — agents + tests resolve the SIDE-CAR port (the
      // host sets its `__mcpPort` to the side-car port via the supervisor onReady).
      if (writePort) {
        ;(globalThis as Record<string, unknown>).__mcpPort = actualPort
        try {
          await deps.db
            .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('mcp_server_port', ?)")
            .run(String(actualPort))
        } catch {
          /* non-fatal — CLI falls back to default port */
        }
      }
      console.log(`[MCP] Server listening on http://127.0.0.1:${actualPort}/mcp`)
      resolve({ port: actualPort })
    }

    httpServer = handle.app.listen(port, '127.0.0.1')
    httpServer.on('listening', () => void onListening())
    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && port !== 0) {
        console.warn(`[MCP] Port ${port} in use, falling back to dynamic port`)
        httpServer = handle.app.listen(0, '127.0.0.1')
        httpServer.on('listening', () => void onListening())
        httpServer.on('error', (err2) => console.error(`[MCP] Server error:`, err2))
      } else {
        console.error(`[MCP] Server error:`, err)
      }
    })
  })
}
