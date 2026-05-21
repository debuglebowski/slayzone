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
  // Heal URLs corrupted by a past round-trip bug that left one or more stray
  // `app` host segments (`file://app/...`, `file://appapp/...`). Collapse them
  // back to the empty-host form before transforming. `app` is never a valid
  // file:// host on the platforms we support, so this is safe.
  const healed = url.replace(/^file:\/\/(?:app)+\//, 'file:///')
  return healed.replace(/^file:\/\//, SLZ_FILE_PREFIX)
}

/**
 * Inverse of `fileUrlToSlzFileUrl`. Strips the whole `slz-file://app` prefix
 * (scheme + sentinel host) back to the empty-host `file:///abs/path` form.
 * Stripping only the scheme would leave `app` stranded in the path, and a
 * later round-trip through `fileUrlToSlzFileUrl` would compound it into
 * `slz-file://appapp/...`. Non-matching URLs pass through unchanged.
 */
export function slzFileUrlToFileUrl(url: string): string {
  return url.startsWith(SLZ_FILE_PREFIX)
    ? `file://${url.slice(SLZ_FILE_PREFIX.length)}`
    : url
}
