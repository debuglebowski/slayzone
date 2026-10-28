import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import express, { type Express, type Request, type Response } from 'express'
import { randomUUID } from 'node:crypto'
import { peerAddress, routeOf, securityEvent } from '@slayzone/platform/security-log'
import { getAuthGate } from '@slayzone/trpc-server'
import { jsonBodyParser } from './json-body'
import { AGENT_HOOK_BODY_LIMIT, AGENT_HOOK_PATH } from './rest-api/agent-hook'
import { registerRestApi } from './rest-api'
import type { RestApiDeps } from './rest-api/types'
import { registerMcpTools } from './mcp-tools'
import { mcpAuthInfo } from './mcp-tools/admin-gate'
import { restPrincipalOf } from './rest-api/principal'

const SESSION_IDLE_TIMEOUT = 30 * 60 * 1000 // 30 min
const IDLE_CHECK_INTERVAL = 5 * 60 * 1000 // 5 min

/** The stable code of a refused or unknown MCP session on a hub with login (T-105). */
export const MCP_SESSION_NOT_FOUND = 'MCP_SESSION_NOT_FOUND'

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
  // One app-wide JSON parser, so its limit must be the route's: a body parsed (or
  // refused) here never reaches a route-level parser. Default 100 KB; the agent-hook
  // route takes up to its own larger limit.
  const defaultJson = jsonBodyParser()
  const agentHookJson = jsonBodyParser({ limit: AGENT_HOOK_BODY_LIMIT })
  app.use((req, res, next) =>
    (req.path === AGENT_HOOK_PATH ? agentHookJson : defaultJson)(req, res, next)
  )

  const transports = new Map<string, StreamableHTTPServerTransport>()
  const sessionActivity = new Map<string, number>()
  /** Who opened each session: the verified principal's user id, null without login. */
  const sessionOwners = new Map<string, string | null>()

  function touchSession(sid: string): void {
    sessionActivity.set(sid, Date.now())
  }

  function removeSession(sid: string): void {
    transports.delete(sid)
    sessionActivity.delete(sid)
    sessionOwners.delete(sid)
  }

  /**
   * The live session `req` names, if the caller may use it (T-105). On a hub with
   * login a session belongs to the account that opened it: the session id is a
   * handle, not a credential, and another account presenting it — to call tools on
   * it, read its event stream or close it — is refused exactly like an unknown id
   * (404 + {@link MCP_SESSION_NOT_FOUND}, which also tells an MCP client to start a
   * new session), with one `authz.denied` line. Without login (the desktop app's
   * hub) any live session id works, as before; an unknown one is the caller's 400.
   */
  function usableSession(
    req: Request,
    res: Response
  ): StreamableHTTPServerTransport | 'refused' | null {
    const sid = req.headers['mcp-session-id'] as string | undefined
    const transport = sid ? transports.get(sid) : undefined
    if (!getAuthGate()) return transport ?? null
    if (!sid) return null
    const caller = restPrincipalOf(req)?.userId ?? null
    if (transport && caller !== null && sessionOwners.get(sid) === caller) return transport
    if (transport) {
      securityEvent({
        event: 'authz.denied',
        outcome: 'denied',
        actor: caller,
        ip: peerAddress(req),
        route: routeOf(req.method, req.originalUrl ?? req.url),
        targetKind: 'procedure',
        targetId: 'mcp',
        detail: { reason: 'not_owner', resource: 'mcp_session', status: 404 }
      })
    }
    res.status(404).json({ error: 'Session not found', code: MCP_SESSION_NOT_FOUND })
    return 'refused'
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
      // The caller the hub's bearer gate verified, for the tool role gate (T-15):
      // the SDK hands `req.auth` to every handler of this request as `authInfo`.
      const principal = restPrincipalOf(req)
      if (principal)
        (req as { auth?: ReturnType<typeof mcpAuthInfo> }).auth = mcpAuthInfo(principal)
      const sessionId = req.headers['mcp-session-id'] as string | undefined

      const live = usableSession(req, res)
      if (live === 'refused') return
      if (sessionId && live) {
        touchSession(sessionId)
        await live.handleRequest(req, res, req.body)
        return
      }

      if (!sessionId && isInitializeRequest(req.body)) {
        const mcpServer = createMcpServer(deps)
        const owner = principal?.userId ?? null
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, transport)
            sessionOwners.set(sid, owner)
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
      const live = usableSession(req, res)
      if (live === 'refused') return
      if (sessionId && live) {
        touchSession(sessionId)
        await live.handleRequest(req, res)
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
      const live = usableSession(req, res)
      if (live === 'refused') return
      if (sessionId && live) {
        await live.handleRequest(req, res)
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
      sessionOwners.clear()
    }
  }
}
