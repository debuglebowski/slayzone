/**
 * The export's hidden web view (`render-pages.ts` holds its pages): `render(page)` loads
 * one page in a web view the person never sees and resolves with what the page posts
 * back (a message carrying the page's token; anything else is ignored). The view exists
 * only while a page renders — mounted by whoever shows `view` (the artifact viewer),
 * invisible, untouchable, its page the only thing it may load — and is unmounted when
 * the page answers, fails, takes longer than {@link EXPORT_RENDER_TIMEOUT_MS} (a script
 * that never yields) or its viewer goes away.
 *
 * WKWebView runs a page's script only inside the window, so the view is mounted, not
 * offscreen: laid over the screen at zero opacity.
 */
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { StyleSheet } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import {
  type ExportRenderPage,
  type ExportRenderReply,
  parseExportRenderReply
} from './render-pages'

/**
 * Mermaid's largest diagrams draw in a few seconds on a phone; an html artifact is taken
 * at most `HTML_SETTLE.maxLoadMs` + `maxAfterLoadMs` (20 s) after it starts.
 */
export const EXPORT_RENDER_TIMEOUT_MS = 30_000

interface PendingRender {
  id: number
  page: ExportRenderPage
  resolve: (reply: ExportRenderReply) => void
  reject: (error: Error) => void
}

let nextRenderId = 0

export interface ExportRenderer {
  /** The hidden web view while a page renders, else null. */
  view: ReactNode
  render: (page: ExportRenderPage) => Promise<ExportRenderReply>
}

export function useExportRenderer(): ExportRenderer {
  const [pending, setPending] = useState<PendingRender | null>(null)

  useEffect(() => {
    if (!pending) return
    const timer = setTimeout(() => {
      setPending((current) => (current === pending ? null : current))
      pending.reject(new Error('Rendering the export took too long.'))
    }, EXPORT_RENDER_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [pending])

  // A viewer that goes away ends its render: nothing is left pending forever.
  const live = useRef<PendingRender | null>(null)
  useEffect(() => {
    live.current = pending
  }, [pending])
  useEffect(
    () => () => {
      live.current?.reject(new Error('The export was cancelled: the viewer was closed.'))
    },
    []
  )

  const render = (page: ExportRenderPage) =>
    new Promise<ExportRenderReply>((resolve, reject) => {
      nextRenderId += 1
      setPending({ id: nextRenderId, page, resolve, reject })
    })

  const fail = (message: string) => {
    if (!pending) return
    setPending(null)
    pending.reject(new Error(message))
  }

  const onMessage = (event: WebViewMessageEvent) => {
    if (!pending) return
    const reply = parseExportRenderReply(event.nativeEvent.data, pending.page.token)
    if (!reply) return
    setPending(null)
    pending.resolve(reply)
  }

  const view = pending ? (
    <WebView
      key={pending.id}
      testID="artifact-export-renderer"
      source={{ html: pending.page.html }}
      originWhitelist={['*']}
      // The page itself (`about:blank` with its HTML); never a link or a redirect.
      onShouldStartLoadWithRequest={(request) => request.url === 'about:blank'}
      onMessage={onMessage}
      onError={(event) => fail(`The export renderer failed: ${event.nativeEvent.description}`)}
      onContentProcessDidTerminate={() => fail('The export renderer stopped.')}
      javaScriptEnabled
      incognito
      sharedCookiesEnabled={false}
      dataDetectorTypes="none"
      setSupportMultipleWindows={false}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.hidden, pending.page.viewport]}
    />
  ) : null

  return { view, render }
}

const styles = StyleSheet.create({
  // A phone-sized page: a diagram lays out as it would on screen.
  hidden: { position: 'absolute', left: 0, top: 0, width: 800, height: 600, opacity: 0 }
})
