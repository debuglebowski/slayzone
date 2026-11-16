/**
 * The browser-page guard as wired into a REAL hub (review 3 HIGH 1): it covers every
 * path express can route — upper-case, mixed-case, trailing slash, doubled slashes,
 * encoded separators — because it classifies with the same key express routes by and
 * FAILS CLOSED (every path except an explicit public allow-list).
 *
 * DNS rebinding as a browser really sends it (review 4 MEDIUM 4): a same-origin GET
 * over http carries Host and nothing else — no Origin, no Sec-Fetch-* (browsers send
 * those only to https / localhost) — and a POST adds only Origin. A login-off hub
 * answers only to its own names; a login hub admits another name only with a native
 * credential (a bearer it then verifies) or to sign in.
 *
 * In-process, desktop shape (login off, supervised), isolated SLAYZONE_ROOT. The login
 * hub's half: browser-request-guard-login-hub.test.ts.
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
  method = 'POST',
  port = hub.port
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request(
      {
        host: '127.0.0.1',
        port,
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
/** A rebound page's request, as a browser sends it over http. */
const reboundGet = { host: 'attacker.test:51100' }
const reboundPost = { host: 'attacker.test:51100', origin: 'http://attacker.test:51100' }

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
    test(`${path}: a rebound hostname is refused (GET: Host only; POST: + Origin)`, async () => {
      const get = await send(path, reboundGet, 'GET')
      expect(get.status, get.body).toBe(403)
      expect(get.body).toMatch(/attacker\.test/)
      const post = await send(path, reboundPost)
      expect(post.status, post.body).toBe(403)
    })
  }
})

describe('login-off hub: its own names only', () => {
  for (const path of ['/api/tasks', '/api/pty', '/api/projects', '/mcp']) {
    test(`${path} under a rebound name: 403, whatever else it sends`, async () => {
      const extras: Array<Record<string, string>> = [
        {},
        { authorization: 'Bearer x' },
        { 'sec-fetch-mode': 'cors' }
      ]
      for (const extra of extras) {
        const r = await send(path, { ...reboundGet, ...extra }, 'GET')
        expect(r.status, r.body).toBe(403)
      }
    })
  }
  for (const host of ['127.0.0.1', 'localhost', 'localhost.', '[::1]']) {
    test(`native client as Host ${host}: admitted`, async () => {
      const r = await send('/api/projects', { host: `${host}:${hub.port}` }, 'GET')
      expect(r.status, r.body).toBe(200)
    })
  }
})

test('/health stays public', async () => {
  const r = await send('/health', panel, 'GET')
  expect(r.status).toBe(200)
})
