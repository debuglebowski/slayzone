import type { TimelineItem } from '@slayzone/terminal/client'

export type ActivityItem = Extract<TimelineItem, { kind: 'text' | 'thinking' | 'tool' }>
export interface ActivityTurn {
  items: ActivityItem[]
  files: Array<Extract<TimelineItem, { kind: 'files-changed' }>>
  final: Extract<TimelineItem, { kind: 'text' }> | null
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
  const flush = (active: boolean): void => {
    if (!segment.length) return
    const activity = segment.filter(
      (item): item is ActivityItem =>
        item.kind === 'text' ||
        item.kind === 'thinking' ||
        (item.kind === 'tool' &&
          item.invocation.name !== 'ExitPlanMode' &&
          item.invocation.name !== 'AskUserQuestion')
    )
    const last = activity[activity.length - 1]
    // The last text stays visible while streaming and after it settles. If the
    // agent emits more activity, it moves into that turn's activity history.
    const final = last?.kind === 'text' ? last : null
    const entries = final ? activity.filter((item) => item !== final) : activity
    const files = segment.filter(
      (item): item is Extract<TimelineItem, { kind: 'files-changed' }> =>
        item.kind === 'files-changed'
    )
    const hidden = new Set<TimelineItem>([...entries, ...files])
    const kept = segment.filter((item) => !hidden.has(item))
    // Preserve a row as an anchor for assistant-initiated turns with no final reply.
    const host = final ?? kept[kept.length - 1] ?? entries[0] ?? files[0]
    if (host && (entries.length || files.length || active || final)) {
      const hostIsActivity = hidden.has(host)
      if (hostIsActivity) kept.push(host)
      turns.set(host, { items: entries, files, final, active, hostIsActivity })
      for (const item of entries) hosts.set(item, host)
      for (const item of files) hosts.set(item, host)
    }
    output.push(...kept)
    segment = []
  }
  for (const item of rows) {
    if (item.kind === 'history-gap' || item.kind === 'conversation-branch') {
      flush(false)
      output.push(item)
    } else if (item.kind === 'user-text') {
      flush(false)
      segment.push(item)
    } else {
      segment.push(item)
      if (item.kind === 'result' || item.kind === 'interrupted') flush(false)
    }
  }
  flush(inFlight)
  return { rows: output, turns, hosts }
}
