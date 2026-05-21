import type { Express } from 'express'
import express from 'express'
import { z } from 'zod'
import type { AgentLifecycleEvent, TerminalState, TerminalMode } from '@slayzone/terminal/shared'
import { mapEventType } from '@slayzone/terminal/shared'
import {
  findSessionByTaskIdAndMode,
  transitionStateFromHook,
  markSessionActiveFromHook
} from '@slayzone/terminal/main'
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
  markActive: markSessionActiveFromHook
}

/**
 * Built-in Claude tools that BLOCK the agent waiting for a user keystroke.
 * Claude Code does NOT fire `Notification` for these (Notification only fires
 * for permission_prompt, idle_prompt, auth_success, and MCP elicitation_dialog
 * — not for native blocking tools). Without this allowlist, PreToolUse pins
 * the session on 'running' until the user answers, the silence-timer trips
 * 5 minutes later, or the turn ends — sidebar shows the loading spinner the
 * whole time and `needs_attention` never lights up.
 *
 * Add new built-in blocking tools here when Anthropic ships them.
 */
const CLAUDE_BLOCKING_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion', 'ExitPlanMode'])

/**
 * Claude Code raw hook event → TerminalState. Keys on the RAW name (not the
 * normalized lifecycle type) because PreToolUse + PostToolUse both normalize
 * to start/stop pairs that would flicker the UI on every tool call inside a
 * single turn. Only the turn-boundary events drive state:
 *
 *   UserPromptSubmit                → 'running' (active inside a turn)
 *   PreToolUse (non-blocking tool)  → 'running'
 *   PreToolUse (blocking tool)      → 'idle'   (agent paused for user)
 *   Stop / SessionEnd               → 'idle'   (turn complete / session over)
 *   Notification                    → 'idle'   (claude paused for user — sidebar dot)
 *   PostToolUse / SessionStart /
 *   SubagentStop / PreCompact       → null     (no-op; mid-turn or already-handled)
 *
 * Mid-turn no-ops are deliberate: PostToolUse fires after every tool but the
 * agent is still working until Stop. Letting it flip to 'idle' caused the
 * sidebar to flicker on every tool call inside one turn.
 */
function claudeCodeHookToTerminalState(hookEvent: string, raw?: unknown): TerminalState | null {
  switch (hookEvent) {
    case 'UserPromptSubmit':
      return 'running'
    case 'PreToolUse': {
      const toolName = (raw as { tool_name?: unknown } | undefined)?.tool_name
      if (typeof toolName === 'string' && CLAUDE_BLOCKING_TOOLS.has(toolName)) return 'idle'
      return 'running'
    }
    case 'Stop':
    case 'SessionEnd':
    case 'Notification':
      return 'idle'
    default:
      return null
  }
}

/**
 * Codex raw hook event → TerminalState. Codex's hooks system emits the same
 * standard event names as Claude with matching turn-boundary semantics, so the
 * mapping mirrors `claudeCodeHookToTerminalState`. Codex surfaces approvals via
 * the dedicated `PermissionRequest` event — no blocking-tool allowlist needed.
 *
 *   UserPromptSubmit / PreToolUse → 'running'
 *   Stop / PermissionRequest      → 'idle'
 *   SessionStart / PostToolUse    → null  (no-op; markActive refreshes the clock)
 */
function codexHookToTerminalState(hookEvent: string): TerminalState | null {
  switch (hookEvent) {
    case 'UserPromptSubmit':
    case 'PreToolUse':
      return 'running'
    case 'Stop':
    case 'PermissionRequest':
      return 'idle'
    default:
      return null
  }
}

/**
 * Agents whose PTY state machine is driven by hook signals instead of adapter
 * output detection. Claude Code and Codex both have reliable native lifecycle
 * hooks; gemini/opencode still rely on adapter detection.
 */
const HOOK_DRIVEN_AGENTS: ReadonlySet<string> = new Set(['claude-code', 'codex'])

/** Dispatch to the per-agent raw-hook-event → TerminalState mapper. */
function hookToTerminalState(
  agentId: string,
  hookEvent: string,
  raw?: unknown
): TerminalState | null {
  return agentId === 'codex'
    ? codexHookToTerminalState(hookEvent)
    : claudeCodeHookToTerminalState(hookEvent, raw)
}

/** Stringify + clamp for diagnostic storage. Keeps raw hook payloads from
 *  blowing up the diagnostics DB while still capturing tool_name,
 *  stop_hook_active, transcript_path, etc. Returns the original on
 *  serialization failure so we still log something useful. */
function truncateForDiag(value: unknown, maxChars: number): string {
  if (value == null) return ''
  let s: string
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    s = String(value)
  }
  return s.length <= maxChars ? s : s.slice(0, maxChars) + '…[truncated]'
}

const PayloadSchema = z.object({
  agentId: z.enum(['claude-code', 'codex', 'gemini', 'opencode']),
  hookEvent: z.string().min(1),
  sessionId: z.string().optional(),
  taskId: z.string().optional(),
  cwd: z.string().optional(),
  raw: z.unknown().optional()
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
  bridge: TerminalStateBridge = defaultBridge
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
      timestamp: Date.now()
    }
    broadcastToWindows('agent:lifecycle', event)

    // Drive the PTY state machine from the hook signal — the source of truth
    // for hook-driven agents (replaces adapter output detection / bullet-glyph
    // regex). gemini/opencode still rely on adapter detection.
    if (HOOK_DRIVEN_AGENTS.has(parsed.data.agentId) && parsed.data.taskId) {
      const mode = parsed.data.agentId as TerminalMode
      const sessionId = bridge.findSession(parsed.data.taskId, mode)
      if (sessionId) {
        const newState = hookToTerminalState(
          parsed.data.agentId,
          parsed.data.hookEvent,
          parsed.data.raw
        )
        recordDiagnosticEvent({
          level: 'info',
          source: 'pty',
          event: 'pty.hook_received',
          sessionId,
          taskId: parsed.data.taskId,
          message: parsed.data.hookEvent,
          // Include raw payload (truncated) so we can see stop_hook_active,
          // tool_name, tool_response, transcript_path, etc. Temporary
          // instrumentation for the "PTY stuck on running after ESC" bug.
          payload: {
            agentId: parsed.data.agentId,
            mappedState: newState ?? 'mark-active',
            raw: truncateForDiag(parsed.data.raw, 4096),
          }
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
