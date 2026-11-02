// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { ChatStorageNotice } from './ChatStorageNotice'

afterEach(cleanup)

test('audit: migration failure must remain visible beside the migration status', () => {
  render(
    <ChatStorageNotice
      status={{
        state: 'migrating',
        computer: { id: 'pc', name: 'Workstation' },
        waitingForAgents: false
      }}
      error="Migration attachment verification incomplete"
      onRetry={() => undefined}
    />
  )
  expect(screen.getByRole('status').textContent).toContain(
    'Migration attachment verification incomplete'
  )
})
