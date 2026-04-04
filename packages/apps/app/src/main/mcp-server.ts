import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import express from 'express'
import type { Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import { z } from 'zod'
import type { Database } from 'better-sqlite3'
import { updateTask } from '@slayzone/task/main'
import type { ProviderConfig } from '@slayzone/task/shared'
import type { ColumnConfig } from '@slayzone/projects/shared'
import { getDefaultStatus, isKnownStatus, parseColumnsConfig } from '@slayzone/projects/shared'
import { listAllProcesses, killProcess, subscribeToProcessLogs } from './process-manager'
import { listPtys, getBuffer, writePty, killPty, hasPty, subscribeToPtyData, onSessionChange } from '@slayzone/terminal/main'
import { getBrowserWebContents, waitForBrowserRegistration } from './browser-registry'
import { app as electronApp } from 'electron'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, readdirSync, unlinkSync, statSync } from 'node:fs'

let httpServer: Server | null = null
let idleTimer: NodeJS.Timeout | null = null
const SESSION_IDLE_TIMEOUT = 30 * 60 * 1000 // 30 min
const IDLE_CHECK_INTERVAL = 5 * 60 * 1000 // 5 min

function notifyRenderer(): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send('tasks:changed')
    win.webContents.send('settings:changed')
  })
}

function createMcpServer(db: Database): McpServer {
  const server = new McpServer({
    name: 'slayzone',
    version: '1.0.0'
  })

  function resolveCurrentTaskId(explicitTaskId?: string): string | null {
    return explicitTaskId ?? process.env.SLAYZONE_TASK_ID ?? null
  }

  function buildDefaultProviderConfig(): ProviderConfig {
    const providerConfig: ProviderConfig = {}
    const allModes = db.prepare('SELECT id, default_flags FROM terminal_modes WHERE enabled = 1').all() as Array<{ id: string; default_flags: string | null }>
    for (const row of allModes) {
      providerConfig[row.id] = { flags: row.default_flags ?? '' }
    }
    return providerConfig
  }

  function getProjectColumns(projectId: string): ColumnConfig[] | null {
    const row = db.prepare('SELECT columns_config FROM projects WHERE id = ?').get(projectId) as
      | { columns_config: string | null }
      | undefined
    return parseColumnsConfig(row?.columns_config)
  }

  function getAllowedStatusesText(columns: ColumnConfig[] | null): string {
    return columns
      ? columns.map((column) => column.id).join(', ')
      : 'inbox, backlog, todo, in_progress, review, done, canceled'
  }

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

      const exists = db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(resolvedTaskId) as { 1: number } | undefined
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

  server.tool(
    'update_task',
    'Update a task\'s details (title, description, status, priority, assignee, due date). Prefer calling get_current_task_id first, then pass that as task_id. In task terminals, you can source task_id from local $SLAYZONE_TASK_ID.',
    {
      task_id: z.string().describe('The task ID to update (read from $SLAYZONE_TASK_ID env var)'),
      title: z.string().optional().describe('New title'),
      description: z.string().nullable().optional().describe('New description (null to clear)'),
      status: z.string().optional().describe('New status'),
      priority: z.number().min(1).max(5).optional().describe('Priority 1-5 (1=highest)'),
      assignee: z.string().nullable().optional().describe('Assignee name (null to clear)'),
      due_date: z.string().nullable().optional().describe('Due date ISO string (null to clear)'),
      close: z.boolean().optional().describe('Close the task tab in the UI')
    },
    async ({ task_id, due_date, close, ...fields }) => {
      if (fields.status !== undefined) {
        const taskRow = db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(task_id) as
          | { project_id: string }
          | undefined
        if (!taskRow) {
          return { content: [{ type: 'text' as const, text: `Task ${task_id} not found` }], isError: true }
        }

        const projectColumns = getProjectColumns(taskRow.project_id)
        if (!isKnownStatus(fields.status, projectColumns)) {
          const allowed = getAllowedStatusesText(projectColumns)
          return {
            content: [{
              type: 'text' as const,
              text: `Unknown status "${fields.status}" for task ${task_id}. Allowed statuses: ${allowed}.`
            }],
            isError: true
          }
        }
      }

      const updated = updateTask(db, { id: task_id, ...fields, dueDate: due_date })
      if (!updated) {
        return { content: [{ type: 'text' as const, text: `Task ${task_id} not found` }], isError: true }
      }
      notifyRenderer()
      if (close) {
        BrowserWindow.getAllWindows().forEach((win) => {
          win.webContents.send('app:close-task', task_id)
        })
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(updated, null, 2)
        }]
      }
    }
  )

  server.tool(
    'create_subtask',
    'Create a subtask under a parent task. Prefer calling get_current_task_id first, then pass that as parent_task_id. In task terminals, you can source parent_task_id from local $SLAYZONE_TASK_ID.',
    {
      parent_task_id: z.string().optional().describe('Parent task ID (recommended: pass $SLAYZONE_TASK_ID)'),
      title: z.string().describe('Subtask title'),
      description: z.string().nullable().optional().describe('Subtask description (null to clear)'),
      status: z.string().optional().describe('Initial status (default: first non-terminal project status)'),
      priority: z.number().min(1).max(5).optional().describe('Priority 1-5 (1=highest, default: 3)'),
      assignee: z.string().nullable().optional().describe('Assignee name (null to clear)'),
      due_date: z.string().nullable().optional().describe('Due date ISO string (null to clear)')
    },
    async ({ parent_task_id, due_date, title, description, status, priority, assignee }) => {
      const resolvedParentId = resolveCurrentTaskId(parent_task_id)
      if (!resolvedParentId) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No parent task ID available. Pass parent_task_id (recommended from $SLAYZONE_TASK_ID).'
          }],
          isError: true
        }
      }

      const parent = db.prepare('SELECT id, project_id, terminal_mode FROM tasks WHERE id = ?').get(resolvedParentId) as
        | { id: string; project_id: string; terminal_mode: string | null }
        | undefined

      if (!parent) {
        return {
          content: [{
            type: 'text' as const,
            text: `Parent task ${resolvedParentId} not found`
          }],
          isError: true
        }
      }

      const id = randomUUID()
      const terminalMode = parent.terminal_mode
        ?? (db.prepare("SELECT value FROM settings WHERE key = 'default_terminal_mode'")
          .get() as { value: string } | undefined)?.value
        ?? 'claude-code'
      const providerConfig = buildDefaultProviderConfig()
      const projectColumns = getProjectColumns(parent.project_id)
      if (status && !isKnownStatus(status, projectColumns)) {
        const allowed = getAllowedStatusesText(projectColumns)
        return {
          content: [{
            type: 'text' as const,
            text: `Unknown status "${status}" for project ${parent.project_id}. Allowed statuses: ${allowed}.`
          }],
          isError: true
        }
      }
      const initialStatus =
        status ?? getDefaultStatus(projectColumns)

      db.prepare(`
        INSERT INTO tasks (
          id, project_id, parent_id, title, description, assignee,
          status, priority, due_date, terminal_mode, provider_config,
          claude_flags, codex_flags, cursor_flags, gemini_flags, opencode_flags,
          is_temporary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        parent.project_id,
        parent.id,
        title,
        description ?? null,
        assignee ?? null,
        initialStatus,
        priority ?? 3,
        due_date ?? null,
        terminalMode,
        JSON.stringify(providerConfig),
        providerConfig['claude-code']?.flags ?? '',
        providerConfig.codex?.flags ?? '',
        providerConfig['cursor-agent']?.flags ?? '',
        providerConfig.gemini?.flags ?? '',
        providerConfig.opencode?.flags ?? '',
        0
      )

      const created = updateTask(db, { id })
      if (!created) {
        return {
          content: [{ type: 'text' as const, text: `Failed to create subtask under ${resolvedParentId}` }],
          isError: true
        }
      }

      notifyRenderer()
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(created, null, 2)
        }]
      }
    }
  )

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
  app.get(`/api/processes`, (_req, res) => {
    const procs = listAllProcesses().map(({ logBuffer: _, ...p }) => p)
    res.json(procs)
  })

  app.get(`/api/processes/:id/logs`, (req, res) => {
    const proc = listAllProcesses().find(p => p.id === req.params.id)
    if (!proc) { res.status(404).json({ error: `Process not found` }); return }
    res.json({ id: proc.id, label: proc.label, logs: proc.logBuffer })
  })

  app.delete(`/api/processes/:id`, (req, res) => {
    const ok = killProcess(req.params.id)
    if (!ok) { res.status(404).json({ error: `Process not found` }); return }
    res.json({ ok: true })
  })

  app.post('/api/notify', (_req, res) => {
    notifyRenderer()
    res.json({ ok: true })
  })

  // Automation manual execution for CLI (`slay automations run`)
  app.post('/api/automations/:id/run', async (req, res) => {
    if (!opts?.automationEngine) {
      res.status(501).json({ error: 'Automation engine not available' })
      return
    }
    try {
      const run = await opts.automationEngine.executeManual(req.params.id)
      res.json(run)
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get(`/api/processes/:id/follow`, (req, res) => {
    const proc = listAllProcesses().find(p => p.id === req.params.id)
    if (!proc) { res.status(404).json({ error: `Process not found` }); return }

    // Already finished: dump buffer and close
    if (proc.status !== 'running') {
      res.setHeader('Content-Type', 'text/plain')
      res.end(proc.logBuffer.join('\n'))
      return
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.flushHeaders()

    for (const line of proc.logBuffer) res.write(`data: ${line}\n\n`)

    const unsub = subscribeToProcessLogs(proc.id, (line) => {
      res.write(`data: ${line}\n\n`)
    })

    req.on('close', unsub)
  })

  // PTY control API for CLI (`slay pty *`)

  app.get('/api/pty', (_req, res) => {
    res.json(listPtys())
  })

  app.get('/api/pty/:id/buffer', (req, res) => {
    const buffer = getBuffer(req.params.id)
    if (buffer === null) { res.status(404).json({ error: 'PTY session not found' }); return }
    res.setHeader('Content-Type', 'text/plain')
    res.end(buffer)
  })

  app.get('/api/pty/:id/follow', (req, res) => {
    const id = req.params.id
    if (!hasPty(id)) { res.status(404).json({ error: 'PTY session not found' }); return }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.flushHeaders()

    // Subscribe first (sync) — no data can arrive until next tick
    const unsubData = subscribeToPtyData(id, (chunk) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    })

    // Replay existing buffer if requested (sync, same tick — no race)
    if (req.query.full === 'true') {
      const buffer = getBuffer(id)
      if (buffer) res.write(`data: ${JSON.stringify(buffer)}\n\n`)
    }

    // Detect session death
    const unsubSession = onSessionChange(() => {
      if (!hasPty(id) && !res.writableEnded) {
        res.write(`event: exit\ndata: {}\n\n`)
        res.end()
      }
    })

    req.on('close', () => {
      unsubData()
      unsubSession()
    })
  })

  app.post('/api/pty/:id/write', (req, res) => {
    const ok = writePty(req.params.id, req.body.data)
    if (!ok) { res.status(404).json({ error: 'PTY session not found' }); return }
    res.json({ ok: true })
  })

  app.delete('/api/pty/:id', (req, res) => {
    const ok = killPty(req.params.id)
    if (!ok) { res.status(404).json({ error: 'PTY session not found' }); return }
    res.json({ ok: true })
  })

  // Browser control API for CLI (`slay browser *`)
  const BROWSER_JS_TIMEOUT = 10_000

  interface BrowserWcResult {
    wc: Electron.WebContents
    /** true when the panel was just auto-opened (renderer already navigated to `url`) */
    autoOpened: boolean
  }

  async function ensureBrowserWc(
    taskId: string | undefined,
    panel: 'visible' | 'hidden' | undefined,
    res: express.Response,
    url?: string,
  ): Promise<BrowserWcResult | null> {
    if (!taskId) { res.status(400).json({ error: 'taskId required' }); return null }
    const wc = getBrowserWebContents(taskId)
    if (wc) return { wc, autoOpened: false }

    if (panel === 'visible') {
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.send('browser:ensure-panel-open', taskId, url)
      })
      try {
        return { wc: await waitForBrowserRegistration(taskId), autoOpened: !!url }
      } catch (err) {
        res.status(408).json({ error: err instanceof Error ? err.message : String(err) })
        return null
      }
    }

    res.status(404).json({ error: 'Browser panel not found. Is the browser panel open on the first tab?' })
    return null
  }

  function execJs<T>(wc: Electron.WebContents, code: string): Promise<T> {
    return Promise.race([
      (wc.mainFrame?.executeJavaScript(code) ?? Promise.reject(new Error('No main frame'))) as Promise<T>,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Browser script timed out (10s)')), BROWSER_JS_TIMEOUT)
      ),
    ])
  }

  const ALLOWED_NAVIGATE_SCHEMES = ['http:', 'https:', 'file:']

  app.get('/api/browser/url', async (req, res) => {
    const result = await ensureBrowserWc(req.query.taskId as string, (req.query.panel as 'visible' | 'hidden') ?? 'hidden', res)
    if (!result) return
    res.json({ url: result.wc.getURL() })
  })

  app.post('/api/browser/navigate', async (req, res) => {
    const { taskId, url, panel = 'visible' } = req.body ?? {}
    if (!url) { res.status(400).json({ error: 'url required' }); return }
    try {
      const parsed = new URL(url)
      if (!ALLOWED_NAVIGATE_SCHEMES.includes(parsed.protocol)) {
        res.status(400).json({ error: `Scheme not allowed: ${parsed.protocol}` }); return
      }
    } catch {
      res.status(400).json({ error: 'Invalid URL' }); return
    }
    const result = await ensureBrowserWc(taskId, panel, res, url)
    if (!result) return
    try {
      // Skip loadURL when panel was just auto-opened — the renderer already created a tab with this URL
      if (!result.autoOpened) await result.wc.loadURL(url)
      res.json({ ok: true, url: result.wc.getURL() })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/browser/click', async (req, res) => {
    const { taskId, selector, panel = 'hidden' } = req.body ?? {}
    if (!selector) { res.status(400).json({ error: 'selector required' }); return }
    const bwc = await ensureBrowserWc(taskId, panel, res)
    if (!bwc) return
    try {
      const result = await execJs<{ ok: boolean; error?: string; tag?: string; text?: string }>(bwc.wc, `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
        el.scrollIntoView({ block: 'center' });
        el.click();
        return { ok: true, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 100) };
      })()`)
      if (!result.ok) { res.status(404).json(result); return }
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/browser/type', async (req, res) => {
    const { taskId, selector, text, panel = 'hidden' } = req.body ?? {}
    if (!selector || text == null) { res.status(400).json({ error: 'selector and text required' }); return }
    const bwc = await ensureBrowserWc(taskId, panel, res)
    if (!bwc) return
    try {
      const result = await execJs<{ ok: boolean; error?: string }>(bwc.wc, `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
        el.scrollIntoView({ block: 'center' });
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
          || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) setter.call(el, ${JSON.stringify(text)});
        else el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      })()`)
      if (!result.ok) { res.status(404).json(result); return }
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/browser/eval', async (req, res) => {
    const { taskId, code, panel = 'hidden' } = req.body ?? {}
    if (!code) { res.status(400).json({ error: 'code required' }); return }
    const bwc = await ensureBrowserWc(taskId, panel, res)
    if (!bwc) return
    try {
      const result = await execJs(bwc.wc, code)
      res.json({ ok: true, result })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/browser/content', async (req, res) => {
    const bwc = await ensureBrowserWc(req.query.taskId as string, (req.query.panel as 'visible' | 'hidden') ?? 'hidden', res)
    if (!bwc) return
    try {
      const content = await execJs(bwc.wc, `(() => {
        const url = location.href;
        const title = document.title;
        const text = (document.body?.innerText || '').slice(0, 50000);
        const interactive = Array.from(document.querySelectorAll('input,textarea,select,button,a[href]'))
          .slice(0, 200)
          .map(el => {
            const o = { tag: el.tagName.toLowerCase() };
            if (el.id) o.id = el.id;
            if (el.name) o.name = el.name;
            if (el.type) o.type = el.type;
            if (el.placeholder) o.placeholder = el.placeholder;
            if (el.href) o.href = el.href;
            if (el.getAttribute('aria-label')) o.ariaLabel = el.getAttribute('aria-label');
            const t = (el.textContent || '').trim().slice(0, 80);
            if (t) o.text = t;
            return o;
          });
        return { url, title, text, interactive };
      })()`)
      res.json(content)
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/browser/screenshot', async (req, res) => {
    const { taskId, panel = 'hidden' } = req.body ?? {}
    const bwc = await ensureBrowserWc(taskId, panel, res)
    if (!bwc) return
    try {
      const image = await bwc.wc.capturePage()
      if (image.isEmpty()) { res.status(500).json({ error: 'Captured image is empty' }); return }
      const dir = join(electronApp.getPath('temp'), 'slayzone', 'browser-screenshots')
      mkdirSync(dir, { recursive: true })
      // Clean up screenshots older than 1 hour
      try {
        const cutoff = Date.now() - 3600_000
        for (const f of readdirSync(dir)) {
          const fp = join(dir, f)
          try { if (statSync(fp).mtimeMs < cutoff) unlinkSync(fp) } catch { /* ignore */ }
        }
      } catch { /* ignore cleanup errors */ }
      const filePath = join(dir, `${randomUUID()}.png`)
      writeFileSync(filePath, image.toPNG())
      res.json({ ok: true, path: filePath })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
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
