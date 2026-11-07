/**
 * The background sub-agents the composer lists. A read of the timeline state,
 * never part of the reducer: kept out of its hashed sources (`REDUCER_SOURCES`),
 * so changing it never invalidates checkpoints.
 *
 * @module shared/background-sub-agents
 */
import { isTurnOpen, type ChatTimelineState, type TimelineItem } from './chat-timeline'

/** A sub-agent still running in the background after its turn closed. */
export interface BackgroundSubAgent {
  toolUseId: string
  /** Absent: none given, or its row is not loaded (paged history). */
  description?: string
  /** When it started; absent while its row is not loaded. */
  timestamp?: number
  /** Its timeline row (a paged history loads it first when revealed). */
  row: number
}

type SubAgentRow = Extract<TimelineItem, { kind: 'sub-agent' }>

/**
 * The background sub-agents still running, in start order: every one but those
 * the open turn started — that turn shows them (its Sub-agents disclosure). They
 * join once that turn closes, like `selectBackgroundJobs` (by turn identity, so
 * a Stop that closed a turn before its result counts). A foreground sub-agent
 * never: its turn waits for it.
 *
 * A row not loaded (paged history) is in an older page, so it was started by a
 * closed turn, and one still running after its turn is a background one (a
 * turn's end fails its foreground ones): listed by its tool id alone.
 */
export function selectBackgroundSubAgents(state: ChatTimelineState): readonly BackgroundSubAgent[] {
  const open = isTurnOpen(state) ? state.turnsClosed : null
  const rows: Array<SubAgentRow | number> = []
  for (const idx of state.inFlightSubAgents) {
    const row = state.timeline[idx]
    if (row === undefined) {
      if (open === null || idx < state.turnStart) rows.push(idx)
      continue
    }
    if (row.kind !== 'sub-agent' || row.phase !== 'in-flight' || !row.backgrounded) continue
    if (open !== null && row.spawnedInTurn === open) continue
    rows.push(row)
  }
  // The same list for the same rows: a render reading it stays memoized.
  const cached = backgroundSubAgentsCache.get(state.inFlightSubAgents)
  if (
    cached &&
    cached.rows.length === rows.length &&
    cached.rows.every((row, i) => row === rows[i])
  ) {
    return cached.agents
  }
  let unloadedIds: Map<number, string> | null = null
  const agents = rows.flatMap((row): BackgroundSubAgent[] => {
    if (typeof row !== 'number') {
      const at = state.subAgentIndex.get(row.toolUseId)
      if (at === undefined) return []
      return [
        {
          toolUseId: row.toolUseId,
          ...(row.description ? { description: row.description } : {}),
          timestamp: row.timestamp,
          row: at
        }
      ]
    }
    unloadedIds ??= new Map([...state.subAgentIndex].map(([id, at]) => [at, id]))
    const toolUseId = unloadedIds.get(row)
    return toolUseId ? [{ toolUseId, row }] : []
  })
  backgroundSubAgentsCache.set(state.inFlightSubAgents, { rows, agents })
  return agents
}

/** By `inFlightSubAgents` (never changed once a reducer call returned it). */
const backgroundSubAgentsCache = new WeakMap<
  readonly number[],
  { rows: ReadonlyArray<SubAgentRow | number>; agents: readonly BackgroundSubAgent[] }
>()
