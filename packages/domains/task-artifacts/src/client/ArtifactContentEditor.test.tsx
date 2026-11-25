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
import { webcrypto } from 'node:crypto'
import { toSlzFileUrl } from '@slayzone/platform/slz-file-url'
import {
  deviceViewport,
  PREVIEW_DEVICES,
  rotateDeviceViewport,
  type DeviceViewport
} from '@slayzone/platform/preview-devices'
import { deviceChassisLayout, type ArtifactDeviceFrame } from './ArtifactDeviceFrame'
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
    artifacts: {
      getMtime: { query: async ({ id }: { id: string }) => disk.mtime[id] ?? null },
      listArchive: { query: (input: { id: string }) => hub.listArchive(input) },
      readBase64: { query: (input: { id: string }) => hub.readBase64(input) }
    },
    app: { shell: { openExternal: { mutate: vi.fn() } } }
  }
  return { useTRPC: () => trpc, useTRPCClient: () => trpcClient }
})
/** The file watcher's `content-changed` handler the mounted editor subscribed. */
let contentChanged: ((id: string) => void) | undefined
let hubId: string | null = null
vi.mock('@slayzone/transport/client', () => ({
  useSubscription: (opts: { onData?: (id: string) => void }) => {
    contentChanged = opts?.onData
  },
  // No hub scope: previews are plain local `slz-file://` paths (`toArtifactFileUrl`).
  useHubId: () => hubId,
  electronBootstrap: { artifactDevicePreview: () => null }
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
vi.mock('@slayzone/diff-view', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@slayzone/diff-view')>()),
  DiffView: ({ diff }: { diff: { path: string } }) => <div data-testid="diff-file">{diff.path}</div>
}))
/** The hub queries the binary viewers make (stubbed per test). */
const hub = {
  listArchive: vi.fn(async (_: { id: string }): Promise<unknown> => null),
  readBase64: vi.fn(async (_: { id: string }): Promise<string | null> => null)
}

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
  viewMode = 'raw',
  siblings = [],
  deviceViewport,
  deviceFrame,
  devicePreviews
}: {
  mode: 'visible' | 'hidden'
  art?: TaskArtifact
  viewMode?: 'preview' | 'split' | 'raw'
  siblings?: TaskArtifact[]
  deviceViewport?: DeviceViewport
  deviceFrame?: ArtifactDeviceFrame
  devicePreviews?: React.ComponentProps<typeof ArtifactContentEditor>['devicePreviews']
}) {
  const props: React.ComponentProps<typeof ArtifactContentEditor> = {
    artifact: art,
    siblingArtifacts: [art, ...siblings],
    viewMode,
    readText,
    saveContent,
    getFilePath,
    effectiveReadability: 'normal',
    effectiveWidth: 'wide',
    zoomPct: 100,
    htmlTheme: 'system',
    devicePreviews:
      devicePreviews ??
      (deviceViewport
        ? [{ slot: 'primary', viewport: deviceViewport, frame: deviceFrame }]
        : undefined),
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
  hubId = null
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
  vi.unstubAllGlobals()
})

it('gives a hub HTML preview a storage origin with the other sandbox flags intact', async () => {
  vi.useRealTimers()
  vi.stubGlobal('crypto', webcrypto)
  hubId = 'hub'
  const html = artifact('page', 'page.html')
  disk.content.page = '<p>Hello</p>'
  getFilePath.mockResolvedValueOnce('/data/page.html')
  render(<Tab mode="visible" art={html} viewMode="preview" />)

  const frame = await screen.findByTitle('HTML preview')
  expect(new URL((frame as HTMLIFrameElement).src).protocol).toBe('slz-artifact:')
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin')
})

it.each(['preview', 'split'] as const)(
  'sizes the sandboxed HTML viewport in %s',
  async (viewMode) => {
    vi.useRealTimers()
    vi.stubGlobal('crypto', webcrypto)
    hubId = 'hub'
    const html = artifact('page', 'page.html')
    disk.content.page = '<p>Hello</p>'
    const viewport = {
      width: 466,
      height: 678,
      deviceScaleFactor: 3,
      mobile: true,
      angle: 0 as const
    }
    const view = render(
      <Tab mode="visible" art={html} viewMode={viewMode} deviceViewport={viewport} />
    )

    const frame = (await screen.findByTitle('HTML preview')) as HTMLIFrameElement
    expect(frame.style.width).toBe('466px')
    expect(frame.style.height).toBe('678px')
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin')

    view.rerender(
      <Tab
        mode="visible"
        art={html}
        viewMode={viewMode}
        deviceViewport={{ ...viewport, width: 890, height: 626 }}
      />
    )
    expect(screen.getByTitle('HTML preview')).toBe(frame)
    expect(frame.style.width).toBe('890px')
    expect(frame.style.height).toBe('626px')

    view.rerender(<Tab mode="visible" art={html} viewMode={viewMode} />)
    expect(await screen.findByTitle('HTML preview')).toHaveProperty('style.width', '100%')
  }
)

it.each(['desktop-1080p', 'compact-laptop'])('fits a thin bezel around the %s screen', (id) => {
  const device = PREVIEW_DEVICES.find((preset) => preset.id === id)!
  const viewport = deviceViewport(device, 0)
  const { layerStyle } = deviceChassisLayout({ device, screen: 0 }, viewport)
  expect(layerStyle.width - viewport.width).toBeLessThan(40)
  expect(layerStyle.height - viewport.height).toBeLessThan(40)
})

it('puts the iPhone Duo camera cutout in the cover corner only', () => {
  const device = PREVIEW_DEVICES.find(({ id }) => id === 'iphone-duo')!
  const cover = deviceChassisLayout({ device, screen: 0 }, deviceViewport(device, 0))
  const inner = deviceChassisLayout({ device, screen: 1 }, deviceViewport(device, 1))
  expect(cover.chassis.cutout?.position).toBeGreaterThan(0.9)
  expect(cover.chassis.cutout?.width).toBe(cover.chassis.cutout?.height)
  expect(inner.chassis.cutout).toBeUndefined()
  expect(Math.abs(cover.height - inner.height)).toBeLessThan(3)
})

it('keeps the Duo cover flatter on the hinge edge when the device rotates', () => {
  const device = PREVIEW_DEVICES.find(({ id }) => id === 'iphone-duo')!
  const frame = { device, screen: 0 }
  const viewport = deviceViewport(device, 0)
  const portrait = deviceChassisLayout(frame, viewport)
  const landscape = deviceChassisLayout(frame, rotateDeviceViewport(viewport))
  expect(portrait.screenRadius).toBe('6px 44px 44px 6px')
  expect(landscape.screenRadius).toBe('6px 6px 44px 44px')
  expect(portrait.width).toBe(landscape.height)
  expect(portrait.height).toBe(landscape.width)
  expect(portrait.layerStyle.width - viewport.width).toBeLessThan(30)
})

it('toggles a device frame around the same live HTML viewport', async () => {
  vi.useRealTimers()
  const html = artifact('page', 'page.html')
  disk.content.page = '<p>Hello</p>'
  const device = PREVIEW_DEVICES.find(({ id }) => id === 'iphone-duo')!
  const viewport = deviceViewport(device, 1)
  const view = render(
    <Tab
      mode="visible"
      art={html}
      viewMode="preview"
      deviceViewport={viewport}
      deviceFrame={{ device, screen: 1 }}
    />
  )
  const frame = (await screen.findByTitle('HTML preview')) as HTMLIFrameElement
  expect(screen.getByTestId('artifact-device-frame').getAttribute('data-device')).toBe('iphone-duo')
  expect(frame.style.width).toBe('951px')
  expect(frame.style.height).toBe('669px')

  view.rerender(<Tab mode="visible" art={html} viewMode="preview" deviceViewport={viewport} />)
  expect(screen.queryByTestId('artifact-device-frame')).toBeNull()
  expect(screen.getByTitle('HTML preview')).toBe(frame)
  expect(frame.style.width).toBe('951px')
  expect(frame.style.height).toBe('669px')
})

it('shows both Duo displays and keeps the original preview mounted', async () => {
  vi.useRealTimers()
  disk.content.page = '<p>Hello</p>'
  const html = artifact('page', 'page.html')
  const device = PREVIEW_DEVICES.find(({ id }) => id === 'iphone-duo')!
  const cover = { slot: 'primary' as const, viewport: deviceViewport(device, 0) }
  const inner = {
    slot: 'secondary' as const,
    viewport: deviceViewport(device, 1),
    label: 'Unfolded'
  }
  const view = render(<Tab mode="visible" art={html} viewMode="preview" devicePreviews={[cover]} />)
  const original = await screen.findByTitle('HTML preview')

  view.rerender(
    <Tab
      mode="visible"
      art={html}
      viewMode="preview"
      devicePreviews={[{ ...cover, label: 'Cover' }, inner]}
    />
  )
  expect(screen.getByTitle('HTML preview — Cover')).toBe(original)
  expect(original).toHaveProperty('style.width', '466px')
  expect(screen.getByTitle('HTML preview — Unfolded')).toHaveProperty('style.width', '951px')
  expect(screen.getByTitle('HTML preview — Unfolded')).toHaveProperty('style.height', '669px')
  expect(getFilePath).toHaveBeenCalledTimes(1)
})

const CONTROLS_HTML = `<!doctype html>
<html><head></head><body><p>Prototype</p>
<slay-artifact-controls><button data-action="show-error">Show error</button></slay-artifact-controls>
</body></html>`
const SHOW_ERROR = { type: 'slayzone:prototype-action', action: 'show-error' }
const dock = (position: string) => screen.queryByTitle(`Artifact controls — ${position}`)
/** A message from a frame, as the window sees it. */
const fromFrame = (frame: HTMLIFrameElement, data: unknown) =>
  fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, data }))

it.each(['preview', 'split'] as const)(
  'relays actions from the controls dock to the screen in %s mode',
  async (viewMode) => {
    vi.useRealTimers()
    disk.content.page = CONTROLS_HTML
    render(<Tab mode="visible" art={artifact('page', 'page.html')} viewMode={viewMode} />)

    const preview = (await screen.findByTitle('HTML preview')) as HTMLIFrameElement
    const controls = (await screen.findByTitle('Artifact controls — bottom')) as HTMLIFrameElement
    expect(controls.getAttribute('sandbox')).toBe('allow-scripts')
    expect(new URL(preview.src).searchParams.get('slayzone-preview')).toBe('screen')
    expect(new URL(controls.src).searchParams.get('slayzone-preview')).toBe('controls')
    expect(new URL(controls.src).searchParams.get('slayzone-controls')).toBe('bottom')
    const toScreen = vi.spyOn(preview.contentWindow!, 'postMessage')
    const toControls = vi.spyOn(controls.contentWindow!, 'postMessage')

    // Dropped until the screen has loaded.
    fromFrame(controls, SHOW_ERROR)
    expect(toScreen).not.toHaveBeenCalled()
    fireEvent.load(preview)
    expect(toControls).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'slayzone:prototype-ready', ready: true }),
      '*'
    )
    fromFrame(preview, SHOW_ERROR)
    fromFrame(controls, { ...SHOW_ERROR, value: {} })
    expect(toScreen).not.toHaveBeenCalled()
    fromFrame(controls, SHOW_ERROR)
    fromFrame(controls, SHOW_ERROR)
    expect(toScreen.mock.calls).toEqual([
      [SHOW_ERROR, '*'],
      [SHOW_ERROR, '*']
    ])
  }
)

it('sends one action to both device previews once both are loaded', async () => {
  vi.useRealTimers()
  disk.content.page = CONTROLS_HTML
  const device = PREVIEW_DEVICES.find(({ id }) => id === 'iphone-duo')!
  render(
    <Tab
      mode="visible"
      art={artifact('page', 'page.html')}
      viewMode="preview"
      devicePreviews={[
        { slot: 'primary', viewport: deviceViewport(device, 0), label: 'Cover' },
        { slot: 'secondary', viewport: deviceViewport(device, 1), label: 'Unfolded' }
      ]}
    />
  )
  const cover = (await screen.findByTitle('HTML preview — Cover')) as HTMLIFrameElement
  const unfolded = screen.getByTitle('HTML preview — Unfolded') as HTMLIFrameElement
  const controls = (await screen.findByTitle('Artifact controls — bottom')) as HTMLIFrameElement
  const sends = [cover, unfolded].map((frame) => vi.spyOn(frame.contentWindow!, 'postMessage'))
  const canvas = screen.getByTestId('artifact-device-canvas')
  expect(canvas.contains(controls)).toBe(true)
  expect(cover.compareDocumentPosition(controls)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  fireEvent.load(cover)
  fromFrame(controls, SHOW_ERROR)
  for (const send of sends) expect(send).not.toHaveBeenCalled()
  fireEvent.load(unfolded)
  fromFrame(controls, SHOW_ERROR)
  for (const send of sends) expect(send).toHaveBeenCalledExactlyOnceWith(SHOW_ERROR, '*')
})

it('opens one dock per position used, sized by what each dock reports', async () => {
  vi.useRealTimers()
  disk.content.page = CONTROLS_HTML.replace(
    '<p>Prototype</p>',
    '<main><slay-artifact-controls position="top">a</slay-artifact-controls></main>' +
      '<slay-artifact-controls position="RIGHT">b</slay-artifact-controls>' +
      '<slay-artifact-controls position="top">c</slay-artifact-controls>'
  )
  render(<Tab mode="visible" art={artifact('page', 'page.html')} viewMode="preview" />)
  const top = (await screen.findByTitle('Artifact controls — top')) as HTMLIFrameElement
  const right = dock('right') as HTMLIFrameElement
  expect(dock('bottom')).not.toBeNull()
  expect(dock('left')).toBeNull()
  const preview = screen.getByTitle('HTML preview')
  expect(top.compareDocumentPosition(preview)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  expect(preview.compareDocumentPosition(right)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)

  const size = { type: 'slayzone:artifact-controls-size' }
  fromFrame(top, { ...size, width: 500, height: 80 })
  fromFrame(right, { ...size, width: 140, height: 900 })
  // A dock only listens to its own frame.
  fromFrame(preview as HTMLIFrameElement, { ...size, width: 1, height: 1 })
  expect(top.parentElement!.style.height).toBe('80px')
  expect(right.parentElement!.style.width).toBe('140px')
})

it('keeps the docks aligned with the saved HTML in Split mode', async () => {
  vi.useRealTimers()
  disk.content.page = CONTROLS_HTML
  render(<Tab mode="visible" art={artifact('page', 'page.html')} viewMode="split" />)

  await screen.findByTitle('Artifact controls — bottom')
  vi.useFakeTimers()
  fireEvent.change(code()!, {
    target: {
      value: CONTROLS_HTML.replace(
        '<slay-artifact-controls>',
        '<slay-artifact-controls position="top">'
      )
    }
  })
  expect(dock('top')).toBeNull()
  expect(dock('bottom')).not.toBeNull()
  await act(() => vi.advanceTimersByTimeAsync(500))
  expect(dock('top')).not.toBeNull()
  expect(dock('bottom')).toBeNull()
})

it('shows no dock in raw mode, without controls, or for the retired JSON manifest', async () => {
  vi.useRealTimers()
  const html = artifact('page', 'page.html')
  disk.content.page = CONTROLS_HTML
  const view = render(<Tab mode="visible" art={html} viewMode="raw" />)
  await screen.findByTestId('code')
  expect(dock('bottom')).toBeNull()

  const manifest = artifact('manifest', 'manifest.html')
  disk.content.manifest = `<html><head><script type="application/json" id="slayzone-prototype">
    {"actions":[{"id":"show-error","label":"Show error"}]}
  </script></head><body><p>Old</p></body></html>`
  view.rerender(<Tab mode="visible" art={manifest} viewMode="preview" />)
  await screen.findByTitle('HTML preview')
  expect(dock('bottom')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Show error' })).toBeNull()
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

  it('shows preview status during path lookup and reports a failed lookup', async () => {
    const path = Promise.withResolvers<string>()
    getFilePath.mockReturnValueOnce(path.promise)
    render(<Tab mode="visible" art={IMAGE} />)
    await flush()
    expect(screen.getByRole('status').textContent).toBe('Loading preview…')

    await act(async () => path.reject(new Error('Hub disconnected')))
    expect(screen.getByRole('status').textContent).toBe('Could not load image preview')
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

describe('ArtifactContentEditor audio', () => {
  it('plays the file in a native audio player and never reads it as text', async () => {
    render(<Tab mode="visible" art={artifact('aud', 'voice.mp3')} />)
    await flush()
    const audio = screen.getByTestId('artifact-audio') as HTMLAudioElement
    expect(audio.tagName).toBe('AUDIO')
    expect(audio.getAttribute('src')).toBe(toSlzFileUrl('/data/aud', 1))
    expect(audio.controls).toBe(true)
    expect(readText).not.toHaveBeenCalled()
  })
})

describe('ArtifactContentEditor video subtitles', () => {
  const addCue = vi.fn()
  const tracks: { kind: string; label: string; language: string; mode: string }[] = []
  beforeEach(() => {
    addCue.mockClear()
    tracks.length = 0
    // jsdom has no TextTrack API.
    HTMLMediaElement.prototype.addTextTrack = function (kind, label = '', language = '') {
      const track = { kind, label, language, mode: 'disabled', addCue }
      tracks.push(track)
      return track as unknown as TextTrack
    }
    ;(globalThis as { VTTCue?: unknown }).VTTCue = class {
      constructor(
        public startTime: number,
        public endTime: number,
        public text: string
      ) {}
    }
  })
  afterEach(() => {
    delete (HTMLMediaElement.prototype as { addTextTrack?: unknown }).addTextTrack
    delete (globalThis as { VTTCue?: unknown }).VTTCue
  })

  it('a same-named .vtt/.srt beside the video becomes its text tracks, the first one shown', async () => {
    disk.content.sub = 'WEBVTT\n\n00:00.500 --> 00:01.500\nHello'
    disk.content.subsv = '1\n00:00:01,000 --> 00:00:02,000\nHej'
    render(
      <Tab
        mode="visible"
        art={VIDEO}
        siblings={[artifact('sub', 'clip.vtt'), artifact('subsv', 'clip.sv.srt')]}
      />
    )
    await flush()
    await flush()
    expect(tracks.map((t) => [t.kind, t.label, t.language, t.mode])).toEqual([
      ['subtitles', 'Subtitles', '', 'showing'],
      ['subtitles', 'sv', 'sv', 'hidden']
    ])
    expect(addCue.mock.calls.map(([c]) => [c.startTime, c.endTime, c.text])).toEqual([
      [0.5, 1.5, 'Hello'],
      [1, 2, 'Hej']
    ])
  })
})

describe('ArtifactContentEditor diff', () => {
  const PATCH = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/b.md b/b.md',
    '--- a/b.md',
    '+++ b/b.md',
    '@@ -1 +1 @@',
    '-x',
    '+y'
  ].join('\n')

  it('previews a patch as one diff per file, under its path', async () => {
    disk.content.d1 = PATCH
    render(<Tab mode="visible" art={artifact('d1', 'fix.diff')} viewMode="preview" />)
    await flush()
    expect(screen.getAllByTestId('diff-file').map((e) => e.textContent)).toEqual([
      'src/a.ts',
      'b.md'
    ])
  })

  it('text with no diff in it says so', async () => {
    disk.content.d2 = 'just notes'
    render(<Tab mode="visible" art={artifact('d2', 'fix.patch')} viewMode="preview" />)
    await flush()
    expect(screen.getByTestId('artifact-diff-empty')).toBeTruthy()
  })

  it('split view keeps the editable source beside the diff', async () => {
    disk.content.d1 = PATCH
    render(<Tab mode="visible" art={artifact('d1', 'fix.diff')} viewMode="split" />)
    await flush()
    expect(code()?.value).toBe(PATCH)
    expect(screen.getAllByTestId('diff-file')).toHaveLength(2)
  })
})

describe('ArtifactContentEditor archive', () => {
  it("lists a zip's entries with their sizes, and the totals", async () => {
    hub.listArchive.mockResolvedValueOnce({
      entries: [
        {
          path: 'docs/',
          isDirectory: true,
          size: 0,
          compressedSize: 0,
          modified: '2026-11-15T09:30:00',
          encrypted: false
        },
        {
          path: 'docs/readme.md',
          isDirectory: false,
          size: 2048,
          compressedSize: 512,
          modified: '2026-11-15T09:30:10',
          encrypted: false
        }
      ],
      totalEntries: 2,
      totalSize: 2048
    })
    render(<Tab mode="visible" art={artifact('z1', 'bundle.zip')} />)
    await flush()
    expect(hub.listArchive).toHaveBeenCalledWith({ id: 'z1' })
    const rows = screen.getAllByTestId('archive-entry').map((r) => r.textContent)
    expect(rows[0]).toContain('docs/')
    expect(rows[1]).toContain('docs/readme.md')
    expect(rows[1]).toContain('2 KB')
    expect(screen.getByTestId('archive-summary').textContent).toMatch(/2 entries.*2 KB/)
    expect(readText).not.toHaveBeenCalled()
  })

  it('a listing that fails shows why, with a retry', async () => {
    hub.listArchive.mockRejectedValueOnce(
      new Error('Not a zip archive: no end-of-central-directory record')
    )
    render(<Tab mode="visible" art={artifact('z2', 'bad.zip')} />)
    await flush()
    expect(screen.getByTestId('archive-error').textContent).toMatch(/not a zip archive/i)
    hub.listArchive.mockResolvedValueOnce({ entries: [], totalEntries: 0, totalSize: 0 })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await flush()
    expect(screen.getByTestId('archive-summary').textContent).toMatch(/0 entries/)
  })
})

describe('ArtifactContentEditor font', () => {
  const added: unknown[] = []
  const deleted: unknown[] = []
  let loads: 'ok' | 'fail' = 'ok'
  beforeEach(() => {
    added.length = 0
    deleted.length = 0
    loads = 'ok'
    ;(globalThis as { FontFace?: unknown }).FontFace = class {
      constructor(
        public family: string,
        public source: ArrayBuffer
      ) {}
      load() {
        return loads === 'ok' ? Promise.resolve(this) : Promise.reject(new Error('bad font'))
      }
    }
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { add: (f: unknown) => added.push(f), delete: (f: unknown) => deleted.push(f) }
    })
  })
  afterEach(() => {
    delete (globalThis as { FontFace?: unknown }).FontFace
    delete (document as { fonts?: unknown }).fonts
  })

  it('loads the font from its bytes and sets a specimen in it; unmounting removes it', async () => {
    hub.readBase64.mockResolvedValueOnce(btoa('\u0000\u0001\u0000\u0000'))
    const view = render(<Tab mode="visible" art={artifact('f1', 'face.woff2')} />)
    await flush()
    expect(hub.readBase64).toHaveBeenCalledWith({ id: 'f1' })
    const face = added[0] as { family: string; source: ArrayBuffer }
    expect(new Uint8Array(face.source)).toEqual(new Uint8Array([0, 1, 0, 0]))
    const specimen = screen.getByTestId('artifact-font')
    expect(specimen.style.fontFamily).toContain(face.family)
    view.unmount()
    expect(deleted).toEqual([face])
  })

  it("a file the browser can't load as a font says so", async () => {
    loads = 'fail'
    hub.readBase64.mockResolvedValueOnce(btoa('nope'))
    render(<Tab mode="visible" art={artifact('f2', 'broken.ttf')} />)
    await flush()
    expect(screen.getByTestId('artifact-font-error').textContent).toMatch(/can't be loaded/i)
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
