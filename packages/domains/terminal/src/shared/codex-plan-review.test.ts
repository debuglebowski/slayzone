import { expect, test } from 'vitest'
import type { TimelineItem } from './chat-timeline'
import { selectCodexPlanReview } from './codex-plan-review'

const plan: TimelineItem = {
  kind: 'codex-plan',
  planId: 'p1',
  turnId: 't1',
  text: 'Build it',
  phase: 'completed',
  timestamp: 1
}
const result: TimelineItem = {
  kind: 'result',
  subtype: 'success',
  isError: false,
  durationMs: 1,
  totalCostUsd: 0,
  numTurns: 1,
  text: null,
  copyText: null,
  timestamp: 2
}

test('review only newest successful completed plan; dismissal survives replay', () => {
  expect(selectCodexPlanReview([plan, result], 'plan')).toMatchObject({
    planId: 'p1',
    phase: 'pending'
  })
  expect(
    selectCodexPlanReview(
      [
        plan,
        result,
        {
          kind: 'codex-plan-decision',
          planId: 'p1',
          decision: 'keep-planning',
          phase: 'completed',
          timestamp: 3
        }
      ],
      'plan'
    )
  ).toBeNull()
  expect(
    selectCodexPlanReview(
      [plan, result, { kind: 'user-text', text: 'revise', timestamp: 3 }],
      'plan'
    )
  ).toBeNull()
  expect(selectCodexPlanReview([plan, result], 'default')).toBeNull()
})

test('unfinished approved handoff can be retried in default mode', () => {
  expect(
    selectCodexPlanReview(
      [
        plan,
        result,
        {
          kind: 'codex-plan-decision',
          planId: 'p1',
          decision: 'implement',
          messageId: 'm1',
          phase: 'requested',
          timestamp: 3
        }
      ],
      'default'
    )
  ).toMatchObject({ planId: 'p1', phase: 'resume', messageId: 'm1' })
})

test('failed turn and revised plan never approve stale proposal', () => {
  const failed = { ...result, isError: true }
  expect(selectCodexPlanReview([plan, failed], 'plan')).toBeNull()
  const draft: TimelineItem = {
    kind: 'codex-plan',
    planId: 'p2',
    turnId: 't2',
    text: 'Revision',
    phase: 'streaming',
    timestamp: 4
  }
  expect(selectCodexPlanReview([plan, result, draft], 'plan')).toBeNull()
  const revision = { ...draft, phase: 'completed' as const }
  expect(
    selectCodexPlanReview([plan, result, revision, { ...result, timestamp: 5 }], 'plan')
  ).toMatchObject({ planId: 'p2', phase: 'pending' })
})
