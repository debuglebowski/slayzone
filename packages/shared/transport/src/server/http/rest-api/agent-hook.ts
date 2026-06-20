import type { Express } from 'express'
import express from 'express'
import { z } from 'zod'
import type { AgentLifecycleEvent, TerminalState, TerminalMode } from '@slayzone/terminal/shared'
import { mapEventType } from '@slayzone/terminal/shared'
import { isHookDrivenMode } from '@slayzone/terminal/server'
import { recordConversation, findPendingSpawn } from '@slayzone/task/server'
import { capturePrompt } from '@slayzone/agent-turns/server'
import type { ConversationOrigin } from '@slayzone/task/shared'
import { recordDiagnosticEvent } from '@slayzone/diagnostics/server'
import type { RestApiDeps, TerminalStateBridge } from './types'

// The bridge interface lives in ./types (capability slot on RestApiDeps); the
// Electron host injects the live `@slayzone/terminal/electron` impl, tests
// inject stubs. Re-exported here so existing importers keep working.
export type { TerminalStateBridge } from './types'

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
 *   PreToolUse (blocking tool)      → 'idle'    (agent paused for user)
 *   PostToolUse (blocking tool)     → 'running' (user answered → agent resumed)
 *   PostToolUse (non-blocking tool) → null      (no-op; mid-turn, already 'running')
 *   Stop / SessionEnd               → 'idle'    (turn complete / session over)
 *   Notification                    → 'idle'    (claude paused for user — sidebar dot)
 *   SessionStart / SubagentStop /
 *   PreCompact                      → null      (no-op; mid-turn or already-handled)
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
    case 'PostToolUse': {
      // The symmetric partner to the PreToolUse blocking-tool branch above, and
      // the fix for "task sits idle (no spinner) after the user accepts a plan".
      //
      // WHY THIS IS NEEDED — the gap it closes:
      //   A blocking tool (ExitPlanMode / AskUserQuestion) parks the session on
      //   'idle' at PreToolUse while Claude waits for the user. On ACCEPT, Claude
      //   runs the tool to completion and emits PostToolUse — and then keeps
      //   working (thinking, writing the implementation) for as long as it takes
      //   before its FIRST real tool call fires the next PreToolUse→'running'.
      //   Measured gaps of 2+ minutes. Crucially there is NO UserPromptSubmit on
      //   accept (the user didn't type a prompt), so this PostToolUse is the ONLY
      //   hook that proves the agent resumed. Drop it (the old behaviour) and the
      //   spinner stays dark through the whole gap.
      //
      // WHY KEYING ON EVENT PRESENCE IS SOUND (no is_error / accept-vs-reject
      // inspection needed) — and why this is gated to BLOCKING tools only:
      //   For a blocking tool, "execution" == the user's decision. ACCEPT → the
      //   tool runs → PostToolUse fires. REJECT / Esc → the PreToolUse is denied,
      //   the tool never executes → NO PostToolUse ever arrives here. Verified
      //   empirically against the live hook log: rejected ExitPlanMode produced
      //   zero PostToolUse; only accepts did. So for a blocking tool,
      //   receiving PostToolUse ⟺ the user accepted ⟹ 'running'. The reject/Esc
      //   path is therefore untouched by this branch (it correctly stays 'idle'
      //   via PreToolUse, then resumes via UserPromptSubmit if the user replies).
      //
      // WHY NOT GENERALISE TO ALL PostToolUse:
      //   A NON-blocking tool fires PostToolUse even when it ran-but-failed
      //   (e.g. Bash exits non-zero). Mapping those to 'running' would be wrong,
      //   AND would re-introduce the per-tool sidebar flicker the no-op was added
      //   to kill. Blocking tools have no "ran-but-failed" state, so the
      //   CLAUDE_BLOCKING_TOOLS gate is exactly what makes this safe WITHOUT an
      //   is_error check (which isn't even carried on the PostToolUse payload).
      //   Future blocking built-ins added to CLAUDE_BLOCKING_TOOLS inherit both
      //   the pause (PreToolUse) and the resume (here) for free — one allowlist,
      //   no drift. Non-blocking PostToolUse stays the no-op it always was.
      const toolName = (raw as { tool_name?: unknown } | undefined)?.tool_name
      if (typeof toolName === 'string' && CLAUDE_BLOCKING_TOOLS.has(toolName)) return 'running'
      return null
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
  if (hookEvent === 'PostToolUse') {
    // Mirror of the PreToolUse branch: a blocking tool's PostToolUse fires only
    // when the user accepted/answered (reject/Esc denies PreToolUse → no
    // PostToolUse), so it is the authoritative "no longer blocked" signal.
    // Clearing here keeps the awaiting flag coherent with the 'running' state
    // that claudeCodeHookToTerminalState now returns for the same event — a
    // running+awaiting pair would be contradictory and confuse the idle-close
    // gate. Non-blocking PostToolUse stays a no-op (returns null below).
    const toolName = (raw as { tool_name?: unknown } | undefined)?.tool_name
    if (typeof toolName === 'string' && CLAUDE_BLOCKING_TOOLS.has(toolName)) return false
    return null
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
 * deterministically by id, AND append it to `conversationHistory`.
 *
 * Applies to the agents in `CONVERSATION_ID_CAPTURE_EVENT` (claude-code, codex,
 * antigravity) — their SessionStart hook carries the id directly. Codex
 * additionally has `/status` + disk-scan detection (`codex-adapter.ts`) as
 * untouched fallbacks.
 *
 * This is the SINGLE authority for "a conversation exists" for claude-code: the
 * id is committed here — only after the agent's real SessionStart proves the
 * conversation was created — never eagerly on the client. That closes the
 * phantom-id path that produced false "session expired" overlays (the old
 * client-side eager commit wrote an unconfirmed minted UUID; a session dying
 * before SessionStart left a pointer to a transcript Claude never wrote). See
 * plans/conv-id-robustness-v2.md.
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
 * `updateTask` preserves existing `flags`/`lastPtyKilledAt`. Always overwrites
 * `conversationId`: the CLI mints a fresh id on resume, so the latest is right.
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
    // Provenance gate: look up the `pending-spawn` row slay wrote when it
    // launched the agent. If the CLI session id matches that row's expected
    // id, record it as honored (`slay-spawned-*`). If it doesn't — or no
    // pending row exists — record as `foreign-observed` (audit only, never
    // honored on read). This closes the RC1 eager-persist clobber: a manual
    // `claude --resume <foreign>` inside a slay PTY can no longer bind the
    // foreign session to the task.
    const pending = await findPendingSpawn(deps.db, taskId, agentId)
    // No pending → no spawn-intent record: definitely foreign.
    // Pending w/ expectedSessionId === null → fresh PTY spawn where slay did
    // NOT pre-mint a UUID; accept the first observed id as fresh (temporal-
    // proximity gate only — Claude mints its own).
    // Pending w/ exact match → honored.
    // Pending w/ mismatch → foreign (e.g. user typed `claude --resume X`).
    const origin: ConversationOrigin = !pending
      ? 'foreign-observed'
      : pending.expectedSessionId === null
        ? 'slay-spawned-fresh'
        : sessionId === pending.expectedSessionId
          ? pending.usedResume
            ? 'slay-spawned-resume'
            : 'slay-spawned-fresh'
          : 'foreign-observed'
    await recordConversation(deps.db, {
      taskId,
      mode: agentId,
      conversationId: sessionId,
      origin
    })
    // Pending row stays — repeated SessionStart payloads on the same spawn
    // are idempotent (we just append another row with the same origin).
    // The row is pruned by the PTY-exit hook OR the periodic TTL sweep.
    if (origin !== 'foreign-observed') deps.notifyRenderer()
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
  bridgeOverride?: TerminalStateBridge
): void {
  // Tests override; the host injects via deps. Absent (standalone server until
  // the pty runtime lands there): conversation-id capture + diagnostics still
  // run, state transitions are skipped.
  const bridge = bridgeOverride ?? deps.terminalStateBridge
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
    deps.agentLifecycle?.emit('event', event)

    // Capture the user's prompt text (UserPromptSubmit) into agent_prompts for
    // the agent-terminal "messages" sidebar. capturePrompt self-gates to
    // capture-capable modes + the UserPromptSubmit event (once per turn → off
    // the per-tool hot path) and is best-effort: fire-and-forget so a DB hiccup
    // never blocks the hook ack.
    if (parsed.data.taskId) {
      void capturePrompt(deps.db, {
        agentId: parsed.data.agentId,
        hookEvent: parsed.data.hookEvent,
        taskId: parsed.data.taskId,
        sessionId: parsed.data.sessionId,
        raw: parsed.data.raw
      }).catch(() => {
        /* best-effort — never block the hook */
      })
    }

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
        const ptySessionId = bridge?.findSession(
          parsed.data.taskId,
          parsed.data.agentId as TerminalMode
        )
        if (ptySessionId) bridge?.noteConversationId?.(ptySessionId, cliSessionId)
      }
    }

    // Drive the PTY state machine from the hook signal — the source of truth
    // for hook-driven agents (replaces adapter output detection / bullet-glyph
    // regex). gemini/opencode still rely on adapter detection.
    if (bridge && isHookDrivenMode(parsed.data.agentId) && parsed.data.taskId) {
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
