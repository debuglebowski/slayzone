/**
 * The browser-page guard as wired into a REAL hub (review 3 HIGH 1): it covers every
 * path express can route — upper-case, mixed-case, trailing slash, doubled slashes,
 * encoded separators — because it classifies with the same key express routes by and
 * FAILS CLOSED (every path except an explicit public allow-list). And native clients
 * reach the hub under any name (MEDIUM 4).
 *
 * In-process, desktop shape (login off, supervised), isolated SLAYZONE_ROOT.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { request } from 'node:http'
import { bootInProcessHub, type InProcessHub } from './owner-checks-harness'

let hub: InProcessHub
beforeAll(async () => {
  hub = await bootInProcessHub({ login: false })
}, 60_000)
afterAll(() => hub?.stop())

function send(
  path: string,
  headers: Record<string, string>,
  method = 'POST'
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request(
      {
        host: '127.0.0.1',
        port: hub.port,
        path,
        method,
        headers: { 'content-type': 'application/json', ...headers }
      },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      }
    )
    r.on('error', reject)
    r.end(method === 'GET' ? undefined : '{}')
  })
}

const panel = { 'x-slayzone-browser-panel': '1', 'sec-fetch-site': 'same-origin' }
const rebound = {
  host: 'attacker.test:51100',
  origin: 'http://attacker.test:51100',
  'sec-fetch-site': 'same-origin'
}

describe('every routable spelling of the API is guarded', () => {
  for (const path of [
    '/api/projects',
    '/API/projects',
    '/Api/Projects/',
    '//api//projects',
    '/api/./projects',
    '/api%2fprojects',
    '/MCP',
    '/Mcp/',
    '/trpc',
    '/'
  ]) {
    test(`${path}: a panel page is refused`, async () => {
      const r = await send(path, panel)
      expect(r.status, r.body).toBe(403)
      expect(r.body).toMatch(/browser panel/)
    })
    test(`${path}: a rebound hostname from a browser is refused`, async () => {
      const r = await send(path, rebound)
      expect(r.status, r.body).toBe(403)
      expect(r.body).toMatch(/attacker\.test/)
    })
  }
})

describe('native clients under any name keep working (no fetch metadata, no Origin)', () => {
  for (const host of [
    'mymac.local:51100',
    'hub.tailnet.ts.net',
    'localhost.:51100',
    'proxy-rewritten'
  ]) {
    test(`Host: ${host}`, async () => {
      const r = await send('/api/projects', { host }, 'GET')
      expect(r.status, r.body).not.toBe(403)
    })
  }
})

test('/health stays public', async () => {
  const r = await send('/health', panel, 'GET')
  expect(r.status).toBe(200)
})
