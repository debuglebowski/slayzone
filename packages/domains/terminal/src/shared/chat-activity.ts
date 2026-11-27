/**
 * How a chat shows a turn's work, as plain data shared by every chat UI (desktop's
 * `ActivityTurn` / `AssistantAnswer`, the phone's turn blocks): which rows a turn
 * folds into its "Activities" (`activityView`), and which of those the user's display
 * settings show (`activityTurnDisplay`). The UIs only render what this decides.
 */
import type { ChatHistoryDisplay } from '@slayzone/terminal-contracts'
import type { TimelineItem } from './chat-timeline'
import { turnChangeSources, unifiedChangeRows, workspaceChangesShows } from './chat-turn-changes'

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
  inFlight: boolean,
  /** The agent's cwd: whether a capture shows a card depends on it (`workspaceChangesShows`). */
  cwd?: string
): {
  rows: TimelineItem[]
  turns: Map<TimelineItem, ActivityTurn>
  hosts: Map<TimelineItem, TimelineItem>
} {
  const sources = turnChangeSources(rows)
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
        (item.kind === 'text' || item.kind === 'thinking') &&
        !item.text &&
        item.stream !== 'open' &&
        !item.textDetail
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
    const allFiles = segment.filter(
      (item): item is Extract<TimelineItem, { kind: 'files-changed' | 'workspace-changes' }> =>
        item.kind === 'files-changed' || item.kind === 'workspace-changes'
    )
    // A capture that shows no card is no content: no turn block, no footer for it.
    const files = allFiles.filter(
      (item) =>
        item.kind !== 'workspace-changes' || workspaceChangesShows(item, sources.get(item), cwd)
    )
    const subAgents = segment.filter((item): item is SubAgentItem => item.kind === 'sub-agent')
    const trigger = segment.find((item): item is TurnTriggerItem => item.kind === 'turn-trigger')
    const hidden = new Set<TimelineItem>([...entries, ...allFiles, ...subAgents, ...empty])
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
      for (const item of allFiles) hosts.set(item, host)
      for (const item of subAgents) hosts.set(item, host)
      if (final && result) hosts.set(result, host)
    }
    output.push(...kept)
    segment = []
    completed = false
  }
  for (const item of rows) {
    if (consumed.has(item)) continue
    // CLI process diagnostics and workspace captures are published after turn
    // completion. A capture with no user message to attach to (an agent-started
    // turn's) belongs to the turn that just ended: alone it is an empty turn
    // block, and the next turn would claim it. Keep them with that turn,
    // stopping at any new content or history boundary.
    if (completed && item.kind !== 'stderr' && item.kind !== 'workspace-changes') flush(false)
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

/** The user's chat display settings for a turn's activity (desktop: Chat display options). */
export interface ChatActivitySettings {
  /** The "Activities" summary of a turn shows (else only its preview, files, sub-agents). */
  showActivities: boolean
  /** A running turn previews its latest activity. */
  previewLatestActivity: boolean
  /** Intermediate assistant messages are activities shown. */
  showActivityMessages: boolean
  showThinking: boolean
  showActivityTools: boolean
}

export const DEFAULT_CHAT_ACTIVITY_SETTINGS: ChatActivitySettings = {
  showActivities: true,
  previewLatestActivity: true,
  showActivityMessages: true,
  showThinking: true,
  showActivityTools: true
}

/** Whether the settings show this activity (process diagnostics always show). */
export function activityShown(item: ActivityItem, settings: ChatActivitySettings): boolean {
  switch (item.kind) {
    case 'stderr':
      return true
    case 'text':
      return settings.showActivityMessages
    case 'thinking':
      return settings.showThinking
    case 'tool':
      return settings.showActivityTools
  }
}

export interface ActivityTurnDisplay {
  /** The activities the summary lists (all of them while `forced`). */
  items: ActivityItem[]
  /** The "Activities" summary shows (the settings, or something inside asked to be seen). */
  showSummary: boolean
  /** The running turn's latest shown activity, previewed under it. */
  latest: ActivityItem | undefined
  /** Nothing of the turn's work shows: no block. */
  empty: boolean
}

/**
 * What a turn's activity block shows. `expanded`: the summary is open (its preview
 * then is the list itself). `forced`: something inside was asked for (a file's tool
 * card, a search hit), so every activity shows whatever the settings say.
 */
export function activityTurnDisplay(
  turn: Pick<ActivityTurn, 'items' | 'files' | 'subAgents' | 'active'>,
  settings: ChatActivitySettings,
  { expanded = false, forced = false }: { expanded?: boolean; forced?: boolean } = {}
): ActivityTurnDisplay {
  const shown = turn.items.filter((item) => activityShown(item, settings))
  const showSummary = settings.showActivities || forced
  const latest =
    turn.active && settings.previewLatestActivity && !(showSummary && expanded)
      ? shown[shown.length - 1]
      : undefined
  const empty =
    (!showSummary || !turn.items.length) && !latest && !turn.files.length && !turn.subAgents.length
  return { items: forced ? turn.items : shown, showSummary, latest, empty }
}

/**
 * What a client may ask the computer to leave out of history pages it never shows
 * (`ChatHistoryDisplay`): the payload is cut to what these settings display.
 */
export function chatHistoryDisplayFor(settings: ChatActivitySettings): ChatHistoryDisplay {
  return {
    ...(!settings.showThinking ? { hideThinking: true as const } : {}),
    ...(!settings.showActivities ? { hideActivities: true as const } : {}),
    ...(!settings.showActivityMessages ? { hideActivityMessages: true as const } : {}),
    ...(!settings.showActivityTools ? { hideActivityTools: true as const } : {})
  }
}
