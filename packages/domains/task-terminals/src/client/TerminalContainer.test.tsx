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
let hoverGroup: (id: string | null) => void = () => {}
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
vi.mock('./TerminalTabBar', () => ({
  TerminalTabBar: ({ onGroupHover }: { onGroupHover: typeof hoverGroup }) => {
    hoverGroup = onGroupHover
    return null
  }
}))
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
    {
      panes,
      isActive,
      prefetchOnly
    }: { panes: { sessionId: string }[]; isActive?: boolean; prefetchOnly?: boolean },
    ref
  ) {
    const id = panes.map((p) => p.sessionId).join(',')
    useImperativeHandle(ref, () => ({ focus: () => focused.push(id) }))
    useEffect(() => {
      mounts.push(id)
    }, [id])
    return (
      <div
        data-testid={`group ${id}`}
        data-active={String(!!isActive)}
        data-prefetch={String(!!prefetchOnly)}
      />
    )
  })
}))

const { TerminalContainer } = await import('./TerminalContainer')

beforeEach(() => {
  loadOverride = null
  reload.mockReset()
  mounts.length = 0
  focused.length = 0
  otherTab.mode = 'terminal'
  otherTab.agentState = 'new'
})
afterEach(cleanup)

test('a hovered chat prefetches once and stays mounted when selected', () => {
  otherTab.mode = 'claude-chat'
  otherTab.agentState = 'stopped'
  vi.useFakeTimers()
  try {
    render(<TerminalContainer isActive taskId="task" cwd="/repo" defaultMode="claude-chat" />)
    act(() => hoverGroup('other'))
    act(() => vi.advanceTimersByTime(100))
    act(() => hoverGroup(null))
    act(() => vi.advanceTimersByTime(200))
    expect(mounts).toEqual(['task:task'])
    act(() => hoverGroup('other'))
    act(() => vi.advanceTimersByTime(180))
    const group = screen.getByTestId('group task:other')
    expect(group.dataset.prefetch).toBe('true')
    expect(group.dataset.active).toBe('false')
    act(() => setActive('other'))
    expect(screen.getByTestId('group task:other')).toBe(group)
    expect(group.dataset.prefetch).toBe('false')
    expect(group.dataset.active).toBe('true')
    expect(mounts).toEqual(['task:task', 'task:other'])
  } finally {
    vi.useRealTimers()
  }
})

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

// Several agent/terminal panels split a task's terminal groups (panel-model step 7).
test('a group filter shows only its groups; the active one falls back to the first shown', () => {
  const { unmount } = render(
    <TerminalContainer
      isActive
      taskId="task"
      cwd="/repo"
      defaultMode="claude-chat"
      groupFilter={{ only: ['other'] }}
    />
  )
  // The main group (active in the hook) belongs to another panel: `other` shows.
  expect(screen.queryByTestId('group task:task')).toBeNull()
  expect(screen.getByTestId('group task:other').dataset.active).toBe('true')
  unmount()
  render(
    <TerminalContainer
      isActive
      taskId="task"
      cwd="/repo"
      defaultMode="claude-chat"
      groupFilter={{ except: ['other'] }}
    />
  )
  act(() => setActive('other'))
  expect(screen.queryByTestId('group task:other')).toBeNull()
  expect(screen.getByTestId('group task:task').dataset.active).toBe('true')
})

test('a panel showing no group gets its own empty state, not the start-your-own offer', () => {
  render(
    <TerminalContainer
      taskId="task"
      cwd="/repo"
      defaultMode="claude-chat"
      groupFilter={{ only: [] }}
      emptyState={<div data-testid="panel-empty" />}
    />
  )
  expect(screen.queryByTestId('panel-empty')).not.toBeNull()
  expect(screen.queryByTestId('terminal-empty-own')).toBeNull()
})

test('while loading, neither the offer nor the error shows', () => {
  loadOverride = { loadState: 'loading', empty: true }
  render(<TerminalContainer taskId="task" cwd="/repo" defaultMode="claude-chat" />)
  expect(screen.queryByTestId('terminal-empty-own')).toBeNull()
  expect(screen.queryByTestId('terminal-load-failed')).toBeNull()
})
