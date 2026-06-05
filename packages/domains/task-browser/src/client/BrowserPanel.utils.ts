export function generateTabId(): string {
  return `tab-${crypto.randomUUID().slice(0, 8)}`
}

/**
 * Normalize raw URL-bar input into a navigable URL.
 * - Absolute paths (`/…`) → `file://`
 * - Schemeless localhost / IPs → `http://`
 * - Schemeless dotted hosts → `https://`
 * - Anything else → Google search
 */
export function normalizeUrl(input: string): string {
  let url = input.trim()
  const hasScheme = /^(https?|file|about|data|view-source):/.test(url)
  if (url.startsWith('/')) {
    url = `file://${url}`
  } else if (!hasScheme) {
    const isLocal =
      /^localhost(:\d+)?(\/|$)/.test(url) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(url)
    const looksLikeUrl = isLocal || (url.includes('.') && !url.includes(' '))
    url = looksLikeUrl
      ? `${isLocal ? 'http' : 'https'}://${url}`
      : `https://www.google.com/search?q=${encodeURIComponent(url)}`
  }
  return url
}
