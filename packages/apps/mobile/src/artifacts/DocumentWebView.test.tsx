import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { Linking } from 'react-native'
import { HTML_PREVIEW_LINK_MESSAGE_TYPE } from '@slayzone/platform/html-preview-links'
import { DocumentWebView, type DocumentPage } from './DocumentWebView'
import { htmlReportPage } from './pages/html-report-page'
import { webViewMounts } from './webview-mock'

interface PageProps {
  onMessage?: (e: { nativeEvent: { data: string } }) => void
  onShouldStartLoadWithRequest: (r: {
    url: string
    isTopFrame: boolean
    navigationType?: string
  }) => boolean
  onContentProcessDidTerminate?: () => void
  onError?: (e: { nativeEvent: { description: string } }) => void
}

const props = () => screen.getByTestId('page').props as PageProps

const link = {
  type: HTML_PREVIEW_LINK_MESSAGE_TYPE,
  url: 'https://evil.example',
  metaKey: false,
  ctrlKey: false,
  shiftKey: false
}

let openURL: jest.SpyInstance
beforeEach(() => {
  openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
})
afterEach(() => openURL.mockRestore())

async function show(page: DocumentPage) {
  const onOpenArtifact = jest.fn()
  await render(<DocumentWebView page={page} onOpenArtifact={onOpenArtifact} testID="page" />)
  return { onOpenArtifact }
}

describe('DocumentWebView, an HTML report', () => {
  it("opens a link only when its host page forwarded it (the page's token)", async () => {
    const report = htmlReportPage('<a href="https://x.dev">x</a>', { forcedTheme: 'dark' })
    await show({ kind: 'report', html: report.html, token: report.token })
    const send = (data: unknown) =>
      props().onMessage?.({
        nativeEvent: { data: typeof data === 'string' ? data : JSON.stringify(data) }
      })

    // The report frame posting to the app straight (WKWebView gives it the handler).
    send(link)
    send({ ...link, token: 'guessed' })
    send('not json')
    expect(openURL).not.toHaveBeenCalled()

    send({ ...link, url: 'https://x.dev', token: report.token })
    expect(openURL).toHaveBeenCalledWith('https://x.dev')
  })
})

describe('DocumentWebView, any page', () => {
  const doc: DocumentPage = { kind: 'document', html: '<p>x</p>', scripts: false }

  it('leaves the page only on a tap', async () => {
    const { onOpenArtifact } = await show(doc)
    expect(
      props().onShouldStartLoadWithRequest({
        url: 'https://evil.example',
        isTopFrame: true,
        navigationType: 'other'
      })
    ).toBe(false)
    expect(
      props().onShouldStartLoadWithRequest({
        url: 'artifact:a9',
        isTopFrame: true,
        navigationType: 'other'
      })
    ).toBe(false)
    expect(openURL).not.toHaveBeenCalled()
    expect(onOpenArtifact).not.toHaveBeenCalled()
  })

  it('a PDF keeps following its links as before', async () => {
    await show({ kind: 'file', fileUri: 'file:///cache/a1/x.pdf' })
    props().onShouldStartLoadWithRequest({
      url: 'https://x.dev',
      isTopFrame: true,
      navigationType: 'other'
    })
    expect(openURL).toHaveBeenCalledWith('https://x.dev')
  })

  it('reloads when its web content process dies (no white page)', async () => {
    await show(doc)
    const before = webViewMounts.count
    await act(async () => props().onContentProcessDidTerminate?.())
    expect(webViewMounts.count).toBe(before + 1)
  })

  it('a page that fails to load says so, with Retry', async () => {
    await show(doc)
    await act(async () => props().onError?.({ nativeEvent: { description: 'boom' } }))
    expect(screen.getByText("This page couldn't be shown.")).toBeTruthy()
    const before = webViewMounts.count
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Retry' })))
    expect(screen.queryByText("This page couldn't be shown.")).toBeNull()
    expect(webViewMounts.count).toBe(before + 1)
  })
})
