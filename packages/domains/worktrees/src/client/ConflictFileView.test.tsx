// @vitest-environment jsdom
// The conflict editor follows the app's editor theme and font size live: a
// change restyles the open view in place — it is not rebuilt, so in-progress
// resolution edits survive.
import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { EditorView } from 'codemirror'
import type { MergeContext } from '@slayzone/task-contracts'

let theme = { editorThemeId: 'default', contentVariant: 'dark' }
let appearance = { editorFontSize: 13 }
vi.mock('@slayzone/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@slayzone/ui')>()),
  useTheme: () => theme,
  useAppearance: () => appearance
}))

const content = { base: 'a\n', ours: 'b\n', theirs: 'c\n', merged: 'merged\n' }
const trpc = {
  worktrees: {
    writeResolvedFile: { mutationOptions: () => ({}) },
    stageFile: { mutationOptions: () => ({}) },
    analyzeConflict: { mutationOptions: () => ({}) },
    getConflictContent: {
      queryOptions: (input: unknown) => ({
        queryKey: ['getConflictContent', input],
        queryFn: async () => content
      })
    }
  }
}
vi.mock('./trpc', async () => await import('@slayzone/transport/client'))
vi.mock('@slayzone/transport/client', () => ({ useTRPC: () => trpc }))

const { ConflictFileView } = await import('./ConflictFileView')
const { TooltipProvider } = await import('@slayzone/ui')

afterEach(() => {
  cleanup()
  theme = { editorThemeId: 'default', contentVariant: 'dark' }
  appearance = { editorFontSize: 13 }
})

const ctx: MergeContext = { type: 'merge', sourceBranch: 'feature', targetBranch: 'main' }

async function setup() {
  const client = new QueryClient()
  const el = (): React.ReactElement => (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ConflictFileView
          repoPath="/repo"
          filePath="a.ts"
          terminalMode="claude-code"
          onResolved={() => {}}
          branchContext={ctx}
        />
      </TooltipProvider>
    </QueryClientProvider>
  )
  const ui = render(el())
  await waitFor(() => expect(ui.container.querySelector('.cm-editor')).toBeTruthy())
  const editorView = (): EditorView =>
    EditorView.findFromDOM(ui.container.querySelector('.cm-editor') as HTMLElement)!
  return { ui, el, editorView }
}

describe('ConflictFileView editor', () => {
  it('restyles the open view on a theme change, keeping edits', async () => {
    const { ui, el, editorView } = await setup()
    const view = editorView()
    act(() => view.dispatch({ changes: { from: 0, insert: 'X' } }))
    const before = view.dom.className

    theme = { editorThemeId: 'default', contentVariant: 'light' }
    ui.rerender(el())

    expect(editorView()).toBe(view)
    expect(view.state.doc.toString()).toBe('Xmerged\n')
    expect(view.dom.className).not.toBe(before)
  })

  it('restyles the open view on a font size change, keeping edits', async () => {
    const { ui, el, editorView } = await setup()
    const view = editorView()
    act(() => view.dispatch({ changes: { from: 0, insert: 'X' } }))
    const before = view.dom.className

    appearance = { editorFontSize: 18 }
    ui.rerender(el())

    expect(editorView()).toBe(view)
    expect(view.state.doc.toString()).toBe('Xmerged\n')
    expect(view.dom.className).not.toBe(before)
  })
})
