/**
 * `handleWebAssets` — the web shell's static-asset + SPA-fallback serving.
 *
 * Pure Node (real ephemeral HTTP servers + a real temp `dist/web/` fixture,
 * no native deps).
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/hub/src/web-assets.test.ts
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { handleWebAssets } from './web-assets.js'

/** A real `dist/web/` fixture: index.html + one hashed asset. */
function makeWebRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'slz-web-assets-'))
  mkdirSync(join(root, 'assets'), { recursive: true })
  writeFileSync(join(root, 'index.html'), '<!doctype html><body>shell</body>')
  writeFileSync(join(root, 'assets', 'index-abc123.js'), 'console.log(1)')
  return root
}

async function startServer(webRoot: string | null): Promise<{
  port: number
  close: () => Promise<void>
}> {
  const srv = http.createServer((req, res) => {
    if (webRoot && handleWebAssets(webRoot, req, res)) return
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()))
  const port = (srv.address() as AddressInfo).port
  return { port, close: () => new Promise((r) => srv.close(() => r())) }
}

async function get(
  port: number,
  path: string,
  init?: RequestInit
): Promise<{ status: number; body: string; headers: Headers }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init)
  return { status: res.status, body: await res.text(), headers: res.headers }
}

test('serves a real /assets/* file with long immutable cache', async () => {
  const root = makeWebRoot()
  const srv = await startServer(root)
  try {
    const { status, body, headers } = await get(srv.port, '/assets/index-abc123.js')
    expect(status, 'status').toBe(200)
    expect(body, 'body').toBe('console.log(1)')
    expect(headers.get('content-type'), 'content-type').toBe('text/javascript; charset=utf-8')
    expect(headers.get('cache-control'), 'long cache on a real asset').toBe(
      'public, max-age=31536000, immutable'
    )
  } finally {
    await srv.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('SPA-falls-back an unclaimed path to index.html, no-cache', async () => {
  const root = makeWebRoot()
  const srv = await startServer(root)
  try {
    const { status, body, headers } = await get(srv.port, '/tasks/abc-123')
    expect(status, 'status').toBe(200)
    expect(body, 'served index.html body').toContain('shell')
    expect(headers.get('cache-control'), 'shell must revalidate').toBe('no-cache')
  } finally {
    await srv.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('"/" itself serves index.html', async () => {
  const root = makeWebRoot()
  const srv = await startServer(root)
  try {
    const { status, body } = await get(srv.port, '/')
    expect(status, 'status').toBe(200)
    expect(body, 'served index.html body').toContain('shell')
  } finally {
    await srv.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a NONEXISTENT /assets/* path falls back to the shell, not a 404 leak', async () => {
  // A stale cached reference to a since-removed hashed file must still land
  // on the SPA shell (which will fetch the CURRENT manifest), not a raw 404.
  const root = makeWebRoot()
  const srv = await startServer(root)
  try {
    const { status, body } = await get(srv.port, '/assets/removed-xyz.js')
    expect(status, 'falls back to 200, not 404').toBe(200)
    expect(body, 'served index.html body').toContain('shell')
  } finally {
    await srv.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('never claims /api, /mcp, /trpc, /computers, or /health', async () => {
  const root = makeWebRoot()
  const srv = await startServer(root)
  try {
    for (const path of ['/api/tasks', '/mcp', '/trpc', '/computers', '/health']) {
      const { status, body } = await get(srv.port, path)
      expect(status, `${path} falls through to the caller's own handler`).toBe(404)
      expect(body, `${path} did not get the SPA shell`).toBe('not found')
    }
  } finally {
    await srv.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('non-GET/HEAD is never claimed', async () => {
  const root = makeWebRoot()
  const srv = await startServer(root)
  try {
    const { status } = await get(srv.port, '/', { method: 'POST' })
    expect(status, 'POST falls through').toBe(404)
  } finally {
    await srv.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('HEAD gets headers with no body', async () => {
  const root = makeWebRoot()
  const srv = await startServer(root)
  try {
    const { status, body, headers } = await get(srv.port, '/assets/index-abc123.js', {
      method: 'HEAD'
    })
    expect(status, 'status').toBe(200)
    expect(body, 'no body on HEAD').toBe('')
    expect(headers.get('content-type'), 'content-type still set').toBe(
      'text/javascript; charset=utf-8'
    )
  } finally {
    await srv.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a webRoot with no dist/web/ (no index.html) is never claimed — falls through cleanly', async () => {
  const emptyRoot = mkdtempSync(join(tmpdir(), 'slz-web-assets-empty-'))
  const srv = await startServer(emptyRoot)
  try {
    const { status, body } = await get(srv.port, '/')
    expect(status, 'falls through to the caller — never fails boot').toBe(404)
    expect(body, 'unclaimed, not a broken empty response').toBe('not found')
  } finally {
    await srv.close()
    rmSync(emptyRoot, { recursive: true, force: true })
  }
})

test('path traversal cannot escape webRoot', async () => {
  // A deterministic escape distance, not a guess at the host's tmpdir depth:
  // webRoot and secretDir are SIBLINGS under the same parent, so exactly
  // "../../<secretDir's own name>/secret.txt" (one `..` to leave `assets/`,
  // one more to leave webRoot itself, landing on the shared parent) is the
  // precise, minimal traversal that would reach it if this were unsafe —
  // no dependence on how deep the OS's real tmpdir happens to be.
  const parent = mkdtempSync(join(tmpdir(), 'slz-web-assets-parent-'))
  const root = join(parent, 'web-root')
  mkdirSync(join(root, 'assets'), { recursive: true })
  writeFileSync(join(root, 'index.html'), '<!doctype html><body>shell</body>')
  const secretDirName = 'secret-sibling'
  mkdirSync(join(parent, secretDirName))
  writeFileSync(join(parent, secretDirName, 'secret.txt'), 'do not serve me')

  const srv = await startServer(root)
  try {
    // %2e%2e%2f so the traversal survives fetch's own URL parsing and
    // reaches handleWebAssets as raw `..%2f` in req.url, exactly as a
    // browser would deliver an encoded request line.
    const escapeAttempt = `/assets/%2e%2e%2f%2e%2e%2f${secretDirName}/secret.txt`
    const { status, body } = await get(srv.port, escapeAttempt)
    // Must fall back to the SPA shell (normalize stripped the `..`s before
    // webRoot ever entered the picture) — never the secret file's content,
    // and never a raw filesystem error either.
    expect(status, 'falls back to the shell, not a crash').toBe(200)
    expect(body, 'served index.html, not the secret file').toContain('shell')
    expect(body, 'secret file contents must never be served').not.toContain('do not serve me')
  } finally {
    await srv.close()
    rmSync(parent, { recursive: true, force: true })
  }
})
