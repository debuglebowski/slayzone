import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import express from 'express'
import type { Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { notifyRenderer } from './notify-renderer'
import { registerRestApi } from './rest-api'
import { registerMcpTools } from './mcp-tools'

let httpServer: Server | null = null
let idleTimer: NodeJS.Timeout | null = null
const SESSION_IDLE_TIMEOUT = 30 * 60 * 1000 // 30 min
const IDLE_CHECK_INTERVAL = 5 * 60 * 1000 // 5 min

function createMcpServer(db: Database): McpServer {
  const server = new McpServer({
    name: 'slayzone',
    version: '1.0.0'
  })

  registerMcpTools(server, { db, notifyRenderer })
  return server
}

export function stopMcpServer(): void {
  if (idleTimer) { clearInterval(idleTimer); idleTimer = null }
  if (httpServer) { httpServer.close(); httpServer = null }
}

function getPreferredPort(db: Database): number {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'mcp_preferred_port' LIMIT 1").get() as { value: string } | undefined
    const port = parseInt(row?.value ?? '', 10)
    return (port >= 1024 && port <= 65535) ? port : 0
  } catch { return 0 }
}

export function startMcpServer(db: Database, opts?: { automationEngine?: { executeManual(id: string): Promise<unknown> } }): void {
  const port = getPreferredPort(db)
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
  idleTimer = setInterval(() => {
    const now = Date.now()
    for (const [sid, lastActive] of sessionActivity) {
      if (now - lastActive > SESSION_IDLE_TIMEOUT) {
        try { transports.get(sid)?.close() } catch { /* already closed */ }
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
        const mcpServer = createMcpServer(db)
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

      res.status(400).json({ error: 'Invalid request — missing session or not an initialize request' })
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

  // REST API for CLI
  registerRestApi(app, {
    db,
    notifyRenderer,
    automationEngine: opts?.automationEngine,
  })

  stopMcpServer()

  function onListening(): void {
    const addr = httpServer!.address()
    const actualPort = typeof addr === 'object' && addr ? addr.port : port
    ;(globalThis as Record<string, unknown>).__mcpPort = actualPort
    try {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('mcp_server_port', ?)").run(String(actualPort))
    } catch { /* non-fatal — CLI falls back to default port */ }
    console.log(`[MCP] Server listening on http://127.0.0.1:${actualPort}/mcp`)
  }

  httpServer = app.listen(port, '127.0.0.1')
  httpServer.on('listening', onListening)
  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && port !== 0) {
      console.warn(`[MCP] Port ${port} in use, falling back to dynamic port`)
      httpServer = app.listen(0, '127.0.0.1')
      httpServer.on('listening', onListening)
      httpServer.on('error', (err2) => console.error(`[MCP] Server error:`, err2))
    } else {
      console.error(`[MCP] Server error:`, err)
    }
  })
}
