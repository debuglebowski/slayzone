/**
 * Pure lifecycle model, independent of timeline rows, transport IO and timers.
 * The outbox remains the delivery authority. Inputs carry a tab, process
 * generation and monotonic revision; an attributed main-turn end also carries
 * its turn id. Replaying identical inputs produces identical snapshots.
 *
 * Initially observed in shadow mode. No consumer uses this model to send,
 * interrupt, approve, restart, or hide existing work until cutover is validated.
 */
import type { AgentEvent, AgentExecution, ChatTurnState } from '@slayzone/terminal-contracts'
import {
  endedSubAgentPhase,
  isAsyncAgentLaunch,
  normalizeSubAgentPhase
} from './sub-agent-lifecycle'

export interface ChatLifecycleTurn {
  readonly id: string
  readonly origin: 'user' | 'agent'
  readonly stopping: boolean
  readonly execution?: AgentExecution
}

interface Value {
  readonly phase: ChatTurnState
  readonly conversationId: string | null
  readonly main: ChatLifecycleTurn | null
  readonly prompts: ReadonlySet<string>
  readonly helpers: ReadonlyMap<string, boolean>
  readonly jobs: ReadonlyMap<string, boolean>
  readonly inFlight: number
  /** The host is stopping this process: its phase only moves to `dead` now. */
  readonly stopping: boolean
}

export interface ChatLifecycle {
  readonly tabId: string
  readonly generation: number
  readonly revision: number
  readonly value: Value
}

export type ChatLifecycleActor =
  | { readonly type: 'main'; readonly turnId?: string }
  | { readonly type: 'child'; readonly parentToolUseId: string }

export type ChatLifecycleSignal =
  | { type: 'process-start'; conversationId: string | null }
  | { type: 'process-ready' }
  | { type: 'process-ended' }
  | { type: 'process-stopping' }
  | { type: 'process-error' }
  | { type: 'turn-start'; turnId: string; origin: 'user' | 'agent' }
  | { type: 'turn-cancel'; turnId?: string }
  | { type: 'outbox'; inFlight: number }
  | { type: 'event'; event: AgentEvent; actor: ChatLifecycleActor; autonomous: boolean }

export interface ChatLifecycleInput {
  readonly tabId: string
  readonly generation: number
  readonly revision: number
  readonly signal: ChatLifecycleSignal
}

/** Central normalization point: child progress is never main-turn progress. */
export function lifecycleEvent(
  event: AgentEvent,
  options: { autonomous: boolean; turnId?: string }
): ChatLifecycleSignal {
  const child = 'parentToolUseId' in event ? event.parentToolUseId : undefined
  return {
    type: 'event',
    event,
    autonomous: options.autonomous,
    actor:
      child != null
        ? { type: 'child', parentToolUseId: child }
        : {
            type: 'main',
            ...((event.execution?.turnId ?? options.turnId)
              ? { turnId: event.execution?.turnId ?? options.turnId }
              : {})
          }
  }
}

export function createChatLifecycle(tabId: string): ChatLifecycle {
  return {
    tabId,
    generation: 0,
    revision: 0,
    value: {
      phase: 'not-spawned',
      conversationId: null,
      main: null,
      prompts: new Set(),
      helpers: new Map(),
      jobs: new Map(),
      inFlight: 0,
      stopping: false
    }
  }
}

function setWork(work: ReadonlyMap<string, boolean>, id: string, backgrounded: boolean | null) {
  if (backgrounded === null && !work.has(id)) return work
  if (backgrounded !== null && work.get(id) === backgrounded) return work
  const next = new Map(work)
  if (backgrounded === null) next.delete(id)
  else next.set(id, backgrounded)
  return next
}

function backgroundOnly(work: ReadonlyMap<string, boolean>): ReadonlyMap<string, boolean> {
  if ([...work.values()].every(Boolean)) return work
  return new Map([...work].filter(([, backgrounded]) => backgrounded))
}

function ended(v: Value, phase: ChatTurnState): Value {
  return { ...v, phase, main: null, prompts: new Set(), helpers: new Map(), jobs: new Map() }
}

function turnEnded(v: Value, failed: boolean): Value {
  return {
    ...v,
    phase: failed ? 'error' : 'idle',
    main: null,
    prompts: new Set(),
    helpers: backgroundOnly(v.helpers),
    jobs: backgroundOnly(v.jobs)
  }
}

function eventValue(
  state: ChatLifecycle,
  signal: Extract<ChatLifecycleSignal, { type: 'event' }>
): Value {
  const v = state.value
  const { event, actor } = signal
  if (event.kind === 'process-exit') return ended(v, 'dead')
  // History and late process output cannot create execution before a spawn or
  // revive a stopped process. Process starts and readiness are explicit inputs.
  if (v.phase === 'not-spawned' || v.phase === 'starting' || v.phase === 'dead') return v

  if (
    actor.type === 'main' &&
    event.execution &&
    v.main?.execution &&
    event.execution.turnId !== v.main.execution.turnId &&
    event.kind !== 'sub-agent' &&
    event.kind !== 'command-task' &&
    event.kind !== 'command-task-output' &&
    event.kind !== 'tool-result'
  )
    return v

  switch (event.kind) {
    case 'turn-started': {
      if (actor.type === 'child') return v
      const execution = event.execution
      if (v.main) {
        if (execution.messageId && execution.messageId !== v.main.id) return v
        if (v.main.execution && v.main.execution.turnId !== execution.turnId) return v
        return { ...v, main: { ...v.main, execution: { ...execution } } }
      }
      return {
        ...v,
        phase: v.prompts.size ? 'idle' : 'running',
        main: {
          id: execution.messageId ?? execution.turnId,
          origin: 'agent',
          stopping: false,
          execution: { ...execution }
        }
      }
    }
    case 'turn-init':
      return v.conversationId === event.sessionId ? v : { ...v, conversationId: event.sessionId }
    case 'permission-request':
      if (v.prompts.has(event.requestId)) return v
      return { ...v, phase: 'idle', prompts: new Set([...v.prompts, event.requestId]) }
    case 'permission-resolved':
    case 'permission-cancelled': {
      // An expired answer must not start execution (especially a child prompt
      // that arrived after the main answer finished).
      if (!v.prompts.has(event.requestId)) return v
      const prompts = new Set(v.prompts)
      prompts.delete(event.requestId)
      const resume =
        event.kind === 'permission-resolved' &&
        prompts.size === 0 &&
        v.main !== null &&
        !(event.decision.behavior === 'deny' && event.decision.interrupt)
      return { ...v, prompts, ...(resume ? { phase: 'running' as const } : {}) }
    }
    case 'result': {
      if (actor.type === 'child') return v
      // An end owns the main turn when it names the turn's bound execution or,
      // before any is bound (a fast turn that ended before its id reply), the
      // turn's own request.
      if (actor.turnId && v.main) {
        const bound = v.main.execution?.turnId
        const messageId = event.execution?.messageId
        const own = bound
          ? actor.turnId === bound
          : actor.turnId === v.main.id || messageId === v.main.id
        if (!own) return v
      }
      const aborted = v.main?.stopping || event.terminalReason?.startsWith('aborted')
      return turnEnded(v, event.isError && !aborted)
    }
    case 'interrupted':
      if (event.reason === 'stop-request') {
        return { ...v, prompts: new Set(), main: v.main ? { ...v.main, stopping: true } : null }
      }
      return turnEnded(v, false)
    case 'user-message-popped':
      // Stop took the message back: its turn is being stopped, and ends at the
      // CLI's end of it (`result` / `interrupted` / `turn-cancel`), not now.
      return v.main && (!event.id || v.main.id === event.id)
        ? { ...v, main: { ...v.main, stopping: true } }
        : v
    case 'sub-agent': {
      const known = v.helpers.get(event.toolUseId)
      const backgrounded = known === true || event.backgrounded === true
      const phase =
        known === undefined || backgrounded
          ? (endedSubAgentPhase(event.status) ?? normalizeSubAgentPhase(event.phase))
          : normalizeSubAgentPhase(event.phase)
      const helpers = setWork(
        v.helpers,
        event.toolUseId,
        phase === 'in-flight' ? backgrounded : null
      )
      return helpers === v.helpers ? v : { ...v, helpers }
    }
    case 'tool-result': {
      const known = v.helpers.get(event.toolUseId)
      if (known === undefined || known) return v
      const helpers = setWork(v.helpers, event.toolUseId, isAsyncAgentLaunch(event) ? true : null)
      return helpers === v.helpers ? v : { ...v, helpers }
    }
    case 'command-task': {
      const jobs = setWork(
        v.jobs,
        event.taskId,
        event.status === 'running' ? event.backgrounded : null
      )
      return jobs === v.jobs ? v : { ...v, jobs }
    }
    case 'assistant-text':
    case 'assistant-thinking':
    case 'tool-call':
    case 'stream-message-start':
    case 'stream-block-start':
    case 'stream-block-delta':
      if (actor.type === 'child' || v.prompts.size || v.main?.stopping) return v
      if (v.main) return v.phase === 'running' ? v : { ...v, phase: 'running' }
      if (!signal.autonomous) return v
      return {
        ...v,
        phase: 'running',
        main: {
          id: actor.turnId ?? `agent:${state.generation}:${state.revision}`,
          origin: 'agent',
          stopping: false
        }
      }
    default:
      return v
  }
}

export function reduceChatLifecycle(
  state: ChatLifecycle,
  input: ChatLifecycleInput
): ChatLifecycle {
  if (
    input.tabId !== state.tabId ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 0 ||
    !Number.isSafeInteger(input.revision) ||
    input.revision <= state.revision
  )
    return state
  const signal = input.signal
  if (signal.type === 'process-start') {
    if (input.generation <= state.generation) return state
    return {
      tabId: state.tabId,
      generation: input.generation,
      revision: input.revision,
      value: {
        ...ended(state.value, 'starting'),
        conversationId: signal.conversationId,
        stopping: false
      }
    }
  }
  if (input.generation !== state.generation) return state
  let value = state.value
  switch (signal.type) {
    case 'process-ready':
      if (value.phase === 'starting') value = { ...value, phase: 'idle' }
      break
    case 'process-ended':
      value = ended(value, 'dead')
      break
    case 'process-stopping':
      if (!value.stopping) value = { ...value, stopping: true }
      break
    case 'process-error':
      if (value.phase !== 'dead' && value.phase !== 'not-spawned') value = turnEnded(value, true)
      break
    case 'turn-start':
      // A message written while a turn the agent started by itself runs does not
      // replace it: the agent takes the message into that turn or starts it after
      // that turn's result (`turn-started`). Its delivery keeps the turn open.
      if (signal.origin === 'user' && value.main?.origin === 'agent') break
      if (value.phase !== 'dead' && value.phase !== 'not-spawned' && value.phase !== 'starting') {
        value = {
          ...value,
          phase: value.prompts.size ? 'idle' : 'running',
          main:
            value.main?.id === signal.turnId
              ? value.main
              : { id: signal.turnId, origin: signal.origin, stopping: false }
        }
      }
      break
    case 'turn-cancel':
      if (
        (value.phase === 'idle' || value.phase === 'running' || value.phase === 'error') &&
        (!signal.turnId || signal.turnId === value.main?.id)
      )
        value = turnEnded(value, false)
      break
    case 'outbox':
      if (!Number.isSafeInteger(signal.inFlight) || signal.inFlight < 0)
        throw new Error('Invalid outbox count')
      if (signal.inFlight !== value.inFlight) value = { ...value, inFlight: signal.inFlight }
      break
    case 'event':
      value = eventValue(state, signal)
      break
  }
  // A process being stopped only ends: nothing it still says moves its phase or
  // opens a turn (the runtime ignores it the same way).
  if (state.value.stopping) {
    if (value.phase !== 'dead' && value.phase !== state.value.phase)
      value = { ...value, phase: state.value.phase }
    if (!state.value.main && value.main) value = { ...value, main: null }
  }
  return { ...state, revision: input.revision, value }
}

/** Versioned, DOM-free snapshot. Raw provider payloads and transcript text never appear here. */
export function chatLifecycleSnapshot(state: ChatLifecycle) {
  const v = state.value
  const backgroundHelpers = [...v.helpers.values()].filter(Boolean).length
  return {
    version: 1 as const,
    tabId: state.tabId,
    generation: state.generation,
    revision: state.revision,
    conversationId: v.conversationId,
    state: v.phase,
    reportedState:
      v.phase === 'idle' && !v.prompts.size && backgroundHelpers
        ? ('background' as const)
        : v.phase,
    main: v.main
      ? { ...v.main, ...(v.main.execution ? { execution: { ...v.main.execution } } : {}) }
      : null,
    turnOpen: v.main !== null || v.prompts.size > 0 || v.inFlight > 0,
    mainTurnOpen: v.main !== null || v.inFlight > 0,
    pendingRequestIds: [...v.prompts],
    outboxInFlight: v.inFlight,
    backgroundHelpers,
    backgroundJobs: [...v.jobs.values()].filter(Boolean).length,
    // The turn side of queue readiness; the transport's own gates (respawn,
    // closing, storage…) apply on top of it in every mode.
    readyForMessage: v.phase === 'idle' && v.main === null && !v.prompts.size && v.inFlight === 0
  }
}

export type ChatLifecycleSnapshot = ReturnType<typeof chatLifecycleSnapshot>
