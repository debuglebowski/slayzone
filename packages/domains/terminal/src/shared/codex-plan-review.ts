import type { ChatCollaborationMode } from '@slayzone/terminal-contracts'
import type { TimelineItem, TimelineRows } from './chat-timeline'

export interface CodexPlanReview {
  planId: string
  text: string
  phase: 'pending' | 'resume'
  messageId?: string
}

/** Derive actionable review from persisted rows, including after reload. */
export function selectCodexPlanReview(
  rows: Readonly<TimelineRows> | readonly TimelineItem[],
  collaboration: ChatCollaborationMode
): CodexPlanReview | null {
  let planAt = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (row?.kind === 'codex-plan') {
      if (row.phase !== 'completed') return null
      planAt = i
      break
    }
  }
  if (planAt < 0) return null
  const plan = rows[planAt]
  if (plan?.kind !== 'codex-plan' || !plan.text.trim()) return null
  const later = rows.slice(planAt + 1)
  const decision = [...later]
    .reverse()
    .find((row) => row?.kind === 'codex-plan-decision' && row.planId === plan.planId)
  if (decision?.kind === 'codex-plan-decision') {
    if (decision.phase === 'completed') return null
    if (decision.decision === 'implement' && decision.messageId)
      return {
        planId: plan.planId,
        text: plan.text,
        phase: 'resume',
        messageId: decision.messageId
      }
  }
  if (collaboration !== 'plan') return null
  if (later.some((row) => row?.kind === 'user-text')) return null
  const turnResult = [...later].reverse().find((row) => row?.kind === 'result')
  if (turnResult?.kind !== 'result' || turnResult.isError) return null
  return { planId: plan.planId, text: plan.text, phase: 'pending' }
}
