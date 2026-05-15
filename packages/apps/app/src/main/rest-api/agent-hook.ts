import type { Express } from 'express'
import express from 'express'
import { z } from 'zod'
import type { AgentLifecycleEvent } from '@slayzone/terminal/shared'
import { mapEventType } from '@slayzone/terminal/shared'
import { broadcastToWindows } from '../broadcast-to-windows'
import type { RestApiDeps } from './types'

const PayloadSchema = z.object({
  agentId: z.enum(['claude-code', 'codex', 'gemini', 'opencode']),
  hookEvent: z.string().min(1),
  sessionId: z.string().optional(),
  taskId: z.string().optional(),
  cwd: z.string().optional(),
  raw: z.unknown().optional(),
})

/**
 * Receives agent lifecycle pings from the bundled `notify.sh` hook script.
 *
 * Loopback-only (the MCP server binds to 127.0.0.1). No auth: blast radius
 * is renderer-side status updates and a future chime — matches Superset.
 *
 * Hot path: hooks fire 5-20× per turn (PreToolUse + PostToolUse per tool).
 * Must stay cheap. No DB writes here. Broadcast no-ops automatically when
 * no renderer is open (BrowserWindow.getAllWindows() returns []).
 */
export function registerAgentHookRoute(app: Express, _deps: RestApiDeps): void {
  // Bumped from default 100kb — SessionStart payloads can carry the full tool list.
  const jsonParser = express.json({ limit: '1mb' })

  app.post('/api/agent-hook', jsonParser, (req, res) => {
    const parsed = PayloadSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.message })
      return
    }
    const type = mapEventType(parsed.data.hookEvent)
    if (!type) {
      // Unknown event → drop silently. Never default to Stop.
      res.status(204).end()
      return
    }
    const event: AgentLifecycleEvent = {
      ...parsed.data,
      type,
      timestamp: Date.now(),
    }
    broadcastToWindows('agent:lifecycle', event)
    res.json({ ok: true })
  })
}
