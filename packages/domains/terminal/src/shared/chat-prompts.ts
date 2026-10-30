/**
 * Prompt model: the agent's open questions to the user — permission requests,
 * AskUserQuestion, plan approval — derived from the chat event log alone, so a
 * reload (a replay of the same events) rebuilds exactly the same state.
 *
 *   permission-request   → pending
 *   permission-resolved  → resolved (the host answered; decision kept)
 *   permission-cancelled → cancelled (the CLI withdrew it)
 *   process-exit / session-spawn / interrupted → every pending one expired
 *     (its process can no longer take an answer)
 *   tool-result for the request's tool → resolved (logs written before
 *     `permission-resolved` existed)
 *
 * Keyed by request id, never by tool id: Codex approvals can carry an empty one.
 *
 * Every prompt of the conversation is kept (in arrival order), so an event finds
 * its prompt through indexes — the request id's position, the pending ones —
 * never by scanning them all: a session in a mode that asks for every tool call
 * has as many prompts as tool calls, and a scan per event made replay quadratic.
 *
 * @module shared/chat-prompts
 */
import type {
  AgentEvent,
  PermissionDecision,
  PermissionRequestEvent
} from '@slayzone/terminal-contracts'
import { PersistentIndex } from './persistent-index'
import { appended, writable } from './replay-batch'

export type ChatPromptStatus = 'pending' | 'resolved' | 'cancelled' | 'expired'

export interface ChatPrompt {
  requestId: string
  toolUseId: string
  toolName: string
  input: unknown
  /** The request as the CLI sent it (display fields, permission suggestions). */
  request: PermissionRequestEvent
  status: ChatPromptStatus
  /** The host's answer; null until resolved, and for answers older logs don't record. */
  decision: PermissionDecision | null
  /** The prompt row the user picked (display only). */
  optionId: string | null
}

export interface PromptState {
  prompts: ChatPrompt[]
  /** Request id → its position in `prompts`. */
  promptIndex: PersistentIndex<number>
  /** Positions in `prompts` of the pending ones, ascending. */
  pendingPrompts: readonly number[]
}

/** No prompts yet. */
export function initialPromptState(): PromptState {
  return { prompts: [], promptIndex: PersistentIndex.empty(), pendingPrompts: [] }
}

const isPending = (p: ChatPrompt): boolean => p.status === 'pending'

/**
 * Change the prompts at `positions` (ascending) that `matches` accepts — the
 * same result as mapping every prompt, read through the positions instead.
 */
function update<S extends PromptState>(
  state: S,
  positions: Iterable<number>,
  matches: (p: ChatPrompt) => boolean,
  change: (p: ChatPrompt) => ChatPrompt
): S {
  let prompts: ChatPrompt[] | null = null
  let pending: number[] | null = null
  for (const at of positions) {
    const p = state.prompts[at]
    if (!p || !matches(p)) continue
    const next = change(p)
    prompts ??= writable(state.prompts)
    prompts[at] = next
    if (isPending(p) !== isPending(next)) {
      pending ??= writable(state.pendingPrompts)
      if (isPending(next)) {
        let i = pending.length
        while (i > 0 && pending[i - 1] > at) i--
        pending.splice(i, 0, at)
      } else {
        pending.splice(pending.indexOf(at), 1)
      }
    }
  }
  if (!prompts) return state
  return { ...state, prompts, ...(pending ? { pendingPrompts: pending } : {}) }
}

/** The position of request `requestId`, as a list (empty when unknown). */
function positionOf(state: PromptState, requestId: string): number[] {
  const at = state.promptIndex.get(requestId)
  return at === undefined ? [] : [at]
}

/** Apply one event's effect on the prompt list (identity when it has none). */
export function applyPromptEvent<S extends PromptState>(state: S, event: AgentEvent): S {
  switch (event.kind) {
    case 'permission-request': {
      if (state.promptIndex.has(event.requestId)) return state
      const prompt: ChatPrompt = {
        requestId: event.requestId,
        toolUseId: event.toolUseId,
        toolName: event.toolName,
        input: event.input,
        request: event,
        status: 'pending',
        decision: null,
        optionId: null
      }
      const at = state.prompts.length
      return {
        ...state,
        prompts: appended(state.prompts, prompt),
        promptIndex: state.promptIndex.with(event.requestId, at),
        pendingPrompts: appended(state.pendingPrompts, at)
      }
    }
    case 'permission-resolved':
      return update(
        state,
        positionOf(state, event.requestId),
        (p) => p.requestId === event.requestId && p.status !== 'resolved',
        (p) => ({
          ...p,
          status: 'resolved',
          decision: event.decision,
          optionId: event.optionId ?? null
        })
      )
    case 'permission-cancelled':
      return update(
        state,
        positionOf(state, event.requestId),
        (p) => p.requestId === event.requestId && isPending(p),
        (p) => ({ ...p, status: 'cancelled' })
      )
    case 'tool-result':
      if (!event.toolUseId || state.pendingPrompts.length === 0) return state
      return update(
        state,
        state.pendingPrompts.slice(),
        (p) => p.toolUseId === event.toolUseId && isPending(p),
        (p) => ({ ...p, status: 'resolved' })
      )
    case 'process-exit':
    case 'session-spawn':
    case 'interrupted':
      return expirePendingPrompts(state)
    default:
      return state
  }
}

/** Every pending prompt can no longer be answered (its process or turn is gone). */
export function expirePendingPrompts<S extends PromptState>(state: S): S {
  if (state.pendingPrompts.length === 0) return state
  return update(state, state.pendingPrompts.slice(), isPending, (p) => ({
    ...p,
    status: 'expired'
  }))
}

/** One pending prompt can no longer be answered (the server refused the answer). */
export function expirePrompt<S extends PromptState>(state: S, requestId: string): S {
  return update(
    state,
    positionOf(state, requestId),
    (p) => p.requestId === requestId && isPending(p),
    (p) => ({ ...p, status: 'expired' })
  )
}

/** Prompts still waiting for the user, oldest first. */
export function selectPendingPrompts(state: PromptState): ChatPrompt[] {
  return state.pendingPrompts.map((at) => state.prompts[at])
}

export function hasPendingPrompt(state: PromptState): boolean {
  return state.pendingPrompts.length > 0
}

/**
 * What the indexes should hold, rebuilt by scanning the prompts — empty when
 * they agree (the replay guard's check).
 */
export function promptIndexProblems(state: PromptState): string[] {
  const problems: string[] = []
  const pending: number[] = []
  state.prompts.forEach((p, at) => {
    // Request ids are unique (a repeated request is ignored).
    if (state.promptIndex.get(p.requestId) !== at)
      problems.push(
        `promptIndex[${p.requestId}] = ${state.promptIndex.get(p.requestId)}, row ${at}`
      )
    if (isPending(p)) pending.push(at)
  })
  if (state.promptIndex.size !== new Set(state.prompts.map((p) => p.requestId)).size)
    problems.push(`promptIndex has ${state.promptIndex.size} ids`)
  if (pending.join() !== state.pendingPrompts.join())
    problems.push(`pendingPrompts [${state.pendingPrompts.join()}], scan [${pending.join()}]`)
  return problems
}

/** The latest prompt raised for a tool call, if any. */
export function selectPromptForTool(
  state: Pick<PromptState, 'prompts'>,
  toolUseId: string
): ChatPrompt | null {
  if (!toolUseId) return null
  for (let i = state.prompts.length - 1; i >= 0; i--) {
    if (state.prompts[i].toolUseId === toolUseId) return state.prompts[i]
  }
  return null
}
