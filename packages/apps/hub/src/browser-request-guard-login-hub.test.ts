/**
 * The browser-page guard on a REAL reachable login hub (review 4 MEDIUM 4): a request
 * under a name the hub is not published under is admitted only with a native
 * credential — a bearer, verified by auth next — or to sign in (a client with no token
 * yet). Never on the absence of browser headers. Login-off half:
 * browser-request-guard-server.test.ts.
 *
 * In-process, isolated SLAYZONE_ROOT.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { request } from 'node:http'
import { bootInProcessHub, type InProcessHub } from './owner-checks-harness'

let loginHub: InProcessHub
beforeAll(async () => {
  loginHub = await bootInProcessHub({ login: true })
}, 60_000)
afterAll(() => loginHub?.stop())

function send(
  path: string,
  headers: Record<string, string>,
  method = 'POST',
  port = loginHub.port
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

describe('login hub: another name only with a native credential, or to sign in', () => {
  const tailnet = { host: 'hub.tailnet.ts.net' }
  test('no credential → 403 (host), before auth', async () => {
    const r = await send('/api/projects', tailnet, 'GET', loginHub.port)
    expect(r.status, r.body).toBe(403)
    expect(r.body).toMatch(/hub\.tailnet\.ts\.net/)
  })
  test('a bearer → on to auth (verified there: 401 for a bad one, 200 for a real one)', async () => {
    const bad = await send(
      '/api/projects',
      { ...tailnet, authorization: 'Bearer not-a-token' },
      'GET',
      loginHub.port
    )
    expect(bad.status, bad.body).toBe(401)
    const ok = await send(
      '/api/projects',
      { ...tailnet, authorization: `Bearer ${loginHub.adminToken}` },
      'GET',
      loginHub.port
    )
    expect(ok.status, ok.body).toBe(200)
  })
  test('sign-in routes stay reachable for a client with no token yet', async () => {
    const r = await send('/api/auth/sign-in/email', tailnet, 'POST', loginHub.port)
    expect(r.status, r.body).not.toBe(403)
  })
})

test("the hub's published name needs no credential to reach auth (which then asks for one)", async () => {
  const r = await send('/api/projects', { host: 'hub.example.com' }, 'GET')
  expect(r.status, r.body).toBe(401)
})
