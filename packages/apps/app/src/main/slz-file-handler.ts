import { readFile } from 'node:fs/promises'
import { normalize, posix, sep } from 'node:path'
import { contentTypeForPath } from '@slayzone/platform/mime-types'
import { injectForcedHtmlTheme } from '@slayzone/platform/forced-html-theme'
import {
  injectArtifactControlsRuntime,
  readArtifactPreviewMode
} from '@slayzone/platform/artifact-controls'
import {
  parseHtmlArtifactPreviewUrl,
  parseSlzFileUrl,
  SLZ_ARTIFACT_SCHEME,
  type SlzFileSource
} from '@slayzone/platform/slz-file-url'

/**
 * Protocol handler for files and desktop HTML artifact previews. Chromium
 * blocks `file://` in webviews and cross-origin renderers.
 *
 * Two kinds of URL (see `@slayzone/platform/slz-file-url`):
 *
 * - **local** (`toSlzFileUrl`): a path on THIS machine, served off disk, confined
 *   to the home directory.
 * - **source** (`toSlzSourceUrl`): a file on a hub or one of its computers. On a
 *   remote hub a preview's paths are another machine's paths, so they are never
 *   read here: the bytes are fetched from the hub that owns them, which routes a
 *   workspace read to the computer holding the checkout and applies the same
 *   gates as `fileEditor.readFile`. The local hub is fetched the same way, so a
 *   workspace on any computer of any hub previews identically.
 */

/** Where to reach a hub and how to sign in to it. */
export interface HubEndpoint {
  /** `http(s)://host[:port]`, no trailing slash. */
  origin: string
  /** Bearer for a hub that requires login; null when none is stored. */
  token: string | null
}

export interface SlzFileHandlerDeps {
  homeDir: string
  /** Null when the hub is not in the registry (removed) or not running. */
  resolveHub: (hubId: string) => Promise<HubEndpoint | null>
  fetch?: typeof fetch
  readFile?: (path: string) => Promise<Buffer<ArrayBuffer>>
}

/** Bare media type: the charset is decided per page (see {@link withHtmlCharset}). */
function mediaType(path: string): string {
  return contentTypeForPath(path).split(';')[0].trim()
}

/** How far the browser's encoding prescan reads into a page (HTML spec). */
const PRESCAN_BYTES = 1024
/** `<meta charset=…>` or `<meta http-equiv="Content-Type" content="…; charset=…">`. */
const CHARSET_DECLARATION = /<meta\b[^>]*\bcharset\s*=/i

/** Whether a page decides its own encoding: a byte order mark, or a declaration
 *  where the browser's prescan finds it. */
function declaresEncoding(head: Uint8Array): boolean {
  const [a, b, c] = head
  if (
    (a === 0xef && b === 0xbb && c === 0xbf) ||
    (a === 0xfe && b === 0xff) ||
    (a === 0xff && b === 0xfe)
  ) {
    return true
  }
  return CHARSET_DECLARATION.test(Buffer.from(head.subarray(0, PRESCAN_BYTES)).toString('latin1'))
}

/**
 * A page that declares no encoding is decoded as UTF-8, not the browser's
 * windows-1252 fallback that turns `·` into `Â·`. One that does declare one keeps
 * it: the header would override its `<meta charset>`.
 */
function withHtmlCharset(contentType: string, head: Uint8Array): string {
  return contentType === 'text/html' && !declaresEncoding(head)
    ? 'text/html; charset=utf-8'
    : contentType
}

/** The first `bytes` of a stream, and the whole stream again to send on. */
async function peekStream(
  body: ReadableStream<Uint8Array>,
  bytes: number
): Promise<{ head: Uint8Array; body: ReadableStream<Uint8Array> }> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (size < bytes) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.length
  }
  const head = Buffer.concat(chunks)
  return {
    head,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        if (head.length > 0) controller.enqueue(head)
      },
      async pull(controller) {
        const { done, value } = await reader.read()
        if (done) controller.close()
        else controller.enqueue(value)
      },
      cancel(reason) {
        return reader.cancel(reason)
      }
    })
  }
}

function messagePage(title: string, detail: string): Response {
  const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui;background:#1a1a1a;color:#888}
div{text-align:center}h1{font-size:14px;font-weight:500;color:#aaa}p{font-size:12px;margin:8px 0 0;word-break:break-all;max-width:400px}</style>
</head><body><div><h1>${esc(title)}</h1><p>${esc(detail)}</p></div></body></html>`,
    { status: 200, headers: { 'content-type': 'text/html' } }
  )
}

/** Per-artifact forced theme (task-artifacts HTML preview), gated on `?theme=`. */
function forcedTheme(url: URL): 'light' | 'dark' | null {
  const theme = url.searchParams.get('theme')
  return theme === 'dark' || theme === 'light' ? theme : null
}

/**
 * What the task-artifacts HTML preview adds to a page it serves, from the URL:
 * the forced theme (`?theme=`) and the `<slay-artifact-controls>` runtime
 * (`?slayzone-preview=`). Injected as text at parse time: the sandboxed preview
 * iframe has no webContents to insertCSS into, and the page is never painted
 * wrong first. Null when there is nothing to add, so every other consumer gets
 * the untouched bytes.
 */
function htmlDoctor(url: URL, contentType: string): ((html: string) => string) | null {
  if (contentType !== 'text/html') return null
  const theme = forcedTheme(url)
  const mode = readArtifactPreviewMode(url)
  if (!theme && !mode) return null
  return (html) => {
    const themed = theme ? injectForcedHtmlTheme(html, theme) : html
    return mode ? injectArtifactControlsRuntime(themed, mode) : themed
  }
}

/** The hub URL that serves a source's bytes. */
export function sourceRequestUrl(origin: string, source: SlzFileSource, relPath: string): string {
  if (source.kind === 'artifact') {
    return `${origin}/api/artifacts/${encodeURIComponent(source.artifactId)}/content`
  }
  const q = new URLSearchParams({ rootPath: source.rootPath, path: relPath })
  if (source.taskId) q.set('taskId', source.taskId)
  if (source.projectId) q.set('projectId', source.projectId)
  if (source.computerId) q.set('computerId', source.computerId)
  return `${origin}/api/files/raw?${q}`
}

/** Hub response headers a preview may see. Everything else (cookies, the
 *  artifact route's `content-disposition: attachment`, which would turn an
 *  iframe into a download) stays behind. */
const PASSED_HEADERS = ['content-length', 'content-range', 'accept-ranges', 'etag']
/** Request headers forwarded to the hub: ranged reads (PDF, media) and revalidation. */
const FORWARDED_HEADERS = ['range', 'if-none-match', 'if-range']

export function createSlzFileHandler(deps: SlzFileHandlerDeps) {
  const doFetch = deps.fetch ?? fetch
  const doRead = deps.readFile ?? ((p: string) => readFile(p))

  async function serveLocal(url: URL, rawPath: string): Promise<Response> {
    const filePath = normalize(rawPath)
    // Block path traversal outside the user's home directory.
    if (!filePath.startsWith(deps.homeDir + sep)) {
      return messagePage('Access denied', 'Path outside home directory')
    }
    let data: Buffer<ArrayBuffer>
    try {
      data = await doRead(filePath)
    } catch {
      return messagePage('File not found', filePath)
    }
    const contentType = mediaType(filePath)
    const doctor = htmlDoctor(url, contentType)
    const body = doctor ? doctor(data.toString('utf-8')) : data
    return new Response(body, {
      headers: {
        'content-type': withHtmlCharset(contentType, data),
        'cache-control': 'no-cache'
      }
    })
  }

  async function serveSource(
    url: URL,
    request: Request,
    source: SlzFileSource,
    relPath: string
  ): Promise<Response> {
    const name = posix.basename(relPath)
    // An artifact is one file: any other name under it (a relative reference
    // inside an HTML artifact) does not exist, rather than being the artifact again.
    if (source.kind === 'artifact' && relPath !== source.name) {
      return messagePage('File not found', relPath)
    }
    const hub = await deps.resolveHub(source.hubId).catch(() => null)
    if (!hub) return messagePage('Hub unavailable', `Can't reach the hub that holds ${name}.`)

    const headers = new Headers()
    if (hub.token) headers.set('authorization', `Bearer ${hub.token}`)
    for (const h of FORWARDED_HEADERS) {
      const v = request.headers.get(h)
      if (v) headers.set(h, v)
    }
    let res: Response
    try {
      res = await doFetch(sourceRequestUrl(hub.origin, source, relPath), {
        headers,
        signal: request.signal
      })
    } catch {
      return messagePage('Hub unavailable', `Can't reach the hub that holds ${name}.`)
    }

    if (res.status === 304 || res.status === 416) {
      return new Response(null, { status: res.status, headers: pick(res.headers) })
    }
    if (!res.ok) {
      const detail = await errorDetail(res)
      void res.body?.cancel().catch(() => {
        // The body may already be consumed (the JSON detail) or the stream closed.
      })
      return res.status === 404
        ? messagePage('File not found', detail ?? relPath)
        : res.status === 401 || res.status === 403
          ? messagePage('Access denied', detail ?? `The hub refused to serve ${name}.`)
          : messagePage("Couldn't load file", detail ?? `The hub answered ${res.status}.`)
    }

    const contentType = mediaType(relPath)
    const out = pick(res.headers)
    out.set('content-type', contentType)
    out.set('cache-control', 'no-cache')
    if (url.protocol === `${SLZ_ARTIFACT_SCHEME}:`) {
      // Apply the sandbox to the document as well as to the preview iframe.
      out.set('content-security-policy', 'sandbox allow-scripts allow-same-origin')
    }
    // A partial response is not the start of the page: no prescan to mirror.
    if (contentType !== 'text/html' || res.status !== 200 || !res.body) {
      return new Response(res.body, { status: res.status, headers: out })
    }
    let peeked: Awaited<ReturnType<typeof peekStream>>
    try {
      peeked = await peekStream(res.body, PRESCAN_BYTES)
    } catch {
      return messagePage("Couldn't load file", `The hub stopped sending ${name}.`)
    }
    out.set('content-type', withHtmlCharset(contentType, peeked.head))
    const doctor = htmlDoctor(url, contentType)
    if (doctor) {
      const doctored = doctor(await new Response(peeked.body).text())
      out.delete('content-length')
      out.delete('etag')
      return new Response(doctored, { status: 200, headers: out })
    }
    return new Response(peeked.body, { status: 200, headers: out })
  }

  return async function slzFileHandler(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const parsed =
      url.protocol === `${SLZ_ARTIFACT_SCHEME}:`
        ? await parseHtmlArtifactPreviewUrl(url)
        : parseSlzFileUrl(request.url)
    if (!parsed) return new Response('Forbidden', { status: 403 })
    if (parsed.kind === 'local') return serveLocal(url, parsed.path)
    return serveSource(url, request, parsed.source, parsed.relPath)
  }
}

function pick(from: Headers): Headers {
  const out = new Headers()
  for (const h of PASSED_HEADERS) {
    const v = from.get(h)
    if (v) out.set(h, v)
  }
  return out
}

/** The hub's `{ error }` message, if the refusal carried one. */
async function errorDetail(res: Response): Promise<string | null> {
  if (!res.headers.get('content-type')?.includes('application/json')) return null
  try {
    const body = (await res.json()) as { error?: unknown }
    return typeof body.error === 'string' ? body.error : null
  } catch {
    return null
  }
}
