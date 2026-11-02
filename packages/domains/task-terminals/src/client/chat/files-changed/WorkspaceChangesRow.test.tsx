// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { TimelineItem } from '@slayzone/terminal/client'
import type { FileDiff } from '@slayzone/diff-view'
import { WorkspaceChangesRow } from './WorkspaceChangesRow'
import { FilesChangedPanel } from './FilesChangedPanel'
import { ChatViewContext, defaultChatView } from '../ChatViewContext'

const queries = vi.hoisted(() => ({ get: vi.fn(), diff: vi.fn() }))
vi.mock('../../trpc', () => ({
  useTRPCClient: () => ({
    chat: {
      workspaceChanges: { get: { query: queries.get }, getFileDiff: { query: queries.diff } }
    }
  })
}))
vi.mock('../diff-comments/ChatDiffView', () => ({
  ChatDiffView: ({ diff }: { diff: FileDiff }) => (
    <pre data-testid="saved-diff">{JSON.stringify(diff)}</pre>
  )
}))
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

it('opens saved workspace diffs independently of native edit tools', async () => {
  queries.get.mockResolvedValue({
    status: 'complete',
    files: [
      {
        path: 'shell.ts',
        kind: 'modified',
        additions: 1,
        deletions: 1,
        binary: false,
        hasDiff: true,
        diff: null
      }
    ]
  })
  queries.diff.mockResolvedValue(
    'diff --git a/shell.ts b/shell.ts\n--- a/shell.ts\n+++ b/shell.ts\n@@ -1 +1 @@\n-before\n+after\n'
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <WorkspaceChangesRow
        item={{
          kind: 'workspace-changes',
          tabId: 'tab',
          captureId: 'capture',
          messageId: 'm',
          id: 'workspace:capture',
          status: 'complete',
          fileCount: 1,
          timestamp: 1
        }}
      />
    </QueryClientProvider>
  )
  expect(queries.get).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /1 file changed/ }))
  expect(
    await screen.findByText(
      'Net changes during this turn may include manual edits or other agents.',
      { exact: false }
    )
  ).toBeTruthy()
  fireEvent.click(await screen.findByRole('button', { name: /shell.ts/ }))
  expect((await screen.findByTestId('saved-diff')).textContent).toContain('after')
  expect(queries.diff).toHaveBeenCalledWith({
    tabId: 'tab',
    captureId: 'capture',
    path: 'shell.ts'
  })
})

it('hides a failed capture with no recorded edits: "unavailable" says nothing', () => {
  const client = new QueryClient()
  render(
    <QueryClientProvider client={client}>
      <WorkspaceChangesRow
        item={{
          kind: 'workspace-changes',
          tabId: 'tab',
          captureId: 'unavailable',
          messageId: 'm',
          id: 'workspace:unavailable',
          status: 'unavailable',
          fileCount: 0,
          timestamp: 1
        }}
      />
    </QueryClientProvider>
  )
  expect(screen.queryByTestId('chat-files-changed')).toBeNull()
  expect(screen.queryByText('Changes unavailable')).toBeNull()
  expect(screen.queryByText('0 files')).toBeNull()
})

it('labels a turn cut short by its agent ending as interrupted', () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <WorkspaceChangesRow
        item={{
          kind: 'workspace-changes',
          tabId: 'tab',
          captureId: 'cut',
          messageId: 'm',
          id: 'workspace:cut',
          status: 'unavailable',
          interrupted: true,
          reason: 'Agent process was replaced.',
          fileCount: 0,
          timestamp: 1
        }}
      />
    </QueryClientProvider>
  )
  expect(screen.getByText('Turn interrupted')).toBeTruthy()
  expect(screen.queryByText('Changes unavailable')).toBeNull()
})

const workspace = {
  kind: 'workspace-changes' as const,
  tabId: 'tab',
  captureId: 'capture',
  messageId: 'u',
  id: 'workspace:capture',
  status: 'complete' as const,
  fileCount: 5,
  timestamp: 3
}

it('opens existing review panel for this capture without loading a second inline surface', () => {
  const open = vi.fn()
  render(
    <ChatViewContext.Provider value={{ ...defaultChatView, filesPanel: { open } }}>
      <WorkspaceChangesRow item={workspace} embedded />
    </ChatViewContext.Provider>
  )
  fireEvent.click(screen.getByRole('button', { name: /5 files changed/ }))
  expect(open).toHaveBeenCalledWith(undefined, 'capture')
  expect(queries.get).not.toHaveBeenCalled()
})

it('falls back to explicitly labelled recorded edits when capture unavailable', () => {
  const recorded = {
    kind: 'files-changed' as const,
    id: 'files:t',
    timestamp: 2,
    shellCommands: 1,
    files: [{ path: '/repo/a.ts', additions: 1, deletions: 0, created: true, toolUseIds: ['t'] }]
  }
  const unavailable = { ...workspace, status: 'unavailable' as const, fileCount: 0 }
  const open = vi.fn()
  render(
    <ChatViewContext.Provider
      value={{
        ...defaultChatView,
        filesPanel: { open },
        timeline: [
          { kind: 'user-text', id: 'u', text: 'edit', timestamp: 0 },
          recorded,
          { kind: 'result', isError: false, timestamp: 2 } as TimelineItem,
          unavailable
        ]
      }}
    >
      <WorkspaceChangesRow item={unavailable} embedded />
    </ChatViewContext.Provider>
  )
  expect(screen.getByText('Recorded edits only')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /1 file changed/ }))
  expect(open).toHaveBeenCalledWith(undefined, 'capture')
  expect(screen.queryByText('0 files changed')).toBeNull()
})

it('reviews shell changes in the same panel and preserves tool attribution', async () => {
  queries.diff.mockResolvedValue('')
  const recorded = {
    kind: 'files-changed' as const,
    id: 'files:t',
    timestamp: 2,
    shellCommands: 1,
    files: [
      { path: '/repo/shell.ts', additions: 1, deletions: 1, created: false, toolUseIds: ['t'] }
    ]
  }
  queries.get.mockResolvedValue({
    status: 'complete',
    files: [
      {
        path: 'shell.ts',
        kind: 'modified',
        additions: 1,
        deletions: 1,
        binary: false,
        hasDiff: true
      }
    ]
  })
  const timeline: TimelineItem[] = [
    { kind: 'user-text', id: 'u', text: 'edit', timestamp: 0 },
    recorded,
    workspace
  ]
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ChatViewContext.Provider value={{ ...defaultChatView, cwd: '/repo', timeline }}>
        <FilesChangedPanel timeline={timeline} cwd="/repo" captureId="capture" onClose={() => {}} />
      </ChatViewContext.Provider>
    </QueryClientProvider>
  )
  fireEvent.click(await screen.findByRole('button', { name: /shell.ts/ }))
  expect(screen.getByRole('button', { name: 'View recorded edits' })).toBeTruthy()
  expect(screen.queryByText(/shell commands can't be seen here/)).toBeNull()
  expect(screen.queryByText(/Workspace changes during this turn/)).toBeNull()
})

it('hides a zero-change turn that recorded no edits', () => {
  render(<WorkspaceChangesRow item={{ ...workspace, fileCount: 0 }} />)
  expect(screen.queryByTestId('chat-files-changed')).toBeNull()
})

it('retains a true zero count when recorded edits were reverted', () => {
  const zero = { ...workspace, fileCount: 0 }
  render(
    <ChatViewContext.Provider
      value={{
        ...defaultChatView,
        cwd: '/repo',
        timeline: [
          { kind: 'user-text', id: 'u', text: 'edit', timestamp: 0 },
          {
            kind: 'files-changed',
            id: 'files:t',
            timestamp: 2,
            shellCommands: 0,
            files: [
              { path: '/repo/a.ts', additions: 1, deletions: 0, created: false, toolUseIds: ['t'] }
            ]
          },
          { kind: 'result', isError: false, timestamp: 2 } as TimelineItem,
          zero
        ]
      }}
    >
      <WorkspaceChangesRow item={zero} />
    </ChatViewContext.Provider>
  )
  expect(screen.getByRole('button', { name: /0 files changed/ })).toBeTruthy()
})

it('hides a zero-change turn whose recorded edits are all outside the workspace', () => {
  const zero = { ...workspace, fileCount: 0 }
  render(
    <ChatViewContext.Provider
      value={{
        ...defaultChatView,
        cwd: '/repo',
        timeline: [
          { kind: 'user-text', id: 'u', text: 'edit artifact', timestamp: 0 },
          {
            kind: 'files-changed',
            id: 'files:t',
            timestamp: 2,
            shellCommands: 0,
            files: [
              {
                path: '/home/me/.slayzone/artifacts/report.html',
                additions: 1,
                deletions: 0,
                created: false,
                toolUseIds: ['t']
              }
            ]
          },
          { kind: 'result', isError: false, timestamp: 2 } as TimelineItem,
          zero
        ]
      }}
    >
      <WorkspaceChangesRow item={zero} />
    </ChatViewContext.Provider>
  )
  expect(screen.queryByTestId('chat-files-changed')).toBeNull()
})
