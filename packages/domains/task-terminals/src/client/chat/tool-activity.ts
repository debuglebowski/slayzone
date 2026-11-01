import type { TimelineItem, TimelineRows } from '@slayzone/terminal/client'

export type ActivityToolEntry = { item: Extract<TimelineItem, { kind: 'tool' }>; row: number }
export interface TurnToolActivity {
  key: string
  tools: ActivityToolEntry[]
  latestTurn: boolean
}

/** Attach hidden tools to their own turn's last visible row (or its file summary). */
export function toolActivityByRow(
  timeline: Readonly<TimelineRows>,
  displayed: readonly TimelineItem[],
  folded?: ReadonlySet<number>
): Map<TimelineItem, TurnToolActivity> {
  const visible = new Set(displayed)
  const groups = new Map<TimelineItem, TurnToolActivity>()
  let tools: ActivityToolEntry[] = []
  let anchor: TimelineItem | undefined
  let files: TimelineItem | undefined
  let key = 'initial'
  const flush = (latestTurn: boolean): void => {
    const host = files ?? anchor
    if (host && tools.length) groups.set(host, { key, tools, latestTurn })
    tools = []
    anchor = files = undefined
  }
  for (let row = 0; row < timeline.length; row++) {
    const item = timeline[row]
    // Never associate calls across an unloaded page or a conversation boundary.
    if (!item) {
      flush(false)
      key = `page:${row}`
      continue
    }
    if (folded?.has(row) || item.parentToolUseId != null) continue
    if (
      item.kind === 'user-text' ||
      item.kind === 'conversation-branch' ||
      item.kind === 'session-start'
    ) {
      flush(false)
      key = `turn:${row}`
    }
    if (visible.has(item)) {
      anchor = item
      if (item.kind === 'files-changed') files = item
    }
    if (
      item.kind === 'tool' &&
      !visible.has(item) &&
      item.invocation.name !== 'ExitPlanMode' &&
      item.invocation.name !== 'AskUserQuestion'
    ) {
      tools.push({ item, row })
    }
  }
  flush(true)
  return groups
}
