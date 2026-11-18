/**
 * The web view every page-shaped artifact shows in: rendered markdown, code, SVG and
 * mermaid pages (`pages/`), HTML reports (their sandboxed host page) and PDFs (the
 * downloaded file; WebKit draws PDFs natively, pinch-zoom included).
 *
 * - What may load and where links go: `decideNavigation` (every request reaches it:
 *   `originWhitelist` lets all through, else the web view itself would hand an
 *   `artifact:` link to iOS). A page's links act only when tapped.
 * - A report's messages count only with its page's token (`htmlReportPage`): its frame
 *   can reach the app's message handler without the host page.
 * - A page whose web content process died (iOS reclaims it under memory pressure) loads
 *   again instead of staying white; one that fails to load says so, with Retry.
 * - JavaScript runs only on pages that carry scripts (diagrams, reports).
 * - Nothing persists: a non-persistent website data store (`incognito`), no shared
 *   cookies, no link previews, no detected phone numbers, no new windows.
 */
import { parseHtmlPreviewLinkMessage } from '@slayzone/platform/html-preview-links'
import { useState } from 'react'
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes'
import { type ChromeColors, useTheme } from '../theme'
import { decideNavigation } from './navigation'

export type DocumentPage =
  /** One of the app's own pages; `scripts`: it runs its own (nonce'd) scripts. */
  | { kind: 'document'; html: string; scripts: boolean }
  /** An HTML report's host page (`htmlReportPage`) and the token its messages carry. */
  | { kind: 'report'; html: string; token: string }
  /** A local file the web view draws itself (PDF). */
  | { kind: 'file'; fileUri: string }

const directoryOf = (uri: string): string => uri.slice(0, uri.lastIndexOf('/') + 1)

export function DocumentWebView({
  page,
  onOpenArtifact,
  testID
}: {
  page: DocumentPage
  onOpenArtifact: (artifactId: string) => void
  testID?: string
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const fileUri = page.kind === 'file' ? page.fileUri : undefined
  // A new web view (the page loaded anew) each time it is bumped.
  const [generation, setGeneration] = useState(0)
  const [failed, setFailed] = useState(false)
  const reload = () => {
    setFailed(false)
    setGeneration((g) => g + 1)
  }

  const onShouldStartLoadWithRequest = (request: ShouldStartLoadRequest): boolean => {
    // A PDF's links are WebKit's own (no script, no refresh): followed as they come.
    const decision = decideNavigation(request, { fileUri, requireTap: page.kind !== 'file' })
    if (decision.kind === 'open-artifact') onOpenArtifact(decision.artifactId)
    else if (decision.kind === 'open-external') void Linking.openURL(decision.url)
    return decision.kind === 'load'
  }

  // A report's link bridge (forwarded by its host page, signed): open the link outside.
  const reportToken = page.kind === 'report' ? page.token : null
  const onMessage = (event: WebViewMessageEvent) => {
    let data: unknown = null
    try {
      data = JSON.parse(event.nativeEvent.data)
    } catch {
      return
    }
    if (reportToken === null || !data || typeof data !== 'object') return
    if ((data as { token?: unknown }).token !== reportToken) return
    const link = parseHtmlPreviewLinkMessage(data)
    if (link) void Linking.openURL(link.url)
  }

  if (failed) {
    return (
      <View style={styles.failed}>
        <Text style={styles.note}>This page couldn't be shown.</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry"
          onPress={reload}
          style={styles.retry}
        >
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    )
  }

  return (
    <WebView
      key={generation}
      testID={testID}
      source={page.kind === 'file' ? { uri: page.fileUri } : { html: page.html }}
      originWhitelist={['*']}
      onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
      onMessage={page.kind === 'report' ? onMessage : undefined}
      onContentProcessDidTerminate={reload}
      onError={() => setFailed(true)}
      javaScriptEnabled={page.kind === 'report' || (page.kind === 'document' && page.scripts)}
      allowFileAccess={page.kind === 'file'}
      allowingReadAccessToURL={fileUri ? directoryOf(fileUri) : undefined}
      incognito
      sharedCookiesEnabled={false}
      allowsLinkPreview={false}
      dataDetectorTypes="none"
      setSupportMultipleWindows={false}
      allowsBackForwardNavigationGestures={false}
      // A report keeps the web view's white, as desktop's frame does; pages paint the theme.
      style={[styles.view, page.kind === 'document' ? { backgroundColor: theme.background } : null]}
    />
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    view: { flex: 1 },
    failed: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
    note: { color: t.mutedForeground, textAlign: 'center' },
    retry: {
      minHeight: 44,
      minWidth: 44,
      paddingHorizontal: 16,
      justifyContent: 'center',
      alignItems: 'center',
      borderRadius: 8,
      backgroundColor: t.muted
    },
    retryText: { color: t.foreground, fontSize: 15, fontWeight: '600' }
  })
