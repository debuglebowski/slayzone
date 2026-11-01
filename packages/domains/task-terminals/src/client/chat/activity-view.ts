import type { TimelineItem } from '@slayzone/terminal/client'
import { unifiedChangeRows } from './files-changed/turn-changes'

export type ActivityItem = Extract<TimelineItem, { kind: 'text' | 'thinking' | 'tool' | 'stderr' }>
export interface ActivityTurn {
  items: ActivityItem[]
  files: Array<Extract<TimelineItem, { kind: 'files-changed' | 'workspace-changes' }>>
  final: Extract<TimelineItem, { kind: 'text' }> | null
  result?: Extract<TimelineItem, { kind: 'result' }>
  userMessageId?: string
  active: boolean
  /** When no other visible row exists, the host itself is an activity item. */
  hostIsActivity: boolean
}

/** Group each loaded part of a turn without associating items across history gaps. */
export function activityView(
  rows: readonly TimelineItem[],
  inFlight: boolean
): {
  rows: TimelineItem[]
  turns: Map<TimelineItem, ActivityTurn>
  hosts: Map<TimelineItem, TimelineItem>
} {
  rows = unifiedChangeRows(rows)
  // Captures may finish after the result, even after the next user message.
  // Attach by message identity; a gap ends the association window.
  const attached = new Map<TimelineItem, TimelineItem[]>()
  const consumed = new Set<TimelineItem>()
  let users = new Map<string, TimelineItem>()
  for (const item of rows) {
    if (item.kind === 'history-gap' || item.kind === 'conversation-branch') users = new Map()
    if (item.kind === 'user-text' && item.id) users.set(item.id, item)
    if (item.kind === 'workspace-changes') {
      const user = users.get(item.messageId)
      if (user) {
        attached.set(user, [...(attached.get(user) ?? []), item])
        consumed.add(item)
      }
    }
  }
  const output: TimelineItem[] = []
  const turns = new Map<TimelineItem, ActivityTurn>()
  const hosts = new Map<TimelineItem, TimelineItem>()
  let segment: TimelineItem[] = []
  let completed = false
  const flush = (active: boolean): void => {
    if (!segment.length) return
    const activity = segment.filter(
      (item): item is ActivityItem =>
        item.kind === 'text' ||
        item.kind === 'thinking' ||
        item.kind === 'stderr' ||
        (item.kind === 'tool' &&
          item.invocation.name !== 'ExitPlanMode' &&
          item.invocation.name !== 'AskUserQuestion')
    )
    // Process diagnostics can arrive after the reply; they don't make it progress text.
    const last = activity.findLast((item) => item.kind !== 'stderr')
    const result = segment.find((item) => item.kind === 'result')
    // A completed text block may still be progress. Only turn completion confirms
    // an answer; pauses, interruptions and history gaps must not promote it.
    const final =
      result && !result.isError && last?.kind === 'text' && last.stream !== 'open' ? last : null
    const entries = final ? activity.filter((item) => item !== final) : activity
    const files = segment.filter(
      (item): item is Extract<TimelineItem, { kind: 'files-changed' | 'workspace-changes' }> =>
        item.kind === 'files-changed' || item.kind === 'workspace-changes'
    )
    const hidden = new Set<TimelineItem>([...entries, ...files])
    const user = segment.find((item) => item.kind === 'user-text')
    if (final && result) hidden.add(result)
    const kept = segment.filter((item) => !hidden.has(item))
    // Preserve a row as an anchor for assistant-initiated turns with no final reply.
    const host = final ?? kept[kept.length - 1] ?? entries[0] ?? files[0]
    if (host && (entries.length || files.length || active || final)) {
      const hostIsActivity = hidden.has(host)
      if (hostIsActivity) kept.push(host)
      turns.set(host, {
        items: entries,
        files,
        final,
        result,
        userMessageId: user?.id,
        active,
        hostIsActivity
      })
      for (const item of entries) hosts.set(item, host)
      for (const item of files) hosts.set(item, host)
      if (final && result) hosts.set(result, host)
    }
    output.push(...kept)
    segment = []
    completed = false
  }
  for (const item of rows) {
    if (consumed.has(item)) continue
    // CLI process diagnostics can arrive after turn completion. Keep consecutive
    // diagnostics with that turn, stopping at any new content or history boundary.
    if (completed && item.kind !== 'stderr') flush(false)
    if (item.kind === 'history-gap' || item.kind === 'conversation-branch') {
      flush(false)
      output.push(item)
    } else if (item.kind === 'user-text') {
      flush(false)
      segment.push(item, ...(attached.get(item) ?? []))
    } else {
      segment.push(item)
      if (item.kind === 'result' || item.kind === 'interrupted') completed = true
    }
  }
  flush(inFlight && !completed)
  return { rows: output, turns, hosts }
}
