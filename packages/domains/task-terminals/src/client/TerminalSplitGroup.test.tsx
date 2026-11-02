// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { TerminalSplitGroup } from './TerminalSplitGroup'
import type { TerminalTab } from '../shared/types'

vi.mock('@slayzone/transport/client', () => ({ useHubId: () => 'hub' }))
vi.mock('@slayzone/terminal/client/LazyTerminal', () => ({ Terminal: () => null }))
vi.mock('./TerminalStarter', () => ({ TerminalStarter: () => null }))
vi.mock('./TerminalContextMenu', () => ({ TerminalContextMenu: () => null }))
vi.mock('./chat/ChatPanel', () => ({
  ChatPanel: ({ tabId }: { tabId: string }) => <textarea aria-label={`Composer ${tabId}`} />
}))

afterEach(cleanup)

test('chat composers render on the first commit without a second lazy-loading boundary', () => {
  const tab: TerminalTab = {
    id: 'main',
    taskId: 'task',
    groupId: 'group',
    label: null,
    mode: 'claude-chat',
    isMain: true,
    position: 0,
    createdAt: '2026-11-03',
    agentState: 'new'
  }
  render(
    <TerminalSplitGroup
      isActive
      panes={['main', 'split'].map((id) => ({
        tab: { ...tab, id },
        taskId: 'task',
        sessionId: id,
        cwd: '/repo'
      }))}
    />
  )
  // An async assertion would hide the first-open fallback and its visible pause.
  expect(screen.getByRole('textbox', { name: 'Composer main' })).toBeTruthy()
  expect(screen.getByRole('textbox', { name: 'Composer split' })).toBeTruthy()
})
