import express, { type Express } from 'express'
import { tmpdir } from 'node:os'
import { mkdirSync } from 'node:fs'
import type { Database } from 'better-sqlite3'
import type { EventEmitter } from 'node:events'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { randomUUID } from 'node:crypto'
import type { TrpcServerDeps } from '@slayzone/transport/server'

import { gcMigrationsTmp } from '@slayzone/migrate/server'
import { acquireLock, type AcquiredLock } from './lockfile'
import { startMultiplex, type MultiplexHandle } from './multiplex'
import { probeAgents, type AgentProbeResult } from './agents-check'
import { formatBanner } from './banner'
import { openServerDatabase } from './db'
import { getServerVersion } from './version'
import type { ServerConfig } from './config'

export interface RestRegistrar {
  (app: Express, deps: ServerCoreDeps): void
}

export interface ServerCoreDeps {
  db: Database
  notifyRenderer: () => void
  automationEngine?: { executeManual(id: string): Promise<unknown> }
  dataRoot: string
  tempDir: string
  menuEvents: EventEmitter
  focusMainWindow?: () => void
}

export interface McpToolsRegistrar {
  (server: McpServer, deps: { db: Database; notifyRenderer: () => void }): void
}

export interface StartServerOpts {
  config: ServerConfig
  /** When true, skip lockfile/banner/agents/signals — embedded in Electron host. */
  embedded?: boolean
  /** Pre-opened DB. If absent, server pkg opens its own at config.dataRoot. */
  db?: Database
  /** EventEmitter that fires 'tasks-changed' / 'settings-changed'. */
  notifyRenderer?: () => void
  /** Automation engine instance. */
  automationEngine?: { executeManual(id: string): Promise<unknown> }
  /** menuEvents bus. Caller passes app's existing emitter, or server creates a stub. */
  menuEvents?: EventEmitter
  /** Optional focus callback (Electron embedded only). */
  focusMainWindow?: () => void
  /** Register pure REST routes (notify, processes, pty, tabs, automations, tasks/*, artifacts/*). */
  registerCoreRest?: RestRegistrar
  /** Register Electron-only REST routes (browser/*, artifacts/export-*) — supplied by Electron host. */
  registerExtraRest?: RestRegistrar
  /** Register MCP tools. */
  registerMcpTools?: McpToolsRegistrar
  /** trpc server deps (db, dataRoot, automationEngine). Required if any client will hit /trpc. */
  trpcDeps?: TrpcServerDeps
}

export interface ServerHandle {
  port: number
  mcpPort: number | null
  dataRoot: string
  agents: AgentProbeResult[] | null
  stop(): Promise<void>
}

const SESSION_IDLE_TIMEOUT = 30 * 60 * 1000
const IDLE_CHECK_INTERVAL = 5 * 60 * 1000

class StubEventEmitter {
  emit(): boolean { return false }
  on(): this { return this }
  off(): this { return this }
}

function buildMcp(
  app: Express,
  db: Database,
  notifyRenderer: () => void,
  registerTools: McpToolsRegistrar | undefined,
): () => void {
  const transports = new Map<string, StreamableHTTPServerTransport>()
  const sessionActivity = new Map<string, number>()

  const idleTimer = setInterval(() => {
    const now = Date.now()
    for (const [sid, last] of sessionActivity) {
      if (now - last > SESSION_IDLE_TIMEOUT) {
        try { transports.get(sid)?.close() } catch { /* ignore */ }
        transports.delete(sid)
        sessionActivity.delete(sid)
      }
    }
  }, IDLE_CHECK_INTERVAL)
  idleTimer.unref()

  const touch = (sid: string): void => { sessionActivity.set(sid, Date.now()) }
  const remove = (sid: string): void => { transports.delete(sid); sessionActivity.delete(sid) }

  const makeServer = (): McpServer => {
    const server = new McpServer({ name: 'slayzone', version: getServerVersion() })
    registerTools?.(server, { db, notifyRenderer })
    return server
  }

  app.post('/mcp', async (req, res) => {
    try {
      const sid = req.headers['mcp-session-id'] as string | undefined
      if (sid && transports.has(sid)) {
        touch(sid)
        await transports.get(sid)!.handleRequest(req, res, req.body)
        return
      }
      if (!sid && isInitializeRequest(req.body)) {
        const server = makeServer()
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => { transports.set(id, transport); touch(id) },
        })
        transport.onclose = () => {
          const found = [...transports.entries()].find(([, t]) => t === transport)?.[0]
          if (found) remove(found)
        }
        await server.connect(transport)
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
      const sid = req.headers['mcp-session-id'] as string | undefined
      if (sid && transports.has(sid)) {
        touch(sid)
        await transports.get(sid)!.handleRequest(req, res)
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
      const sid = req.headers['mcp-session-id'] as string | undefined
      if (sid && transports.has(sid)) {
        await transports.get(sid)!.handleRequest(req, res)
        remove(sid)
        return
      }
      res.status(400).json({ error: 'Invalid session' })
    } catch (err) {
      console.error('[MCP] DELETE error:', err)
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' })
    }
  })

  return () => clearInterval(idleTimer)
}

export async function startServer(opts: StartServerOpts): Promise<ServerHandle> {
  const { config, embedded = false } = opts
  const version = getServerVersion()

  // 1. Open DB if not provided.
  const ownsDb = opts.db == null
  if (!embedded) mkdirSync(config.dataRoot, { recursive: true })
  const db = opts.db ?? openServerDatabase({ dataRoot: config.dataRoot })

  // 2. Acquire lockfile (skip in embedded — Electron's single-instance lock covers it).
  let lock: AcquiredLock | null = null
  if (!embedded) {
    lock = acquireLock({
      dataRoot: config.dataRoot,
      info: { host: config.host, port: 0, mcpPort: config.mcpPort, version },
      force: config.lockForce,
    })
  }

  // 3. Probe agents (skip if embedded or noAgentCheck).
  const agents = !embedded && !config.noAgentCheck ? probeAgents() : null

  // 4. Build Express app.
  const expressApp = express()
  expressApp.use(express.json({ limit: '50mb' }))

  expressApp.get('/health', (_req, res) => {
    res.json({ ok: true, version, dataRoot: config.dataRoot, uptimeMs: process.uptime() * 1000 })
  })

  const notifyRenderer = opts.notifyRenderer ?? (() => { /* no listener */ })
  const menuEvents = opts.menuEvents ?? (new StubEventEmitter() as unknown as EventEmitter)

  const coreDeps: ServerCoreDeps = {
    db,
    notifyRenderer,
    automationEngine: opts.automationEngine,
    dataRoot: config.dataRoot,
    tempDir: tmpdir(),
    menuEvents,
    focusMainWindow: opts.focusMainWindow,
  }

  // 5. Register REST routes (core + extra).
  opts.registerCoreRest?.(expressApp, coreDeps)
  opts.registerExtraRest?.(expressApp, coreDeps)

  // 6. Mount MCP at /mcp.
  const stopMcp = buildMcp(expressApp, db, notifyRenderer, opts.registerMcpTools)

  // 6b. Boot-time GC of stale migrations-tmp/ uploads.
  try { gcMigrationsTmp(config.dataRoot) } catch { /* best-effort */ }

  // 7. Start multiplex (one http.Server hosting Express + WSS at /trpc).
  const trpcDeps: TrpcServerDeps = opts.trpcDeps ?? {
    db,
    dataRoot: config.dataRoot,
    slayzoneVersion: version,
    automationEngine: opts.automationEngine,
  }
  const splitMcp = config.mcpPort != null && config.mcpPort !== config.port
  const primary = startMultiplex({
    expressApp,
    trpcDeps,
    host: config.host,
    port: config.port,
  })
  await primary.ready

  // 8. Optional split-mode: separate MCP-only server.
  let secondary: MultiplexHandle | null = null
  if (splitMcp && config.mcpPort != null) {
    const mcpApp = express()
    mcpApp.use(express.json({ limit: '50mb' }))
    const stopMcpSecondary = buildMcp(mcpApp, db, notifyRenderer, opts.registerMcpTools)
    secondary = startMultiplex({
      expressApp: mcpApp,
      trpcDeps,
      host: config.host,
      port: config.mcpPort,
    })
    await secondary.ready
    // Stop the MCP timer on the primary if we're splitting (still need it on secondary).
    void stopMcpSecondary
  }

  const finalPort = primary.port
  const finalMcpPort = secondary ? secondary.port : finalPort

  // 9. Persist port to settings (single new key per user choice).
  try {
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('slayzone_server_port', ?)",
    ).run(String(finalPort))
    if (splitMcp) {
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('slayzone_mcp_port', ?)",
      ).run(String(finalMcpPort))
    } else {
      db.prepare("DELETE FROM settings WHERE key = 'slayzone_mcp_port'").run()
    }
  } catch {
    /* settings table may not exist on fresh DB w/o migrations — non-fatal */
  }
  ;(globalThis as Record<string, unknown>).__slayzonePort = finalPort
  ;(globalThis as Record<string, unknown>).__slayzoneMcpPort = finalMcpPort

  // 10. Print banner (skip embedded).
  if (!embedded) {
    const banner = formatBanner({
      version,
      host: config.host,
      port: finalPort,
      mcpPort: splitMcp ? finalMcpPort : null,
      dataRoot: config.dataRoot,
      lockPath: lock?.path ?? null,
      pid: process.pid,
      agents,
    })
    console.log(banner)
  }

  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    stopMcp()
    await primary.close()
    if (secondary) await secondary.close()
    if (ownsDb) {
      try { db.close() } catch { /* ignore */ }
    }
    lock?.release()
  }

  return {
    port: finalPort,
    mcpPort: splitMcp ? finalMcpPort : null,
    dataRoot: config.dataRoot,
    agents,
    stop,
  }
}
