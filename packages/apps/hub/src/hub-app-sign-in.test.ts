/**
 * The native app's Microsoft sign-in (hub-auth `app-sign-in.ts`) through the REAL built
 * hub: Entra sign-in on, password sign-in off, a reachable hub (public address, so the
 * flood limits are on). The app half is the shared client (`@slayzone/hub-auth/client`,
 * what the iOS app runs) with Node's WebCrypto; the auth session is the harness browser
 * (sso-hub-harness.ts: cookie jar, manual redirects, a local fake Entra).
 *
 * Proves: /health advertises the app sign-in; start → Entra (MFA) → confirm page →
 * `slayzone://auth/callback?code&state` → exchange → a bearer that works on the REST API;
 * the code is single-use (a replay revokes the session it minted); the start never
 * redirects anywhere but the allow-listed app redirect; the routes need no bearer; the
 * audit names the flow and carries no code, verifier or token; the token route is
 * flood-limited.
 *
 * Run with: vitest (packages/shared/test-utils/vitest.harness.config.ts)
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { webcrypto } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  APP_SIGN_IN_REDIRECT_URI,
  exchangeAppSignInCode,
  type PkceCrypto,
  readAppSignInCallback,
  startAppSignIn
} from '@slayzone/hub-auth/client'
import { nodeHubTransport } from '@slayzone/hub-auth/client-node'
import {
  Browser,
  ensureBuilt,
  type FakeEntra,
  type Hub,
  HUB_BIN,
  HUB_DIR,
  MFA,
  PUBLIC,
  PUBLIC_ORIGIN,
  startSsoHub
} from './sso-hub-harness'

const ELECTRON_BIN = createRequire(import.meta.url)('electron') as unknown as string

const nodeCrypto: PkceCrypto = {
  getRandomValues: (bytes) => webcrypto.getRandomValues(bytes),
  sha256: (data) => webcrypto.subtle.digest('SHA-256', data)
}

let tmp = ''
let entra: FakeEntra
let hub: Hub
const secrets: string[] = []

beforeAll(async () => {
  await ensureBuilt(HUB_DIR, HUB_BIN)
  tmp = mkdtempSync(join(tmpdir(), 'slz-hub-app-sso-'))
  ;({ hub, entra } = await startSsoHub(ELECTRON_BIN, tmp))
})

afterAll(async () => {
  await hub?.stop()
  await entra?.stop()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

/** The app starts a sign-in; the person signs in with MFA and presses Continue. */
async function signInInBrowser(): Promise<{
  pending: Awaited<ReturnType<typeof startAppSignIn>>
  redirect: string
}> {
  const pending = await startAppSignIn(hub.base, nodeCrypto)
  secrets.push(pending.verifier)
  const browser = new Browser(hub, entra)
  const start = new URL(pending.url)
  const page = await browser.open(start.pathname + start.search, MFA)
  const html = await page.text()
  expect(page.status, `confirm page, got ${page.status}: ${html.slice(0, 300)}`).toBe(200)
  expect(html, 'names the account').toContain('ada@normain.test')
  expect(html, 'names the hub').toContain(PUBLIC)
  expect(!/<script/i.test(html), 'no script on the page').toBe(true)
  const confirm = await browser.post(
    '/api/auth/app-sso/confirm',
    { decision: 'continue' },
    PUBLIC_ORIGIN
  )
  expect(confirm.status, `confirm → 302, got ${confirm.status}`).toBe(302)
  return { pending, redirect: confirm.headers.get('location') ?? '' }
}

const exchange = (code: string, verifier: string) =>
  exchangeAppSignInCode(nodeHubTransport, hub.base, {
    code,
    verifier,
    redirectUri: APP_SIGN_IN_REDIRECT_URI
  })

const tasksWith = (token: string | null) =>
  fetch(`${hub.base}/api/tasks`, {
    headers: token ? { authorization: `Bearer ${token}` } : {}
  })

describe('a hub with Entra sign-in: the native app signs in with Microsoft', () => {
  test('/health advertises the app sign-in', async () => {
    const health = (await (await fetch(`${hub.base}/health`)).json()) as {
      appSignIn?: { microsoft?: boolean }
      switches?: Record<string, boolean>
    }
    expect(health.appSignIn, 'appSignIn').toEqual({ microsoft: true })
    expect(health.switches?.enableSso, 'enableSso').toBe(true)
  })

  test('start → Entra with MFA → confirm → code in the app → token works on REST', async () => {
    const { pending, redirect } = await signInInBrowser()
    expect(redirect.startsWith(`${APP_SIGN_IN_REDIRECT_URI}?code=`), redirect).toBe(true)
    const callback = readAppSignInCallback(redirect, pending)
    expect(callback.ok, redirect).toBe(true)
    if (!callback.ok) return
    secrets.push(callback.code)
    const result = await exchange(callback.code, pending.verifier)
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    secrets.push(result.token)
    expect((await tasksWith(result.token)).status, 'GET /api/tasks with the token').toBe(200)
    expect((await tasksWith(null)).status, 'without it → 401').toBe(401)
  })

  test('a replayed code is refused and the session it minted is revoked', async () => {
    const { pending, redirect } = await signInInBrowser()
    const callback = readAppSignInCallback(redirect, pending)
    if (!callback.ok) throw new Error(redirect)
    secrets.push(callback.code)
    const first = await exchange(callback.code, pending.verifier)
    if (!first.ok) throw new Error(JSON.stringify(first))
    secrets.push(first.token)
    expect((await tasksWith(first.token)).status).toBe(200)
    const again = await exchange(callback.code, pending.verifier)
    expect(again).toMatchObject({ ok: false, reason: 'refused', code: 'CODE_INVALID' })
    expect((await tasksWith(first.token)).status, 'first token revoked').toBe(401)
  })

  test('the start redirects only to the allow-listed app redirect', async () => {
    const pending = await startAppSignIn(hub.base, nodeCrypto)
    const evil = pending.url.replace(
      encodeURIComponent(APP_SIGN_IN_REDIRECT_URI),
      encodeURIComponent('https://evil.example/cb')
    )
    const res = await fetch(evil, { redirect: 'manual' })
    expect(res.status, 'refused').toBe(400)
    expect(res.headers.get('location'), 'no redirect').toBe(null)
  })

  test('audit: the flow is on the record, no code, verifier or token in any line', async () => {
    const security = hub.logs.filter((l) => l.startsWith('{"type":"security"'))
    const events = security.map((l) => {
      const e = JSON.parse(l) as { event: string; outcome: string; detail: { method?: string } }
      return `${e.event}:${e.outcome}${e.detail.method ? `:${e.detail.method}` : ''}`
    })
    for (const want of [
      'auth.signin:success:sso',
      'auth.app_sso.code:success',
      'auth.signin:success:app',
      'auth.app_sso.replay:denied'
    ]) {
      expect(events, `${want} audited (got ${events.join(', ')})`).toContain(want)
    }
    const all = hub.logs.join('\n')
    for (const s of secrets) expect(all, 'no secret in the hub output').not.toContain(s)
  })

  test('the token route is flood-limited per address (10 a minute)', async () => {
    let refused: Response | null = null
    for (let i = 0; i < 12 && !refused; i++) {
      const res = await fetch(`${hub.base}/api/auth/app-sso/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: 'A'.repeat(43),
          code_verifier: 'B'.repeat(43),
          redirect_uri: APP_SIGN_IN_REDIRECT_URI
        })
      })
      if (res.status === 429) refused = res
      else expect(res.status, 'an unknown code is a 400 until the limit').toBe(400)
    }
    expect(refused, 'refused within 12 requests').not.toBe(null)
  })
})
