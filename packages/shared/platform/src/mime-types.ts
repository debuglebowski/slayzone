/**
 * Content type of a file served by bytes (a preview: image, PDF, HTML page and the
 * assets it loads), guessed from the extension. Pure — no fs, no node:path — so the
 * hub's routed raw-file endpoint and any host serving a preview share one table.
 *
 * Text types carry `charset=utf-8`: a preview's HTML/CSS/JS is utf-8 in practice and
 * a browser that guesses otherwise mangles it.
 *
 * @module platform/mime-types
 */

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav'
}

export const DEFAULT_CONTENT_TYPE = 'application/octet-stream'

/** The content type for `path` (either separator), else `application/octet-stream`. */
export function contentTypeForPath(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = name.lastIndexOf('.')
  // A leading dot is a hidden file's name (`.env`), not an extension.
  if (dot <= 0) return DEFAULT_CONTENT_TYPE
  return CONTENT_TYPES[name.slice(dot + 1).toLowerCase()] ?? DEFAULT_CONTENT_TYPE
}
