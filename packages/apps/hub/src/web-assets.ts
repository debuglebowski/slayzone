/**
 * Static-asset + SPA-fallback serving for the web shell (`@slayzone/web-shell`,
 * built into `dist/web/` alongside this package's own `bin.cjs`).
 *
 * Mirrors `health.ts`'s shape deliberately: a pure `handle*(req, res): boolean`
 * function, unit-tested with real HTTP servers, no framework.
 *
 * DELIBERATELY UNGATED. This runs for every GET/HEAD whose path is not `/api`,
 * `/mcp`, `/trpc`, `/computers`, or `/health` — regardless of `hubAuthRequired`.
 * `restAuthAction` (rest-auth.ts) already resolves every such path to `'allow'`
 * unconditionally; it only ever gates `/api/*` + `/mcp`. That is not incidental
 * here — the shell IS the login screen (`LoginScreen.tsx` POSTs to
 * `/api/auth/web-login`, itself bootstrap-exempt), so it must be reachable with
 * no credential at all or a browser could never get far enough to sign in.
 *
 * @module server/web-assets
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm'
}

/**
 * Paths owned by other handlers in the dispatch chain. Never claimed here —
 * even when `dist/web/` is absent, so those still answer exactly as they did
 * before this shipped rather than falling through to the SPA shell.
 */
const RESERVED_PATHS = ['/api', '/mcp', '/trpc', '/computers', '/health']

function isReserved(pathname: string): boolean {
  return RESERVED_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

function decodeUriSafe(path: string): string {
  try {
    return decodeURIComponent(path)
  } catch {
    // A malformed escape can't name a real file either way — fall through to
    // the (still-safe) raw string rather than 500ing a GET.
    return path
  }
}

/**
 * Serve `dist/web/assets/*` with a long, immutable cache lifetime (Vite
 * content-hashes every filename under `assets/`, so a stale cached copy is
 * never served under the name a fresh build would use) and everything else
 * — including "/" itself and any client-side route the SPA owns — as the
 * `index.html` shell, revalidated on every request.
 *
 * `webRoot` with no `index.html` (dev, or a build that skipped the web
 * bundle) → returns false without touching `res` at all, so the caller's
 * existing fallback (today, `mcpRest.app`'s own 404) answers unchanged. Never
 * throws, never fails boot — `server.ts` calls this unconditionally.
 */
export function handleWebAssets(
  webRoot: string,
  req: IncomingMessage,
  res: ServerResponse
): boolean {
  const method = req.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') return false
  const pathname = decodeUriSafe((req.url ?? '/').split('?')[0])
  if (isReserved(pathname)) return false

  const indexPath = join(webRoot, 'index.html')
  if (!existsSync(indexPath)) return false

  // Normalize the UNTRUSTED pathname ALONE, before it ever touches webRoot.
  // `path.normalize` on an absolute ("/"-leading) string resolves every `..`
  // it can and drops any excess ones at the leading "/" (it never goes
  // negative) — so this step strips every `..` out of `relative` by itself.
  // By the time `join(webRoot, relative)` runs there is nothing left for it
  // to traverse WITH: `join` re-normalizes the concatenation, but a string
  // with no `..` segments in it can only ever land as a (possibly
  // nonexistent) path NESTED under webRoot, never outside it. Normalizing
  // webRoot+relative TOGETHER in one shot instead would be the unsafe
  // version — a `..` count large enough to first cancel webRoot's own
  // segments and then descend into an unrelated absolute path is exactly a
  // real escape, and IS what this two-step order exists to prevent.
  const relative = normalize(pathname)
  const candidate = join(webRoot, relative)
  const isAsset =
    relative.startsWith('/assets/') && existsSync(candidate) && statSync(candidate).isFile()

  const target = isAsset ? candidate : indexPath
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream',
    'cache-control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache'
  })
  if (method === 'HEAD') {
    res.end()
    return true
  }
  createReadStream(target).pipe(res)
  return true
}
