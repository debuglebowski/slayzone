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
import type { ChatTimelineState, TimelineItem } from './chat-timeline'
import { PersistentIndex } from './persistent-index'
import { beginReducerCall, endReducerCall } from './replay-batch'

/**
 * Bump on ANY change to the reducer or what it calls (the test says when). Also
 * bumped to refuse stored projections built from rows of another representation:
 * 19 = rows carry out-of-line references (`chat-blobs`), so pages built before the
 * v13 chat store (inline base64) are rebuilt from the events on next open.
 */
export const CHAT_TIMELINE_VERSION = '26'

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
  './sub-agent-lifecycle.ts',
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

interface StoredIndex {
  $entries: Record<string, unknown>
  $toolu?: Record<string, unknown>
}

const TOOL_USE_PREFIX = 'toolu_'

function encodeIndex(index: PersistentIndex<unknown>, groupToolIds: boolean): StoredIndex {
  const entries: Record<string, unknown> = Object.create(null)
  const tools: Record<string, unknown> = Object.create(null)
  let hasTools = false
  for (const [id, value] of index.entries()) {
    if (groupToolIds && id.startsWith(TOOL_USE_PREFIX)) {
      tools[id.slice(TOOL_USE_PREFIX.length)] = value
      hasTools = true
    } else {
      entries[id] = value
    }
  }
  return hasTools ? { $entries: entries, $toolu: tools } : { $entries: entries }
}

function* indexEntries(packed: StoredIndex): Generator<[string, unknown]> {
  yield* Object.entries(packed.$entries)
  if (packed.$toolu)
    for (const [id, value] of Object.entries(packed.$toolu)) yield [TOOL_USE_PREFIX + id, value]
}

/** `state` as text, without its rows before `tailFrom`. */
export function encodeTimelineState(
  state: ChatTimelineState,
  tailFrom: number,
  mapWireRow?: (row: TimelineItem, index: number) => TimelineItem
): string {
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
    tail: mapWireRow ? (tail as TimelineItem[]).map((row, i) => mapWireRow(row, from + i)) : tail,
    state: Object.fromEntries(
      Object.entries(rest).map(([key, value]) => [
        key,
        value instanceof PersistentIndex ? encodeIndex(value, key === 'toolIndex') : value
      ])
    )
  }
  return JSON.stringify(encoded, (_key, value: unknown) => {
    if (value instanceof Map) return { $map: [...value.entries()] }
    return value
  })
}

/** A state from {@link encodeTimelineState} text: rows before its tail unloaded. Throws on another version. */
export function decodeTimelineState(
  text: string,
  version: typeof CHAT_TIMELINE_VERSION | '25' = CHAT_TIMELINE_VERSION
): ChatTimelineState {
  const decoded = JSON.parse(text, (_key, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const o = value as Record<string, unknown>
      if (
        Array.isArray(o.$map) &&
        Object.keys(o).length === 1 &&
        o.$map.every((entry) => Array.isArray(entry) && entry.length === 2)
      ) {
        return new Map(o.$map as Array<[unknown, unknown]>)
      }
    }
    return value
  }) as Encoded
  if (decoded.v !== version) {
    throw new Error(`timeline checkpoint version ${decoded.v} is not ${version}`)
  }
  beginReducerCall()
  try {
    for (const key of ['toolIndex', 'workspaceIndex', 'promptIndex', 'userIndex', 'takenBack']) {
      const value = decoded.state[key]
      const entries =
        version === '25'
          ? (value as { $index: Array<[string, unknown]> }).$index
          : indexEntries(value as StoredIndex)
      decoded.state[key] = PersistentIndex.fromEntries(entries)
    }
  } finally {
    endReducerCall()
  }
  const timeline = new Array<unknown>(decoded.rowCount).fill(undefined)
  for (let k = 0; k < decoded.tail.length; k++) timeline[decoded.tailFrom + k] = decoded.tail[k]
  return { ...(decoded.state as object), timeline, stalled: null } as ChatTimelineState
}
