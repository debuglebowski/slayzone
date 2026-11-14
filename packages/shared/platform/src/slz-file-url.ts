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

/**
 * Build a slz-file URL from an absolute path. Pass `version` to cache-bust.
 * Pass `theme` ('light' | 'dark') to have the main-process handler force that
 * color scheme onto `.html`/`.htm` responses (task-artifacts HTML preview);
 * every other consumer omits it and gets the unmodified file, unchanged.
 */
export function toSlzFileUrl(
  absolutePath: string,
  version?: string | number,
  theme?: 'light' | 'dark'
): string {
  if (absolutePath.startsWith('data:') || absolutePath.startsWith('blob:')) return absolutePath
  const path = absolutePath.startsWith('/') ? absolutePath : `/${absolutePath}`
  const params: string[] = []
  if (version !== undefined) params.push(`v=${encodeURIComponent(String(version))}`)
  if (theme !== undefined) params.push(`theme=${theme}`)
  const query = params.length > 0 ? `?${params.join('&')}` : ''
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
  return url.startsWith(SLZ_FILE_PREFIX) ? `file://${url.slice(SLZ_FILE_PREFIX.length)}` : url
}

/**
 * A file that lives on a hub or on one of its computers, not on this machine.
 *
 * On a remote hub the paths a preview names are another machine's paths, so the
 * desktop handler cannot read them off its own disk. A source URL says where the
 * file is; the main process fetches it from that hub, which routes a workspace
 * read to the computer that owns the checkout (same target resolution and gates
 * as `fileEditor.readFile`).
 *
 * - `workspace`: a file under `rootPath` on the machine the target resolves to.
 * - `artifact`: a task artifact's current content, kept by the hub. `name` is
 *   the one relative path it answers to (its file name), so a relative
 *   reference inside an HTML artifact never re-fetches the artifact itself.
 */
export type SlzFileSource =
  | {
      kind: 'workspace'
      hubId: string
      rootPath: string
      computerId?: string | null
      taskId?: string
      projectId?: string
    }
  | { kind: 'artifact'; hubId: string; artifactId: string; name: string }

export type ParsedSlzFileUrl =
  | { kind: 'local'; path: string }
  | { kind: 'source'; source: SlzFileSource; relPath: string }

/**
 * Marks a source URL: `slz-file://app/@src/<base64url(source)>/<relative path>`.
 * Never a valid local path — the handler only serves local paths under the
 * home directory, which is never `/@src`.
 */
const SOURCE_SEGMENT = '@src'

function encodeSource(source: SlzFileSource): string {
  const bytes = new TextEncoder().encode(JSON.stringify(source))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeSource(token: string): SlzFileSource | null {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return null
  let parsed: unknown
  try {
    const bin = atob(token.replace(/-/g, '+').replace(/_/g, '/'))
    parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const o = parsed as Record<string, unknown>
  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0
  const optStr = (v: unknown) => v === undefined || str(v)
  if (!str(o.hubId)) return null
  if (o.kind === 'artifact' && str(o.artifactId) && str(o.name)) {
    return { kind: 'artifact', hubId: o.hubId, artifactId: o.artifactId, name: o.name }
  }
  if (
    o.kind === 'workspace' &&
    str(o.rootPath) &&
    (o.computerId === null || optStr(o.computerId)) &&
    optStr(o.taskId) &&
    optStr(o.projectId)
  ) {
    const source: SlzFileSource = { kind: 'workspace', hubId: o.hubId, rootPath: o.rootPath }
    if (o.computerId !== undefined) source.computerId = o.computerId as string | null
    if (o.taskId !== undefined) source.taskId = o.taskId as string
    if (o.projectId !== undefined) source.projectId = o.projectId as string
    return source
  }
  return null
}

/**
 * Build a source URL for `relPath` (relative to the source, `/`-separated).
 * The relative path stays hierarchical, so an HTML page's relative references
 * (`img/logo.png`, `../style.css`) resolve to siblings of the same source.
 */
export function toSlzSourceUrl(
  source: SlzFileSource,
  relPath: string,
  version?: string | number,
  theme?: 'light' | 'dark'
): string {
  const path = relPath
    .split('/')
    .filter((s) => s.length > 0)
    .map(encodeURIComponent)
    .join('/')
  const params: string[] = []
  if (version !== undefined) params.push(`v=${encodeURIComponent(String(version))}`)
  if (theme !== undefined) params.push(`theme=${theme}`)
  const query = params.length > 0 ? `?${params.join('&')}` : ''
  return `${SLZ_FILE_PREFIX}/${SOURCE_SEGMENT}/${encodeSource(source)}/${path}${query}`
}

/**
 * Parse a slz-file URL into a local path or a source + relative path. Null for
 * anything malformed: a foreign host, an undecodable source, or a relative path
 * that is empty or climbs (`..`) — so a bad URL is refused, never guessed at.
 */
export function parseSlzFileUrl(url: string): ParsedSlzFileUrl | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'slz-file:' || parsed.hostname !== SLZ_FILE_HOST) return null
  const raw = parsed.pathname.split('/').slice(1)
  if (raw[0] !== SOURCE_SEGMENT) {
    try {
      return { kind: 'local', path: decodeURIComponent(parsed.pathname) }
    } catch {
      return null
    }
  }
  const source = decodeSource(raw[1] ?? '')
  if (!source) return null
  let segments: string[]
  try {
    segments = raw.slice(2).map(decodeURIComponent)
  } catch {
    return null
  }
  if (
    segments.length === 0 ||
    segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('/') || s.includes('\\'))
  ) {
    return null
  }
  return { kind: 'source', source, relPath: segments.join('/') }
}

/**
 * Preview URL for a task artifact, given the path `artifacts.getFilePath`
 * answered — a path on the HUB's disk. With a hub id the URL names the hub and
 * the artifact, so the bytes come from that hub (a remote hub's disk is not this
 * machine's); without one (no hub scope: tests, standalone viewers) it is the
 * plain local path.
 */
export function toArtifactFileUrl(
  hubId: string | null,
  artifactId: string,
  hubPath: string,
  version?: string | number,
  theme?: 'light' | 'dark'
): string {
  if (!hubId) return toSlzFileUrl(hubPath, version, theme)
  const name = hubPath.split(/[\\/]/).pop() || artifactId
  return toSlzSourceUrl({ kind: 'artifact', hubId, artifactId, name }, name, version, theme)
}
