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
