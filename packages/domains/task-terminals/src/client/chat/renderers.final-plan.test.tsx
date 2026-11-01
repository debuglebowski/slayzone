// @vitest-environment jsdom
import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import type { TimelineItem } from '@slayzone/terminal/client'

vi.mock('@slayzone/diff-view', () => ({ DiffView: () => null }))
vi.mock('@slayzone/markdown/client', () => ({
  GhMarkdown: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}))

import { renderTimelineItem } from './renderers'

afterEach(cleanup)

describe('final plan presentation', () => {
  it.each(['streaming', 'completed'] as const)(
    'gives a %s Codex plan its own labeled card',
    (phase) => {
      render(
        renderTimelineItem(
          {
            kind: 'codex-plan',
            planId: 'plan',
            turnId: 'turn',
            text: '# Ship it\n\n1. Add tests\n2. Implement',
            phase,
            timestamp: 0
          },
          'plan'
        )
      )
      const card = screen.getByRole('region', { name: 'Final plan' })
      expect(within(card).getByText(/1\. Add tests/)).toBeTruthy()
      expect(within(card).queryByText('Writing…') !== null).toBe(phase === 'streaming')
    }
  )

  it('uses the same card for Claude while preserving plan contents', () => {
    const item: TimelineItem = {
      kind: 'tool',
      timestamp: 0,
      invocation: {
        id: 'exit',
        name: 'ExitPlanMode',
        status: 'done',
        input: { plan: 'Add tests first.' }
      }
    }
    render(renderTimelineItem(item, 'plan'))
    expect(
      within(screen.getByRole('region', { name: 'Final plan' })).getByText('Add tests first.')
    ).toBeTruthy()
  })

  it('keeps ordinary answers and progress checklists out of the final-plan card', () => {
    render(
      <>
        {renderTimelineItem(
          {
            kind: 'text',
            role: 'assistant',
            messageId: 'reply',
            text: 'My plan is ready.',
            timestamp: 0
          },
          'reply'
        )}
        {renderTimelineItem(
          { kind: 'plan', steps: [{ step: 'Investigate', status: 'inProgress' }], timestamp: 0 },
          'progress'
        )}
      </>
    )
    expect(screen.queryByRole('region', { name: 'Final plan' })).toBeNull()
    expect(screen.getByText('My plan is ready.')).toBeTruthy()
  })
})
