// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { FileDiff } from '@slayzone/diff-view'
import { WorkspaceChangesRow } from './WorkspaceChangesRow'

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
  fireEvent.click(screen.getByRole('button', { name: /Workspace changes during this turn/ }))
  expect(
    await screen.findByText('Other tasks or manual edits may contribute.', { exact: false })
  ).toBeTruthy()
  fireEvent.click(await screen.findByRole('button', { name: /shell.ts/ }))
  expect((await screen.findByTestId('saved-diff')).textContent).toContain('after')
  expect(queries.diff).toHaveBeenCalledWith({
    tabId: 'tab',
    captureId: 'capture',
    path: 'shell.ts'
  })
})

it('never labels unavailable tracking as zero changed files', () => {
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
  expect(screen.getByText('Unavailable')).toBeTruthy()
  expect(screen.queryByText('0 files')).toBeNull()
})
