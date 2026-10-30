/**
 * A chat reducer state as text — a checkpoint of the hub's timeline projection
 * (`chat_timeline_checkpoints`) and what a client opens a paged session from.
 * It holds every field but the rows before `tailFrom` (those are in pages):
 * decoded, those rows are unloaded (`undefined`) and the reducer loads them
 * when it needs one.
 *
 * DERIVED and versioned: text from another {@link CHAT_TIMELINE_VERSION} is
 * refused (its reader rebuilds from the saved events), so a changed reducer
 * never shows rows an older one built. `chat-timeline-checkpoint.test.ts`
 * hashes {@link REDUCER_SOURCES}: changing them fails it until the version is
 * bumped.
 */
import type { ChatTimelineState } from './chat-timeline'
import { PersistentIndex } from './persistent-index'
import { beginReducerCall, endReducerCall } from './replay-batch'

/** Bump on ANY change to the reducer or what it calls (the test says when). */
export const CHAT_TIMELINE_VERSION = '1'

/**
 * Bump when what the hub persists or serves next to the state changes shape
 * (checkpoint data, page summaries).
 */
export const TIMELINE_PROJECTION_FORMAT = 1

/** The version a projection is stored and served under: the reducer's and its format. */
export const TIMELINE_PROJECTION_VERSION = `${CHAT_TIMELINE_VERSION}.${TIMELINE_PROJECTION_FORMAT}`

/** What the reducer's output depends on (relative to this file). */
export const REDUCER_SOURCES = [
  './chat-timeline.ts',
  './chat-prompts.ts',
  './turn-file-changes.ts',
  './codex-file-changes.ts',
  './persistent-index.ts',
  './replay-batch.ts',
  './timeline-rows.ts',
  './chat-timeline-checkpoint.ts',
  './timeline-summary.ts',
  '../../../terminal-contracts/src/agent-events.ts',
  '../../../terminal-contracts/src/bg-shell-helpers.ts',
  '../../../terminal-contracts/src/chat-attachments.ts',
  '../../../terminal-contracts/src/chat-cli-commands.ts'
] as const

interface Encoded {
  v: string
  rowCount: number
  tailFrom: number
  tail: unknown[]
  state: Record<string, unknown>
}

/** `state` as text, without its rows before `tailFrom`. */
export function encodeTimelineState(state: ChatTimelineState, tailFrom: number): string {
  if (state.stalled) throw new Error('a stalled timeline state is not a checkpoint')
  const { timeline, stalled: _stalled, ...rest } = state
  const from = Math.max(0, Math.min(tailFrom, timeline.length))
  const tail = timeline.slice(from)
  if (tail.some((row) => row === undefined)) {
    throw new Error('a checkpoint tail must hold every row')
  }
  const encoded: Encoded = {
    v: CHAT_TIMELINE_VERSION,
    rowCount: timeline.length,
    tailFrom: from,
    tail,
    state: rest
  }
  return JSON.stringify(encoded, (_key, value: unknown) => {
    if (value instanceof Map) return { $map: [...value.entries()] }
    if (value instanceof PersistentIndex) return { $index: [...value.entries()] }
    return value
  })
}

/** A state from {@link encodeTimelineState} text: rows before its tail unloaded. Throws on another version. */
export function decodeTimelineState(text: string): ChatTimelineState {
  const decoded = JSON.parse(text, (_key, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const o = value as Record<string, unknown>
      if (Array.isArray(o.$map) && Object.keys(o).length === 1) {
        return new Map(o.$map as Array<[unknown, unknown]>)
      }
      if (Array.isArray(o.$index) && Object.keys(o).length === 1) {
        beginReducerCall()
        try {
          return PersistentIndex.fromEntries(o.$index as Array<[string, unknown]>)
        } finally {
          endReducerCall()
        }
      }
    }
    return value
  }) as Encoded
  if (decoded.v !== CHAT_TIMELINE_VERSION) {
    throw new Error(`timeline checkpoint version ${decoded.v} is not ${CHAT_TIMELINE_VERSION}`)
  }
  const timeline = new Array<unknown>(decoded.rowCount).fill(undefined)
  for (let k = 0; k < decoded.tail.length; k++) timeline[decoded.tailFrom + k] = decoded.tail[k]
  return { ...(decoded.state as object), timeline, stalled: null } as ChatTimelineState
}
