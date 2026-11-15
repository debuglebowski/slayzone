import { act, render, screen } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import {
  EXPORT_RENDER_SOURCE,
  type ExportRenderPage,
  type ExportRenderReply,
  HTML_RENDER_TIMEOUT_MS,
  htmlRasterPage
} from './render-pages'
import { EXPORT_RENDER_TIMEOUT_MS, useExportRenderer } from './use-export-renderer'

/** The view is hidden from accessibility on purpose: look for it anyway. */
const HIDDEN = { includeHiddenElements: true }

type Render = (page: ExportRenderPage) => Promise<ExportRenderReply>

const TOKEN = 'page-token'
const page = (html: string, viewport?: ExportRenderPage['viewport']): ExportRenderPage => ({
  html,
  token: TOKEN,
  viewport
})

async function mount(): Promise<{ run: () => Render }> {
  let run: Render | null = null
  function Host(): ReactNode {
    const renderer = useExportRenderer()
    run = renderer.render
    return renderer.view
  }
  await render(<Host />)
  return {
    run: () => {
      if (!run) throw new Error('not mounted')
      return run
    }
  }
}

const viewProps = () =>
  screen.getByTestId('artifact-export-renderer', HIDDEN).props as {
    source: { html: string }
    javaScriptEnabled: boolean
    onMessage: (e: { nativeEvent: { data: string } }) => void
    onShouldStartLoadWithRequest: (r: { url: string }) => boolean
    onContentProcessDidTerminate: () => void
    pointerEvents: string
  }

const reply = (body: object, token: string = TOKEN) =>
  ({
    nativeEvent: { data: JSON.stringify({ source: EXPORT_RENDER_SOURCE, token, ...body }) }
  }) as const

describe('useExportRenderer: a hidden web view per render', () => {
  it('shows nothing until asked', async () => {
    await mount()
    expect(screen.queryByTestId('artifact-export-renderer', HIDDEN)).toBeNull()
  })

  it('loads the page with scripts on, answers with its reply, then goes away', async () => {
    const host = await mount()
    let result: Promise<ExportRenderReply> | null = null
    await act(async () => {
      result = host.run()(page('<html>page</html>'))
    })
    const props = viewProps()
    expect(props.source).toEqual({ html: '<html>page</html>' })
    expect(props.javaScriptEnabled).toBe(true)
    expect(props.pointerEvents).toBe('none')
    // Only the page itself loads (and an html artifact's srcdoc frame): no link, no
    // redirect, no refresh, no remote frame.
    expect(props.onShouldStartLoadWithRequest({ url: 'about:blank' })).toBe(true)
    expect(props.onShouldStartLoadWithRequest({ url: 'about:srcdoc' })).toBe(true)
    expect(props.onShouldStartLoadWithRequest({ url: 'https://x.dev' })).toBe(false)
    expect(props.onShouldStartLoadWithRequest({ url: 'about:blank#x' })).toBe(false)
    expect(props.onShouldStartLoadWithRequest({ url: 'data:text/html,x' })).toBe(false)
    expect(props.onShouldStartLoadWithRequest({ url: 'javascript:alert(1)' })).toBe(false)
    // Noise the page didn't send is ignored, and so is a reply without its token.
    await act(async () => props.onMessage({ nativeEvent: { data: '{"hello":1}' } }))
    await act(async () => props.onMessage(reply({ type: 'svg', svg: '<svg id="forged"/>' }, 'x')))
    expect(screen.getByTestId('artifact-export-renderer', HIDDEN)).toBeOnTheScreen()
    await act(async () => props.onMessage(reply({ type: 'svg', svg: '<svg/>' })))
    await expect(result).resolves.toEqual({ type: 'svg', svg: '<svg/>' })
    expect(screen.queryByTestId('artifact-export-renderer', HIDDEN)).toBeNull()
  })

  it('a web view that crashes fails the render', async () => {
    const host = await mount()
    let result: Promise<ExportRenderReply> | null = null
    await act(async () => {
      result = host.run()(page('<html/>'))
    })
    const settled = expect(result).rejects.toThrow('The export renderer stopped.')
    await act(async () => viewProps().onContentProcessDidTerminate())
    await settled
    expect(screen.queryByTestId('artifact-export-renderer', HIDDEN)).toBeNull()
  })

  it('a page that never answers fails after the timeout', async () => {
    jest.useFakeTimers()
    const host = await mount()
    let result: Promise<ExportRenderReply> | null = null
    await act(async () => {
      result = host.run()(page('<html/>'))
    })
    const settled = expect(result).rejects.toThrow('Rendering the export took too long.')
    await act(async () => {
      jest.advanceTimersByTime(EXPORT_RENDER_TIMEOUT_MS)
    })
    await settled
    expect(screen.queryByTestId('artifact-export-renderer', HIDDEN)).toBeNull()
    jest.useRealTimers()
  })
})

// Review 6, #4: an html artifact's page runs the artifact's own scripts. A loop in one
// never answers: the render fails after its timeout and its web view is unmounted
// (released), as any page's.
describe('useExportRenderer: an html artifact', () => {
  it("is laid out at the page's viewport; a page that loops is released at its timeout", async () => {
    jest.useFakeTimers()
    const host = await mount()
    const looping = htmlRasterPage('<script>for (;;) {}</script>', 'loop.html', 'void 0')
    let result: Promise<ExportRenderReply> | null = null
    await act(async () => {
      result = host.run()(looping)
    })
    const props = screen.getByTestId('artifact-export-renderer', HIDDEN).props as {
      source: { html: string }
      style: unknown
      onShouldStartLoadWithRequest: (r: { url: string; isTopFrame?: boolean }) => boolean
    }
    expect(props.source.html).toBe(looping.html)
    expect(props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ width: 539, height: 780 })])
    )
    // In the artifact's frame too: nothing but the page and its srcdoc.
    expect(
      props.onShouldStartLoadWithRequest({ url: 'https://elsewhere.example', isTopFrame: false })
    ).toBe(false)
    expect(props.onShouldStartLoadWithRequest({ url: 'about:srcdoc', isTopFrame: false })).toBe(
      true
    )
    const settled = expect(result).rejects.toThrow('Rendering the export took too long.')
    // Drawing a long report takes longer than a diagram: still running at the default.
    await act(async () => {
      jest.advanceTimersByTime(EXPORT_RENDER_TIMEOUT_MS)
    })
    expect(screen.getByTestId('artifact-export-renderer', HIDDEN)).toBeOnTheScreen()
    await act(async () => {
      jest.advanceTimersByTime(HTML_RENDER_TIMEOUT_MS - EXPORT_RENDER_TIMEOUT_MS)
    })
    await settled
    expect(screen.queryByTestId('artifact-export-renderer', HIDDEN)).toBeNull()
    jest.useRealTimers()
  })
})

// Review 4, M4: a render whose viewer goes away is ended, not left pending forever
// (holding the multi-MB page it was given).
it('rejects a pending render when the viewer unmounts', async () => {
  let run: Render | null = null
  function Host(): ReactNode {
    const renderer = useExportRenderer()
    run = renderer.render
    return renderer.view
  }
  const view = await render(<Host />)
  let result: Promise<ExportRenderReply> | null = null
  await act(async () => {
    result = (run as unknown as Render)(page('<html>page</html>'))
  })
  const settled = (result as unknown as Promise<ExportRenderReply>).catch((e: Error) => e)
  await act(async () => view.unmount())
  expect(String(await settled)).toMatch(/closed/)
})
