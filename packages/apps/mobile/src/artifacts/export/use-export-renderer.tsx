/**
 * The export's hidden web view (`render-pages.ts` holds its pages): `render(page)` loads
 * one page in a web view the person never sees and resolves with what the page posts
 * back (a message carrying the page's token; anything else is ignored). The view exists
 * only while a page renders — mounted by whoever shows `view` (the artifact viewer),
 * invisible, untouchable, its page the only thing it may load — and is unmounted when
 * the page answers, fails, takes longer than its timeout ({@link EXPORT_RENDER_TIMEOUT_MS}
 * unless the page says otherwise; a script that never yields) or its viewer goes away.
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
 * Mermaid's largest diagrams draw in a few seconds on a phone. A page may ask for longer
 * (`ExportRenderPage.timeoutMs`: an html artifact's, `HTML_RENDER_TIMEOUT_MS`).
 */
export const EXPORT_RENDER_TIMEOUT_MS = 30_000

/**
 * What the view may load: the page itself (`about:blank` with its HTML) and an html
 * artifact's frame (`about:srcdoc`) — in every frame. Never a link, a redirect, a
 * refresh, or a remote frame.
 */
export const isExportPageLoad = (request: { url: string }): boolean =>
  request.url === EXPORT_PAGE_URL || request.url === 'about:srcdoc'

/**
 * The page's own frame: react-native-webview loads `source.html` at `about:blank` and
 * hands each message over with the URL of the frame that posted it. WKWebView gives its
 * message handler to every frame, so an html artifact's frame (`about:srcdoc`) can post
 * to the app without the page: only the page's own messages are read.
 */
const EXPORT_PAGE_URL = 'about:blank'

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
  // The render in progress, kept as it changes (state lags a render): a render asked for
  // while one is pending, and a viewer that goes away, end it — nothing is left pending
  // forever.
  const live = useRef<PendingRender | null>(null)
  const settle = (done: PendingRender) => {
    if (live.current === done) live.current = null
    setPending((current) => (current === done ? null : current))
  }

  useEffect(() => {
    if (!pending) return
    const timer = setTimeout(() => {
      settle(pending)
      pending.reject(new Error('Rendering the export took too long.'))
    }, pending.page.timeoutMs ?? EXPORT_RENDER_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [pending])

  useEffect(
    () => () => {
      live.current?.reject(new Error('The export was cancelled: the viewer was closed.'))
    },
    []
  )

  const render = (page: ExportRenderPage) =>
    new Promise<ExportRenderReply>((resolve, reject) => {
      const replaced = live.current
      nextRenderId += 1
      const next = { id: nextRenderId, page, resolve, reject }
      live.current = next
      setPending(next)
      replaced?.reject(new Error('The export was replaced by another one.'))
    })

  const fail = (message: string) => {
    if (!pending) return
    settle(pending)
    pending.reject(new Error(message))
  }

  const onMessage = (event: WebViewMessageEvent) => {
    if (!pending || event.nativeEvent.url !== EXPORT_PAGE_URL) return
    const reply = parseExportRenderReply(event.nativeEvent.data, pending.page.token)
    if (!reply) return
    settle(pending)
    pending.resolve(reply)
  }

  const view = pending ? (
    <WebView
      key={pending.id}
      testID="artifact-export-renderer"
      source={{ html: pending.page.html }}
      originWhitelist={['*']}
      onShouldStartLoadWithRequest={isExportPageLoad}
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
