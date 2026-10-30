/**
 * What an artifact page may load, and where a tapped link goes (the web view's
 * `onShouldStartLoadWithRequest`). Mirrors desktop's previews:
 *
 * - the page itself (`about:blank` + its anchors; a report's `about:srcdoc` frame), and
 *   a PDF's own local file, load;
 * - inside a report's frame anything loads: desktop lets the sandboxed frame navigate
 *   itself (the frame's sandbox still forbids leaving it);
 * - `artifact:<id>` (an artifact link) opens that artifact in the app;
 * - http(s) and mailto open outside the app (desktop: a bare click opens externally);
 * - anything else (other files, `javascript:`, app schemes) is refused.
 */

export type NavigationDecision =
  | { kind: 'load' }
  | { kind: 'open-artifact'; artifactId: string }
  | { kind: 'open-external'; url: string }
  | { kind: 'block' }

const EXTERNAL = /^(https?:\/\/|mailto:)/i
const ARTIFACT_LINK = /^artifact:(.+)$/

/**
 * A `file:` URL's path, comparable: decoded, without its fragment, and without iOS's
 * `/private` prefix (`/var` is a symlink to `/private/var`; WebKit may report either).
 */
function filePathOf(url: string): string | null {
  if (!url.startsWith('file://')) return null
  let path = url.slice('file://'.length).split('#', 1)[0]
  try {
    path = decodeURI(path)
  } catch {
    return null
  }
  return path.startsWith('/private/') ? path.slice('/private'.length) : path
}

export function decideNavigation(
  request: { url: string; isTopFrame?: boolean },
  page: { fileUri?: string } = {}
): NavigationDecision {
  const { url } = request
  if (request.isTopFrame === false) return { kind: 'load' }
  if (url === 'about:blank' || url.startsWith('about:blank#') || url === 'about:srcdoc') {
    return { kind: 'load' }
  }
  if (page.fileUri) {
    const path = filePathOf(url)
    if (path !== null && path === filePathOf(page.fileUri)) return { kind: 'load' }
  }
  const artifact = ARTIFACT_LINK.exec(url)
  if (artifact) return { kind: 'open-artifact', artifactId: decodeURIComponent(artifact[1]) }
  if (EXTERNAL.test(url)) return { kind: 'open-external', url }
  return { kind: 'block' }
}
