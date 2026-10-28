import type { TerminalState } from '@slayzone/terminal-contracts'

/**
 * The claude agent TREE — the model behind `TerminalState` for hook-driven claude
 * sessions.
 *
 * WHY THIS EXISTS: a claude session is NOT one agent. It is one main loop plus N
 * *concurrent background subagents*, all sharing one PTY, one CLI session id, and
 * one `SLAYZONE_AGENT_HOOK_CONTEXT`. Every one of them fires the same hooks down
 * the same pipe. Mapping each hook straight to a state (the old
 * `claudeCodeHookToTerminalState`) therefore let a subagent's `PreToolUse` assert
 * "the agent is working" while the MAIN loop sat parked on an unanswered
 * question — measured in the live app as 37 minutes of green spinner on a task
 * that was waiting for the user, with the amber "needs you" cue wiped by the
 * same transition (`* → running` clears `needs_attention`).
 *
 * So state is DERIVED from two independent facts kept per session, rather than
 * dictated by whichever hook arrived last:
 *
 *   awaitingUser  — the main loop is blocked on a user answer   (highest priority)
 *   mainWorking   — the main loop is mid-turn
 *   subagents     — ids of background subagents still in flight
 *
 * Priority is explicit in `resolveState` and is the whole point of the model:
 *
 *   awaiting the user  →  'idle'        (+ needs_attention: "this needs me")
 *   main loop working  →  'running'
 *   only helpers left  →  'background'  (work in flight, but nothing needs me)
 *   nothing            →  'idle'
 *
 * `awaitingUser` outranking activity is what fixes the bug: a helper's tool call
 * can no longer overwrite "waiting for your answer".
 *
 * Pure and synchronous — no PTY, no DB, no Electron. One tree per session lives
 * in the hook route (the single authority for hook → state).
 */

/**
 * Built-in claude tools that BLOCK the main loop waiting for a user keystroke.
 * Claude fires no `Notification` for these (that covers permission_prompt,
 * idle_prompt, auth_success and MCP elicitation — not native blocking tools), so
 * this allowlist is the only signal that the main loop parked.
 *
 * A blocking tool has no ran-but-failed state: ACCEPT/answer runs the tool →
 * `PostToolUse` fires; REJECT/Esc denies it → no `PostToolUse` ever arrives. That
 * asymmetry is what lets `PostToolUse` be read as "the user answered" without
 * inspecting `is_error` (which the payload doesn't even carry).
 *
 * Add new blocking built-ins here as Anthropic ships them — pause AND resume are
 * both derived from this one set, so there is nothing else to keep in sync.
 */
export const CLAUDE_BLOCKING_TOOLS: ReadonlySet<string> = new Set([
  'AskUserQuestion',
  'ExitPlanMode'
])

export interface AgentTree {
  /** Main loop is mid-turn (prompt submitted / running its own tools). */
  mainWorking: boolean
  /** Main loop is parked on a blocking tool waiting for the user. */
  awaitingUser: boolean
  /** `agent_id`s of background subagents still working. Exact, not a count:
   *  every subagent hook carries its `agent_id` and `SubagentStop` carries the
   *  same id (verified 400/400 in live diagnostics), so entries are added and
   *  removed by identity — a missed event can't corrupt a counter. */
  subagents: Set<string>
  /** Background jobs claude started (`Bash` run_in_background or auto-backgrounded
   *  on timeout, `Monitor`), keyed by claude's task id. Deliberately NOT part of
   *  {@link resolveState}: a long-lived dev server must not hold the session out
   *  of 'idle' — the turn ending still has to fire the amber "your turn" cue. It
   *  is a separate fact (sidebar indicator + idle-close guard). Claude fires NO
   *  hook when a job exits on its own, so the hook route prunes this against the
   *  computer's process table ({@link dropBackgroundJobs}). */
  backgroundJobs: Map<string, BackgroundJob>
}

export type BackgroundJobKind = 'shell' | 'monitor'

export interface BackgroundJob {
  /** claude's task id (`bg7siv1aw`) — what `TaskStop` and the output file name use. */
  id: string
  /** `shell`: Bash; its stdout is `<…>/tasks/<id>.output`. `monitor`: Monitor;
   *  stdout is a pipe, so only its command line identifies it. */
  kind: BackgroundJobKind
  command: string | null
}

/** One hook, reduced to only what the tree cares about. */
export interface AgentHookSignal {
  hookEvent: string
  /** `tool_name` for Pre/PostToolUse. */
  toolName?: string | undefined
  /** claude `agent_id` — PRESENT ⇒ this hook came from a background subagent,
   *  ABSENT ⇒ it came from the main loop. The discriminator the whole model
   *  rests on; main-loop payloads never carry it. */
  subagentId?: string | undefined
}

export function createAgentTree(): AgentTree {
  return {
    mainWorking: false,
    awaitingUser: false,
    subagents: new Set(),
    backgroundJobs: new Map()
  }
}

/** Extract the subagent id from a raw claude hook payload (`agent_id`). Returns
 *  undefined for main-loop hooks, which carry no such field. */
export function subagentIdOf(raw: unknown): string | undefined {
  const id = (raw as { agent_id?: unknown } | undefined)?.agent_id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/** Derive the session's state from the tree. The priority ladder — see header. */
export function resolveState(tree: AgentTree): TerminalState {
  if (tree.awaitingUser) return 'idle'
  if (tree.mainWorking) return 'running'
  if (tree.subagents.size > 0) return 'background'
  return 'idle'
}

/**
 * Fold one hook into the tree and return the state the session should now hold,
 * or `null` for "no state opinion — just refresh the activity clock".
 *
 * MUTATES `tree` (it is the session's own record) and is the ONLY writer of it.
 *
 * `null` is returned for the events that were deliberate no-ops before and stay
 * that way, so a mid-turn tool storm can't flicker the sidebar:
 *   - main `PostToolUse` for a non-blocking tool (agent is still working; only
 *     `Stop` ends a turn)
 *   - `SessionStart` / `PreCompact` (mid-turn or PTY-owned settle)
 */
export function applyAgentHook(tree: AgentTree, sig: AgentHookSignal): TerminalState | null {
  // ── Background subagent ────────────────────────────────────────────────────
  // Track liveness ONLY. A subagent must never speak for the main loop: it may
  // not set mainWorking and it may not clear awaitingUser. That restraint IS the
  // fix — everything else here is bookkeeping.
  if (sig.subagentId) {
    if (sig.hookEvent === 'SubagentStop') tree.subagents.delete(sig.subagentId)
    else tree.subagents.add(sig.subagentId)
    // While the main loop works, its own 'running' already covers the session and
    // a helper's churn must not downgrade it; resolveState returns 'running'
    // anyway, so this is a same-state no-op the machine skips. Once the main loop
    // is done, the same call is what surfaces (and later drains) 'background'.
    return resolveState(tree)
  }

  // ── Main loop ──────────────────────────────────────────────────────────────
  switch (sig.hookEvent) {
    case 'UserPromptSubmit':
      tree.mainWorking = true
      tree.awaitingUser = false
      return resolveState(tree)

    case 'PreToolUse': {
      const blocking = !!sig.toolName && CLAUDE_BLOCKING_TOOLS.has(sig.toolName)
      tree.mainWorking = !blocking
      tree.awaitingUser = blocking
      return resolveState(tree)
    }

    case 'PostToolUse': {
      // Only a BLOCKING tool's PostToolUse carries information: it proves the
      // user answered/accepted, and it is the ONLY such proof (no
      // UserPromptSubmit fires on accept), so without it the spinner stays dark
      // through the whole post-accept stretch — measured at 2+ minutes before
      // the agent's next tool call. Non-blocking PostToolUse stays a no-op.
      if (sig.toolName && CLAUDE_BLOCKING_TOOLS.has(sig.toolName)) {
        tree.mainWorking = true
        tree.awaitingUser = false
        return resolveState(tree)
      }
      return null
    }

    case 'Stop':
    case 'SessionEnd':
      // Turn over / session over. Any subagents still in flight now surface as
      // 'background' instead of being flattened to 'idle'.
      tree.mainWorking = false
      tree.awaitingUser = false
      return resolveState(tree)

    case 'Notification':
      // Claude paused for the user (permission prompt, idle prompt, …). Ends the
      // working stretch, but deliberately does NOT set awaitingUser: its dominant
      // subtype is `idle_prompt` (waiting for the NEXT instruction), which is
      // exactly the stale case idle-close SHOULD be allowed to hibernate.
      tree.mainWorking = false
      return resolveState(tree)

    default:
      // SessionStart / PreCompact / unknown: alive, but no state opinion.
      return null
  }
}

/** Tools that stop a background job by id. `KillShell` is the pre-`TaskStop` name. */
const BACKGROUND_JOB_STOP_TOOLS: ReadonlySet<string> = new Set(['TaskStop', 'KillShell'])

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * Fold one hook into the tree's background-job set. Returns whether the set
 * changed. Main loop and subagents alike (a subagent's job outlives nothing
 * special — it is the same claude process's child).
 *
 * Only `PostToolUse` carries the job id (claude assigns it when the tool returns):
 *   Bash    → `tool_response.backgroundTaskId` (explicit run_in_background AND a
 *             foreground command auto-backgrounded on timeout)
 *   Monitor → `tool_response.taskId`
 *   TaskStop / KillShell → `tool_response.task_id` / `tool_input.task_id|shell_id`
 */
export function applyBackgroundJobHook(tree: AgentTree, hookEvent: string, raw: unknown): boolean {
  if (hookEvent !== 'PostToolUse' || !raw || typeof raw !== 'object') return false
  const r = raw as {
    tool_name?: unknown
    tool_input?: Record<string, unknown>
    tool_response?: Record<string, unknown>
  }
  const tool = str(r.tool_name)
  const input = r.tool_input && typeof r.tool_input === 'object' ? r.tool_input : {}
  const response = r.tool_response && typeof r.tool_response === 'object' ? r.tool_response : {}

  if (tool && BACKGROUND_JOB_STOP_TOOLS.has(tool)) {
    const id = str(response.task_id) ?? str(input.task_id) ?? str(input.shell_id)
    return id !== null && tree.backgroundJobs.delete(id)
  }

  let job: BackgroundJob | null = null
  if (tool === 'Bash') {
    const id = str(response.backgroundTaskId)
    if (id) job = { id, kind: 'shell', command: str(input.command) }
  } else if (tool === 'Monitor') {
    const id = str(response.taskId)
    if (id) job = { id, kind: 'monitor', command: str(input.command) }
  }
  if (!job || tree.backgroundJobs.has(job.id)) return false
  tree.backgroundJobs.set(job.id, job)
  return true
}

/** Forget jobs whose process is gone. Returns whether any were tracked. Takes
 *  the dead ids, not the alive ones: a liveness probe only speaks for the jobs it
 *  was asked about, never for one started while it was in flight. */
export function dropBackgroundJobs(tree: AgentTree, deadIds: Iterable<string>): boolean {
  let changed = false
  for (const id of deadIds) changed = tree.backgroundJobs.delete(id) || changed
  return changed
}
