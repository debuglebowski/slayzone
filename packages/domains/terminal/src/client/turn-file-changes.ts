import type { TimelineItem, ToolInvocation } from './chat-timeline'

/**
 * Claude Code's file tools: what they changed is in their structured result
 * (`filePath` + `structuredPatch`, notebook paths). Codex names its file changes
 * `codex/fileChange`, so its turns never get a row.
 */
export const FILE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit'
])

/** One file of a `files-changed` row. */
export interface TurnFileChange {
  path: string
  /** The calls that changed it, in order. */
  toolUseIds: string[]
  /** Lines added / removed by those calls; null when a call doesn't say (notebook cells). */
  additions: number | null
  deletions: number | null
  /** The first call created it (a Write of a new file). */
  created: boolean
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** `+` / `-` lines of a `structuredPatch`, or null when there is none. */
function patchCounts(patch: unknown): { additions: number; deletions: number } | null {
  if (!Array.isArray(patch)) return null
  let additions = 0
  let deletions = 0
  for (const hunk of patch) {
    const lines = isRecord(hunk) && Array.isArray(hunk.lines) ? hunk.lines : []
    for (const line of lines) {
      if (typeof line !== 'string') continue
      if (line.startsWith('+')) additions++
      else if (line.startsWith('-')) deletions++
    }
  }
  return { additions, deletions }
}

function lineCount(text: string): number {
  if (!text) return 0
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n').length
}

/**
 * The file one finished call changed, with its line counts — null for other
 * tools, a call that failed, was denied or has no result yet.
 */
export function fileChangeOf(
  invocation: ToolInvocation
): { path: string; additions: number | null; deletions: number | null; created: boolean } | null {
  if (!FILE_TOOL_NAMES.has(invocation.name)) return null
  if (invocation.status !== 'done' || invocation.denied || !invocation.result) return null
  if (invocation.result.isError) return null
  const input = isRecord(invocation.input) ? invocation.input : {}
  const res = isRecord(invocation.result.structured) ? invocation.result.structured : {}
  if (invocation.name === 'NotebookEdit') {
    const path = str(res.notebook_path) ?? str(input.notebook_path)
    return path ? { path, additions: null, deletions: null, created: false } : null
  }
  const path = str(res.filePath) ?? str(input.file_path)
  if (!path) return null
  if (invocation.name === 'Write' && res.type === 'create') {
    const content = str(res.content) ?? str(input.content) ?? ''
    return { path, additions: lineCount(content), deletions: 0, created: true }
  }
  const counts = patchCounts(res.structuredPatch)
  return {
    path,
    additions: counts?.additions ?? null,
    deletions: counts?.deletions ?? null,
    created: false
  }
}

const addCounts = (a: number | null, b: number | null): number | null =>
  a === null || b === null ? null : a + b

/**
 * Adds the turn's `files-changed` row before its result — `timeline` ends with
 * the turn's `result`. The turn is everything since the previous result (a
 * queued message's bubble can sit inside it); sub-agents' edits count. No row
 * when no file changed; the same events always build the same row, so a reload
 * shows it again.
 */
export function withTurnFilesChanged(timeline: TimelineItem[]): TimelineItem[] {
  const end = timeline.length - 1
  const result = timeline[end]
  if (result?.kind !== 'result') return timeline
  const files = new Map<string, TurnFileChange>()
  let lastToolUseId: string | null = null
  let shellCommands = 0
  let start = end
  while (start > 0 && timeline[start - 1].kind !== 'result') start--
  for (let i = start; i < end; i++) {
    const it = timeline[i]
    if (it.kind !== 'tool') continue
    if (it.invocation.name === 'Bash') shellCommands++
    const change = fileChangeOf(it.invocation)
    if (!change) continue
    lastToolUseId = it.invocation.id
    const prev = files.get(change.path)
    files.set(
      change.path,
      prev
        ? {
            ...prev,
            toolUseIds: [...prev.toolUseIds, it.invocation.id],
            additions: addCounts(prev.additions, change.additions),
            deletions: addCounts(prev.deletions, change.deletions)
          }
        : { ...change, toolUseIds: [it.invocation.id] }
    )
  }
  if (lastToolUseId === null) return timeline
  const row: TimelineItem = {
    kind: 'files-changed',
    id: `files:${lastToolUseId}`,
    files: [...files.values()],
    shellCommands,
    timestamp: result.timestamp
  }
  return [...timeline.slice(0, end), row, result]
}
