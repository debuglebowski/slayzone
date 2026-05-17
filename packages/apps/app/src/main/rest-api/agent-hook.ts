import type { Express } from 'express'
import express from 'express'
import { z } from 'zod'
import type { AgentLifecycleEvent, TerminalState, TerminalMode } from '@slayzone/terminal/shared'
import { mapEventType } from '@slayzone/terminal/shared'
import { findSessionByTaskIdAndMode, transitionStateFromHook, markSessionActiveFromHook } from '@slayzone/terminal/main'
import { recordDiagnosticEvent } from '@slayzone/diagnostics/main'
import { broadcastToWindows } from '../broadcast-to-windows'
import type { RestApiDeps } from './types'

/**
 * Pluggable bridge to the PTY state machine. Defaults wire to the live
 * `@slayzone/terminal/main` impl; tests override with stubs to avoid pulling
 * node-pty / Electron native modules into the test runner.
 */
export interface TerminalStateBridge {
  findSession: (taskId: string, mode: TerminalMode) => string | null
  transition: (sessionId: string, state: TerminalState, hookEvent: string) => boolean
  /** Refresh the silence-timer clock without changing state. Called for hook
   *  events that prove activity but don't transition (PostToolUse, etc.). */
  markActive: (sessionId: string) => boolean
}

const defaultBridge: TerminalStateBridge = {
  findSession: findSessionByTaskIdAndMode,
  transition: transitionStateFromHook,
  markActive: markSessionActiveFromHook,
}

/**
 * Claude Code raw hook event → TerminalState. Keys on the RAW name (not the
 * normalized lifecycle type) because PreToolUse + PostToolUse both normalize
 * to start/stop pairs that would flicker the UI on every tool call inside a
 * single turn. Only the turn-boundary events drive state:
 *
 *   UserPromptSubmit / PreToolUse  → 'running' (active inside a turn)
 *   Stop / SessionEnd              → 'idle'   (turn complete / session over)
 *   Notification                   → 'idle'   (claude paused for user — sidebar dot)
 *   PostToolUse / SessionStart /
 *   SubagentStop / PreCompact      → null     (no-op; mid-turn or already-handled)
 *
 * Mid-turn no-ops are deliberate: PostToolUse fires after every tool but the
 * agent is still working until Stop. Letting it flip to 'idle' caused the
 * sidebar to flicker on every tool call inside one turn.
 */
function claudeCodeHookToTerminalState(hookEvent: string): TerminalState | null {
  switch (hookEvent) {
    case 'UserPromptSubmit':
    case 'PreToolUse':
      return 'running'
    case 'Stop':
    case 'SessionEnd':
    case 'Notification':
      return 'idle'
    default:
      return null
  }
}

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
export function registerAgentHookRoute(
  app: Express,
  _deps: RestApiDeps,
  bridge: TerminalStateBridge = defaultBridge,
): void {
  // Bumped from default 100kb — SessionStart payloads can carry the full tool list.
  const jsonParser = express.json({ limit: '1mb' })

  app.post('/api/agent-hook', jsonParser, (req, res) => {
    const parsed = PayloadSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.message })
      return
    }
    const type = mapEventType(parsed.data.hookEvent, parsed.data.agentId)
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

    // Drive the PTY state machine from the hook signal — this is the source of
    // truth for claude-code (replaces the bullet-glyph regex in ClaudeAdapter).
    // Other agents still rely on adapter detection until their detectActivity
    // is similarly retired.
    if (parsed.data.agentId === 'claude-code' && parsed.data.taskId) {
      const sessionId = bridge.findSession(parsed.data.taskId, 'claude-code')
      if (sessionId) {
        const newState = claudeCodeHookToTerminalState(parsed.data.hookEvent)
        recordDiagnosticEvent({
          level: 'info',
          source: 'pty',
          event: 'pty.hook_received',
          sessionId,
          taskId: parsed.data.taskId,
          message: parsed.data.hookEvent,
          payload: { agentId: parsed.data.agentId, mappedState: newState ?? 'mark-active' }
        })
        if (newState) {
          bridge.transition(sessionId, newState, parsed.data.hookEvent)
        } else {
          // PostToolUse / SubagentStop / PreCompact / SessionStart: no state
          // change but the agent is alive — refresh the silence-timer clock so
          // the fail-safe doesn't flip running→idle mid-turn.
          bridge.markActive(sessionId)
        }
      }
    }

    res.json({ ok: true })
  })
}
