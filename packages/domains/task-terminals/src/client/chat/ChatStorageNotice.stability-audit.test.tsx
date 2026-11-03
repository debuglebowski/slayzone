// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { ChatOpenFailure } from './ChatOpenFailure'

afterEach(cleanup)

test('audit: migration failure must remain visible beside the migration status', () => {
  render(
    <ChatOpenFailure
      status={{
        state: 'migrating',
        computer: { id: 'pc', name: 'Workstation' },
        waitingForAgents: false
      }}
      error="Migration attachment verification incomplete"
      placement="center"
      onRetry={() => undefined}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Details' }))
  expect(screen.getByRole('status').textContent).toContain('Moving chat to Workstation')
  expect(screen.getByRole('status').textContent).toContain(
    'Migration attachment verification incomplete'
  )
})
