/**
 * `withSecurityHeaders` — the security headers every hub response carries.
 *
 * Pure Node (real ephemeral HTTP servers, a real temp `dist/web/` fixture, no
 * native deps). The same headers on a REAL spawned hub,
 * through every handler it has, are in security-headers-served.test.ts.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/hub/src/security-headers.test.ts
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, assert, expect, test } from 'vitest'
import { ENTRA_AUTHORITY } from '@slayzone/hub-auth/server'
import {
  API_CSP,
  ENTRA_SIGN_IN_ORIGIN,
  POSTHOG_ORIGINS,
  strictTransportSecurity,
  webShellCsp,
  withSecurityHeaders
} from './security-headers.js'
import { handleWebAssets } from './web-assets.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

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
  handler: Handler,
  telemetry = true
): Promise<{ base: string; close: () => Promise<void> }> {
  const srv = http.createServer(withSecurityHeaders(handler, { publicAddress, telemetry }))
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

test('HSTS only for an https (non-loopback) public address', () => {
  expect(strictTransportSecurity(undefined), 'no public address').toBe(null)
  for (const loopback of ['127.0.0.1:4100', 'localhost', '[::1]:8080']) {
    expect(strictTransportSecurity(loopback), loopback).toBe(null)
  }
  expect(strictTransportSecurity('hub.example.com'), 'https host').toBe('max-age=31536000')
  expect(strictTransportSecurity('10.0.0.5:8443'), 'https ip:port').toBe('max-age=31536000')
})

test('shell CSP: script only self, no eval, no inline script, no Convex', () => {
  for (const pub of [undefined, 'hub.example.com', '127.0.0.1:4100']) {
    const csp = webShellCsp(pub, true)
    expect(csp, `no unsafe-eval: ${csp}`).not.toContain('unsafe-eval')
    expect(csp, `no wasm-unsafe-eval: ${csp}`).not.toContain('wasm-unsafe-eval')
    expect(directive(csp, 'script-src')?.join(' '), 'script-src').toBe("'self'")
    expect(directive(csp, 'default-src')?.join(' '), 'default-src').toBe("'self'")
    expect(directive(csp, 'frame-ancestors')?.join(' '), 'frame-ancestors').toBe("'none'")
    expect(directive(csp, 'object-src')?.join(' '), 'object-src').toBe("'none'")
    expect(csp, `no Convex host: ${csp}`).not.toContain('convex')
    expect(csp, `no wildcard: ${csp}`).not.toContain('*')
    for (const origin of POSTHOG_ORIGINS) {
      expect(directive(csp, 'connect-src'), `connect-src has ${origin}`).toContain(origin)
    }
  }
})

test('shell CSP, telemetry off: no PostHog origin, nothing else changes', () => {
  for (const pub of [undefined, 'hub.example.com', '127.0.0.1:4100']) {
    const on = webShellCsp(pub, true)
    const off = webShellCsp(pub, false)
    const connect = directive(off, 'connect-src') ?? []
    for (const origin of POSTHOG_ORIGINS) {
      expect(connect, `connect-src without ${origin}`).not.toContain(origin)
    }
    expect(off, `no posthog anywhere: ${off}`).not.toContain('posthog')
    expect(connect, 'connect-src keeps self (+ the public ws)').toEqual(
      (directive(on, 'connect-src') ?? []).filter((src) => !POSTHOG_ORIGINS.includes(src))
    )
    // Every other directive is the telemetry-on policy, unchanged.
    const others = (csp: string): string[] =>
      csp
        .split(';')
        .map((d) => d.trim())
        .filter((d) => !d.startsWith('connect-src'))
    expect(others(off), 'other directives unchanged').toEqual(others(on))
  }
})

test('shell CSP: /trpc websocket derived from the public address only', () => {
  expect(
    directive(webShellCsp(undefined, true), 'connect-src')?.filter((s) => s.startsWith('ws'))
      .length,
    'no public address: self only'
  ).toBe(0)
  expect(
    directive(webShellCsp('hub.example.com', true), 'connect-src'),
    'https public address → wss'
  ).toContain('wss://hub.example.com')
  expect(
    directive(webShellCsp('127.0.0.1:4100', true), 'connect-src'),
    'loopback public address → ws'
  ).toContain('ws://127.0.0.1:4100')
})

test('shell CSP: the web sign-in chain needs no new source; form-action stays self + Entra (T-13)', () => {
  // "Sign in with Microsoft" is a LINK to /api/auth/web-sso: a top-level navigation,
  // which no directive governs, through Entra (wherever it hops) and back by the
  // hub's own callback. form-action would govern a form-based start's redirects: it
  // admits Entra's authorize origin and nothing else. The shell's session calls
  // (/health, /api/auth/web-session, /api/auth/web-logout, /api/auth/web-login) are
  // same-origin fetches under connect-src 'self'.
  expect(ENTRA_SIGN_IN_ORIGIN, 'the origin it redirects to').toEqual(
    new URL(ENTRA_AUTHORITY).origin
  )
  for (const pub of [undefined, 'hub.example.com', '127.0.0.1:4100']) {
    const csp = webShellCsp(pub, true)
    expect(
      directive(csp, 'form-action')?.join(' '),
      'form-action: self + Entra, nothing else'
    ).toEqual(`'self' ${ENTRA_SIGN_IN_ORIGIN}`)
    expect(directive(csp, 'connect-src')?.[0], 'connect-src self').toBe("'self'")
  }
})

test("the web shell build's default PostHog host is allowed", () => {
  // The CSP names PostHog's EU hosts; the web shell build names the host its
  // bundle reports to. Changing one without the other blocks telemetry silently.
  const vite = readFileSync(join(__dirname, '../../web-shell/vite.config.ts'), 'utf8')
  const m = vite.match(/env\.POSTHOG_HOST \?\? '([^']+)'/)
  assert(m, 'vite.config.ts names a default POSTHOG_HOST')
  expect(POSTHOG_ORIGINS, `${m[1]} in ${POSTHOG_ORIGINS.join(' ')}`).toContain(m[1])
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
const pubTelemetryOff = await serve('hub.example.com', withShell, false)
afterAll(async () => {
  await loop.close()
  await pub.close()
  await pubTelemetryOff.close()
  rmSync(webRoot, { recursive: true, force: true })
})

test('web shell document: shell CSP, revalidated, nosniff, DENY, same-origin', async () => {
  const r = await fetch(`${loop.base}/`)
  expect(r.headers.get('content-type'), 'content-type kept').toBe('text/html; charset=utf-8')
  expect(r.headers.get('cache-control'), 'index not cached long').toBe('no-cache')
  expect(r.headers.get('content-security-policy'), 'csp').toEqual(webShellCsp(undefined, true))
  expect(r.headers.get('x-content-type-options'), 'nosniff').toBe('nosniff')
  expect(r.headers.get('x-frame-options'), 'xfo').toBe('DENY')
  expect(r.headers.get('referrer-policy'), 'referrer').toBe('same-origin')
  expect(r.headers.get('strict-transport-security'), 'no HSTS on loopback').toBe(null)
})

test('hashed asset keeps immutable caching and gets the shell CSP', async () => {
  const r = await fetch(`${loop.base}/assets/index-abc123.js`)
  expect(r.headers.get('cache-control'), 'cache').toBe('public, max-age=31536000, immutable')
  expect(r.headers.get('content-security-policy'), 'csp').toEqual(webShellCsp(undefined, true))
})

test('a route keeps its own type and caching; security headers win', async () => {
  const r = await fetch(`${loop.base}/shell-explicit`)
  expect(r.headers.get('content-type'), 'content-type kept').toBe('text/plain')
  expect(r.headers.get('cache-control'), 'cache-control kept').toBe('private, max-age=60')
  expect(r.headers.get('content-security-policy'), 'csp wins').toEqual(webShellCsp(undefined, true))
  expect(r.headers.get('x-frame-options'), 'xfo wins').toBe('DENY')
})

test('implicit header: no-store default, x-powered-by removed', async () => {
  const r = await fetch(`${loop.base}/shell-implicit`)
  expect(r.headers.get('cache-control'), 'default cache-control').toBe('no-store')
  expect(r.headers.get('x-powered-by'), 'x-powered-by removed').toBe(null)
  expect(r.headers.get('x-content-type-options'), 'nosniff').toBe('nosniff')
})

test('array headers: duplicates kept, forced header replaced', async () => {
  const r = await fetch(`${loop.base}/shell-array`)
  expect(r.headers.getSetCookie().join(','), 'both cookies').toBe('a=1,b=2')
  expect(r.headers.get('referrer-policy'), 'referrer wins').toBe('same-origin')
})

test('API paths: no-store wins, API CSP, also on 404s and odd spellings', async () => {
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
    expect(r.headers.get('cache-control'), `${path} cache-control`).toBe('no-store')
    expect(r.headers.get('content-security-policy'), `${path} csp`).toEqual(API_CSP)
    expect(r.headers.get('x-content-type-options'), `${path} nosniff`).toBe('nosniff')
    expect(r.headers.get('x-frame-options'), `${path} xfo`).toBe('DENY')
  }
  const head = await fetch(`${loop.base}/api/nope`, { method: 'HEAD' })
  expect(head.headers.get('cache-control'), 'HEAD too').toBe('no-store')
})

test('a 404 outside the API: shell CSP and no-store', async () => {
  const r = await fetch(`${loop.base}/`, { method: 'POST' })
  expect(r.status, 'status').toBe(404)
  expect(r.headers.get('cache-control'), 'cache-control').toBe('no-store')
  expect(r.headers.get('content-security-policy'), 'csp').toEqual(webShellCsp(undefined, true))
})

test('https public address: HSTS on every response', async () => {
  for (const path of ['/', '/assets/index-abc123.js', '/api/nope', '/health']) {
    const r = await fetch(`${pub.base}${path}`)
    expect(r.headers.get('strict-transport-security'), path).toBe('max-age=31536000')
  }
  const doc = await fetch(`${pub.base}/`)
  expect(doc.headers.get('content-security-policy'), 'csp').toEqual(
    webShellCsp('hub.example.com', true)
  )
})

test('telemetry off: every shell response blocks PostHog, the API policy is unchanged', async () => {
  for (const path of ['/', '/assets/index-abc123.js', '/shell-explicit', '/shell-implicit']) {
    const r = await fetch(`${pubTelemetryOff.base}${path}`)
    const csp = r.headers.get('content-security-policy') ?? ''
    expect(csp, `${path} csp`).toEqual(webShellCsp('hub.example.com', false))
    for (const origin of POSTHOG_ORIGINS) {
      expect(directive(csp, 'connect-src'), `${path} blocks ${origin}`).not.toContain(origin)
    }
  }
  const api = await fetch(`${pubTelemetryOff.base}/api/nope`)
  expect(api.headers.get('content-security-policy'), 'API csp').toEqual(API_CSP)
})

test('telemetry on: the shell response allows PostHog', async () => {
  const r = await fetch(`${pub.base}/`)
  const connect = directive(r.headers.get('content-security-policy') ?? '', 'connect-src')
  for (const origin of POSTHOG_ORIGINS) expect(connect, origin).toContain(origin)
})
