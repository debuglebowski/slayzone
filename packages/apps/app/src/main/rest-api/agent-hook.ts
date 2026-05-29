import type { Express } from 'express'
import express from 'express'
import { z } from 'zod'
import type { AgentLifecycleEvent, TerminalState, TerminalMode } from '@slayzone/terminal/shared'
import { mapEventType } from '@slayzone/terminal/shared'
import {
  findSessionByTaskIdAndMode,
  transitionStateFromHook,
  markSessionActiveFromHook,
  noteSessionConversationId,
  setSessionAwaitingInput,
  isHookDrivenMode
} from '@slayzone/terminal/main'
import { updateTask, getTaskOp } from '@slayzone/task/main'
import { getProviderConversationId } from '@slayzone/task/shared'
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
  /** Mirror a captured CLI conversation id onto the live PTY session so the
   *  idle-close (hibernation) gate sees a resumable session for hook-driven
   *  providers (claude-code) that never run `/status`. Optional so test stubs
   *  can omit it. */
  noteConversationId?: (sessionId: string, conversationId: string | null) => void
  /** Set the authoritative "blocked waiting for the user" flag so the idle-close
   *  gate never hibernates an agent paused mid-interaction (which reports the
   *  same 'idle' state as a completed turn). Optional for test stubs. */
  noteAwaitingInput?: (sessionId: string, awaiting: boolean) => void
}

const defaultBridge: TerminalStateBridge = {
  findSession: findSessionByTaskIdAndMode,
  transition: transitionStateFromHook,
  markActive: markSessionActiveFromHook,
  noteConversationId: noteSessionConversationId,
  noteAwaitingInput: setSessionAwaitingInput
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
 * Antigravity (`agy`) raw hook event → TerminalState. `agy` has no per-turn
 * UserPromptSubmit; the model-invocation events bracket a turn:
 *
 *   PreInvocation → 'running'  (model call about to start)
 *   Stop          → 'idle'     (execution loop terminated)
 *   PostToolUse / PostInvocation → null  (mid-turn; markActive refreshes clock)
 */
function antigravityHookToTerminalState(hookEvent: string): TerminalState | null {
  switch (hookEvent) {
    case 'PreInvocation':
      return 'running'
    case 'Stop':
      return 'idle'
    default:
      return null
  }
}

/**
 * Agents whose hook payload carries a resumable CLI session id, mapped to the
 * hook event that delivers it. Persisted to
 * `provider_config[agentId].conversationId` for deterministic resume-by-id.
 *
 * - `claude-code`: `SessionStart` fires on startup and on `/clear` (new session id
 *   each time); raw payload carries `session_id`.
 * - `codex`: `SessionStart` fires once per session, carries `session_id`.
 * - `antigravity`: every `agy` hook payload carries `conversationId`; we capture
 *   on `PreInvocation` (turn start). Repeats short-circuit in `persistConversationId`.
 */
const CONVERSATION_ID_CAPTURE_EVENT: Record<string, string> = {
  'claude-code': 'SessionStart',
  codex: 'SessionStart',
  antigravity: 'PreInvocation'
}

/** Dispatch to the per-agent raw-hook-event → TerminalState mapper. */
function hookToTerminalState(
  agentId: string,
  hookEvent: string,
  raw?: unknown
): TerminalState | null {
  if (agentId === 'codex') return codexHookToTerminalState(hookEvent)
  if (agentId === 'antigravity') return antigravityHookToTerminalState(hookEvent)
  return claudeCodeHookToTerminalState(hookEvent, raw)
}

/**
 * Raw hook event → "is the agent now blocked waiting for the user?" for the
 * idle-close (hibernation) gate. Returns `true` (blocked), `false` (resumed /
 * turn-complete → safe to hibernate), or `null` (no change).
 *
 * Needed because blocking-pause and turn-complete BOTH map to `'idle'` in
 * `hookToTerminalState`, so the terminal state alone can't tell "paused mid-
 * interaction, don't kill" from "done, fine to kill". The blocking signals:
 *   - claude: PreToolUse for a blocking built-in (AskUserQuestion / ExitPlanMode)
 *   - codex:  PermissionRequest
 * Resume/complete signals (UserPromptSubmit, non-blocking PreToolUse, Stop,
 * SessionEnd, PreInvocation) clear it. Notification is intentionally NOT treated
 * as blocking — its dominant subtype is `idle_prompt` (agent waiting for the
 * NEXT instruction), which is exactly the stale case we DO want to hibernate;
 * genuine permission prompts are rare under `--allow-dangerously-skip-permissions`
 * and are still caught by the output `detectPrompt` backstop.
 */
function hookToAwaitingUser(agentId: string, hookEvent: string, raw?: unknown): boolean | null {
  if (agentId === 'codex') {
    if (hookEvent === 'PermissionRequest') return true
    if (hookEvent === 'UserPromptSubmit' || hookEvent === 'PreToolUse' || hookEvent === 'Stop')
      return false
    return null
  }
  if (agentId === 'antigravity') {
    if (hookEvent === 'PreInvocation' || hookEvent === 'Stop') return false
    return null
  }
  // claude-code
  if (hookEvent === 'PreToolUse') {
    const toolName = (raw as { tool_name?: unknown } | undefined)?.tool_name
    return typeof toolName === 'string' && CLAUDE_BLOCKING_TOOLS.has(toolName)
  }
  if (hookEvent === 'UserPromptSubmit' || hookEvent === 'Stop' || hookEvent === 'SessionEnd')
    return false
  return null
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
  agentId: z.enum(['claude-code', 'codex', 'gemini', 'antigravity', 'opencode']),
  hookEvent: z.string().min(1),
  /** The agent CLI's own session id (a UUID forwarded by notify.sh from the
   *  hook payload's `session_id`) — NOT the SlayZone PTY session id. */
  sessionId: z.string().optional(),
  taskId: z.string().optional(),
  cwd: z.string().optional(),
  raw: z.unknown().optional()
})

/**
 * Persist a CLI's session_id (carried by its `SessionStart` hook) to the task's
 * `provider_config[agentId].conversationId` so the session can be resumed
 * deterministically by id.
 *
 * Applies to the agents in `CONVERSATION_ID_CAPTURE_AGENTS` (codex, antigravity)
 * — their SessionStart hook carries the id directly. Codex additionally has
 * `/status` + disk-scan detection (`codex-adapter.ts`) as untouched fallbacks.
 *
 * The CLI session_id is a UUID — distinct from the SlayZone PTY session id
 * resolved via `bridge.findSession`. `agentId` doubles as the `provider_config`
 * key — for the capture agents the `AgentId` string equals the `TerminalMode`.
 *
 * Reads through the task domain (`getTaskOp` + `getProviderConversationId`)
 * rather than raw SQL so the `provider_config` schema stays owned by that
 * domain. Uses the pure `updateTask` (not `updateTaskOp`) deliberately:
 * `updateTaskOp` emits `db:tasks:update:done`, which triggers a GitHub/Linear
 * push — wrong for a machine-written conversation id. `notifyRenderer()` still
 * refreshes the renderer via `tasks:changed`. The per-mode deep-merge inside
 * `updateTask` preserves existing `flags`/`lastPtyKilledAt`. Always overwrites:
 * the CLI mints a fresh id on resume, so the latest id is always the right one.
 *
 * Best-effort — on any failure the adapter detection fallbacks still capture
 * the id.
 */
async function persistConversationId(
  deps: RestApiDeps,
  agentId: string,
  taskId: string,
  sessionId: string
): Promise<void> {
  try {
    const task = await getTaskOp(deps.db, taskId)
    if (!task) return
    // Already current — skip the redundant write + tasks:changed broadcast.
    if (getProviderConversationId(task.provider_config, agentId) === sessionId) return
    updateTask(deps.db, {
      id: taskId,
      providerConfig: { [agentId]: { conversationId: sessionId } }
    })
    deps.notifyRenderer()
  } catch {
    // Best-effort — adapter `/status` + disk-scan fallbacks still cover capture.
  }
}

/**
 * Receives agent lifecycle pings from the bundled `notify.sh` hook script.
 *
 * Loopback-only (the MCP server binds to 127.0.0.1). No auth: blast radius
 * is renderer-side status updates and a future chime — matches Superset.
 *
 * Hot path: hooks fire 5-20× per turn (PreToolUse + PostToolUse per tool).
 * Must stay cheap. The ONLY DB write is the once-per-session `SessionStart`
 * conversation-id capture for codex/antigravity (see `persistConversationId`) —
 * gated so it never touches the per-tool hot path. Broadcast no-ops
 * automatically when no renderer is open (BrowserWindow.getAllWindows() = []).
 */
export function registerAgentHookRoute(
  app: Express,
  deps: RestApiDeps,
  bridge: TerminalStateBridge = defaultBridge
): void {
  // Bumped from default 100kb — SessionStart payloads can carry the full tool list.
  const jsonParser = express.json({ limit: '1mb' })

  app.post('/api/agent-hook', jsonParser, async (req, res) => {
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

    // PRIMARY resume-id capture — persist the CLI session id into
    // provider_config[agentId].conversationId for the capture agents. Gated to
    // one event per agent (see CONVERSATION_ID_CAPTURE_EVENT) so this stays off
    // the per-tool hot path. `raw.session_id` / `raw.conversationId` are
    // fallbacks if the notify.sh envelope ever omits the top-level `sessionId`.
    if (
      CONVERSATION_ID_CAPTURE_EVENT[parsed.data.agentId] === parsed.data.hookEvent
    ) {
      const rawIds = parsed.data.raw as
        | { session_id?: string; conversationId?: string }
        | undefined
      const cliSessionId =
        parsed.data.sessionId ?? rawIds?.session_id ?? rawIds?.conversationId
      if (parsed.data.taskId && cliSessionId) {
        // Awaited: a single indexed SELECT + UPDATE on local SQLite is sub-ms,
        // and the capture event is low-frequency (repeats short-circuit in the
        // helper) — keeping it deterministic beats a fire-and-forget race.
        await persistConversationId(
          deps,
          parsed.data.agentId,
          parsed.data.taskId,
          cliSessionId
        )
        // Mirror onto the live PTY session for the idle-close gate.
        const ptySessionId = bridge.findSession(
          parsed.data.taskId,
          parsed.data.agentId as TerminalMode
        )
        if (ptySessionId) bridge.noteConversationId?.(ptySessionId, cliSessionId)
      }
    }

    // Drive the PTY state machine from the hook signal — the source of truth
    // for hook-driven agents (replaces adapter output detection / bullet-glyph
    // regex). gemini/opencode still rely on adapter detection.
    if (isHookDrivenMode(parsed.data.agentId) && parsed.data.taskId) {
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

        // Feed the idle-close gate the authoritative "blocked on user" signal —
        // distinguishes a paused-mid-interaction agent (don't hibernate) from a
        // completed turn (both report 'idle').
        const awaiting = hookToAwaitingUser(
          parsed.data.agentId,
          parsed.data.hookEvent,
          parsed.data.raw
        )
        if (awaiting !== null) bridge.noteAwaitingInput?.(sessionId, awaiting)
      }
    }

    res.json({ ok: true })
  })
}
