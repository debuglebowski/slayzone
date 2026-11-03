import type { TimelineItem, TimelineRows } from '@slayzone/terminal/client'
import { relativeToCwd } from './relative-path'

export type WorkspaceChanges = Extract<TimelineItem, { kind: 'workspace-changes' }>
export type RecordedChanges = Extract<TimelineItem, { kind: 'files-changed' }>

// Timeline arrays are immutable snapshots; share one scan across all turn rows.
const sourceCache = new WeakMap<
  Readonly<TimelineRows>,
  Map<WorkspaceChanges, RecordedChanges | undefined>
>()

/** Match saved captures to tool records by user-message identity, never across history gaps. */
export function turnChangeSources(
  rows: Readonly<TimelineRows>
): Map<WorkspaceChanges, RecordedChanges | undefined> {
  const cached = sourceCache.get(rows)
  if (cached) return cached
  const sources = new Map<WorkspaceChanges, RecordedChanges | undefined>()
  let chunk: TimelineItem[] = []
  const flush = () => {
    const recorded = new Map<string, RecordedChanges>()
    const users: string[] = []
    for (const item of chunk) {
      if (item.kind === 'user-text' && item.id) users.push(item.id)
      if (item.kind === 'files-changed' && users[0]) recorded.set(users[0], item)
      // Stop inserts an interruption marker before the normal result/summary.
      // Only the result advances to a queued user message.
      if (item.kind === 'result') users.shift()
    }
    for (const item of chunk) {
      if (item.kind === 'workspace-changes') sources.set(item, recorded.get(item.messageId))
    }
    chunk = []
  }
  for (const item of rows) {
    if (!item || item.kind === 'history-gap' || item.kind === 'conversation-branch') flush()
    else chunk.push(item)
  }
  flush()
  sourceCache.set(rows, sources)
  return sources
}

/** Keep original row identities for paging, search and reveal. */
export function unifiedChangeRows(rows: readonly TimelineItem[]): TimelineItem[] {
  const replaced = new Set([...turnChangeSources(rows).values()].filter(Boolean))
  return rows.filter((item) => item.kind !== 'files-changed' || !replaced.has(item))
}

/** A recorded edit inside the workspace (its capture's diff would show it). */
function editedInside(recorded: RecordedChanges | undefined, cwd: string | undefined): boolean {
  if (!recorded) return false
  if (!cwd) return true
  // A relative path is relative to the agent's cwd: inside.
  return recorded.files.some(
    (f) => !/^([/\\]|[A-Za-z]:)/.test(f.path) || relativeToCwd(f.path, cwd) !== f.path
  )
}

/**
 * Whether a turn's capture shows a card (`WorkspaceChangesRow`). One that shows
 * none is no turn content: it must not open a turn block or a footer.
 */
export function workspaceChangesShows(
  item: WorkspaceChanges,
  recorded: RecordedChanges | undefined,
  cwd: string | undefined
): boolean {
  // Failed capture: its recorded edits, else nothing. An agent-cut turn keeps its
  // card: it is that turn's only "Turn interrupted" signal.
  if (item.status === 'unavailable') return Boolean(recorded) || Boolean(item.interrupted)
  // Nothing changed in the workspace: no card, unless an edit inside it was
  // reverted (true zero). Edits outside it (e.g. artifacts) can't show in its diff.
  if (item.status === 'complete' && item.fileCount === 0) return editedInside(recorded, cwd)
  return true
}
