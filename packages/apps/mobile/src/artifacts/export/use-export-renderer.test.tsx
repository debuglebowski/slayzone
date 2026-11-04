import { act, render, screen } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { EXPORT_RENDER_SOURCE, type ExportRenderReply } from './render-pages'
import { EXPORT_RENDER_TIMEOUT_MS, useExportRenderer } from './use-export-renderer'

/** The view is hidden from accessibility on purpose: look for it anyway. */
const HIDDEN = { includeHiddenElements: true }

type Render = (html: string) => Promise<ExportRenderReply>

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

const reply = (body: object) =>
  ({ nativeEvent: { data: JSON.stringify({ source: EXPORT_RENDER_SOURCE, ...body }) } }) as const

describe('useExportRenderer: a hidden web view per render', () => {
  it('shows nothing until asked', async () => {
    await mount()
    expect(screen.queryByTestId('artifact-export-renderer', HIDDEN)).toBeNull()
  })

  it('loads the page with scripts on, answers with its reply, then goes away', async () => {
    const host = await mount()
    let result: Promise<ExportRenderReply> | null = null
    await act(async () => {
      result = host.run()('<html>page</html>')
    })
    const props = viewProps()
    expect(props.source).toEqual({ html: '<html>page</html>' })
    expect(props.javaScriptEnabled).toBe(true)
    expect(props.pointerEvents).toBe('none')
    // Only the page itself loads: no link, no redirect.
    expect(props.onShouldStartLoadWithRequest({ url: 'about:blank' })).toBe(true)
    expect(props.onShouldStartLoadWithRequest({ url: 'https://x.dev' })).toBe(false)
    // Noise the page didn't send is ignored.
    await act(async () => props.onMessage({ nativeEvent: { data: '{"hello":1}' } }))
    await act(async () => props.onMessage(reply({ type: 'svg', svg: '<svg/>' })))
    await expect(result).resolves.toEqual({ type: 'svg', svg: '<svg/>' })
    expect(screen.queryByTestId('artifact-export-renderer', HIDDEN)).toBeNull()
  })

  it('a web view that crashes fails the render', async () => {
    const host = await mount()
    let result: Promise<ExportRenderReply> | null = null
    await act(async () => {
      result = host.run()('<html/>')
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
      result = host.run()('<html/>')
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
