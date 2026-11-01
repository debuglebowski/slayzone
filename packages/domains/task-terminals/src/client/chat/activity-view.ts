import type { TimelineItem } from '@slayzone/terminal/client'

export type ActivityItem = Extract<TimelineItem, { kind: 'text' | 'thinking' | 'tool' | 'stderr' }>
export interface ActivityTurn {
  items: ActivityItem[]
  files: Array<Extract<TimelineItem, { kind: 'files-changed' }>>
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
      result && !result.isError && last?.kind === 'text' && last.stream !== 'open'
        ? last
        : null
    const entries = final ? activity.filter((item) => item !== final) : activity
    const files = segment.filter(
      (item): item is Extract<TimelineItem, { kind: 'files-changed' }> =>
        item.kind === 'files-changed'
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
    // CLI process diagnostics can arrive after turn completion. Keep consecutive
    // diagnostics with that turn, stopping at any new content or history boundary.
    if (completed && item.kind !== 'stderr') flush(false)
    if (item.kind === 'history-gap' || item.kind === 'conversation-branch') {
      flush(false)
      output.push(item)
    } else if (item.kind === 'user-text') {
      flush(false)
      segment.push(item)
    } else {
      segment.push(item)
      if (item.kind === 'result' || item.kind === 'interrupted') completed = true
    }
  }
  flush(inFlight && !completed)
  return { rows: output, turns, hosts }
}
