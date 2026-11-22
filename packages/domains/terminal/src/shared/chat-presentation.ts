import { chatProviderForBinary } from '@slayzone/terminal-contracts'
import { streamKeyOf, type TimelineItem } from './chat-timeline'

// Plan approval now answers ExitPlanMode itself; the markers stay only so old
// conversations keep them hidden (`isRenderable`) and out of prompt history.
export const PLAN_APPROVED_MARKER = '__slay_plan_approved__'
export const PLAN_CANCELLED_MARKER = '__slay_plan_cancelled__'
export const isPlanMarker = (text: string): boolean =>
  text === PLAN_APPROVED_MARKER || text === PLAN_CANCELLED_MARKER

/**
 * Sub-agent launcher tool — `Agent` in current Claude Code SDK, `Task` in older
 * versions. Paired with a `kind:'sub-agent'` timeline row that already shows
 * status/usage; we render this card inside the SubAgentRow accordion instead of
 * at root.
 */
export function isAgentLauncherToolName(name: string | undefined): boolean {
  return name === 'Agent' || name === 'Task'
}

/**
 * Items the dispatcher renders as `null`. Virtualized lists must filter these
 * before counting, otherwise reserved slot heights leave ghost gaps.
 */
export function isRenderable(item: TimelineItem): boolean {
  if (item.kind === 'session-start') return false
  // A later marker closes the same turn: one "Turn interrupted" per turn.
  if (item.kind === 'interrupted' && item.superseded) return false
  if (item.kind === 'codex-plan-decision') return false
  if (item.kind === 'rate-limit' && item.status === 'allowed') return false
  // Launcher tool is rendered inside SubAgentRow's accordion, not at root.
  if (item.kind === 'tool' && isAgentLauncherToolName(item.invocation.name)) return false
  // Plan resolution markers are detector-only, never shown as user bubbles.
  if (item.kind === 'user-text' && isPlanMarker(item.text)) return false
  return true
}

/**
 * A row's key that is the same after a reload (from ids the events carry), for
 * scroll anchors (`data-anchor-key`). Null for rows only known by position.
 */
export function stableAnchorKey(item: TimelineItem): string | null {
  switch (item.kind) {
    case 'user-text':
      return item.id ? `user:${item.id}` : null
    case 'text':
    case 'thinking':
    case 'tool':
      // The streaming key (`text:<messageId>:<n>`, `tool:<id>`) is the same live
      // and on replay; rows from before streaming have no block ordinal.
      return (
        streamKeyOf(item) ??
        `${item.kind}:${item.kind === 'tool' ? item.invocation.id : item.messageId}`
      )
    case 'hook':
      return item.hookId ? `hook:${item.hookId}` : null
    case 'codex-plan':
      return `codex-plan:${item.planId}`
    case 'sub-agent':
      return `sub-agent:${item.toolUseId}`
    case 'notice':
      return item.id ? `notice:${item.id}` : null
    case 'files-changed':
    case 'workspace-changes':
      return item.id
    default:
      return null
  }
}

type Branch = Extract<TimelineItem, { kind: 'conversation-branch' }>

/** What a divider says happened (desktop's `ConversationBranchRow`). */
export function branchLabel(item: Branch, agent = 'Claude'): string {
  switch (item.reason) {
    case 'rewound':
      return `Rewound: ${agent} forgot what came after this point`
    case 'forked':
      return 'Forked into a new conversation'
    case 'fork-failed':
      return 'Fork failed: still the original conversation'
    case 'switched':
      if (item.source === 'terminal') return 'Continued from the terminal'
      return item.title ? `Resumed: ${item.title}` : 'Resumed an earlier conversation'
  }
}

/** The divider's show / hide control; null when it folds nothing. */
export function branchToggleLabel(item: Branch, open: boolean): string | null {
  if (item.hiddenCount <= 0) return null
  const what =
    item.reason === 'switched'
      ? 'previous conversation'
      : item.reason === 'forked'
        ? 'original conversation'
        : 'rewound'
  return open ? `Hide ${what}` : `Show ${what} (${item.hiddenCount})`
}

/** Where a turn ended without a reply (desktop's `InterruptedBlock`). */
export function interruptedLabel(
  item: Extract<TimelineItem, { kind: 'interrupted' }>,
  agent = 'Claude Code'
): string {
  switch (item.reason) {
    case 'already-in-conversation':
      return `Not run again: ${agent} already had this message`
    case 'watchdog':
      return 'Turn interrupted by SlayZone watchdog'
    case 'stop-request':
      return 'Turn stopped by request'
    default:
      return 'Turn interrupted'
  }
}

/**
 * An agent that could not start, in desktop's words (`AgentProblemCard`): what happened
 * and the way out. `inUse`: the terminal runs this conversation, so it can be continued
 * here (`chat.takeOver`).
 */
export function agentProblemText(item: Extract<TimelineItem, { kind: 'agent-problem' }>): {
  title: string
  hint: string
  inUse: boolean
} {
  const inUse = item.code === 'conversation-in-use'
  const name =
    (item.binary ? chatProviderForBinary(item.binary)?.product : undefined) ??
    item.binary ??
    'The agent'
  const title =
    item.code === 'cli-not-installed'
      ? `${name} isn't installed`
      : item.code === 'spawn-refused'
        ? 'The computer refused to start the agent'
        : inUse
          ? 'This conversation is running in the terminal'
          : "The agent couldn't start"
  const hint =
    item.code === 'cli-not-installed'
      ? `Install ${name} on the computer this task runs on (it must be on that computer's PATH), then retry.`
      : inUse
        ? 'One conversation runs in one place at a time. Continue it here (the terminal stops first), or stop it there and retry.'
        : 'Fix the cause below, then retry.'
  return { title, hint, inUse }
}

export interface AskOption {
  label: string
  description?: string
  /** Shown beside the options when focused (a mock-up, a snippet). */
  preview?: string
}
export interface AskQuestion {
  question: string
  header?: string
  multiSelect?: boolean
  options: AskOption[]
}

export function questionsOf(input: unknown): AskQuestion[] {
  const qs = (input as { questions?: unknown } | null)?.questions
  return Array.isArray(qs)
    ? qs.filter(
        (q): q is AskQuestion =>
          q !== null && typeof q === 'object' && typeof (q as AskQuestion).question === 'string'
      )
    : []
}
