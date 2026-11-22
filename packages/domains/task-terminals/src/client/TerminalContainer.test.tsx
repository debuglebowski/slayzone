// @vitest-environment jsdom
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { TerminalGroup, TerminalTab } from '../shared/types'

const tab = (id: string, groupId: string, isMain: boolean): TerminalTab =>
  ({
    id,
    taskId: 'task',
    groupId,
    label: null,
    mode: isMain ? 'claude-chat' : 'terminal',
    isMain,
    position: isMain ? 0 : 1,
    createdAt: '2026-11-18',
    agentState: 'new'
  }) as TerminalTab

const mainTab = tab('task', 'task', true)
const otherTab = tab('other', 'other', false)
const groups: TerminalGroup[] = [
  { id: 'task', tabs: [mainTab], isMain: true },
  { id: 'other', tabs: [otherTab], isMain: false }
]

let setActive: (id: string) => void = () => {}
/** What the mocked hook reports about its load; null = loaded with both groups. */
let loadOverride: { loadState: 'loading' | 'loaded' | 'failed'; empty: boolean } | null = null
const reload = vi.fn()
const mounts: string[] = []
const focused: string[] = []

vi.mock('./useTaskTerminals', () => ({
  useTaskTerminals: () => {
    const [activeGroupId, setActiveGroupId] = useState('task')
    setActive = setActiveGroupId
    const empty = loadOverride?.empty ?? false
    return {
      tabs: empty ? [] : [mainTab, otherTab],
      groups: empty ? [] : groups,
      loadState: loadOverride?.loadState ?? 'loaded',
      reload,
      activeGroupId,
      setActiveGroupId,
      createTab: vi.fn(),
      splitTab: vi.fn(),
      closeTab: vi.fn(),
      movePane: vi.fn(),
      renameTab: vi.fn(),
      setChatFontSize: vi.fn(),
      getSessionId: (id: string) => `task:${id}`
    }
  }
}))
const mutate = { mutate: () => Promise.resolve() }
vi.mock('./trpc', () => ({
  useTRPCClient: () => ({
    app: { taskWindows: { claimSession: mutate, releaseSession: mutate } },
    pty: { kill: mutate }
  })
}))
vi.mock('@slayzone/terminal', () => ({
  markSkipCache: vi.fn(),
  usePty: () => ({ subscribePrompt: () => () => {}, subscribeTitle: () => () => {} })
}))
vi.mock('@slayzone/ui', async (orig) => ({
  ...(await orig<typeof import('@slayzone/ui')>()),
  useTheme: () => ({ terminalOverrideThemeId: null, contentVariant: 'dark' })
}))
vi.mock('./TerminalTabBar', () => ({ TerminalTabBar: () => null }))
vi.mock('./agent-prompts/AgentPromptsSidebar', () => ({
  AgentPromptsSidebar: () => null,
  AgentPromptsToggleButton: () => null,
  usePromptsSidebarOpen: () => [false, () => {}]
}))
vi.mock('./agent-sessions/SessionsSidebar', () => ({
  SessionsSidebar: () => null,
  SessionHistoryToggleButton: () => null,
  useSessionsSidebarOpen: () => [false, () => {}]
}))
vi.mock('./agent-sessions/useFamilySessions', () => ({ useFamilySessions: () => [] }))
vi.mock('./chat/ChatFontSizeControl', () => ({ ChatFontSizeControl: () => null }))
vi.mock('./TerminalSplitGroup', () => ({
  TerminalSplitGroup: forwardRef(function FakeGroup(
    { panes, isActive }: { panes: { sessionId: string }[]; isActive?: boolean },
    ref
  ) {
    const id = panes.map((p) => p.sessionId).join(',')
    useImperativeHandle(ref, () => ({ focus: () => focused.push(id) }))
    useEffect(() => {
      mounts.push(id)
    }, [id])
    return <div data-testid={`group ${id}`} data-active={String(!!isActive)} />
  })
}))

const { TerminalContainer } = await import('./TerminalContainer')

beforeEach(() => {
  loadOverride = null
  reload.mockReset()
  mounts.length = 0
  focused.length = 0
})
afterEach(cleanup)

test('switching tab groups keeps a visited group mounted, only the active one is live', () => {
  render(<TerminalContainer taskId="task" cwd="/repo" defaultMode="claude-chat" />)
  // A group never visited isn't mounted (its terminals start on first visit).
  expect(mounts).toEqual(['task:task'])

  act(() => setActive('other'))
  act(() => setActive('task'))
  act(() => setActive('other'))

  expect(mounts).toEqual(['task:task', 'task:other'])
  expect(screen.getByTestId('group task:task').dataset.active).toBe('false')
  expect(screen.getByTestId('group task:other').dataset.active).toBe('true')
})

test('switching back to a mounted group focuses it (no pane attach completes the claim)', () => {
  render(<TerminalContainer taskId="task" cwd="/repo" defaultMode="claude-chat" isActive />)
  act(() => setActive('other'))
  focused.length = 0
  act(() => setActive('task'))
  expect(focused).toEqual(['task:task'])
})

test('no tabs of your own after a successful load: offers to start an agent', () => {
  loadOverride = { loadState: 'loaded', empty: true }
  render(<TerminalContainer taskId="task" cwd="/repo" defaultMode="claude-chat" />)
  expect(screen.queryByTestId('terminal-empty-own')).not.toBeNull()
  expect(screen.queryByTestId('terminal-load-failed')).toBeNull()
})

test('a failed load is an error with a retry, never the start-your-own offer', () => {
  loadOverride = { loadState: 'failed', empty: true }
  render(<TerminalContainer taskId="task" cwd="/repo" defaultMode="claude-chat" />)
  expect(screen.queryByTestId('terminal-empty-own')).toBeNull()
  const failed = screen.getByTestId('terminal-load-failed')
  act(() => failed.querySelector('button')!.click())
  expect(reload).toHaveBeenCalledTimes(1)
})

test('while loading, neither the offer nor the error shows', () => {
  loadOverride = { loadState: 'loading', empty: true }
  render(<TerminalContainer taskId="task" cwd="/repo" defaultMode="claude-chat" />)
  expect(screen.queryByTestId('terminal-empty-own')).toBeNull()
  expect(screen.queryByTestId('terminal-load-failed')).toBeNull()
})
