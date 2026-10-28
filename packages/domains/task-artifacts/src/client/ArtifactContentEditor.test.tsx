// @vitest-environment jsdom
// The editor's load/flush effect across a tab switch (task tabs live in
// <Activity>, which tears effects down on hide and re-runs them on show):
// - hiding flushes an unsaved edit to disk at once (the debounced save is dropped);
// - showing reloads the file from disk;
// - an image's preview is cache-busted on show, so it re-reads the file.
import { Activity } from 'react'
import type React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { toSlzFileUrl } from '@slayzone/platform/slz-file-url'
import type { TaskArtifact } from '@slayzone/task-contracts'

// Stable clients, like the real providers' (the editor's callbacks depend on them).
vi.mock('@slayzone/transport/client', () => {
  const trpc = { artifacts: { onContentChanged: { subscriptionOptions: () => ({}) } } }
  const trpcClient = {
    artifacts: { getMtime: { query: async ({ id }: { id: string }) => disk.mtime[id] ?? null } },
    app: { shell: { openExternal: { mutate: vi.fn() } } }
  }
  return { useTRPC: () => trpc, useTRPCClient: () => trpcClient, useSubscription: () => undefined }
})
const appearance = {
  notesFontFamily: 'sans',
  notesCheckedHighlight: false,
  notesShowToolbar: false,
  notesSpellcheck: false,
  editorMinimapEnabled: false,
  editorTocEnabled: false
}
const theme = { editorThemeId: 'default', contentVariant: 'dark' }
vi.mock('@slayzone/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@slayzone/ui')>()),
  useAppearance: () => appearance,
  // The 1s mtime poll is its own path (external writes); not under test here.
  useVisibleInterval: () => undefined
}))
vi.mock('@slayzone/settings/client', () => ({ useTheme: () => theme }))
vi.mock('@slayzone/editor', () => ({
  RichTextEditor: () => null,
  resolveReadOnlyLinkClickTarget: () => null,
  usePdfViewerLinks: () => undefined,
  useHtmlPreviewLinks: () => undefined
}))
vi.mock('@slayzone/markdown/client', () => ({
  Markdown: () => null,
  MermaidBlock: () => null,
  MediaView: ({ source }: { source: { src?: string } }) => (
    <img data-testid="media" src={source.src} alt="" />
  )
}))
vi.mock('@slayzone/file-editor/client/SearchableCodeView', () => ({
  SearchableCodeView: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea data-testid="code" value={value} onChange={(e) => onChange(e.target.value)} />
  )
}))
vi.mock('@slayzone/file-editor/client/EditorToc', () => ({ EditorToc: () => null }))

const { ArtifactContentEditor } = await import('./ArtifactContentEditor')

const disk: { content: Record<string, string>; mtime: Record<string, number> } = {
  content: {},
  mtime: {}
}
const readContent = vi.fn(async (id: string) => disk.content[id] ?? null)
const saveContent = vi.fn(async (id: string, content: string) => {
  disk.content[id] = content
  disk.mtime[id] = (disk.mtime[id] ?? 0) + 1
})
const getFilePath = vi.fn(async (id: string) => `/data/${id}`)

const artifact = (id: string, title: string): TaskArtifact =>
  ({ id, task_id: 't1', title, folder_id: null, render_mode: null }) as unknown as TaskArtifact
const NOTES = artifact('a1', 'notes.md')
const IMAGE = artifact('img', 'pic.png')

function Tab({ mode, art = NOTES }: { mode: 'visible' | 'hidden'; art?: TaskArtifact }) {
  const props: React.ComponentProps<typeof ArtifactContentEditor> = {
    artifact: art,
    viewMode: 'raw',
    readContent,
    saveContent,
    getFilePath,
    effectiveReadability: 'normal',
    effectiveWidth: 'wide',
    zoomPct: 100,
    htmlTheme: 'system',
    searchQuery: '',
    searchActiveIndex: 0,
    searchMatchCase: false,
    searchRegex: false,
    onSearchMatchCountChange: () => undefined
  }
  return (
    <Activity mode={mode}>
      <ArtifactContentEditor {...props} />
    </Activity>
  )
}

const code = () => screen.queryByTestId('code') as HTMLTextAreaElement | null
const flush = () => act(async () => {})

beforeEach(() => {
  vi.useFakeTimers()
  disk.content = { a1: 'v1' }
  disk.mtime = { a1: 1, img: 1 }
  readContent.mockClear()
  saveContent.mockClear()
  getFilePath.mockClear()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('ArtifactContentEditor across a tab switch', () => {
  it('hiding flushes an unsaved edit at once; the debounced save does not run after', async () => {
    const view = render(<Tab mode="visible" />)
    await flush()
    expect(code()?.value).toBe('v1')

    fireEvent.change(code()!, { target: { value: 'edited' } })
    view.rerender(<Tab mode="hidden" />)
    expect(saveContent.mock.calls).toEqual([['a1', 'edited']])

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(saveContent).toHaveBeenCalledTimes(1)
  })

  it('hiding with nothing unsaved writes nothing', async () => {
    const view = render(<Tab mode="visible" />)
    await flush()
    view.rerender(<Tab mode="hidden" />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(saveContent).not.toHaveBeenCalled()
  })

  it('showing reloads the file from disk', async () => {
    const view = render(<Tab mode="visible" />)
    await flush()
    expect(readContent).toHaveBeenCalledTimes(1)

    view.rerender(<Tab mode="hidden" />)
    disk.content.a1 = 'changed on disk'
    view.rerender(<Tab mode="visible" />)
    await flush()
    expect(readContent).toHaveBeenCalledTimes(2)
    expect(code()?.value).toBe('changed on disk')
  })

  it('an edit flushed on hide is what the reload on show reads back', async () => {
    const view = render(<Tab mode="visible" />)
    await flush()
    fireEvent.change(code()!, { target: { value: 'kept' } })
    view.rerender(<Tab mode="hidden" />)
    view.rerender(<Tab mode="visible" />)
    await flush()
    expect(code()?.value).toBe('kept')
    expect(disk.content.a1).toBe('kept')
  })

  it("showing cache-busts an image's preview, so it re-reads the file", async () => {
    const view = render(<Tab mode="visible" art={IMAGE} />)
    await flush()
    const src = () => screen.getByTestId('media').getAttribute('src')
    expect(src()).toBe(toSlzFileUrl('/data/img', 1))

    view.rerender(<Tab mode="hidden" art={IMAGE} />)
    view.rerender(<Tab mode="visible" art={IMAGE} />)
    await flush()
    expect(src()).toBe(toSlzFileUrl('/data/img', 2))
  })
})
