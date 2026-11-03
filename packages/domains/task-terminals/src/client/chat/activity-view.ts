import type { TimelineItem } from '@slayzone/terminal/client'
import { unifiedChangeRows } from './files-changed/turn-changes'

export type ActivityItem = Extract<TimelineItem, { kind: 'text' | 'thinking' | 'tool' | 'stderr' }>
export type SubAgentItem = Extract<TimelineItem, { kind: 'sub-agent' }>
export type TurnTriggerItem = Extract<TimelineItem, { kind: 'turn-trigger' }>
export interface ActivityTurn {
  items: ActivityItem[]
  /** The turn's sub-agents: their own rows beside the Activities, never inside them. */
  subAgents: SubAgentItem[]
  files: Array<Extract<TimelineItem, { kind: 'files-changed' | 'workspace-changes' }>>
  /** What opened an agent-started turn (background work ended): the turn's header, no row of its own. */
  trigger?: TurnTriggerItem
  final: Extract<TimelineItem, { kind: 'text' }> | null
  result?: Extract<TimelineItem, { kind: 'result' }>
  userMessageId?: string
  /**
   * The message sent into this turn while it ran ("Send now"): the agent read it
   * here and the turn goes on after it, so this part has no answer of its own.
   */
  continuedBy?: Extract<TimelineItem, { kind: 'user-text' }>
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
  const flush = (
    active: boolean,
    historyComplete = true,
    continuedBy?: Extract<TimelineItem, { kind: 'user-text' }>
  ): void => {
    if (!segment.length) return
    // A text / thinking block with no text shows nothing (Claude's hidden
    // thinking is one): no activity, no row. One still streaming counts.
    const empty = segment.filter(
      (item) =>
        (item.kind === 'text' || item.kind === 'thinking') && !item.text && item.stream !== 'open'
    )
    const activity = segment.filter(
      (item): item is ActivityItem =>
        !empty.includes(item) &&
        (item.kind === 'text' ||
          item.kind === 'thinking' ||
          item.kind === 'stderr' ||
          (item.kind === 'tool' &&
            item.invocation.name !== 'ExitPlanMode' &&
            item.invocation.name !== 'AskUserQuestion'))
    )
    // Process diagnostics can arrive after the reply; they don't make it progress text.
    const last = activity.findLast((item) => item.kind !== 'stderr')
    const result = segment.find((item) => item.kind === 'result')
    const user = segment.find((item) => item.kind === 'user-text')
    // Session-file imports have answered user messages, but no live result events.
    // Never infer completion through a page boundary or an explicit interruption.
    const importedAnswer =
      historyComplete &&
      !active &&
      user?.delivery === 'answered' &&
      !segment.some((item) => item.kind === 'interrupted' || item.kind === 'turn-error')
    // A completed text block may still be progress. Only turn completion confirms
    // an answer; pauses, interruptions and history gaps must not promote it.
    const final =
      (result ? !result.isError : importedAnswer) && last?.kind === 'text' && last.stream !== 'open'
        ? last
        : null
    const entries = final ? activity.filter((item) => item !== final) : activity
    const files = segment.filter(
      (item): item is Extract<TimelineItem, { kind: 'files-changed' | 'workspace-changes' }> =>
        item.kind === 'files-changed' || item.kind === 'workspace-changes'
    )
    const subAgents = segment.filter((item): item is SubAgentItem => item.kind === 'sub-agent')
    const trigger = segment.find((item): item is TurnTriggerItem => item.kind === 'turn-trigger')
    const hidden = new Set<TimelineItem>([...entries, ...files, ...subAgents, ...empty])
    if (final && result) hidden.add(result)
    let kept = segment.filter((item) => !hidden.has(item))
    // A turn carries its trigger as a header; it never anchors the turn itself.
    const rest = kept.filter((item) => item !== trigger)
    // Preserve a row as an anchor for assistant-initiated turns with no final reply.
    const host = final ?? rest[rest.length - 1] ?? entries[0] ?? subAgents[0] ?? files[0]
    if (
      host &&
      (entries.length ||
        subAgents.length ||
        files.length ||
        active ||
        final ||
        host.kind === 'interrupted')
    ) {
      const hostIsActivity = hidden.has(host)
      kept = rest
      if (hostIsActivity) kept.push(host)
      turns.set(host, {
        items: entries,
        subAgents,
        files,
        final,
        result,
        userMessageId: user?.id,
        ...(continuedBy ? { continuedBy } : {}),
        active,
        hostIsActivity,
        trigger
      })
      if (trigger) hosts.set(trigger, host)
      for (const item of entries) hosts.set(item, host)
      for (const item of files) hosts.set(item, host)
      for (const item of subAgents) hosts.set(item, host)
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
      flush(false, false)
      output.push(item)
    } else if (item.kind === 'user-text') {
      flush(false, true, item.joinsTurn ? item : undefined)
      segment.push(item, ...(attached.get(item) ?? []))
    } else {
      segment.push(item)
      if (item.kind === 'result' || item.kind === 'interrupted') completed = true
    }
  }
  flush(inFlight && !completed)
  return { rows: output, turns, hosts }
}
