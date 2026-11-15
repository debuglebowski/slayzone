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
import { RICH_TEXT_MAX_BYTES, type ArtifactTextRead } from '../shared/text-read'

// Stable clients, like the real providers' (the editor's callbacks depend on them).
vi.mock('./trpc', () => {
  const trpc = {
    artifacts: {
      onContentChanged: { subscriptionOptions: (_input: unknown, opts: unknown) => opts }
    }
  }
  const trpcClient = {
    artifacts: { getMtime: { query: async ({ id }: { id: string }) => disk.mtime[id] ?? null } },
    app: { shell: { openExternal: { mutate: vi.fn() } } }
  }
  return { useTRPC: () => trpc, useTRPCClient: () => trpcClient }
})
/** The file watcher's `content-changed` handler the mounted editor subscribed. */
let contentChanged: ((id: string) => void) | undefined
vi.mock('@slayzone/transport/client', () => ({
  useSubscription: (opts: { onData?: (id: string) => void }) => {
    contentChanged = opts?.onData
  },
  // No hub scope: previews are plain local `slz-file://` paths (`toArtifactFileUrl`).
  useHubId: () => null
}))
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
  useTheme: () => theme,
  // The 1s mtime poll is its own path (external writes); not under test here.
  useVisibleInterval: () => undefined
}))
vi.mock('@slayzone/editor', () => ({
  RichTextEditor: () => <div data-testid="rich" />,
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

const disk: {
  content: Record<string, string>
  mtime: Record<string, number>
  /** Not text on disk: what readText reports instead of content. */
  notText: Record<string, Exclude<ArtifactTextRead, { kind: 'text' }>>
} = {
  content: {},
  mtime: {},
  notText: {}
}
const textRead = (id: string): ArtifactTextRead | null =>
  disk.notText[id] ??
  (disk.content[id] == null
    ? null
    : {
        kind: 'text',
        content: disk.content[id],
        size: new TextEncoder().encode(disk.content[id]).length
      })
const readText = vi.fn(async (id: string): Promise<ArtifactTextRead | null> => textRead(id))
const saveContent = vi.fn(async (id: string, content: string) => {
  disk.content[id] = content
  disk.mtime[id] = (disk.mtime[id] ?? 0) + 1
})
const getFilePath = vi.fn(async (id: string) => `/data/${id}`)

const artifact = (id: string, title: string): TaskArtifact =>
  ({ id, task_id: 't1', title, folder_id: null, render_mode: null }) as unknown as TaskArtifact
const NOTES = artifact('a1', 'notes.md')
const IMAGE = artifact('img', 'pic.png')
const VIDEO = artifact('vid', 'clip.mp4')

function Tab({
  mode,
  art = NOTES,
  viewMode = 'raw'
}: {
  mode: 'visible' | 'hidden'
  art?: TaskArtifact
  viewMode?: 'preview' | 'split' | 'raw'
}) {
  const props: React.ComponentProps<typeof ArtifactContentEditor> = {
    artifact: art,
    viewMode,
    readText,
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
  disk.notText = {}
  readText.mockClear()
  readText.mockImplementation(async (id: string) => textRead(id))
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
    expect(readText).toHaveBeenCalledTimes(1)

    view.rerender(<Tab mode="hidden" />)
    disk.content.a1 = 'changed on disk'
    view.rerender(<Tab mode="visible" />)
    await flush()
    expect(readText).toHaveBeenCalledTimes(2)
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

  it('showing keeps the same editor mounted (caret, scroll and undo survive)', async () => {
    const view = render(<Tab mode="visible" />)
    await flush()
    const before = code()
    expect(before?.value).toBe('v1')

    view.rerender(<Tab mode="hidden" />)
    view.rerender(<Tab mode="visible" />)
    expect(screen.queryByText('Loading...')).toBeNull()
    await flush()
    expect(code()).toBe(before)
  })
})

describe('ArtifactContentEditor video', () => {
  const video = () => screen.getByTestId('artifact-video') as HTMLVideoElement

  it('plays the file in a native player and never reads it as text', async () => {
    render(<Tab mode="visible" art={VIDEO} />)
    await flush()
    expect(video().getAttribute('src')).toBe(toSlzFileUrl('/data/vid', 1))
    expect(video().controls).toBe(true)
    expect(readText).not.toHaveBeenCalled()
  })

  it('hiding the tab pauses playback, so a hidden tab never keeps playing sound', async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const view = render(<Tab mode="visible" art={VIDEO} />)
    await flush()
    pause.mockClear()
    view.rerender(<Tab mode="hidden" art={VIDEO} />)
    expect(pause).toHaveBeenCalled()
    pause.mockRestore()
  })

  it('a file the player cannot decode says so instead of a blank frame', async () => {
    render(<Tab mode="visible" art={VIDEO} />)
    await flush()
    fireEvent.error(video())
    expect(screen.getByTestId('artifact-video-error').textContent).toMatch(/can't be played/i)
  })
})

describe('ArtifactContentEditor switching artifacts', () => {
  const OTHER = artifact('a2', 'other.md')

  it('shows Loading, then the new artifact in a fresh editor', async () => {
    disk.content.a2 = 'second'
    const view = render(<Tab mode="visible" />)
    await flush()
    const first = code()
    view.rerender(<Tab mode="visible" art={OTHER} />)
    expect(screen.getByText('Loading...')).toBeTruthy()
    await flush()
    expect(code()?.value).toBe('second')
    expect(code()).not.toBe(first)
  })

  it("a read that finishes after the switch never shows the old artifact's text", async () => {
    disk.content.a2 = 'second'
    const pending: Record<string, () => void> = {}
    readText.mockImplementation(
      (id: string) =>
        new Promise<ArtifactTextRead | null>((resolve) => {
          pending[id] = () => resolve(textRead(id))
        })
    )
    const view = render(<Tab mode="visible" />)
    await flush()
    view.rerender(<Tab mode="visible" art={OTHER} />)
    await flush()

    await act(async () => pending.a2())
    expect(code()?.value).toBe('second')
    await act(async () => pending.a1())
    expect(code()?.value).toBe('second')
  })
})

describe('ArtifactContentEditor and its own autosave', () => {
  // The file watcher reports EVERY write, the editor's own autosave included (100 ms
  // debounce). The editor treated that echo as an outside change: arriving while the
  // save was still reading back its mtime it raised a false conflict banner, and the
  // save marked the draft clean even when keys were typed during it — so the echo
  // then reloaded the file over them (lost text, caret reset; e2e 93 under load).
  /** saveContent that writes only when released. */
  function heldSave(): { release: () => Promise<void> } {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    saveContent.mockImplementationOnce(async (id: string, content: string) => {
      await gate
      disk.content[id] = content
      disk.mtime[id] = (disk.mtime[id] ?? 0) + 1
    })
    return {
      release: async () => {
        release()
        await flush()
      }
    }
  }
  const banner = () => screen.queryByTestId('artifact-conflict-banner')

  it("its own save's change event is no change: no conflict, no reload", async () => {
    render(<Tab mode="visible" />)
    await flush()
    const save = heldSave()
    fireEvent.change(code()!, { target: { value: 'abc' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    const reads = readText.mock.calls.length
    act(() => contentChanged?.('a1'))
    await save.release()
    act(() => contentChanged?.('a1'))
    await flush()
    expect(banner()).toBeNull()
    expect(readText.mock.calls.length).toBe(reads)
    expect(code()?.value).toBe('abc')
  })

  it('keys typed during a save stay, and are saved next', async () => {
    render(<Tab mode="visible" />)
    await flush()
    const save = heldSave()
    fireEvent.change(code()!, { target: { value: 'abc' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    fireEvent.change(code()!, { target: { value: 'abcdef' } })
    await save.release()
    act(() => contentChanged?.('a1'))
    await flush()
    expect(code()?.value).toBe('abcdef')
    expect(banner()).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(saveContent.mock.calls.at(-1)).toEqual(['a1', 'abcdef'])
    expect(disk.content.a1).toBe('abcdef')
  })

  it('a write from outside during the save still shows', async () => {
    render(<Tab mode="visible" />)
    await flush()
    const save = heldSave()
    fireEvent.change(code()!, { target: { value: 'abc' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    await save.release()
    // Someone else writes right after the save.
    disk.content.a1 = 'from outside'
    disk.mtime.a1 = (disk.mtime.a1 ?? 0) + 1
    act(() => contentChanged?.('a1'))
    await flush()
    expect(code()?.value).toBe('from outside')
  })
})

describe('ArtifactContentEditor: files not shown as text', () => {
  // An unknown extension falls back to markdown, so a binary file reached the
  // rich-text editor as decoded UTF-8: a multi-second freeze, and one keystroke
  // autosaved the decoded text over the original bytes.
  const BLOB = artifact('bin', 'blob.bin')
  const noPreview = () => screen.queryByTestId('artifact-no-preview')

  it('a binary file shows No preview, never an editor, and is never written', async () => {
    disk.notText.bin = { kind: 'binary', size: 4_194_304 }
    disk.mtime.bin = 1
    const onDownload = vi.fn()
    render(
      <Activity mode="visible">
        <ArtifactContentEditor
          {...({
            artifact: BLOB,
            viewMode: 'preview',
            readText,
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
            onSearchMatchCountChange: () => undefined,
            onDownload
          } satisfies React.ComponentProps<typeof ArtifactContentEditor>)}
        />
      </Activity>
    )
    await flush()
    expect(noPreview()?.getAttribute('data-reason')).toBe('binary')
    expect(noPreview()?.textContent).toContain('4.0 MB')
    expect(code()).toBeNull()
    expect(screen.queryByTestId('rich')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /download/i }))
    expect(onDownload).toHaveBeenCalledTimes(1)

    // A watcher event re-reads, still binary: still no editor, nothing saved.
    disk.mtime.bin = 2
    act(() => contentChanged?.('bin'))
    await flush()
    expect(noPreview()).not.toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(saveContent).not.toHaveBeenCalled()
  })

  it('a file over the size cap is not opened', async () => {
    disk.notText.bin = { kind: 'too-large', size: 70 * 1024 * 1024 }
    render(<Tab mode="visible" art={BLOB} />)
    await flush()
    expect(noPreview()?.getAttribute('data-reason')).toBe('too-large')
    expect(noPreview()?.textContent).toContain('70.0 MB')
    expect(code()).toBeNull()
  })

  it('a text file rewritten as binary from outside switches to No preview', async () => {
    render(<Tab mode="visible" />)
    await flush()
    expect(code()?.value).toBe('v1')
    disk.notText.a1 = { kind: 'binary', size: 10 }
    disk.mtime.a1 = 2
    act(() => contentChanged?.('a1'))
    await flush()
    expect(code()).toBeNull()
    expect(noPreview()?.getAttribute('data-reason')).toBe('binary')
  })

  it('a failed first read shows an error with Retry, not an empty editor', async () => {
    readText.mockImplementationOnce(async () => {
      throw new Error('computer offline')
    })
    render(<Tab mode="visible" />)
    await flush()
    expect(code()).toBeNull()
    expect(noPreview()?.getAttribute('data-reason')).toBe('error')
    expect(noPreview()?.textContent).toContain('computer offline')
    expect(saveContent).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await flush()
    expect(noPreview()).toBeNull()
    expect(code()?.value).toBe('v1')
  })
})

describe('ArtifactContentEditor: large markdown', () => {
  const big = '# Big\n\n' + 'x'.repeat(RICH_TEXT_MAX_BYTES)
  const notice = () => screen.queryByTestId('artifact-large-doc-notice')

  it('opens as source with a notice, and as rich text on request', async () => {
    disk.content.a1 = big
    render(<Tab mode="visible" viewMode="preview" />)
    await flush()
    expect(screen.queryByTestId('rich')).toBeNull()
    expect(code()?.value).toBe(big)
    expect(notice()).not.toBeNull()

    fireEvent.click(screen.getByTestId('artifact-large-doc-open-rich'))
    expect(screen.queryByTestId('rich')).not.toBeNull()
    expect(notice()).toBeNull()
  })

  it('the split view also opens as source', async () => {
    disk.content.a1 = big
    render(<Tab mode="visible" viewMode="split" />)
    await flush()
    expect(screen.getAllByTestId('code')).toHaveLength(1)
    expect(notice()).not.toBeNull()
  })

  it('raw view needs no notice', async () => {
    disk.content.a1 = big
    render(<Tab mode="visible" viewMode="raw" />)
    await flush()
    expect(code()?.value).toBe(big)
    expect(notice()).toBeNull()
  })

  it('markdown at the limit opens as rich text', async () => {
    disk.content.a1 = 'x'.repeat(RICH_TEXT_MAX_BYTES)
    render(<Tab mode="visible" viewMode="preview" />)
    await flush()
    expect(screen.queryByTestId('rich')).not.toBeNull()
    expect(notice()).toBeNull()
  })

  it('typing past the limit does not swap the rich editor out', async () => {
    // The choice follows the size read from disk, not the draft.
    disk.content.a1 = 'small'
    render(<Tab mode="visible" viewMode="raw" />)
    await flush()
    fireEvent.change(code()!, { target: { value: big } })
    expect(code()?.value).toBe(big)
    expect(notice()).toBeNull()
  })
})
