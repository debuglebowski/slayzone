/**
 * Compressed request bodies are refused (GHSA-27r3-jxmh-p828).
 *
 * body-parser < 2.4.0 pipes a `Content-Encoding` body into a decompression stream and,
 * once it has read the body, leaves that stream piped with no error listener: a valid
 * compressed frame followed by trailing bytes decodes, the route answers, and the
 * trailing bytes then error on the finished decoder — an uncaught exception that kills
 * the hub. No client of ours compresses a request body (notify.sh's curl/wget, the
 * `slay` CLI's fetch, MCP clients, the web shell), so every JSON parser is built with
 * `inflate: false` (`jsonBodyParser`) and answers such a request 415 before any
 * decoder exists. This drives the REAL `createMcpRestApp` (`/mcp`, `/api/agent-hook`,
 * a plain REST route) with the advisory's payload, then checks the process survived
 * and still serves an ordinary request; and that no source file builds an Express body
 * parser any other way.
 *
 * Native ABI (the harness DB is better-sqlite3 built for Electron) → Electron strict
 * loader, hand-rolled harness.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *     --experimental-loader ./packages/shared/test-utils/loader.ts \
 *     packages/shared/transport/src/server/http/json-body.test.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, relative, resolve, sep } from 'node:path'
import { deflateSync, gzipSync } from 'node:zlib'
import { createTestHarness } from '../../../../test-utils/ipc-harness.js'
import { createMcpRestApp } from './mcp-server'

let passed = 0
let failed = 0
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    failed++
  }
}
function assertEq(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

// Any uncaught exception is the crash under test: record it instead of dying, so the
// failing case is reported rather than taking the run down with it.
const uncaught: unknown[] = []
process.on('uncaughtException', (err) => void uncaught.push(err))

/** One valid compressed frame, then trailing bytes (the advisory's payload). */
function withTrailingBytes(frame: Buffer): Buffer {
  return Buffer.concat([frame, Buffer.from([0x00]), Buffer.alloc(100 * 1024, 0x58)])
}

function post(
  port: number,
  path: string,
  body: Buffer,
  headers: Record<string, string>
): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path,
        agent: false,
        headers: { ...headers, 'content-length': String(body.length) }
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => (data += c))
        // Let the trailing bytes reach a finished decoder before answering.
        res.on('end', () =>
          setTimeout(() => done({ status: res.statusCode ?? 0, body: data }), 200)
        )
      }
    )
    req.on('error', fail)
    req.end(body)
  })
}

const harness = await createTestHarness()
const mcpRest = createMcpRestApp({ db: harness.slayDb, notifyRenderer: () => undefined })
const server: Server = createServer(mcpRest.app)
await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
const port = (server.address() as AddressInfo).port
const json = { 'content-type': 'application/json' }
const initialize = Buffer.from(
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 't', version: '1' }
    }
  })
)

console.log('compressed request bodies')

for (const [encoding, compress] of [
  ['gzip', gzipSync],
  ['deflate', deflateSync]
] as const) {
  for (const path of ['/mcp', '/api/agent-hook', '/api/tasks']) {
    await test(`${encoding} + trailing bytes on ${path} → 415, process survives`, async () => {
      const res = await post(port, path, withTrailingBytes(compress(initialize)), {
        ...json,
        accept: 'application/json, text/event-stream',
        'content-encoding': encoding
      })
      assertEq(res.status, 415, 'status')
      assertEq(uncaught.length, 0, `uncaught exceptions (${String(uncaught[0])})`)
    })
  }
}

await test('an uncompressed request still parses afterwards', async () => {
  const res = await post(port, '/mcp', initialize, {
    ...json,
    accept: 'application/json, text/event-stream'
  })
  assertEq(res.status, 200, `status (${res.body.slice(0, 200)})`)
  assertEq(uncaught.length, 0, 'uncaught exceptions')
})

console.log('per-route body size limits')

/** A JSON object of roughly `bytes` bytes. */
function jsonOfSize(bytes: number): Buffer {
  return Buffer.from(JSON.stringify({ hook_event_name: 'SessionStart', pad: 'x'.repeat(bytes) }))
}

await test('/api/agent-hook takes a body over 100 KB (its limit is 1 MB)', async () => {
  // SessionStart payloads can carry the full tool list; the app-wide 100 KB parser
  // used to answer 413 before the route's own 1 MB parser ever ran.
  const res = await post(port, '/api/agent-hook', jsonOfSize(300 * 1024), json)
  assertEq(res.status === 413, false, `status ${res.status} (${res.body.slice(0, 120)})`)
})

await test('/api/agent-hook still refuses a body over 1 MB', async () => {
  const res = await post(port, '/api/agent-hook', jsonOfSize(1100 * 1024), json)
  assertEq(res.status, 413, 'status')
})

await test('other routes keep the 100 KB default', async () => {
  const res = await post(port, '/api/tasks', jsonOfSize(300 * 1024), json)
  assertEq(res.status, 413, 'status')
})

console.log('one way to build a body parser')

await test('no source file builds an Express body parser except json-body.ts', () => {
  const packagesDir = resolve(import.meta.dirname, '../../../../..')
  const parserCall = /\b(?:express|bodyParser)\.(?:json|urlencoded|raw|text)\s*\(/
  const offenders: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'out' || name === 'dist' || name.startsWith('.')) {
        continue
      }
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(name)) continue
      if (/\.test\.[a-z]+$/.test(name) || name === 'json-body.ts') continue
      if (full.includes(`${sep}test-utils${sep}`) || full.includes(`${sep}test${sep}`)) continue
      const lines = readFileSync(full, 'utf8').split('\n')
      lines.forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '')
        if (/^\s*\*/.test(code)) return
        if (parserCall.test(code)) offenders.push(`${relative(packagesDir, full)}:${i + 1}`)
      })
    }
  }
  walk(packagesDir)
  assertEq(offenders.join(', '), '', 'body parsers built outside jsonBodyParser')
})

mcpRest.dispose()
await new Promise<void>((closed) => server.close(() => closed()))
harness.cleanup()

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
