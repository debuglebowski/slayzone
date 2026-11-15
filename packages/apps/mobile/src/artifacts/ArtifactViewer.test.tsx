import { act, fireEvent, render, screen, userEvent, waitFor } from '@testing-library/react-native'
import { ActionSheetIOS, Image, Linking, Share } from 'react-native'
import { hubEntryOf } from '../hub-session'
import { pending, trpcTest } from '../testing'
import { ArtifactViewer, type ArtifactViewerProps } from './ArtifactViewer'
import { artifactRow, fakeArtifactsHub, versionRow } from './fake-artifacts-hub'
import { exportArtifact } from './export/export-artifact'
import { downloadArtifactFile } from './files'
import { hubTarget } from './hub-rest'
import { loadHtml2canvasScript, loadMermaidScript } from './page-assets'

jest.mock('./files', () => ({ ...jest.requireActual('./files'), downloadArtifactFile: jest.fn() }))
jest.mock('./page-assets', () => ({
  MERMAID_BUNDLE_FILE: 'mermaid.min.js',
  loadMermaidScript: jest.fn(async () => 'globalThis.mermaid={}'),
  loadHtml2canvasScript: jest.fn(async () => 'window.html2canvas=function(){}')
}))

jest.mock('./export/export-artifact', () => ({ exportArtifact: jest.fn() }))

const download = jest.mocked(downloadArtifactFile)
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
    onShouldStartLoadWithRequest: (req: { url: string; isTopFrame: boolean }) => boolean
  }

beforeEach(() => {
  download.mockReset()
  runExport.mockReset()
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
    expect(hub.callsTo('artifacts.readContent')).toHaveLength(0)
    // Node lays nothing out: report the screen's size as iOS would.
    await act(async () =>
      fireEvent(screen.getByTestId('artifact-image'), 'layout', {
        nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 600 } }
      })
    )
    await waitFor(() => expect(screen.getByRole('button', { name: '1:1' })).toBeEnabled())
  })

  it('PDF: the downloaded file in the web view', async () => {
    download.mockResolvedValue('file:///cache/a1/spec.pdf')
    const hub = fakeArtifactsHub({ artifacts: [artifactRow('a1', 'spec.pdf')] })
    await view(hub, { artifactId: 'a1' })
    await screen.findByTestId('artifact-page-pdf')
    expect(pageOf('artifact-page-pdf').source).toEqual({ uri: 'file:///cache/a1/spec.pdf' })
  })

  it('video: no player on the phone, so it says so and offers Share; nothing is read up front', async () => {
    const hub = fakeArtifactsHub({ artifacts: [artifactRow('a1', 'clip.mp4')] })
    await view(hub, { artifactId: 'a1' })
    await screen.findByTestId('artifact-video')
    // The note's own Share, beside the header's.
    expect(screen.getAllByRole('button', { name: 'Share' })).toHaveLength(2)
    // A video is often large: neither its text nor its file is fetched until Share.
    expect(hub.callsTo('artifacts.readContent')).toHaveLength(0)
    expect(download).not.toHaveBeenCalled()
  })

  it("a file that isn't text, in a text kind: says so and offers Share", async () => {
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', 'archive.zip')],
      content: { a1: 'PK\u0003\u0004\u0000\u0000' }
    })
    await view(hub, { artifactId: 'a1' })
    await screen.findByTestId('artifact-binary')
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
    await userEvent.setup().press(screen.getByTestId('artifact-version-1'))
    expect(onSelectVersion).toHaveBeenCalledWith(1)
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

  it('an artifact link opens that artifact; a web link opens outside', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', 'plan.md')],
      content: { a1: '[Spec](artifact:a2)' }
    })
    const { onOpenArtifact } = await view(hub, { artifactId: 'a1' })
    await screen.findByTestId('artifact-page-markdown')
    const page = pageOf('artifact-page-markdown')
    expect(page.onShouldStartLoadWithRequest({ url: 'about:blank', isTopFrame: true })).toBe(true)
    expect(page.onShouldStartLoadWithRequest({ url: 'artifact:a2', isTopFrame: true })).toBe(false)
    expect(onOpenArtifact).toHaveBeenCalledWith('a2')
    expect(page.onShouldStartLoadWithRequest({ url: 'https://x.dev', isTopFrame: true })).toBe(
      false
    )
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
          html2canvasScript: loadHtml2canvasScript
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
      hub.on('artifacts.readContent', () => {
        throw new Error('The hub could not read the file.')
      })
      await act(async () => hub.emit('artifacts.onContentChanged', 'a1'))
      await screen.findByText(/could not read the file/)
      expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled()
    })
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
