import type { Express } from 'express'
import express from 'express'
import { z } from 'zod'
import type { AgentLifecycleEvent, TerminalState, TerminalMode } from '@slayzone/terminal/shared'
import { mapEventType } from '@slayzone/terminal/shared'
import { isHookDrivenMode } from '@slayzone/terminal/server'
import {
  recordConversation,
  findPendingSpawn,
  confirmSessionConversation,
  getBoundTaskId
} from '@slayzone/task/server'
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

/**
 * `slaySessionId` → bound `taskId`, cached after the first DB hit. A warm-pool
 * agent's env vars are fixed at spawn (before its task exists), so its hook
 * payloads never carry `taskId` — only `slaySessionId` — for the session's
 * entire life. `getBoundTaskId` recovers it from the `bindSessionToTask`
 * write; caching is safe because that bind is set-once and never changes.
 */
const poolSessionTaskIdCache = new Map<string, string>()

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

const AGENT_IDS = ['claude-code', 'codex', 'gemini', 'antigravity', 'opencode'] as const
type HookAgentId = (typeof AGENT_IDS)[number]
function isAgentId(v: unknown): v is HookAgentId {
  return typeof v === 'string' && (AGENT_IDS as readonly string[]).includes(v)
}

/**
 * The hook envelope — INTENTIONALLY loose. It admits BOTH shapes, and the real
 * validation happens in `resolveHookIdentity` so back-compat never depends on
 * schema strictness:
 *
 *   NEW (benign notify.sh v2+): `{ ctx, raw, arg, agentId }` — three OPAQUE
 *     channels the script forwards without naming any field:
 *       - ctx : the app-packed identity blob (`SLAYZONE_HOOK_CONTEXT`) —
 *               `{ v, taskId, slaySessionId, projectId, agentId, channel }`.
 *       - raw : the stdin hook payload (Claude/Codex/Gemini/Antigravity), or null.
 *       - arg : argv $1 (Antigravity's event NAME, or the OpenCode plugin's whole
 *               JSON payload) as a string, or null.
 *     ALL field extraction (event name, session ids, cwd) is done HERE, on the
 *     server — never in the shared shell script (the file that rots when an
 *     older channel clobbers it).
 *
 *   LEGACY (old installed scripts + old released apps): flat
 *     `{ agentId, hookEvent, sessionId?, taskId?, slaySessionId?, cwd?, raw? }`.
 *     Still fully resolves — no flag day.
 */
const PayloadSchema = z.object({
  agentId: z.string().optional(),
  hookEvent: z.string().optional(),
  sessionId: z.string().optional(),
  taskId: z.string().optional(),
  slaySessionId: z.string().optional(),
  cwd: z.string().optional(),
  raw: z.unknown().optional(),
  /** NEW envelope: opaque identity blob (already-parsed JSON object). */
  ctx: z.unknown().optional(),
  /** NEW envelope: argv $1 forwarded opaquely (event name OR JSON payload). */
  arg: z.string().nullable().optional()
})

/** The fully-resolved hook identity — the server-side result of the field
 *  extraction that the benign notify.sh no longer does. Downstream consumers
 *  (state machine, prompt capture, conversation-id persist) read ONLY this. */
interface ResolvedHook {
  agentId: HookAgentId
  hookEvent: string
  taskId?: string
  slaySessionId?: string
  /** CLI session UUID (claude/codex `session_id`, antigravity `conversationId`). */
  sessionId?: string
  cwd?: string
  raw?: unknown
  /** Attribution only — which SlayZone channel fired the hook (from the blob). */
  channel?: string
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined
}

/**
 * Resolve the hook identity from EITHER envelope shape. This is where the field
 * logic that used to live in notify.sh now lives — in TypeScript, on the server,
 * so a stale shell copy can never strip it. Returns `null` when the payload
 * carries no usable identity (no agent id, or no event signal at all) → 400.
 *
 * Precedence per field: explicit legacy top-level > ctx blob > derived from the
 * raw/arg payload. This keeps OLD flat payloads byte-identical while letting the
 * NEW opaque envelope resolve everything server-side.
 */
function resolveHookIdentity(body: z.infer<typeof PayloadSchema>): ResolvedHook | null {
  const ctx = asRecord(body.ctx)

  // agentId: top-level (both shapes set it) → ctx blob. Must be a known agent.
  const agentIdRaw = body.agentId ?? ctx?.agentId
  if (!isAgentId(agentIdRaw)) return null

  // Effective raw payload for downstream + event derivation:
  //   - stdin `raw` when it is an object (Claude/Codex/Gemini/Antigravity), else
  //   - the argv payload parsed as JSON when `arg` is a JSON string (OpenCode
  //     plugin shells `bash notify.sh '<json>'` with no stdin).
  let effRaw = asRecord(body.raw)
  const arg = body.arg ?? undefined
  const argIsJson = typeof arg === 'string' && arg.trimStart().startsWith('{')
  if (!effRaw && argIsJson) {
    try {
      effRaw = asRecord(JSON.parse(arg!))
    } catch {
      /* not JSON after all — leave effRaw undefined */
    }
  }

  // hookEvent: explicit legacy field → argv-as-event-name (Antigravity: `arg` is
  // a plain event name, not JSON) → payload `hook_event_name` → payload `type`.
  // This is the exact priority the old notify.sh applied, moved server-side.
  const argAsEventName = typeof arg === 'string' && !argIsJson && arg.length > 0 ? arg : undefined
  const hookEvent =
    body.hookEvent ??
    argAsEventName ??
    (typeof effRaw?.hook_event_name === 'string' ? effRaw.hook_event_name : undefined) ??
    (typeof effRaw?.type === 'string' ? (effRaw.type as string) : undefined)

  // No event signal at all (no explicit event, no argv, no parseable payload) →
  // malformed. Distinguishes a genuinely-empty ping from an unknown-but-present
  // event (the latter derives a name and is dropped as 204 downstream).
  if (!hookEvent) return null

  const cliSessionId =
    body.sessionId ??
    (typeof effRaw?.session_id === 'string' ? effRaw.session_id : undefined) ??
    (typeof effRaw?.conversationId === 'string' ? effRaw.conversationId : undefined)

  return {
    agentId: agentIdRaw,
    hookEvent,
    taskId: body.taskId ?? (typeof ctx?.taskId === 'string' ? ctx.taskId : undefined),
    slaySessionId:
      body.slaySessionId ?? (typeof ctx?.slaySessionId === 'string' ? ctx.slaySessionId : undefined),
    sessionId: cliSessionId,
    cwd: body.cwd ?? (typeof effRaw?.cwd === 'string' ? effRaw.cwd : undefined),
    raw: effRaw ?? body.raw,
    channel: typeof ctx?.channel === 'string' ? ctx.channel : undefined
  }
}

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
 * Process ONE agent-hook envelope — the SINGLE authority shared by the Express
 * route (local loopback hooks) AND the hub's runner-relay consumer (a remote
 * runner relays the envelope over its ws channel — see the hub composition
 * root). Pure of Express so both callers reuse the exact same field-resolution,
 * state-machine, prompt-capture, and conversation-id logic — no duplication, no
 * drift.
 *
 * Returns a status the HTTP caller maps to a response:
 *   - 'ok'      → 200 (processed).
 *   - 'unknown' → 204 (event derived but not mappable; never default to Stop).
 *   - 'bad'     → 400 (no usable identity in the envelope).
 * The ws relay consumer ignores the return (fire-and-forget).
 *
 * Hot path: hooks fire 5-20× per turn (PreToolUse + PostToolUse per tool). Must
 * stay cheap. The ONLY DB write is the once-per-session `SessionStart`
 * conversation-id capture for the capture agents (see `persistConversationId`) —
 * gated so it never touches the per-tool hot path. Broadcasts no-op when no
 * renderer is open.
 */
export async function processAgentHook(
  body: unknown,
  deps: RestApiDeps,
  bridge: TerminalStateBridge | undefined
): Promise<'ok' | 'unknown' | 'bad'> {
  const parsed = PayloadSchema.safeParse(body)
  if (!parsed.success) return 'bad'

  // All field extraction the benign notify.sh no longer does happens HERE.
  const hook = resolveHookIdentity(parsed.data)
  if (!hook) return 'bad'

  const type = mapEventType(hook.hookEvent, hook.agentId)
  if (!type) return 'unknown'

  // Resolve the effective task id up front. A warm-pool-adopted session's
  // payload never carries `taskId` (its env vars were fixed before the task
  // existed — see `poolSessionTaskIdCache` above) — fall back to the DB binding
  // so its hooks aren't silently dropped by every taskId-gated consumer below
  // (was: no spinner, no prompt capture, taskId-less lifecycle events, for the
  // session's whole life).
  let resolvedTaskId = hook.taskId
  if (!resolvedTaskId && hook.slaySessionId) {
    resolvedTaskId = poolSessionTaskIdCache.get(hook.slaySessionId)
    if (!resolvedTaskId) {
      const bound = await getBoundTaskId(deps.db, hook.slaySessionId)
      if (bound) {
        resolvedTaskId = bound
        poolSessionTaskIdCache.set(hook.slaySessionId, bound)
      }
    }
  }

  const event: AgentLifecycleEvent = {
    agentId: hook.agentId,
    hookEvent: hook.hookEvent,
    sessionId: hook.sessionId,
    cwd: hook.cwd,
    raw: hook.raw,
    taskId: resolvedTaskId,
    type,
    timestamp: Date.now()
  }
  deps.agentLifecycle?.emit('event', event)

  // Capture the user's prompt text (UserPromptSubmit) into agent_prompts for
  // the agent-terminal "messages" sidebar. capturePrompt self-gates to
  // capture-capable modes + the UserPromptSubmit event (once per turn → off
  // the per-tool hot path) and is best-effort: fire-and-forget so a DB hiccup
  // never blocks the hook ack.
  if (resolvedTaskId) {
    void capturePrompt(deps.db, {
      agentId: hook.agentId,
      hookEvent: hook.hookEvent,
      taskId: resolvedTaskId,
      sessionId: hook.sessionId,
      raw: hook.raw
    }).catch(() => {
      /* best-effort — never block the hook */
    })
  }

  // PRIMARY resume-id capture — persist the CLI session id into
  // provider_config[agentId].conversationId for the capture agents. Gated to
  // one event per agent (see CONVERSATION_ID_CAPTURE_EVENT) so this stays off
  // the per-tool hot path. `hook.sessionId` already folded in raw.session_id /
  // raw.conversationId fallbacks during identity resolution.
  if (CONVERSATION_ID_CAPTURE_EVENT[hook.agentId] === hook.hookEvent) {
    const cliSessionId = hook.sessionId
    if (hook.taskId && cliSessionId) {
      // Awaited: a single indexed SELECT + UPDATE on local SQLite is sub-ms,
      // and the capture event is low-frequency (repeats short-circuit in the
      // helper) — keeping it deterministic beats a fire-and-forget race.
      await persistConversationId(deps, hook.agentId, hook.taskId, cliSessionId)
      // Mirror onto the live PTY session for the idle-close gate.
      const ptySessionId = bridge?.findSession(hook.taskId, hook.agentId as TerminalMode)
      if (ptySessionId) bridge?.noteConversationId?.(ptySessionId, cliSessionId)
    } else if (!hook.taskId && hook.slaySessionId && cliSessionId) {
      // Pre-warmed POOLED agent: no task yet, so capture the conversation
      // keyed by the SlayZone runtime session id (write-once confirm on the
      // pooled `agent_sessions` row). The session→task binding happens later
      // at pool adoption (`bindSessionToTask`); the resolver then honors this
      // conversation for the bound task. Best-effort — swallow on failure.
      try {
        await confirmSessionConversation(deps.db, {
          sessionId: hook.slaySessionId,
          observedConversationId: cliSessionId
        })
      } catch {
        /* best-effort — pool conversation capture never blocks the hook */
      }
    }
  }

  // Drive the PTY state machine from the hook signal — the source of truth
  // for hook-driven agents (replaces adapter output detection / bullet-glyph
  // regex). gemini/opencode still rely on adapter detection.
  if (bridge && isHookDrivenMode(hook.agentId) && resolvedTaskId) {
    const mode = hook.agentId as TerminalMode
    const sessionId = bridge.findSession(resolvedTaskId, mode)
    if (sessionId) {
      const newState = hookToTerminalState(hook.agentId, hook.hookEvent, hook.raw)
      recordDiagnosticEvent({
        level: 'info',
        source: 'pty',
        event: 'pty.hook_received',
        sessionId,
        taskId: resolvedTaskId,
        message: hook.hookEvent,
        // Include raw payload (truncated) so we can see stop_hook_active,
        // tool_name, tool_response, transcript_path, etc. `channel` makes a
        // future cross-channel notify.sh clobber visible in Diagnostics.
        payload: {
          agentId: hook.agentId,
          channel: hook.channel ?? 'unknown',
          mappedState: newState ?? 'mark-active',
          raw: truncateForDiag(hook.raw, 4096)
        }
      })
      if (newState) {
        bridge.transition(sessionId, newState, hook.hookEvent)
      } else {
        // PostToolUse / SubagentStop / PreCompact / SessionStart: no state
        // change but the agent is alive — refresh the silence-timer clock so
        // the fail-safe doesn't flip running→idle mid-turn.
        bridge.markActive(sessionId)
      }

      // Feed the idle-close gate the authoritative "blocked on user" signal —
      // distinguishes a paused-mid-interaction agent (don't hibernate) from a
      // completed turn (both report 'idle').
      const awaiting = hookToAwaitingUser(hook.agentId, hook.hookEvent, hook.raw)
      if (awaiting !== null) bridge.noteAwaitingInput?.(sessionId, awaiting)
    }
  }

  return 'ok'
}

/**
 * Receives agent lifecycle pings from the bundled `notify.sh` hook script.
 *
 * Auth: NONE. The hook ALWAYS posts to loopback — either the local sidecar's
 * 127.0.0.1 port, or (for a runner-routed pty) the RUNNER's OWN loopback, which
 * relays to the hub over its already-authenticated ws channel. So the agent env
 * carries no per-agent bearer and the route trusts loopback, exactly as the
 * local path always has. Blast radius is renderer-side status updates + a chime.
 *
 * The actual work is `processAgentHook` (shared with the hub's ws-relay
 * consumer); this is a thin Express wrapper mapping its result to a status code.
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
    const result = await processAgentHook(req.body, deps, bridge)
    if (result === 'bad') {
      res.status(400).json({ ok: false, error: 'unresolvable agent-hook envelope' })
      return
    }
    if (result === 'unknown') {
      // Unknown event → drop silently. Never default to Stop.
      res.status(204).end()
      return
    }
    res.json({ ok: true })
  })
}
