/**
 * The app's view of every signed-in hub at once, as plain data: what each hub has
 * delivered (`HubFeed`), the one task list merged from all of them (`mergeHubTasks`),
 * what is wrong with a hub (`hubProblem`), and which client a write about a row goes
 * to (`ownerClient`). The React side that fills the feeds is `hub-connections.tsx`.
 *
 * Rows are keyed by hub AND task id, never by task id alone: hubs of one user can
 * share ids (a project cloned from a prod hub to a dev hub keeps its UUIDs), so a
 * bare-id lookup like desktop's ownership map would send a write to the wrong hub.
 */
import type { HubEntry } from '@slayzone/platform/hub-registry'
import type { HubConnection, ResolvedHub, TypedHubWsClient } from '@slayzone/transport/client'
import type { AppRouter } from '@slayzone/api'
import type { RouterOutputs } from './trpc'

export type BoardData = RouterOutputs['task']['loadBoardData']
export type BoardTask = BoardData['tasks'][number]
export type BoardProject = NonNullable<BoardData['projects'][number]>

/** A hub's board query, as the list needs it. */
export interface HubBoardState {
  /** The last board loaded (kept while a reload fails); undefined = none yet. */
  data: BoardData | undefined
  /** The first load is under way. */
  pending: boolean
  /** Why the last load failed; null = it didn't. */
  error: string | null
  refreshing: boolean
}

/** What one signed-in hub has delivered. */
export interface HubFeed {
  hub: HubEntry
  /** Its socket (`useHubConnection`); null = the federation does not list it. */
  connection: HubConnection | null
  /** Not connected for longer than `UNREACHABLE_GRACE_MS`. */
  stalled: boolean
  board: HubBoardState
}

/**
 * How long a hub may be disconnected before the app says so. A socket that drops
 * (the app resumed from the background, the hub restarted) reconnects at once, in
 * well under this; a banner for that would only flash.
 */
export const UNREACHABLE_GRACE_MS = 2_000

/** One task in the merged list. */
export interface TaskRow {
  /** Unique across hubs. */
  key: string
  hubId: string
  hubLabel: string
  task: BoardTask
  project: BoardProject | undefined
}

/**
 * Every hub's top-level tasks in one list, each tagged with its hub: hubs in the order
 * given (sign-in order), each hub's tasks in its own board order (what the app showed
 * for a single hub). A hub with no board yet adds nothing.
 */
export function mergeHubTasks(feeds: readonly HubFeed[]): TaskRow[] {
  const rows: TaskRow[] = []
  for (const { hub, board } of feeds) {
    if (!board.data) continue
    const projects = new Map<string, BoardProject>()
    for (const p of board.data.projects) if (p) projects.set(p.id, p)
    for (const task of board.data.tasks) {
      if (task.parent_id !== null) continue
      rows.push({
        key: rowKey(hub.id, task.id),
        hubId: hub.id,
        hubLabel: hub.label,
        task,
        project: projects.get(task.project_id)
      })
    }
  }
  return rows
}

export const rowKey = (hubId: string, taskId: string): string => `${hubId}\n${taskId}`

/** Any task of one hub's board by id, subtasks included (a deep link may name one). */
export function findTaskRow(feed: HubFeed, taskId: string): TaskRow | null {
  const data = feed.board.data
  const task = data?.tasks.find((t) => t.id === taskId)
  if (!data || !task) return null
  return {
    key: rowKey(feed.hub.id, task.id),
    hubId: feed.hub.id,
    hubLabel: feed.hub.label,
    task,
    project: data.projects.find((p) => p?.id === task.project_id) ?? undefined
  }
}

/** What the app tells the user about a hub. */
export type HubProblem =
  /** Not connected yet, longer than the grace period; nothing has failed yet. */
  | { kind: 'connecting'; hub: HubEntry }
  /** Not connected, and an attempt (or the board load) failed. */
  | { kind: 'unreachable'; hub: HubEntry; detail: string | null }
  /** Connected, but the hub refused or failed the board (e.g. a revoked sign-in). */
  | { kind: 'failed'; hub: HubEntry; message: string }

export function hubProblem(feed: HubFeed): HubProblem | null {
  const { hub, connection, stalled, board } = feed
  if (!connection) return null
  if (connection.status === 'open') {
    return board.error ? { kind: 'failed', hub, message: board.error } : null
  }
  if (board.error) return { kind: 'unreachable', hub, detail: board.error }
  if (!stalled) return null
  if (connection.error) return { kind: 'unreachable', hub, detail: connection.error.message }
  return board.data ? null : { kind: 'connecting', hub }
}

/** The app router's client of one hub. */
export type HubClient = TypedHubWsClient<AppRouter>['client']

/**
 * The client of the hub that owns a row: every write about the row goes to it.
 * Throws when that hub is not signed in — never falls back to another hub.
 */
export function ownerClient(
  resolve: (hubId: string) => ResolvedHub | null,
  hubId: string
): HubClient {
  const resolved = resolve(hubId)
  if (!resolved) throw new Error(`Hub ${hubId} is not signed in`)
  // Re-typed for the app router, the way a typed view re-types the runtime (path-based).
  return resolved.ws.client as unknown as HubClient
}
