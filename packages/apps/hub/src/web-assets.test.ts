/**
 * `handleWebAssets` — the web shell's static-asset + SPA-fallback serving.
 *
 * Pure Node (real ephemeral HTTP servers + a real temp `dist/web/` fixture,
 * no native deps) → runs under plain `npx tsx`.
 *
 * Run with: npx tsx packages/apps/hub/src/web-assets.test.ts
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleWebAssets } from './web-assets.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => Promise<void>): Promise<void> {
  return fn()
    .then(() => {
      console.log(`  ✓ ${name}`)
      passed++
    })
    .catch((e) => {
      console.error(`  ✗ ${name}`)
      console.error(`    ${e instanceof Error ? e.message : e}`)
      failed++
    })
}

function assertEq(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected)
    throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`)
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

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

async function main(): Promise<void> {
  console.log('\nhandleWebAssets\n')

  await test('serves a real /assets/* file with long immutable cache', async () => {
    const root = makeWebRoot()
    const srv = await startServer(root)
    try {
      const { status, body, headers } = await get(srv.port, '/assets/index-abc123.js')
      assertEq(status, 200, 'status')
      assertEq(body, 'console.log(1)', 'body')
      assertEq(headers.get('content-type'), 'text/javascript; charset=utf-8', 'content-type')
      assertEq(
        headers.get('cache-control'),
        'public, max-age=31536000, immutable',
        'long cache on a real asset'
      )
    } finally {
      await srv.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  await test('SPA-falls-back an unclaimed path to index.html, no-cache', async () => {
    const root = makeWebRoot()
    const srv = await startServer(root)
    try {
      const { status, body, headers } = await get(srv.port, '/tasks/abc-123')
      assertEq(status, 200, 'status')
      assert(body.includes('shell'), 'served index.html body')
      assertEq(headers.get('cache-control'), 'no-cache', 'shell must revalidate')
    } finally {
      await srv.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  await test('"/" itself serves index.html', async () => {
    const root = makeWebRoot()
    const srv = await startServer(root)
    try {
      const { status, body } = await get(srv.port, '/')
      assertEq(status, 200, 'status')
      assert(body.includes('shell'), 'served index.html body')
    } finally {
      await srv.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  await test('a NONEXISTENT /assets/* path falls back to the shell, not a 404 leak', async () => {
    // A stale cached reference to a since-removed hashed file must still land
    // on the SPA shell (which will fetch the CURRENT manifest), not a raw 404.
    const root = makeWebRoot()
    const srv = await startServer(root)
    try {
      const { status, body } = await get(srv.port, '/assets/removed-xyz.js')
      assertEq(status, 200, 'falls back to 200, not 404')
      assert(body.includes('shell'), 'served index.html body')
    } finally {
      await srv.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  await test('never claims /api, /mcp, /trpc, /computers, or /health', async () => {
    const root = makeWebRoot()
    const srv = await startServer(root)
    try {
      for (const path of ['/api/tasks', '/mcp', '/trpc', '/computers', '/health']) {
        const { status, body } = await get(srv.port, path)
        assertEq(status, 404, `${path} falls through to the caller's own handler`)
        assertEq(body, 'not found', `${path} did not get the SPA shell`)
      }
    } finally {
      await srv.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  await test('non-GET/HEAD is never claimed', async () => {
    const root = makeWebRoot()
    const srv = await startServer(root)
    try {
      const { status } = await get(srv.port, '/', { method: 'POST' })
      assertEq(status, 404, 'POST falls through')
    } finally {
      await srv.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  await test('HEAD gets headers with no body', async () => {
    const root = makeWebRoot()
    const srv = await startServer(root)
    try {
      const { status, body, headers } = await get(srv.port, '/assets/index-abc123.js', {
        method: 'HEAD'
      })
      assertEq(status, 200, 'status')
      assertEq(body, '', 'no body on HEAD')
      assertEq(
        headers.get('content-type'),
        'text/javascript; charset=utf-8',
        'content-type still set'
      )
    } finally {
      await srv.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  await test('a webRoot with no dist/web/ (no index.html) is never claimed — falls through cleanly', async () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'slz-web-assets-empty-'))
    const srv = await startServer(emptyRoot)
    try {
      const { status, body } = await get(srv.port, '/')
      assertEq(status, 404, 'falls through to the caller — never fails boot')
      assertEq(body, 'not found', 'unclaimed, not a broken empty response')
    } finally {
      await srv.close()
      rmSync(emptyRoot, { recursive: true, force: true })
    }
  })

  await test('path traversal cannot escape webRoot', async () => {
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
      assertEq(status, 200, 'falls back to the shell, not a crash')
      assert(body.includes('shell'), 'served index.html, not the secret file')
      assert(!body.includes('do not serve me'), 'secret file contents must never be served')
    } finally {
      await srv.close()
      rmSync(parent, { recursive: true, force: true })
    }
  })

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

void main()
