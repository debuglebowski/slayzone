import type { Express } from 'express'
import { z } from 'zod'
import type { AgentLifecycleEvent, TerminalState, TerminalMode } from '@slayzone/terminal-contracts'
import { mapEventType } from '@slayzone/terminal-contracts'
import {
  isHookDrivenMode,
  applyAgentHook,
  applyBackgroundJobHook,
  dropBackgroundJobs,
  createAgentTree,
  subagentIdOf,
  unadoptedWarmAgent,
  type AgentTree
} from '@slayzone/terminal/server'
import {
  recordConversation,
  findPendingSpawn,
  findOwnedSpawnForConversation,
  getCurrentConversationId,
  confirmSessionConversation,
  markSessionFirstTurn,
  getTaskOp
} from '@slayzone/task/server'
import { capturePrompt } from '@slayzone/agent-turns/server'
import type { ConversationOrigin } from '@slayzone/task-contracts'
import { recordDiagnosticEvent } from '@slayzone/diagnostics/server'
import type { RestApiDeps, TerminalStateBridge } from './types'
import { getAuthGate } from '@slayzone/trpc-server'
import { jsonBodyParser } from '../json-body'
import { restPrincipalOf } from './principal'
import { hookReporterMayTouch, type HookReporter } from './agent-hook-owner'

// The bridge interface lives in ./types (capability slot on RestApiDeps); the
// Electron host injects the live `@slayzone/terminal/electron` impl, tests
// inject stubs. Re-exported here so existing importers keep working.
export type { TerminalStateBridge } from './types'
export type { HookReporter } from './agent-hook-owner'

/**
 * Per-session claude agent TREE (see `@slayzone/terminal/server` → agent-tree.ts).
 *
 * A claude session is one main loop + N CONCURRENT background subagents sharing
 * one PTY and one hook context, so state cannot be a pure function of the last
 * hook — it is DERIVED from per-session facts (main working / awaiting user /
 * which subagents are in flight). This map holds those facts.
 *
 * Lives here rather than on the PTY session because this route is already the
 * single authority for hook → state (shared by the Express route AND the hub's
 * ws-relay consumer), so there is exactly one writer and no bridge surface to
 * keep in sync. Evicted on `SessionEnd`, and also via `evictAgentTree` below on
 * PTY exit — bounded at one small record per PTY session.
 */
const agentTrees = new Map<string, AgentTree>()

/**
 * Drop a session's agent tree outside the `SessionEnd` hook path — call this on
 * PTY exit (kill/respawn/crash/mode-switch/tab-close: `finalizeSessionExit` in
 * pty-manager.ts is the single funnel for all of them).
 *
 * Without this, a session whose PTY was killed rather than cleanly exited
 * (SIGKILL doesn't let claude fire its own `SessionEnd` hook) leaves its tree
 * behind forever. If that tree still held a subagent id from a `SubagentStop`
 * that never arrived, `resolveState` is permanently stuck returning
 * `'background'` — the spinner never clears even though nothing is running,
 * and a respawn reusing the same session id inherits the same poisoned tree.
 */
export function evictAgentTree(sessionId: string): void {
  agentTrees.delete(sessionId)
  stopBackgroundJobPoll(sessionId)
}

/**
 * Background-job liveness polls — one per session with claude background jobs
 * in flight (`AgentTree.backgroundJobs`).
 *
 * Claude reports a job's START (`PostToolUse` → its id) and an explicit
 * `TaskStop`, but fires NO hook when a job exits on its own — verified: a
 * `sleep 300` finishing mid-turn produced nothing. So while a session has jobs,
 * the route asks the process owner (`bridge.probeBackgroundJobs` → the computer)
 * which are still alive, every {@link BACKGROUND_JOB_POLL_MS}. Self-terminating:
 * the chain stops once the set is empty, and on eviction (pty exit/SessionEnd).
 */
const BACKGROUND_JOB_POLL_MS = 3_000
const backgroundJobPolls = new Map<string, ReturnType<typeof setTimeout>>()

function stopBackgroundJobPoll(sessionId: string): void {
  const timer = backgroundJobPolls.get(sessionId)
  if (timer) clearTimeout(timer)
  backgroundJobPolls.delete(sessionId)
}

/** Publish the session's job count and (re)arm or stop its poll to match. */
function syncBackgroundJobs(sessionId: string, bridge: TerminalStateBridge): void {
  const count = agentTrees.get(sessionId)?.backgroundJobs.size ?? 0
  bridge.noteBackgroundJobs?.(sessionId, count)
  if (count === 0) {
    stopBackgroundJobPoll(sessionId)
    return
  }
  if (backgroundJobPolls.has(sessionId)) return
  const timer = setTimeout(() => {
    backgroundJobPolls.delete(sessionId)
    void pollBackgroundJobs(sessionId, bridge)
  }, BACKGROUND_JOB_POLL_MS)
  timer.unref?.()
  backgroundJobPolls.set(sessionId, timer)
}

async function pollBackgroundJobs(sessionId: string, bridge: TerminalStateBridge): Promise<void> {
  const tree = agentTrees.get(sessionId)
  if (!tree || !bridge.probeBackgroundJobs) return
  const asked = [...tree.backgroundJobs.values()]
  let alive: string[] | null
  try {
    alive = await bridge.probeBackgroundJobs(sessionId, asked)
  } catch {
    // Transient (lost connection): keep what we have and ask again. A computer
    // that is gone for good ends in pty exit → eviction, which stops the chain.
    alive = asked.map((j) => j.id)
  }
  // Evicted / replaced while the probe was in flight: that tree is not ours.
  if (agentTrees.get(sessionId) !== tree) return
  const aliveSet = new Set(alive ?? [])
  dropBackgroundJobs(
    tree,
    asked.filter((j) => !aliveSet.has(j.id)).map((j) => j.id)
  )
  syncBackgroundJobs(sessionId, bridge)
}

function treeFor(sessionId: string): AgentTree {
  let tree = agentTrees.get(sessionId)
  if (!tree) {
    tree = createAgentTree()
    agentTrees.set(sessionId, tree)
  }
  return tree
}

/**
 * Claude Code raw hook → TerminalState, via the session's agent tree.
 *
 * Keys on the RAW event name (not the normalized lifecycle type) because
 * PreToolUse + PostToolUse both normalize to start/stop pairs that would flicker
 * the UI on every tool call inside a single turn. The tree adds the axis a
 * per-event mapping structurally cannot express: WHO fired the hook — the main
 * loop, or one of its background subagents. Without it a helper's PreToolUse
 * asserted "the agent is working" over the main loop's parked-on-a-question
 * state, so the task span green while it waited for an answer AND the amber cue
 * was wiped (`* → running` clears `needs_attention`).
 *
 * Resulting states (full ladder + rationale in agent-tree.ts):
 *   main UserPromptSubmit            → 'running'
 *   main PreToolUse (non-blocking)   → 'running'
 *   main PreToolUse (blocking tool)  → 'idle'       (parked; outranks helpers)
 *   main PostToolUse (blocking tool) → 'running'    (user answered → resumed)
 *   main PostToolUse (non-blocking)  → null         (no-op; mid-turn)
 *   main Stop / SessionEnd           → 'idle', or 'background' if helpers remain
 *   main Notification                → 'idle'
 *   subagent any                     → 'running' while the main loop works,
 *                                      else 'background', draining to 'idle' on
 *                                      the last SubagentStop
 *   SessionStart / PreCompact        → null         (no-op; markActive only)
 */
function claudeCodeHookToTerminalState(
  sessionId: string,
  hookEvent: string,
  raw?: unknown
): TerminalState | null {
  const toolName = (raw as { tool_name?: unknown } | undefined)?.tool_name
  const state = applyAgentHook(treeFor(sessionId), {
    hookEvent,
    toolName: typeof toolName === 'string' ? toolName : undefined,
    subagentId: subagentIdOf(raw)
  })
  // Session over — drop the tree so a long-lived app doesn't accumulate one per
  // session. Routed through the same `evictAgentTree` the pty-exit paths use
  // (rather than an inline delete) so there is exactly one place that can ever
  // diverge in what "evict" means.
  if (hookEvent === 'SessionEnd') evictAgentTree(sessionId)
  return state
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
 * `provider_config[mode].conversationId` (the hook's mode — see `ResolvedHook.mode`)
 * for deterministic resume-by-id.
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
 * Conversation ids already marked as having taken a turn (v158). The DB write is
 * write-once and idempotent, so this only exists to keep a repeat turn from
 * issuing a no-op UPDATE on every prompt for the life of the process.
 */
const firstTurnMarked = new Set<string>()

/**
 * E2E reset: drop every agent tree, poll and first-turn mark. The e2e reset wipes
 * the DB in-process (no side-car restart), so without this a reused session id
 * inherits a stale tree and a reused conversation id skips its first-turn write.
 */
export function resetAgentHookStateForTest(): void {
  for (const timer of backgroundJobPolls.values()) clearTimeout(timer)
  backgroundJobPolls.clear()
  agentTrees.clear()
  firstTurnMarked.clear()
}

/**
 * Hook events that PROVE a conversation has content on disk. A turn is what makes
 * a provider write its transcript — until one happens, `--resume <id>` fails even
 * though slay has known the id since spawn (see migration v158).
 *
 * `UserPromptSubmit` is the canonical human turn and already the once-per-turn
 * event on this route; `Stop` is the backstop for a turn that began some other
 * way. Deliberately NOT the per-tool events: they would fire this on the hot path
 * for no extra information, and NOT `SessionStart` — that is exactly the signal
 * that lied, since it fires before a single byte is written.
 */
const TURN_PROOF_EVENTS = new Set(['UserPromptSubmit', 'Stop'])

/** Dispatch to the per-agent raw-hook-event → TerminalState mapper. Only claude
 *  needs the sessionId: it is the one provider with a concurrent agent tree, so
 *  its state is derived from per-session facts rather than the lone event. */
function hookToTerminalState(
  agentId: string,
  sessionId: string,
  hookEvent: string,
  raw?: unknown
): TerminalState | null {
  if (agentId === 'codex') return codexHookToTerminalState(hookEvent)
  if (agentId === 'antigravity') return antigravityHookToTerminalState(hookEvent)
  return claudeCodeHookToTerminalState(sessionId, hookEvent, raw)
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
function hookToAwaitingUser(agentId: string, sessionId: string, hookEvent: string): boolean | null {
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
  // claude-code: the agent tree already owns this fact — it is the same
  // `awaitingUser` axis the state ladder resolves from, updated by
  // `claudeCodeHookToTerminalState` immediately before this call. Reading it back
  // (instead of re-deriving from the event) keeps ONE truth, and gives the
  // hibernation gate the subagent fix for free: a helper's PreToolUse no longer
  // reports "not blocked" for a main loop that is parked on a question, so a task
  // mid-question can no longer be idle-closed.
  return agentTrees.get(sessionId)?.awaitingUser ?? null
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
 *       - ctx : the app-packed identity blob (`SLAYZONE_AGENT_HOOK_CONTEXT`, or the
 *               retired `SLAYZONE_HOOK_CONTEXT` from a pre-rename app) —
 *               `{ v, taskId, projectId, agentId, releaseChannel }`. A blob from an
 *               agent booted by an older build may also carry `slaySessionId`;
 *               nothing reads it any more.
 *       - raw : the stdin hook payload (Claude/Codex/Gemini/Antigravity), or null.
 *       - arg : argv $1 (Antigravity's event NAME, or the OpenCode plugin's whole
 *               JSON payload) as a string, or null.
 *     ALL field extraction (event name, session ids, cwd) is done HERE, on the
 *     server — never in the shared shell script (the file that rots when an
 *     older release channel clobbers it).
 *
 *   LEGACY (old installed scripts + old released apps): flat
 *     `{ agentId, hookEvent, sessionId?, taskId?, cwd?, raw? }`.
 *     Still fully resolves — no flag day.
 */
const PayloadSchema = z.object({
  agentId: z.string().optional(),
  hookEvent: z.string().optional(),
  sessionId: z.string().optional(),
  taskId: z.string().optional(),
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
  /**
   * The terminal MODE this hook belongs to — the key of the conversation ledger
   * and the PTY registry. Equals `agentId` for a built-in; a user-defined provider
   * has its own mode id while running a built-in agent, and only the agent may
   * travel in `agentId` (`isAgentId`). Carried as `ctx.mode` (see `buildMcpEnv`),
   * absent when equal — so every built-in and legacy payload resolves unchanged.
   */
  mode: string
  hookEvent: string
  taskId?: string
  /** CLI session UUID (claude/codex `session_id`, antigravity `conversationId`). */
  sessionId?: string
  /**
   * `SessionStart.source` — WHY the agent started this session. Claude Code
   * emits: `startup` | `resume` | `clear` | `compact` | `fork`. Load-bearing for
   * exactly one case: `clear` is the agent rotating its own session id in place,
   * which the id-match provenance gate would otherwise read as a hijack (see
   * `persistConversationId`). Absent on every other hook event.
   */
  source?: string
  cwd?: string
  raw?: unknown
  /** Attribution only — which release channel fired the hook (from the blob). */
  releaseChannel?: string
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
    mode: typeof ctx?.mode === 'string' && ctx.mode ? ctx.mode : agentIdRaw,
    hookEvent,
    source: typeof effRaw?.source === 'string' ? effRaw.source : undefined,
    taskId: body.taskId ?? (typeof ctx?.taskId === 'string' ? ctx.taskId : undefined),
    sessionId: cliSessionId,
    cwd: body.cwd ?? (typeof effRaw?.cwd === 'string' ? effRaw.cwd : undefined),
    raw: effRaw ?? body.raw,
    releaseChannel: typeof ctx?.releaseChannel === 'string' ? ctx.releaseChannel : undefined
  }
}

/**
 * Persist a CLI's session_id (carried by its `SessionStart` hook) to the task's
 * `provider_config[mode].conversationId` so the session can be resumed
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
 * resolved via `bridge.findSession`. Keyed by `mode` (`ResolvedHook.mode`), never
 * the agent id: they differ for a user-defined provider wrapping a capture agent.
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
  mode: string,
  taskId: string,
  sessionId: string,
  /** `SessionStart.source` — see `ResolvedHook.source`. Only `'clear'` alters
   *  the decision below; every other value falls through to the id-match gate. */
  source?: string
): Promise<void> {
  try {
    // The task's board row as the renderer sees it (`provider_config` legacy
    // mirror + `currentConversationByMode`), captured before the write so the
    // refresh below fires only when the row actually changed. Every resume of a
    // conversation already bound — each agent respawn, ~60 at a hub boot —
    // re-records the same id and changes nothing on the board; pinging every
    // renderer for those was pure refetch traffic.
    const rowBefore = await boardRowSnapshot(deps, taskId)
    const notifyIfRowChanged = async (): Promise<void> => {
      const rowAfter = await boardRowSnapshot(deps, taskId)
      // Unreadable either side → can't prove "unchanged": notify.
      if (rowAfter !== null && rowAfter === rowBefore) return
      deps.notifyRenderer({ taskIds: [taskId] })
    }
    // ── In-band id rotation (`/clear`) ────────────────────────────────────────
    // The agent dropped its conversation and minted a NEW session id without
    // restarting its process. The id-match gate below cannot classify this: the
    // reported id necessarily differs from the one slay pre-minted, which reads
    // identically to a hijack (`claude --resume <foreign>`), so a `/clear` was
    // recorded `foreign-observed` — audit-only. The user-visible damage was that
    // the task kept resuming the PRE-clear conversation and the cleared session
    // never appeared in the sessions sidebar.
    //
    // What makes honoring it safe is that `source` and ownership are checked
    // TOGETHER. `source === 'clear'` is self-reported by the agent, so on its own
    // it would let any process claiming `clear` rebind the task; ownership alone
    // is too weak because a manual `--resume` typed in the same terminal inherits
    // the same environment. So we additionally require that slay recorded a spawn
    // for this (task, mode) whose id is the conversation being REPLACED — a
    // pre-minted id only slay's own command line could have introduced. A hijack
    // fails on `source` (`resume`/`startup`), and a `clear` from an unrelated
    // terminal fails on ownership.
    //
    // Scoped to `clear` on purpose: `compact` and `fork` also fire SessionStart,
    // but `compact` keeps the same id (already honored, nothing to fix) and
    // `fork`'s id semantics are unverified — left on the existing gate.
    if (source === 'clear') {
      const outgoing = await getCurrentConversationId(deps.db, taskId, mode)
      // Idempotence: a repeated SessionStart for a clear we already recorded
      // makes the new id the current one, so `outgoing === sessionId`. Nothing to
      // do — falling through would record a duplicate row every replay.
      if (outgoing === sessionId) return
      // No outgoing conversation (a task that never bound an id) → there is
      // nothing to claim ownership OF, so skip the lookup and let the standard
      // gate handle it as an ordinary first spawn.
      const ownedSpawn = outgoing
        ? await findOwnedSpawnForConversation(deps.db, taskId, mode, outgoing)
        : null
      if (ownedSpawn) {
        await recordConversation(deps.db, {
          taskId,
          mode,
          conversationId: sessionId,
          origin: 'in-band-clear'
        })
        await notifyIfRowChanged()
        return
      }
      // No ownership claim → fall through to the standard gate, which will
      // classify it `foreign-observed` exactly as before.
    }

    // Provenance gate: look up the `pending-spawn` row slay wrote when it
    // launched the agent. If the CLI session id matches that row's expected
    // id, record it as honored (`slay-spawned-*`). If it doesn't — or no
    // pending row exists — record as `foreign-observed` (audit only, never
    // honored on read). This closes the RC1 eager-persist clobber: a manual
    // `claude --resume <foreign>` inside a slay PTY can no longer bind the
    // foreign session to the task.
    const pending = await findPendingSpawn(deps.db, taskId, mode)
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
      mode,
      conversationId: sessionId,
      origin
    })
    // Pending row stays — repeated SessionStart payloads on the same spawn
    // are idempotent (we just append another row with the same origin).
    // The row is pruned by the PTY-exit hook OR the periodic TTL sweep.
    if (origin !== 'foreign-observed') await notifyIfRowChanged()
  } catch {
    // Best-effort — adapter `/status` + disk-scan fallbacks still cover capture.
  }
}

/** Serialized board row of a task (null when it does not exist / cannot be read). */
async function boardRowSnapshot(deps: RestApiDeps, taskId: string): Promise<string | null> {
  try {
    return JSON.stringify(await getTaskOp(deps.db, taskId))
  } catch {
    return null
  }
}

/**
 * Process ONE agent-hook envelope — the SINGLE authority shared by the Express
 * route (local loopback hooks) AND the hub's computer-relay consumer (a remote
 * computer relays the envelope over its ws channel — see the hub composition
 * root). Pure of Express so both callers reuse the exact same field-resolution,
 * state-machine, prompt-capture, and conversation-id logic — no duplication, no
 * drift.
 *
 * Returns a status the HTTP caller maps to a response:
 *   - 'ok'      → 200 (processed).
 *   - 'unknown' → 204 (event derived but not mappable; never default to Stop).
 *   - 'bad'     → 400 (no usable identity in the envelope).
 *   - 'denied'  → 404 (a hub with login: the reporter may not touch what the event
 *                 names — see agent-hook-owner.ts; dropped with one audit line).
 * The ws relay consumer ignores the return (fire-and-forget).
 *
 * `reporter`: who reports the event — the REST principal, or the owner of the
 * computer that relayed it. Read only on a hub with login, where it is required.
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
  bridge: TerminalStateBridge | undefined,
  reporter?: HookReporter
): Promise<'ok' | 'unknown' | 'bad' | 'denied'> {
  const parsed = PayloadSchema.safeParse(body)
  if (!parsed.success) return 'bad'

  // All field extraction the benign notify.sh no longer does happens HERE.
  const hook = resolveHookIdentity(parsed.data)
  if (!hook) return 'bad'

  const type = mapEventType(hook.hookEvent, hook.agentId)
  if (!type) return 'unknown'

  // A warm agent boots with the id of a task created later, if ever. Until a terminal
  // adopts it, the pool still holds it and its hooks are the pool's, not the task's.
  const warmAgent = hook.taskId ? unadoptedWarmAgent(hook.taskId) : null

  // A hub with login: nothing below runs unless the reporter may touch the task (or,
  // for an unadopted warm agent, the pool's agent) this event names (T-18). The
  // desktop app's hub skips the check.
  if (
    getAuthGate() &&
    !(await hookReporterMayTouch(deps.db, reporter, { taskId: hook.taskId }, hook.hookEvent))
  ) {
    return 'denied'
  }

  if (warmAgent) {
    // Its task has no terminal yet (and may have no row), so there is no lifecycle
    // to report, no prompt to capture and no state machine to drive. The one thing
    // to keep is the conversation the agent booted into: confirm it on the pooled
    // session (write-once, exact match against the id minted at boot). Adoption binds
    // that session to the task, which makes the conversation the task's resume target.
    if (CONVERSATION_ID_CAPTURE_EVENT[hook.agentId] === hook.hookEvent && hook.sessionId) {
      try {
        await confirmSessionConversation(deps.db, {
          sessionId: warmAgent.sessionId,
          observedConversationId: hook.sessionId
        })
      } catch {
        /* best-effort — pool conversation capture never blocks the hook */
      }
    }
    return 'ok'
  }

  const event: AgentLifecycleEvent = {
    agentId: hook.agentId,
    hookEvent: hook.hookEvent,
    sessionId: hook.sessionId,
    cwd: hook.cwd,
    raw: hook.raw,
    taskId: hook.taskId,
    type,
    timestamp: Date.now()
  }
  deps.agentLifecycle?.emit('event', event)

  // Capture the user's prompt text (UserPromptSubmit) into agent_prompts for
  // the agent-terminal "messages" sidebar. capturePrompt self-gates to
  // capture-capable modes + the UserPromptSubmit event (once per turn → off
  // the per-tool hot path) and is best-effort: fire-and-forget so a DB hiccup
  // never blocks the hook ack.
  if (hook.taskId) {
    void capturePrompt(deps.db, {
      agentId: hook.agentId,
      hookEvent: hook.hookEvent,
      taskId: hook.taskId,
      sessionId: hook.sessionId,
      raw: hook.raw
    }).catch(() => {
      /* best-effort — never block the hook */
    })
  }

  // Resumability proof (v158) — this is the moment `--resume <id>` starts
  // working, so it is the moment the id may be handed out as a resume target.
  // Keyed by CONVERSATION id, not task: it marks the conversation itself, whichever
  // task holds it. Fire-and-forget: a DB hiccup must never block the ack, and the
  // next turn re-attempts.
  if (
    hook.sessionId &&
    TURN_PROOF_EVENTS.has(hook.hookEvent) &&
    !firstTurnMarked.has(hook.sessionId)
  ) {
    const provenId = hook.sessionId
    firstTurnMarked.add(provenId)
    void markSessionFirstTurn(deps.db, provenId).catch(() => {
      // Let a later turn retry rather than leaving the session unresumable.
      firstTurnMarked.delete(provenId)
    })
  }

  // PRIMARY resume-id capture — persist the CLI session id into
  // provider_config[mode].conversationId for the capture agents. Gated to
  // one event per agent (see CONVERSATION_ID_CAPTURE_EVENT) so this stays off
  // the per-tool hot path. `hook.sessionId` already folded in raw.session_id /
  // raw.conversationId fallbacks during identity resolution.
  if (CONVERSATION_ID_CAPTURE_EVENT[hook.agentId] === hook.hookEvent) {
    const cliSessionId = hook.sessionId
    if (hook.taskId && cliSessionId) {
      // Awaited: a single indexed SELECT + UPDATE on local SQLite is sub-ms,
      // and the capture event is low-frequency (repeats short-circuit in the
      // helper) — keeping it deterministic beats a fire-and-forget race.
      await persistConversationId(deps, hook.mode, hook.taskId, cliSessionId, hook.source)
      // Mirror onto the live PTY session for the idle-close gate.
      const ptySessionId = bridge?.findSession(hook.taskId, hook.mode as TerminalMode)
      if (ptySessionId) bridge?.noteConversationId?.(ptySessionId, cliSessionId)
    }
  }

  // Drive the PTY state machine from the hook signal — the source of truth
  // for hook-driven agents (replaces adapter output detection / bullet-glyph
  // regex). gemini/opencode still rely on adapter detection.
  // Hook-driven is a property of the AGENT; the PTY is found by its MODE.
  if (bridge && isHookDrivenMode(hook.agentId) && hook.taskId) {
    const sessionId = bridge.findSession(hook.taskId, hook.mode as TerminalMode)
    if (sessionId) {
      const newState = hookToTerminalState(hook.agentId, sessionId, hook.hookEvent, hook.raw)
      const subagentId = subagentIdOf(hook.raw)
      const agentType = (hook.raw as { agent_type?: unknown } | undefined)?.agent_type
      recordDiagnosticEvent({
        level: 'info',
        source: 'pty',
        event: 'pty.hook_received',
        sessionId,
        taskId: hook.taskId,
        message: hook.hookEvent,
        // Include raw payload (truncated) so we can see stop_hook_active,
        // tool_name, tool_response, transcript_path, etc. `releaseChannel` makes
        // a future cross-release-channel notify.sh clobber visible in Diagnostics.
        payload: {
          agentId: hook.agentId,
          mode: hook.mode,
          releaseChannel: hook.releaseChannel ?? 'unknown',
          mappedState: newState ?? 'mark-active',
          // WHO fired this hook — the main loop or a background subagent — plus
          // the live tree. Surfaced because diagnosing the subagent-masks-a-
          // pending-question bug otherwise required cross-checking the agent's
          // own transcript to tell the two apart.
          subagent: subagentId ? { id: subagentId, type: agentType ?? 'unknown' } : false,
          agentTree: agentTrees.get(sessionId)
            ? {
                mainWorking: agentTrees.get(sessionId)!.mainWorking,
                awaitingUser: agentTrees.get(sessionId)!.awaitingUser,
                activeSubagents: agentTrees.get(sessionId)!.subagents.size
              }
            : undefined,
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

      // Claude background jobs: a separate fact from the state above (see
      // agent-tree.ts). Only tracked when something can probe their liveness —
      // a count nothing could ever clear would stick forever.
      if (
        hook.agentId === 'claude-code' &&
        bridge.probeBackgroundJobs &&
        hook.hookEvent === 'PostToolUse' &&
        applyBackgroundJobHook(treeFor(sessionId), hook.hookEvent, hook.raw)
      ) {
        syncBackgroundJobs(sessionId, bridge)
      }
      // SessionEnd evicted the tree (and its jobs) above; the PTY may live on
      // (`/clear`), so its published count must not outlive the tree.
      if (hook.hookEvent === 'SessionEnd') bridge.noteBackgroundJobs?.(sessionId, 0)

      // Feed the idle-close gate the authoritative "blocked on user" signal —
      // distinguishes a paused-mid-interaction agent (don't hibernate) from a
      // completed turn (both report 'idle').
      const awaiting = hookToAwaitingUser(hook.agentId, sessionId, hook.hookEvent)
      if (awaiting !== null) bridge.noteAwaitingInput?.(sessionId, awaiting)
    }
  }

  return 'ok'
}

/**
 * Receives agent lifecycle pings from the bundled `notify.sh` hook script.
 *
 * Auth: NONE. The hook ALWAYS posts to loopback — either the local sidecar's
 * 127.0.0.1 port, or (for a computer-routed pty) the COMPUTER's OWN loopback, which
 * relays to the hub over its already-authenticated ws channel. So the agent env
 * carries no per-agent bearer and the route trusts loopback, exactly as the
 * local path always has. Blast radius is renderer-side status updates + a chime.
 * On a hub with login the bearer gate does apply, and the event is reported as the
 * signed-in caller: it may only touch that caller's task (T-18).
 *
 * The actual work is `processAgentHook` (shared with the hub's ws-relay
 * consumer); this is a thin Express wrapper mapping its result to a status code.
 */
export const AGENT_HOOK_PATH = '/api/agent-hook'
/** Above the 100 KB default — SessionStart payloads can carry the full tool list. */
export const AGENT_HOOK_BODY_LIMIT = '1mb'

export function registerAgentHookRoute(
  app: Express,
  deps: RestApiDeps,
  bridgeOverride?: TerminalStateBridge
): void {
  // Tests override; the host injects via deps. Absent (standalone server until
  // the pty runtime lands there): conversation-id capture + diagnostics still
  // run, state transitions are skipped.
  const bridge = bridgeOverride ?? deps.terminalStateBridge
  // createMcpRestApp's app-wide parser already applies this limit to the path; this
  // one serves an app that mounts the route without it (it is a no-op on a parsed body).
  const jsonParser = jsonBodyParser({ limit: AGENT_HOOK_BODY_LIMIT })

  app.post(AGENT_HOOK_PATH, jsonParser, async (req, res) => {
    // On a hub with login the bearer gate bound the caller: the event is reported as
    // them (agent-hook-owner.ts). Absent on the desktop app's hub, where nothing checks.
    const principal = restPrincipalOf(req)
    const result = await processAgentHook(req.body, deps, bridge, {
      userId: principal?.userId ?? null,
      computerId: null
    })
    if (result === 'denied') {
      res.status(404).json({ ok: false, error: 'Not found' })
      return
    }
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
