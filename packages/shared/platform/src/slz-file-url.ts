/**
 * slz-file:// is a custom Chromium-privileged scheme (registered with
 * `standard: true, secure: true, supportFetchAPI: true, stream: true,
 * bypassCSP: true`) used to serve local files into webviews + iframes
 * where `file://` is blocked.
 *
 * `standard: true` makes Chromium parse URLs as authority + path. Without a
 * sentinel host, the first path segment gets moved into the authority slot
 * (lowercased, Unicode-mangled) — breaking the home-dir security check in
 * the main-process handler. So every renderer-side constructor goes through
 * `toSlzFileUrl()` to fill the authority with `SLZ_FILE_HOST` and the
 * handler rejects requests whose host is anything else.
 */

export const SLZ_FILE_HOST = 'app'
export const SLZ_FILE_PREFIX = `slz-file://${SLZ_FILE_HOST}`

/** Build a slz-file URL from an absolute path. Pass `version` to cache-bust. */
export function toSlzFileUrl(absolutePath: string, version?: string | number): string {
  const path = absolutePath.startsWith('/') ? absolutePath : `/${absolutePath}`
  const query = version !== undefined ? `?v=${encodeURIComponent(String(version))}` : ''
  return `${SLZ_FILE_PREFIX}${path}${query}`
}

/**
 * Rewrite a `file://` URL into our scheme. Only handles the empty-host form
 * (`file:///abs/path`) used on macOS + Linux. Windows UNC paths
 * (`file://host/share/...`) would produce a broken URL — not supported.
 */
export function fileUrlToSlzFileUrl(url: string): string {
  return url.replace(/^file:\/\//, SLZ_FILE_PREFIX)
}
