import { act, fireEvent, render, screen, userEvent, waitFor } from '@testing-library/react-native'
import { ActionSheetIOS, Image, Linking, Share } from 'react-native'
import { hubEntryOf } from '../hub-session'
import { pending, trpcTest } from '../testing'
import { ArtifactViewer, type ArtifactViewerProps } from './ArtifactViewer'
import { artifactRow, fakeArtifactsHub, versionRow } from './fake-artifacts-hub'
import { exportArtifact } from './export/export-artifact'
import { artifactFileExists, downloadArtifactFile } from './files'
import { hubTarget } from './hub-rest'
import { loadHtml2canvasScript, loadMermaidScript } from './page-assets'
import { mediaPlayer } from './media-player'

jest.mock('./files', () => ({
  ...jest.requireActual('./files'),
  downloadArtifactFile: jest.fn(),
  artifactFileExists: jest.fn()
}))
// expo-video's native half is absent in Node: a stand-in player that records its
// source, and a view that keeps its props. `mediaPlayer` is switched per test between
// that module and null (a build without the native module).
const mockPlayerStatus: Array<(e: { status: string }) => void> = []
jest.mock('expo-video', () => {
  const { View } = require('react-native')
  return {
    useVideoPlayer: (source: string) => ({
      source,
      status: 'loading',
      addListener: (_event: string, listener: (e: { status: string }) => void) => {
        mockPlayerStatus.push(listener)
        return { remove: () => undefined }
      }
    }),
    VideoView: (props: object) => <View {...props} />
  }
})
jest.mock('./media-player', () => ({ mediaPlayer: jest.fn() }))
jest.mock('./page-assets', () => ({
  MERMAID_BUNDLE_FILE: 'mermaid.min.js',
  loadMermaidScript: jest.fn(async () => 'globalThis.mermaid={}'),
  loadHtml2canvasScript: jest.fn(async () => 'window.html2canvas=function(){}')
}))

jest.mock('./export/export-artifact', () => ({ exportArtifact: jest.fn() }))

const download = jest.mocked(downloadArtifactFile)
const fileExists = jest.mocked(artifactFileExists)
const runExport = jest.mocked(exportArtifact)
const target = hubTarget({ entry: hubEntryOf('home.example'), token: 'h' })

async function view(
  hub: ReturnType<typeof fakeArtifactsHub>,
  props: Partial<ArtifactViewerProps> & { artifactId: string }
) {
  const { wrapper } = trpcTest(hub.backend)
  const onSelectVersion = jest.fn()
  const onOpenArtifact = jest.fn()
  await render(
    <ArtifactViewer
      target={target}
      taskId="t1"
      version={null}
      onSelectVersion={onSelectVersion}
      onOpenArtifact={onOpenArtifact}
      {...props}
    />,
    { wrapper }
  )
  return { onSelectVersion, onOpenArtifact }
}

const pageOf = (testID: string) =>
  screen.getByTestId(testID).props as {
    source: { html?: string; uri?: string }
    javaScriptEnabled: boolean
    onMessage?: unknown
    onShouldStartLoadWithRequest: (req: {
      url: string
      isTopFrame: boolean
      navigationType?: string
    }) => boolean
  }

beforeEach(() => {
  download.mockReset()
  fileExists.mockReset().mockReturnValue(true)
  runExport.mockReset()
  jest.mocked(mediaPlayer).mockReturnValue(jest.requireActual('./ArtifactMediaPlayer'))
  jest.mocked(loadMermaidScript).mockClear()
  // `getSize` is overloaded (promise / callbacks): the promise form, which the image uses.
  jest
    .spyOn(Image, 'getSize')
    .mockImplementation((() =>
      Promise.resolve({ width: 200, height: 100 })) as unknown as typeof Image.getSize)
})

describe('ArtifactViewer picks the renderer desktop does', () => {
  it('markdown: a rendered page, no script', async () => {
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', 'plan.md')],
      content: { a1: '# Plan\n\n- [x] done' }
    })
    await view(hub, { artifactId: 'a1' })
    await screen.findByTestId('artifact-page-markdown')
    const page = pageOf('artifact-page-markdown')
    expect(page.source.html).toContain('<h1>Plan</h1>')
    expect(page.source.html).toContain('type="checkbox"')
    expect(page.javaScriptEnabled).toBe(false)
    expect(loadMermaidScript).not.toHaveBeenCalled()
  })

  it('markdown with a ```mermaid fence: the bundled mermaid draws it', async () => {
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', 'flow.md')],
      content: { a1: '```mermaid\ngraph TD; A-->B\n```' }
    })
    await view(hub, { artifactId: 'a1' })
    await screen.findByTestId('artifact-page-markdown')
    const page = pageOf('artifact-page-markdown')
    expect(loadMermaidScript).toHaveBeenCalled()
    expect(page.javaScriptEnabled).toBe(true)
    expect(page.source.html).toContain('globalThis.mermaid={}')
    expect(page.source.html).toContain('class="mermaid-block"')
  })

  it('code: monospace lines', async () => {
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', 'main.ts')],
      content: { a1: 'const a = 1\nconst b = 2' }
    })
    await view(hub, { artifactId: 'a1' })
    await screen.findByTestId('artifact-page-code')
    expect(pageOf('artifact-page-code').source.html).toContain('<span class="l">const a = 1</span>')
  })

  it("HTML: the report in desktop's sandbox, scripts on, links bridged", async () => {
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', 'report.html')],
      content: { a1: '<h1>Report</h1>' }
    })
    await view(hub, { artifactId: 'a1' })
    await screen.findByTestId('artifact-page-html')
    const page = pageOf('artifact-page-html')
    expect(page.source.html).toContain('sandbox="allow-scripts"')
    expect(page.javaScriptEnabled).toBe(true)
    expect(page.onMessage).toEqual(expect.any(Function))
    // No scheme of its own: the app's theme variant, not the phone's.
    expect(page.source.html).toMatch(/color-scheme:(dark|light) !important/)
  })

  it('SVG: the drawing, and its source on Source', async () => {
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', 'logo.svg')],
      content: { a1: '<svg viewBox="0 0 1 1"><rect/></svg>' }
    })
    await view(hub, { artifactId: 'a1' })
    await screen.findByTestId('artifact-page-svg')
    expect(pageOf('artifact-page-svg').source.html).toContain(
      '<svg viewBox="0 0 1 1"><rect/></svg>'
    )
    await userEvent.setup().press(screen.getByRole('button', { name: 'Source' }))
    expect(pageOf('artifact-page-svg').source.html).toContain('<span class="l">&lt;svg')
  })

  it('mermaid file: the diagram, drawn by the bundled mermaid', async () => {
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', 'flow.mmd')],
      content: { a1: 'graph TD; A-->B' }
    })
    await view(hub, { artifactId: 'a1' })
    await screen.findByTestId('artifact-page-mermaid')
    const page = pageOf('artifact-page-mermaid')
    expect(page.source.html).toContain('mermaid-fill')
    expect(page.javaScriptEnabled).toBe(true)
  })

  it('image: the downloaded file, zoomable', async () => {
    download.mockResolvedValue('file:///cache/a1/shot.png')
    const hub = fakeArtifactsHub({ artifacts: [artifactRow('a1', 'shot.png')] })
    await view(hub, { artifactId: 'a1' })
    await screen.findByTestId('artifact-image')
    expect(download).toHaveBeenCalledWith(
      target,
      expect.objectContaining({ artifact: expect.objectContaining({ id: 'a1' }), version: null })
    )
    expect(hub.callsTo('artifacts.readText')).toHaveLength(0)
    // Node lays nothing out: report the screen's size as iOS would.
    await act(async () =>
      fireEvent(screen.getByTestId('artifact-image'), 'layout', {
        nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 600 } }
      })
    )
    await waitFor(() => expect(screen.getByRole('button', { name: '1:1' })).toBeEnabled())
  })

  it('a downloaded file that is gone by the time it is shown again is downloaded again', async () => {
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', 'shot.png')],
      versions: { a1: [versionRow('a1', 2), versionRow('a1', 1)] }
    })
    const onDisk = new Set<string>()
    download.mockImplementation(async (_t, source) => {
      const uri = source.version
        ? 'file:///cache/a1/v-hash1/shot.png'
        : 'file:///cache/a1/w/shot.png'
      onDisk.add(uri)
      return uri
    })
    fileExists.mockImplementation((uri) => onDisk.has(uri))
    const { wrapper } = trpcTest(hub.backend)
    const props: ArtifactViewerProps = {
      target,
      taskId: 't1',
      artifactId: 'a1',
      version: null,
      onSelectVersion: jest.fn(),
      onOpenArtifact: jest.fn()
    }
    const { rerender } = await render(<ArtifactViewer {...props} />, { wrapper })
    await screen.findByTestId('artifact-image')
    await rerender(<ArtifactViewer {...props} version={1} />)
    await waitFor(() => expect(download).toHaveBeenCalledTimes(2))
    // The working copy's file went (replaced, or purged by the OS) while the version showed.
    onDisk.delete('file:///cache/a1/w/shot.png')
    await rerender(<ArtifactViewer {...props} version={null} />)
    await waitFor(() => expect(download).toHaveBeenCalledTimes(3))
    await screen.findByTestId('artifact-image')
    expect(download.mock.calls[2][1].version).toBeNull()
  })

  it('PDF: the downloaded file in the web view', async () => {
    download.mockResolvedValue('file:///cache/a1/spec.pdf')
    const hub = fakeArtifactsHub({ artifacts: [artifactRow('a1', 'spec.pdf')] })
    await view(hub, { artifactId: 'a1' })
    await screen.findByTestId('artifact-page-pdf')
    expect(pageOf('artifact-page-pdf').source).toEqual({ uri: 'file:///cache/a1/spec.pdf' })
  })

  it.each([
    ['clip.mp4', 'video'],
    ['voice.m4a', 'audio']
  ])('%s: the downloaded file in the native player', async (title) => {
    download.mockResolvedValue(`file:///cache/a1/${title}`)
    const hub = fakeArtifactsHub({ artifacts: [artifactRow('a1', title)] })
    await view(hub, { artifactId: 'a1' })
    await screen.findByTestId('artifact-media')
    const props = screen.getByTestId('artifact-media').props as {
      player: { source: string }
      nativeControls: boolean
    }
    expect(props.player.source).toBe(`file:///cache/a1/${title}`)
    expect(props.nativeControls).toBe(true)
    expect(hub.callsTo('artifacts.readText')).toHaveLength(0)
  })

  it.each(['clip.webm', 'song.ogg', 'memo.opus'])(
    "%s: a format iOS can't play never reaches the player: a note and Share",
    async (title) => {
      const hub = fakeArtifactsHub({ artifacts: [artifactRow('a1', title)] })
      await view(hub, { artifactId: 'a1' })
      expect((await screen.findByTestId('artifact-unsupported')).props.children).toMatch(
        /^Can't play this format on iPhone/
      )
      expect(screen.getAllByRole('button', { name: 'Share' })).toHaveLength(2)
      expect(download).not.toHaveBeenCalled()
    }
  )

  it("a file the player reports it can't play: a note and Share instead of a black box", async () => {
    download.mockResolvedValue('file:///cache/a1/clip.mov')
    const hub = fakeArtifactsHub({ artifacts: [artifactRow('a1', 'clip.mov')] })
    mockPlayerStatus.length = 0
    await view(hub, { artifactId: 'a1' })
    await screen.findByTestId('artifact-media')
    await act(async () => {
      for (const listener of mockPlayerStatus) listener({ status: 'error' })
    })
    expect((await screen.findByTestId('artifact-unsupported')).props.children).toMatch(
      /^Can't play this format/
    )
    expect(screen.queryByTestId('artifact-media')).toBeNull()
  })

  it('video in a build without the native player: says so and offers Share, fetching nothing', async () => {
    jest.mocked(mediaPlayer).mockReturnValue(null)
    const hub = fakeArtifactsHub({ artifacts: [artifactRow('a1', 'clip.mp4')] })
    await view(hub, { artifactId: 'a1' })
    expect((await screen.findByTestId('artifact-unsupported')).props.children).toMatch(
      /can't be played in this build/
    )
    // The note's own Share, beside the header's.
    expect(screen.getAllByRole('button', { name: 'Share' })).toHaveLength(2)
    expect(hub.callsTo('artifacts.readText')).toHaveLength(0)
    expect(download).not.toHaveBeenCalled()
  })

  it.each(['bundle.zip', 'face.woff2'])(
    '%s: no viewer on the phone yet, so a note and Share; nothing fetched up front',
    async (title) => {
      const hub = fakeArtifactsHub({ artifacts: [artifactRow('a1', title)] })
      await view(hub, { artifactId: 'a1' })
      expect((await screen.findByTestId('artifact-unsupported')).props.children).toMatch(
        /can't be shown in the app yet/
      )
      expect(hub.callsTo('artifacts.readText')).toHaveLength(0)
      expect(download).not.toHaveBeenCalled()
    }
  )

  it("a file that isn't text, in a text kind: says so and offers Share", async () => {
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', 'dump.bin')],
      content: { a1: 'PK\u0003\u0004\u0000\u0000' }
    })
    await view(hub, { artifactId: 'a1' })
    await screen.findByTestId('artifact-binary')
    // The hub said so (`readText`); the bytes never came.
    expect(hub.callsTo('artifacts.readContent')).toHaveLength(0)
  })

  it('a file too large for text: says so and offers Share, without fetching it', async () => {
    const hub = fakeArtifactsHub({ artifacts: [artifactRow('a1', 'huge.log')] })
    hub.on('artifacts.readText', () => ({ kind: 'too-large', size: 70 * 1024 * 1024 }))
    await view(hub, { artifactId: 'a1' })
    expect((await screen.findByTestId('artifact-too-large')).props.children.join('')).toMatch(
      /too large to preview \(70 MB\)/
    )
    expect(screen.getAllByRole('button', { name: 'Share' })).toHaveLength(2)
    expect(hub.callsTo('artifacts.readContent')).toHaveLength(0)
  })

  it('a hub without readText: the whole file as before', async () => {
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', 'plan.md')],
      content: { a1: '# Old hub' }
    })
    hub.on('artifacts.readText', () => {
      throw new Error('No procedure found on path "artifacts.readText"')
    })
    await view(hub, { artifactId: 'a1' })
    await screen.findByTestId('artifact-page-markdown')
    expect(pageOf('artifact-page-markdown').source.html).toContain('<h1>Old hub</h1>')
  })

  it('a deleted artifact says so', async () => {
    const hub = fakeArtifactsHub({ artifacts: [] })
    await view(hub, { artifactId: 'gone' })
    await screen.findByText('This artifact no longer exists.')
  })
})

describe('ArtifactViewer, live and interactive', () => {
  it('reloads the content when the hub says the file changed', async () => {
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', 'plan.md')],
      content: { a1: '# Before' }
    })
    await view(hub, { artifactId: 'a1' })
    await screen.findByTestId('artifact-page-markdown')
    hub.state.content.a1 = '# After'
    await act(async () => hub.emit('artifacts.onContentChanged', 'other'))
    expect(pageOf('artifact-page-markdown').source.html).toContain('Before')
    await act(async () => hub.emit('artifacts.onContentChanged', 'a1'))
    await waitFor(() => expect(pageOf('artifact-page-markdown').source.html).toContain('After'))
  })

  it('History lists the versions; picking one asks for it', async () => {
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', 'plan.md')],
      content: { a1: '# Plan' },
      versions: { a1: [versionRow('a1', 2), versionRow('a1', 1)] }
    })
    const { onSelectVersion } = await view(hub, { artifactId: 'a1' })
    await screen.findByTestId('artifact-page-markdown')
    await userEvent.setup().press(screen.getByRole('button', { name: 'History' }))
    await screen.findByTestId('artifact-version-1')
    expect(screen.getByText('current')).toBeOnTheScreen()
    // People's words, not the content hash.
    expect(screen.getByText('Version 2')).toBeOnTheScreen()
    expect(screen.queryByText(/hash/)).toBeNull()
    expect(screen.getAllByText(/^Person · .* · 10 bytes$/)).toHaveLength(2)
    await userEvent.setup().press(screen.getByTestId('artifact-version-1'))
    expect(onSelectVersion).toHaveBeenCalledWith(1)
  })

  it('History closes with Done', async () => {
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', 'plan.md')],
      content: { a1: '# Plan' },
      versions: { a1: [versionRow('a1', 2)] }
    })
    await view(hub, { artifactId: 'a1' })
    await screen.findByTestId('artifact-page-markdown')
    const user = userEvent.setup()
    await user.press(screen.getByRole('button', { name: 'History' }))
    await screen.findByTestId('artifact-version-2')
    await user.press(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByTestId('artifact-version-2')).toBeNull())
  })

  it('a row that failed to load says why, with Retry', async () => {
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', 'plan.md')],
      content: { a1: '# P' }
    })
    let fail = true
    hub.on('artifacts.get', ({ id }) => {
      if (fail) throw new Error('The hub is unreachable.')
      return hub.state.artifacts.find((a) => a.id === id) ?? null
    })
    await view(hub, { artifactId: 'a1', backLabel: 'Search' })
    await screen.findByText('The hub is unreachable.', undefined, { timeout: 5000 })
    expect(screen.queryByRole('button', { name: 'Back to Search' })).toBeNull()
    fail = false
    await userEvent.setup().press(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByTestId('artifact-page-markdown')
  })

  it("Back says where it goes (the caller's label)", async () => {
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', 'plan.md')],
      content: { a1: '# P' }
    })
    await view(hub, { artifactId: 'a1', backLabel: 'Search', onBack: jest.fn() })
    await screen.findByTestId('artifact-page-markdown')
    expect(screen.getByRole('button', { name: 'Back to Search' })).toBeOnTheScreen()
    expect(screen.getByText('‹ Search')).toBeOnTheScreen()
  })

  it('shows a version when one is named, with the way back', async () => {
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', 'plan.md')],
      content: { a1: '# Plan' },
      versions: { a1: [versionRow('a1', 2), versionRow('a1', 1)] }
    })
    const { onSelectVersion } = await view(hub, { artifactId: 'a1', version: 1 })
    await screen.findByText('Viewing v1')
    await waitFor(() => expect(pageOf('artifact-page-markdown').source.html).toContain('(v1)'))
    expect(hub.callsTo('artifacts.versionsRead')).toEqual([{ artifactId: 'a1', versionRef: 1 }])
    await userEvent.setup().press(screen.getByRole('button', { name: 'Back to current' }))
    expect(onSelectVersion).toHaveBeenCalledWith(null)
  })

  it('Share hands the downloaded file to the share sheet', async () => {
    const share = jest
      .spyOn(Share, 'share')
      .mockResolvedValue({ action: 'sharedAction', activityType: undefined })
    download.mockResolvedValue('file:///cache/a1/plan.md')
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', 'plan.md')],
      content: { a1: '# Plan' }
    })
    await view(hub, { artifactId: 'a1' })
    await screen.findByTestId('artifact-page-markdown')
    await userEvent.setup().press(screen.getByRole('button', { name: 'Share' }))
    await waitFor(() =>
      expect(share).toHaveBeenCalledWith({ url: 'file:///cache/a1/plan.md', title: 'plan.md' })
    )
  })

  it('a tapped artifact link opens that artifact; a tapped web link opens outside', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', 'plan.md')],
      content: { a1: '[Spec](artifact:a2)' }
    })
    const { onOpenArtifact } = await view(hub, { artifactId: 'a1' })
    await screen.findByTestId('artifact-page-markdown')
    const page = pageOf('artifact-page-markdown')
    const tap = (url: string) => ({ url, isTopFrame: true, navigationType: 'click' })
    expect(page.onShouldStartLoadWithRequest({ url: 'about:blank', isTopFrame: true })).toBe(true)
    // Not tapped (a refresh, a redirect): nothing opens.
    expect(
      page.onShouldStartLoadWithRequest({
        url: 'https://x.dev',
        isTopFrame: true,
        navigationType: 'other'
      })
    ).toBe(false)
    expect(openURL).not.toHaveBeenCalled()
    expect(page.onShouldStartLoadWithRequest(tap('artifact:a2'))).toBe(false)
    expect(onOpenArtifact).toHaveBeenCalledWith('a2')
    expect(page.onShouldStartLoadWithRequest(tap('https://x.dev'))).toBe(false)
    expect(openURL).toHaveBeenCalledWith('https://x.dev')
  })

  it("HTML: the colour scheme cycles System → Dark, saved on the artifact's hub", async () => {
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', 'report.html')],
      content: { a1: '<html><head></head><body>x</body></html>' }
    })
    await view(hub, { artifactId: 'a1' })
    await screen.findByTestId('artifact-page-html')
    await userEvent.setup().press(screen.getByRole('button', { name: 'Colour scheme: System' }))
    await waitFor(() =>
      expect(hub.callsTo('artifacts.update')).toEqual([{ id: 'a1', htmlThemeOverride: 'dark' }])
    )
    await screen.findByRole('button', { name: 'Colour scheme: Dark' })
    await waitFor(() =>
      expect(pageOf('artifact-page-html').source.html).toContain('color-scheme:dark !important')
    )
  })

  it("HTML: a colour scheme that couldn't be saved says so on its own line, not Share's", async () => {
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', 'report.html')],
      content: { a1: '<p>x</p>' }
    })
    hub.on('artifacts.update', () => {
      throw new Error('Read-only hub')
    })
    const share = jest
      .spyOn(Share, 'share')
      .mockResolvedValue({ action: 'sharedAction', activityType: undefined })
    download.mockResolvedValue('file:///cache/a1/report.html')
    await view(hub, { artifactId: 'a1' })
    await screen.findByTestId('artifact-page-html')
    const user = userEvent.setup()
    await user.press(screen.getByRole('button', { name: 'Colour scheme: System' }))
    await screen.findByText('Read-only hub')
    // Sharing (which clears its own error) leaves the scheme's error alone.
    await user.press(screen.getByRole('button', { name: 'Share' }))
    await waitFor(() => expect(share).toHaveBeenCalled())
    expect(screen.getByText('Read-only hub')).toBeOnTheScreen()
  })
})

describe('ArtifactViewer, Zoom', () => {
  it("markdown: steps through desktop's ladder, saved on the artifact's hub; the % resets", async () => {
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', 'plan.md')],
      content: { a1: '# Plan' }
    })
    await view(hub, { artifactId: 'a1' })
    await screen.findByTestId('artifact-page-markdown')
    expect(pageOf('artifact-page-markdown').source.html).not.toContain('zoom:')
    const user = userEvent.setup()
    await user.press(screen.getByRole('button', { name: 'Zoom in' }))
    await waitFor(() =>
      expect(hub.callsTo('artifacts.update')).toEqual([{ id: 'a1', zoomPct: 110 }])
    )
    await screen.findByRole('button', { name: 'Reset zoom (110%)' })
    expect(pageOf('artifact-page-markdown').source.html).toContain('html{zoom:1.1}')
    await user.press(screen.getByRole('button', { name: 'Reset zoom (110%)' }))
    // 100% is the default: saved as none, as desktop does.
    await waitFor(() => expect(hub.callsTo('artifacts.update')).toContainEqual({ id: 'a1', zoomPct: null }))
    await screen.findByRole('button', { name: 'Reset zoom (100%)' })
    expect(pageOf('artifact-page-markdown').source.html).not.toContain('zoom:')
  })

  it("opens at the artifact's saved zoom; the ladder's ends disable their button", async () => {
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', 'main.ts', { zoom_pct: 300 })],
      content: { a1: 'const a = 1' }
    })
    await view(hub, { artifactId: 'a1' })
    await screen.findByTestId('artifact-page-code')
    expect(pageOf('artifact-page-code').source.html).toContain('html{zoom:3}')
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeEnabled()
  })

  it('HTML: the report frame zooms', async () => {
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', 'report.html', { zoom_pct: 50 })],
      content: { a1: '<p>x</p>' }
    })
    await view(hub, { artifactId: 'a1' })
    await screen.findByTestId('artifact-page-html')
    expect(pageOf('artifact-page-html').source.html).toContain('transform:scale(0.5)')
  })

  it("SVG: no zoom control on the drawing (pinch zooms it), one on its source, as desktop", async () => {
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', 'logo.svg', { zoom_pct: 150 })],
      content: { a1: '<svg viewBox="0 0 1 1"><rect/></svg>' }
    })
    await view(hub, { artifactId: 'a1' })
    await screen.findByTestId('artifact-page-svg')
    expect(screen.queryByRole('button', { name: 'Zoom in' })).toBeNull()
    expect(pageOf('artifact-page-svg').source.html).not.toContain('zoom:')
    await userEvent.setup().press(screen.getByRole('button', { name: 'Source' }))
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeOnTheScreen()
    expect(pageOf('artifact-page-svg').source.html).toContain('html{zoom:1.5}')
  })

  it.each([
    ['shot.png', 'artifact-image'],
    ['doc.pdf', 'artifact-page-pdf']
  ])('%s: no zoom control (pinch zooms it)', async (title, testID) => {
    download.mockResolvedValue(`file:///cache/a1/${title}`)
    const hub = fakeArtifactsHub({ artifacts: [artifactRow('a1', title)] })
    await view(hub, { artifactId: 'a1' })
    await screen.findByTestId(testID)
    expect(screen.queryByRole('button', { name: 'Zoom in' })).toBeNull()
  })

  it("a zoom that couldn't be saved says so and shows the saved zoom again", async () => {
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', 'plan.md')],
      content: { a1: '# Plan' }
    })
    hub.on('artifacts.update', () => {
      throw new Error('Read-only hub')
    })
    await view(hub, { artifactId: 'a1' })
    await screen.findByTestId('artifact-page-markdown')
    await userEvent.setup().press(screen.getByRole('button', { name: 'Zoom in' }))
    await screen.findByText('Read-only hub')
    await screen.findByRole('button', { name: 'Reset zoom (100%)' })
    expect(pageOf('artifact-page-markdown').source.html).not.toContain('zoom:')
  })
})

describe('ArtifactViewer, Export', () => {
  /** Opens Export and picks `choice` (by label); the sheet's options. */
  async function pickExport(choice: string | null): Promise<string[]> {
    let options: string[] = []
    jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((o, pick) => {
      options = o.options
      pick(choice === null ? (o.cancelButtonIndex ?? options.length - 1) : options.indexOf(choice))
    })
    await userEvent.setup().press(screen.getByRole('button', { name: 'Export' }))
    return options
  }

  it.each([
    ['plan.md', '# Plan', 'markdown', ['PDF', 'HTML', 'Cancel']],
    ['main.ts', 'const a = 1', 'code', ['PDF', 'HTML', 'Cancel']],
    ['report.html', '<h1>R</h1>', 'html', ['PDF', 'Cancel']],
    ['logo.svg', '<svg/>', 'svg', ['PDF', 'PNG', 'Cancel']],
    ['flow.mmd', 'graph TD; A-->B', 'mermaid', ['PDF', 'PNG', 'HTML', 'Cancel']]
  ])('%s offers the formats desktop does', async (title, content, kind, expected) => {
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', title)],
      content: { a1: content }
    })
    await view(hub, { artifactId: 'a1' })
    await screen.findByTestId(`artifact-page-${kind}`)
    expect(await pickExport(null)).toEqual(expected)
    expect(runExport).not.toHaveBeenCalled()
  })

  it('images and PDFs have no export', async () => {
    download.mockResolvedValue('file:///cache/a1/spec.pdf')
    const hub = fakeArtifactsHub({ artifacts: [artifactRow('a1', 'spec.pdf')] })
    await view(hub, { artifactId: 'a1' })
    await screen.findByTestId('artifact-page-pdf')
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull()
  })

  it('exports the text on screen in the picked format, with the hidden renderer', async () => {
    runExport.mockResolvedValue('file:///cache/slayzone-exports/flow.png')
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', 'flow.mmd')],
      content: { a1: 'graph TD; A-->B' }
    })
    await view(hub, { artifactId: 'a1' })
    await screen.findByTestId('artifact-page-mermaid')
    await pickExport('PNG')
    await waitFor(() =>
      expect(runExport).toHaveBeenCalledWith(
        { content: 'graph TD; A-->B', mode: 'mermaid-preview', title: 'flow.mmd', format: 'png' },
        {
          render: expect.any(Function),
          mermaidScript: loadMermaidScript,
          html2canvasScript: loadHtml2canvasScript,
          signal: expect.objectContaining({ aborted: false }),
          onNotice: expect.any(Function)
        }
      )
    )
    await screen.findByRole('button', { name: 'Export' })
  })

  it('exports the version on screen', async () => {
    runExport.mockResolvedValue('file:///cache/slayzone-exports/plan.pdf')
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', 'plan.md')],
      content: { a1: '# Plan' },
      versions: { a1: [versionRow('a1', 2), versionRow('a1', 1)] }
    })
    await view(hub, { artifactId: 'a1', version: 1 })
    await waitFor(() => expect(pageOf('artifact-page-markdown').source.html).toContain('(v1)'))
    await pickExport('PDF')
    await waitFor(() =>
      expect(runExport).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('(v1)'), format: 'pdf' }),
        expect.anything()
      )
    )
  })

  // Review 6, #7: Export makes a file of what is on screen. While the version picked is
  // still loading or doesn't exist (or the text failed to load), what is on screen is a
  // spinner or an error, not the working copy still in the cache: nothing to export.
  describe('only what is on screen', () => {
    async function viewThenPick(
      hub: ReturnType<typeof fakeArtifactsHub>,
      version: number
    ): Promise<void> {
      const { wrapper } = trpcTest(hub.backend)
      const props: ArtifactViewerProps = {
        target,
        taskId: 't1',
        artifactId: 'a1',
        version: null,
        onSelectVersion: jest.fn(),
        onOpenArtifact: jest.fn()
      }
      const { rerender } = await render(<ArtifactViewer {...props} />, { wrapper })
      // The working copy is loaded (and cached) first.
      await screen.findByTestId('artifact-page-markdown')
      expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled()
      await rerender(<ArtifactViewer {...props} version={version} />)
    }

    it('a version that does not exist: Export is off', async () => {
      const hub = fakeArtifactsHub({
        artifacts: [artifactRow('a1', 'plan.md')],
        content: { a1: '# Working copy' },
        versions: { a1: [versionRow('a1', 1)] }
      })
      await viewThenPick(hub, 7)
      await screen.findByText('This artifact has no version 7.')
      expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled()
      // Share would hand over the working copy as "version 7": off too.
      expect(screen.getByRole('button', { name: 'Share' })).toBeDisabled()
      await userEvent.setup().press(screen.getByRole('button', { name: 'Export' }))
      expect(runExport).not.toHaveBeenCalled()
    })

    it('a version still loading: Export is off', async () => {
      const hub = fakeArtifactsHub({
        artifacts: [artifactRow('a1', 'plan.md')],
        content: { a1: '# Working copy' }
      })
      hub.on('artifacts.versionsList', pending)
      await viewThenPick(hub, 2)
      await screen.findByTestId('artifact-loading')
      expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Share' })).toBeDisabled()
    })

    it('text that failed to load (an older copy still cached): Export is off', async () => {
      const hub = fakeArtifactsHub({
        artifacts: [artifactRow('a1', 'plan.md')],
        content: { a1: '# Before' }
      })
      await view(hub, { artifactId: 'a1' })
      await screen.findByTestId('artifact-page-markdown')
      hub.on('artifacts.readText', () => {
        throw new Error('The hub could not read the file.')
      })
      await act(async () => hub.emit('artifacts.onContentChanged', 'a1'))
      await screen.findByText(/could not read the file/)
      expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled()
    })
  })

  // Review 9, L4: closing the viewer stops its export: the share sheet never opens over
  // another screen.
  it('closing the viewer cancels its export (the abort signal)', async () => {
    let signal: AbortSignal | undefined
    runExport.mockImplementation((_request, deps) => {
      signal = deps.signal
      return new Promise(() => undefined)
    })
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', 'plan.md')],
      content: { a1: '# Plan' }
    })
    await view(hub, { artifactId: 'a1' })
    await screen.findByTestId('artifact-page-markdown')
    await pickExport('PDF')
    await waitFor(() => expect(signal).toBeDefined())
    expect(signal?.aborted).toBe(false)
    await act(async () => screen.unmount())
    expect(signal?.aborted).toBe(true)
  })

  // Review 9, F4: drawn again with text labels — said under the toolbar, as it happens
  // (before the share sheet opens), not as an error.
  it("a notice of the export's is shown under the toolbar", async () => {
    runExport.mockImplementation(async (_request, deps) => {
      deps.onNotice?.('Some labels were drawn as plain text.')
      return 'file:///cache/slayzone-exports/r.pdf'
    })
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', 'report.html')],
      content: { a1: '<h1>R</h1>' }
    })
    await view(hub, { artifactId: 'a1' })
    await screen.findByTestId('artifact-page-html')
    await pickExport('PDF')
    await screen.findByText('Some labels were drawn as plain text.')
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled()
  })

  it('a failed export says why, under the toolbar', async () => {
    runExport.mockRejectedValue(new Error("Couldn't draw the diagram: Parse error"))
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', 'flow.mmd')],
      content: { a1: 'nope' }
    })
    await view(hub, { artifactId: 'a1' })
    await screen.findByTestId('artifact-page-mermaid')
    await pickExport('PDF')
    await screen.findByText("Couldn't draw the diagram: Parse error")
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled()
  })
})

it('leaving during a slow artifact share download cancels the share sheet', async () => {
  const share = jest
    .spyOn(Share, 'share')
    .mockReset()
    .mockResolvedValue({ action: 'sharedAction', activityType: undefined })
  let finishDownload!: (path: string) => void
  download.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishDownload = resolve
      })
  )
  const hub = fakeArtifactsHub({
    artifacts: [artifactRow('a1', 'plan.md')],
    content: { a1: '# Plan' }
  })
  await view(hub, { artifactId: 'a1' })
  await screen.findByTestId('artifact-page-markdown')
  await userEvent.setup().press(screen.getByRole('button', { name: 'Share' }))
  await waitFor(() => expect(download).toHaveBeenCalledTimes(1))
  await act(async () => screen.unmount())
  await act(async () => finishDownload('file:///cache/a1/plan.md'))
  expect(share).not.toHaveBeenCalled()
})
