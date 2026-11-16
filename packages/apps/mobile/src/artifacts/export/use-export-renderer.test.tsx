import { act, render, screen } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { injectedJavaScript } from '../webview-mock'
import {
  EXPORT_RENDER_SOURCE,
  type ExportPageSink,
  type ExportRenderPage,
  exportAckScript,
  type ExportRenderReply,
  HTML_RENDER_IDLE_MS,
  htmlRasterPage
} from './render-pages'
import { EXPORT_RENDER_IDLE_MS, useExportRenderer } from './use-export-renderer'

/** The view is hidden from accessibility on purpose: look for it anyway. */
const HIDDEN = { includeHiddenElements: true }

type Render = (page: ExportRenderPage, sink?: ExportPageSink) => Promise<ExportRenderReply>

const TOKEN = 'page-token'
const page = (html: string, extra: Partial<ExportRenderPage> = {}): ExportRenderPage => ({
  html,
  token: TOKEN,
  ...extra
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
    onMessage: (e: { nativeEvent: { data: string; url?: string } }) => void
    onShouldStartLoadWithRequest: (r: { url: string }) => boolean
    onContentProcessDidTerminate: () => void
    pointerEvents: string
  }

/** A message as react-native-webview's iOS view hands it over: its frame's URL with it. */
const reply = (body: object, token: string = TOKEN, url = 'about:blank') =>
  ({
    nativeEvent: { data: JSON.stringify({ source: EXPORT_RENDER_SOURCE, token, ...body }), url }
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
    // Review 9, F2: in any frame (react-native-webview asks for every frame's loads).
    for (const url of [
      'blob:null/0b6c',
      'file:///etc/hosts',
      'http://evil.example/',
      'about:srcdoc#x',
      'about:blankx'
    ]) {
      expect(props.onShouldStartLoadWithRequest({ url })).toBe(false)
    }
    // Noise the page didn't send is ignored, and so is a reply without its token.
    await act(async () =>
      props.onMessage({ nativeEvent: { data: '{"hello":1}', url: 'about:blank' } })
    )
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
    const settled = expect(result).rejects.toThrow(
      'Rendering the export stalled: nothing came back from it for 30 s.'
    )
    await act(async () => {
      jest.advanceTimersByTime(EXPORT_RENDER_IDLE_MS)
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
    const settled = expect(result).rejects.toThrow(
      `Rendering the export stalled: nothing came back from it for ${HTML_RENDER_IDLE_MS / 1000} s.`
    )
    // An html artifact settles before it says anything: more time than a diagram gets.
    await act(async () => {
      jest.advanceTimersByTime(EXPORT_RENDER_IDLE_MS)
    })
    expect(screen.getByTestId('artifact-export-renderer', HIDDEN)).toBeOnTheScreen()
    await act(async () => {
      jest.advanceTimersByTime(HTML_RENDER_IDLE_MS - EXPORT_RENDER_IDLE_MS)
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

// Follow-up N2: the viewer closed while the export read its script from disk; the
// export then asks for a render. That render is cancelled at once: nothing is left
// pending forever (no view mounts to time it out).
it('a render asked for after the viewer unmounted is rejected at once', async () => {
  let run: Render | null = null
  function Host(): ReactNode {
    const renderer = useExportRenderer()
    run = renderer.render
    return renderer.view
  }
  const view = await render(<Host />)
  await act(async () => view.unmount())
  const late = (run as unknown as Render)(page('<html>late</html>'))
  await expect(late).rejects.toThrow(/closed/)
})

// Review 8, L11: WKWebView hands its message handler to every frame: an html artifact's
// own frame (`about:srcdoc`) can post to the app without the host page. Only the page
// itself (its frame, `about:blank`) answers.
it('takes replies only from the page itself, not from a frame in it', async () => {
  const host = await mount()
  let result: Promise<ExportRenderReply> | null = null
  await act(async () => {
    result = host.run()(page('<html/>'))
  })
  const props = viewProps()
  await act(async () =>
    props.onMessage(reply({ type: 'svg', svg: '<svg/>' }, TOKEN, 'about:srcdoc'))
  )
  await act(async () =>
    props.onMessage(reply({ type: 'svg', svg: '<svg/>' }, TOKEN, 'https://x.dev/'))
  )
  expect(screen.getByTestId('artifact-export-renderer', HIDDEN)).toBeOnTheScreen()
  await act(async () => props.onMessage(reply({ type: 'svg', svg: '<svg id="page"/>' })))
  await expect(result).resolves.toEqual({ type: 'svg', svg: '<svg id="page"/>' })
})

// Review 8, L12: a render asked for while one is pending replaces it; the first is ended,
// not left pending forever.
it('a render asked for while one is pending ends that one', async () => {
  const host = await mount()
  let first: Promise<ExportRenderReply> | null = null
  let second: Promise<ExportRenderReply> | null = null
  await act(async () => {
    first = host.run()(page('<html>first</html>'))
  })
  const firstSettled = (first as unknown as Promise<ExportRenderReply>).catch((e: Error) => e)
  await act(async () => {
    second = host.run()(page('<html>second</html>'))
  })
  expect(String(await firstSettled)).toMatch(/replaced/)
  const props = viewProps()
  expect(props.source).toEqual({ html: '<html>second</html>' })
  await act(async () => props.onMessage(reply({ type: 'svg', svg: '<svg/>' })))
  await expect(second).resolves.toEqual({ type: 'svg', svg: '<svg/>' })
  expect(screen.queryByTestId('artifact-export-renderer', HIDDEN)).toBeNull()
})

it('two renders asked for at once: the first is ended, the second runs', async () => {
  const host = await mount()
  let first: Promise<ExportRenderReply> | null = null
  let second: Promise<ExportRenderReply> | null = null
  await act(async () => {
    first = host.run()(page('<html>first</html>'))
    second = host.run()(page('<html>second</html>'))
  })
  await expect(first).rejects.toThrow(/replaced/)
  const props = viewProps()
  expect(props.source).toEqual({ html: '<html>second</html>' })
  await act(async () => props.onMessage(reply({ type: 'svg', svg: '<svg/>' })))
  await expect(second).resolves.toEqual({ type: 'svg', svg: '<svg/>' })
})

// Review 9, L5: one fixed budget covered an html artifact's whole render, and its pages
// came back in one message. Now each message of the page (progress, a page) restarts the
// renderer's idle timer, and the pages are put together here as they come.
describe('useExportRenderer: progress, not a fixed budget', () => {
  const IDLE = 10_000
  const slow = () => page('<html/>', { idleTimeoutMs: IDLE })

  /** Where the pages go (the PDF being written): what it was handed. */
  function sink() {
    const pages: string[] = []
    return {
      pages,
      page: (index: number, base64: string) => {
        pages[index] = base64
      },
      restart: () => {
        pages.length = 0
      }
    }
  }

  // Follow-up N3: no page is kept: each goes to the sink as it comes, and the page is
  // told it was taken (it draws no further while a few wait).
  it('a render that keeps reporting progress well past 90 s completes, each page handed on and answered', async () => {
    jest.useFakeTimers()
    const host = await mount()
    const into = sink()
    injectedJavaScript.length = 0
    let result: Promise<ExportRenderReply> | null = null
    await act(async () => {
      result = host.run()(slow(), into)
    })
    const props = viewProps()
    for (let i = 0; i < 12; i++) {
      await act(async () => {
        jest.advanceTimersByTime(IDLE - 1)
      })
      await act(async () =>
        props.onMessage(
          i % 2
            ? reply({ type: 'progress' })
            : reply({ type: 'page', index: i / 2, base64: `UA${i}=` })
        )
      )
    }
    // 12 × 10 s: far past any one budget, and still running.
    expect(screen.getByTestId('artifact-export-renderer', HIDDEN)).toBeOnTheScreen()
    await act(async () =>
      props.onMessage(reply({ type: 'pages-end', count: 6, textLabels: false }))
    )
    await expect(result).resolves.toEqual({ type: 'pages', count: 6, textLabels: false })
    expect(into.pages).toEqual(['UA0=', 'UA2=', 'UA4=', 'UA6=', 'UA8=', 'UA10='])
    // Each page answered once it was taken, counting every page taken so far.
    expect(injectedJavaScript).toEqual([1, 2, 3, 4, 5, 6].map(exportAckScript))
    expect(screen.queryByTestId('artifact-export-renderer', HIDDEN)).toBeNull()
    jest.useRealTimers()
  })

  it('a render that goes silent fails with a clear message, its view released', async () => {
    jest.useFakeTimers()
    const host = await mount()
    let result: Promise<ExportRenderReply> | null = null
    await act(async () => {
      result = host.run()(slow(), sink())
    })
    const settled = expect(result).rejects.toThrow(
      'Rendering the export stalled: nothing came back from it for 10 s.'
    )
    await act(async () => {
      jest.advanceTimersByTime(IDLE - 1)
    })
    await act(async () => viewProps().onMessage(reply({ type: 'page', index: 0, base64: 'UA==' })))
    // Noise and a message without the token are no progress.
    await act(async () => {
      jest.advanceTimersByTime(IDLE - 1)
    })
    await act(async () =>
      viewProps().onMessage({ nativeEvent: { data: '{"type":"progress"}', url: 'about:blank' } })
    )
    await act(async () => viewProps().onMessage(reply({ type: 'progress' }, 'guess')))
    expect(screen.getByTestId('artifact-export-renderer', HIDDEN)).toBeOnTheScreen()
    await act(async () => {
      jest.advanceTimersByTime(1)
    })
    await settled
    expect(screen.queryByTestId('artifact-export-renderer', HIDDEN)).toBeNull()
    jest.useRealTimers()
  })

  it('a page out of order fails the render', async () => {
    const host = await mount()
    let result: Promise<ExportRenderReply> | null = null
    await act(async () => {
      result = host.run()(slow())
    })
    await act(async () => viewProps().onMessage(reply({ type: 'page', index: 1, base64: 'UA==' })))
    await expect(result).resolves.toMatchObject({ type: 'error', code: 'render' })
    expect(screen.queryByTestId('artifact-export-renderer', HIDDEN)).toBeNull()
  })
})

// Review 9, L2: a frame inside an html artifact (<iframe src="about:blank">) posts as
// about:blank too: the token is the only guard. A message longer than the page's cap is
// dropped before anything else is read of it.
it("drops a message longer than the page's cap, even one with the token", async () => {
  const host = await mount()
  let result: Promise<ExportRenderReply> | null = null
  const ok = reply({ type: 'svg', svg: '<svg/>' })
  await act(async () => {
    result = host.run()(page('<html/>', { maxMessageChars: ok.nativeEvent.data.length }))
  })
  await act(async () => viewProps().onMessage(reply({ type: 'svg', svg: '<svg id="long"/>' })))
  expect(screen.getByTestId('artifact-export-renderer', HIDDEN)).toBeOnTheScreen()
  await act(async () => viewProps().onMessage(ok))
  await expect(result).resolves.toEqual({ type: 'svg', svg: '<svg/>' })
})
