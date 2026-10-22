/**
 * `withSecurityHeaders` — the security headers every hub response carries.
 *
 * Pure Node (real ephemeral HTTP servers, a real temp `dist/web/` fixture, no
 * native deps) → runs under plain `npx tsx`. The same headers on a REAL spawned hub,
 * through every handler it has, are in security-headers-served.test.ts.
 *
 * Run with: npx tsx packages/apps/hub/src/security-headers.test.ts
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  API_CSP,
  POSTHOG_ORIGINS,
  strictTransportSecurity,
  webShellCsp,
  withSecurityHeaders
} from './security-headers.js'
import { handleWebAssets } from './web-assets.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? e.message : e}`)
    failed++
  }
}

function assertEq(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected)
    throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`)
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

/** One directive's sources, e.g. `directive(csp, 'connect-src')`. */
function directive(csp: string, name: string): string[] | null {
  for (const part of csp.split(';')) {
    const [n, ...sources] = part.trim().split(/\s+/)
    if (n === name) return sources
  }
  return null
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void

async function serve(
  publicAddress: string | undefined,
  handler: Handler
): Promise<{ base: string; close: () => Promise<void> }> {
  const srv = http.createServer(withSecurityHeaders(handler, { publicAddress }))
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()))
  const port = (srv.address() as AddressInfo).port
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => srv.close(() => r()))
  }
}

/** Routes that write their headers every way a hub handler does. */
const routes: Handler = (req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  if (path === '/shell-explicit') {
    // A route that sets its own type + caching (kept) and its own CSP/XFO (overridden).
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Cache-Control': 'private, max-age=60',
      'Content-Security-Policy': "default-src *; script-src 'unsafe-inline'",
      'X-Frame-Options': 'SAMEORIGIN'
    })
    res.end('ok')
    return
  }
  if (path === '/shell-implicit') {
    // setHeader + end: Node writes the header implicitly.
    res.setHeader('content-type', 'text/plain')
    res.setHeader('x-powered-by', 'Express')
    res.end('ok')
    return
  }
  if (path === '/shell-array') {
    res.writeHead(200, [
      'content-type',
      'text/plain',
      'set-cookie',
      'a=1',
      'set-cookie',
      'b=2',
      'referrer-policy',
      'unsafe-url'
    ])
    res.end('ok')
    return
  }
  if (path === '/api/stream') {
    // Like pty/follow.ts: an API route asking for `no-cache` gets `no-store`.
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.flushHeaders()
    res.end()
    return
  }
  res.statusCode = 404
  res.end(JSON.stringify({ error: 'Not found' }))
}

async function main(): Promise<void> {
  console.log('\nsecurity headers\n')

  await test('HSTS only for an https (non-loopback) public address', () => {
    assertEq(strictTransportSecurity(undefined), null, 'no public address')
    for (const loopback of ['127.0.0.1:4100', 'localhost', '[::1]:8080']) {
      assertEq(strictTransportSecurity(loopback), null, loopback)
    }
    assertEq(strictTransportSecurity('hub.example.com'), 'max-age=31536000', 'https host')
    assertEq(strictTransportSecurity('10.0.0.5:8443'), 'max-age=31536000', 'https ip:port')
  })

  await test('shell CSP: script only self, no eval, no inline script, no Convex', () => {
    for (const pub of [undefined, 'hub.example.com', '127.0.0.1:4100']) {
      const csp = webShellCsp(pub)
      assert(!csp.includes('unsafe-eval'), `no unsafe-eval: ${csp}`)
      assert(!csp.includes('wasm-unsafe-eval'), `no wasm-unsafe-eval: ${csp}`)
      assertEq(directive(csp, 'script-src')?.join(' '), "'self'", 'script-src')
      assertEq(directive(csp, 'default-src')?.join(' '), "'self'", 'default-src')
      assertEq(directive(csp, 'frame-ancestors')?.join(' '), "'none'", 'frame-ancestors')
      assertEq(directive(csp, 'object-src')?.join(' '), "'none'", 'object-src')
      assert(!csp.includes('convex'), `no Convex host: ${csp}`)
      assert(!csp.includes('*'), `no wildcard: ${csp}`)
      for (const origin of POSTHOG_ORIGINS) {
        assert(directive(csp, 'connect-src')?.includes(origin), `connect-src has ${origin}`)
      }
    }
  })

  await test('shell CSP: /trpc websocket derived from the public address only', () => {
    assertEq(
      directive(webShellCsp(undefined), 'connect-src')?.filter((s) => s.startsWith('ws')).length,
      0,
      'no public address: self only'
    )
    assert(
      directive(webShellCsp('hub.example.com'), 'connect-src')?.includes('wss://hub.example.com'),
      'https public address → wss'
    )
    assert(
      directive(webShellCsp('127.0.0.1:4100'), 'connect-src')?.includes('ws://127.0.0.1:4100'),
      'loopback public address → ws'
    )
  })

  await test("the web shell build's default PostHog host is allowed", () => {
    // The CSP names PostHog's EU hosts; the web shell build names the host its
    // bundle reports to. Changing one without the other blocks telemetry silently.
    const vite = readFileSync(join(__dirname, '../../web-shell/vite.config.ts'), 'utf8')
    const m = vite.match(/env\.POSTHOG_HOST \?\? '([^']+)'/)
    assert(m, 'vite.config.ts names a default POSTHOG_HOST')
    assert(POSTHOG_ORIGINS.includes(m![1]), `${m![1]} in ${POSTHOG_ORIGINS.join(' ')}`)
  })

  const webRoot = mkdtempSync(join(tmpdir(), 'slz-security-headers-'))
  mkdirSync(join(webRoot, 'assets'), { recursive: true })
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><body>shell</body>')
  writeFileSync(join(webRoot, 'assets', 'index-abc123.js'), 'console.log(1)')
  // The test routes first (the SPA fallback would claim any GET), then the shell.
  const withShell: Handler = (req, res) => {
    if (req.url?.startsWith('/shell-') || req.url?.startsWith('/api/stream')) routes(req, res)
    else if (!handleWebAssets(webRoot, req, res)) routes(req, res)
  }

  const loop = await serve(undefined, withShell)
  const pub = await serve('hub.example.com', withShell)
  try {
    await test('web shell document: shell CSP, revalidated, nosniff, DENY, same-origin', async () => {
      const r = await fetch(`${loop.base}/`)
      assertEq(r.headers.get('content-type'), 'text/html; charset=utf-8', 'content-type kept')
      assertEq(r.headers.get('cache-control'), 'no-cache', 'index not cached long')
      assertEq(r.headers.get('content-security-policy'), webShellCsp(undefined), 'csp')
      assertEq(r.headers.get('x-content-type-options'), 'nosniff', 'nosniff')
      assertEq(r.headers.get('x-frame-options'), 'DENY', 'xfo')
      assertEq(r.headers.get('referrer-policy'), 'same-origin', 'referrer')
      assertEq(r.headers.get('strict-transport-security'), null, 'no HSTS on loopback')
    })

    await test('hashed asset keeps immutable caching and gets the shell CSP', async () => {
      const r = await fetch(`${loop.base}/assets/index-abc123.js`)
      assertEq(r.headers.get('cache-control'), 'public, max-age=31536000, immutable', 'cache')
      assertEq(r.headers.get('content-security-policy'), webShellCsp(undefined), 'csp')
    })

    await test('a route keeps its own type and caching; security headers win', async () => {
      const r = await fetch(`${loop.base}/shell-explicit`)
      assertEq(r.headers.get('content-type'), 'text/plain', 'content-type kept')
      assertEq(r.headers.get('cache-control'), 'private, max-age=60', 'cache-control kept')
      assertEq(r.headers.get('content-security-policy'), webShellCsp(undefined), 'csp wins')
      assertEq(r.headers.get('x-frame-options'), 'DENY', 'xfo wins')
    })

    await test('implicit header: no-store default, x-powered-by removed', async () => {
      const r = await fetch(`${loop.base}/shell-implicit`)
      assertEq(r.headers.get('cache-control'), 'no-store', 'default cache-control')
      assertEq(r.headers.get('x-powered-by'), null, 'x-powered-by removed')
      assertEq(r.headers.get('x-content-type-options'), 'nosniff', 'nosniff')
    })

    await test('array headers: duplicates kept, forced header replaced', async () => {
      const r = await fetch(`${loop.base}/shell-array`)
      assertEq(r.headers.getSetCookie().join(','), 'a=1,b=2', 'both cookies')
      assertEq(r.headers.get('referrer-policy'), 'same-origin', 'referrer wins')
    })

    await test('API paths: no-store wins, API CSP, also on 404s and odd spellings', async () => {
      for (const path of [
        '/api/stream',
        '/api/nope',
        '/health',
        '/trpc',
        '/mcp',
        '/computers',
        '/%61pi/nope'
      ]) {
        const r = await fetch(`${loop.base}${path}`)
        assertEq(r.headers.get('cache-control'), 'no-store', `${path} cache-control`)
        assertEq(r.headers.get('content-security-policy'), API_CSP, `${path} csp`)
        assertEq(r.headers.get('x-content-type-options'), 'nosniff', `${path} nosniff`)
        assertEq(r.headers.get('x-frame-options'), 'DENY', `${path} xfo`)
      }
      const head = await fetch(`${loop.base}/api/nope`, { method: 'HEAD' })
      assertEq(head.headers.get('cache-control'), 'no-store', 'HEAD too')
    })

    await test('a 404 outside the API: shell CSP and no-store', async () => {
      const r = await fetch(`${loop.base}/`, { method: 'POST' })
      assertEq(r.status, 404, 'status')
      assertEq(r.headers.get('cache-control'), 'no-store', 'cache-control')
      assertEq(r.headers.get('content-security-policy'), webShellCsp(undefined), 'csp')
    })

    await test('https public address: HSTS on every response', async () => {
      for (const path of ['/', '/assets/index-abc123.js', '/api/nope', '/health']) {
        const r = await fetch(`${pub.base}${path}`)
        assertEq(r.headers.get('strict-transport-security'), 'max-age=31536000', path)
      }
      const doc = await fetch(`${pub.base}/`)
      assertEq(doc.headers.get('content-security-policy'), webShellCsp('hub.example.com'), 'csp')
    })
  } finally {
    await loop.close()
    await pub.close()
    rmSync(webRoot, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

void main()
