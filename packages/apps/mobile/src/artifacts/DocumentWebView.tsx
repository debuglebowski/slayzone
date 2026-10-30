/**
 * The web view every page-shaped artifact shows in: rendered markdown, code, SVG and
 * mermaid pages (`pages/`), HTML reports (their sandboxed host page) and PDFs (the
 * downloaded file; WebKit draws PDFs natively, pinch-zoom included).
 *
 * - What may load and where links go: `decideNavigation` (every request reaches it:
 *   `originWhitelist` lets all through, else the web view itself would hand an
 *   `artifact:` link to iOS).
 * - JavaScript runs only on pages that carry scripts (diagrams, reports).
 * - Nothing persists: a non-persistent website data store (`incognito`), no shared
 *   cookies, no link previews, no detected phone numbers, no new windows.
 */
import { parseHtmlPreviewLinkMessage } from '@slayzone/platform/html-preview-links'
import { Linking, StyleSheet } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes'
import { useTheme } from '../theme'
import { decideNavigation } from './navigation'

export type DocumentPage =
  /** One of the app's own pages; `scripts`: it runs its own (nonce'd) scripts. */
  | { kind: 'document'; html: string; scripts: boolean }
  /** An HTML report's host page (`htmlReportPage`). */
  | { kind: 'report'; html: string }
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
  const fileUri = page.kind === 'file' ? page.fileUri : undefined

  const onShouldStartLoadWithRequest = (request: ShouldStartLoadRequest): boolean => {
    const decision = decideNavigation(request, { fileUri })
    if (decision.kind === 'open-artifact') onOpenArtifact(decision.artifactId)
    else if (decision.kind === 'open-external') void Linking.openURL(decision.url)
    return decision.kind === 'load'
  }

  // A report's link bridge (forwarded by its host page): open the link outside.
  const onMessage = (event: WebViewMessageEvent) => {
    let data: unknown = null
    try {
      data = JSON.parse(event.nativeEvent.data)
    } catch {
      return
    }
    const link = parseHtmlPreviewLinkMessage(data)
    if (link) void Linking.openURL(link.url)
  }

  return (
    <WebView
      testID={testID}
      source={page.kind === 'file' ? { uri: page.fileUri } : { html: page.html }}
      originWhitelist={['*']}
      onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
      onMessage={page.kind === 'report' ? onMessage : undefined}
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

const styles = StyleSheet.create({ view: { flex: 1 } })
