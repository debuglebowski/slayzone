/**
 * The export's hidden web view (`render-pages.ts` holds its pages): `render(page)` loads
 * one page in a web view the person never sees and resolves with what the page answers
 * (its messages carry the page's token; anything else is ignored), an html artifact's
 * pages put together as they come. The view exists only while a page renders — mounted
 * by whoever shows `view` (the artifact viewer), invisible, untouchable, its page the
 * only thing it may load — and is unmounted when the page answers, fails, goes longer
 * than its idle timeout without a message ({@link EXPORT_RENDER_IDLE_MS} unless the page
 * says otherwise; a script that never yields), or its viewer goes away. There is no cap
 * on a render that keeps sending: each message restarts the clock.
 *
 * WKWebView runs a page's script only inside the window, so the view is mounted, not
 * offscreen: laid over the screen at zero opacity.
 */
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { StyleSheet } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import {
  collectExportReply,
  type ExportRenderMessage,
  type ExportRenderPage,
  type ExportRenderReply,
  parseExportRenderMessage
} from './render-pages'
import { useStableCallback } from '../../chat/useStableCallback'

/**
 * Mermaid's largest diagrams draw in a few seconds on a phone, in one go (no message
 * until the reply). A page may ask for longer (`ExportRenderPage.idleTimeoutMs`: an html
 * artifact's, `HTML_RENDER_IDLE_MS`).
 */
export const EXPORT_RENDER_IDLE_MS = 30_000

/**
 * What the view may load: the page itself (`about:blank` with its HTML) and an html
 * artifact's frame (`about:srcdoc`) — in every frame. Never a link, a redirect, a
 * refresh, or a remote frame.
 */
export const isExportPageLoad = (request: { url: string }): boolean =>
  request.url === EXPORT_PAGE_URL || request.url === 'about:srcdoc'

/**
 * The page's own URL: react-native-webview loads `source.html` at `about:blank` and hands
 * each message over with the URL of the frame that posted it. WKWebView gives its message
 * handler to every frame, so an html artifact's frame (`about:srcdoc`) can post to the
 * app without the page — and so can a frame inside it at `about:blank`, the page's own
 * URL. Messages from another URL are dropped unread, but that is a filter for noise, not
 * a guard: the page's token is (`parseExportRenderMessage`).
 */
const EXPORT_PAGE_URL = 'about:blank'

interface PendingRender {
  id: number
  page: ExportRenderPage
  resolve: (reply: ExportRenderReply) => void
  reject: (error: Error) => void
  /** Puts the page's messages together into its reply. */
  take: (message: ExportRenderMessage) => ExportRenderReply | null
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
  // The pending render's idle timer: (re)started when it starts and at each of its messages.
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stopIdle = () => {
    if (idle.current !== null) clearTimeout(idle.current)
    idle.current = null
  }
  const settle = (done: PendingRender) => {
    if (live.current === done) live.current = null
    stopIdle()
    setPending((current) => (current === done ? null : current))
  }
  // Stable: the effect below re-arms the timer when `pending` changes, not on every render.
  const startIdle = useStableCallback((render: PendingRender) => {
    stopIdle()
    const ms = render.page.idleTimeoutMs ?? EXPORT_RENDER_IDLE_MS
    idle.current = setTimeout(() => {
      idle.current = null
      settle(render)
      render.reject(
        new Error(`Rendering the export stalled: nothing came back from it for ${ms / 1000} s.`)
      )
    }, ms)
  })

  useEffect(() => {
    if (!pending) return
    startIdle(pending)
    return stopIdle
  }, [pending, startIdle])

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
      const next = { id: nextRenderId, page, resolve, reject, take: collectExportReply() }
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
    const { token, maxMessageChars } = pending.page
    const message = parseExportRenderMessage(event.nativeEvent.data, token, maxMessageChars)
    if (!message) return
    const reply = pending.take(message)
    if (!reply) {
      // Still going: the clock starts again.
      startIdle(pending)
      return
    }
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
