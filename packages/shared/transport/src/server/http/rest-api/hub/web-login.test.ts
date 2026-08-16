/**
 * REST: `POST /api/auth/web-login` contract tests.
 *
 * The `webLogin` capability is a STUB here, deliberately — the real
 * `signInEmail` + `mintWebSession` logic lives in `apps/hub/src/web-sessions.ts`
 * (covered against a real better-auth instance in its own `web-sessions.test.ts`
 * and `rest-auth.test.ts`'s szw_ tests), and this package has no hub-auth
 * dependency. This file owns exactly what the ROUTE layer is responsible for:
 * status codes, body validation, the Set-Cookie header, and the capability gate.
 *
 * Uses raw `fetch` rather than the shared `mountRestApp` harness's `request()`
 * helper — that helper discards response headers, and `Set-Cookie` is the one
 * thing this route's contract actually depends on.
 */
import express from 'express'
import { test, expect, describe } from '../../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../test-utils/rest-harness.js'
import { registerWebLoginRoute } from './web-login.js'
import type { RestApiDeps } from '../types.js'

type WebLogin = NonNullable<RestApiDeps['webLogin']>

function mount(webLogin: RestApiDeps['webLogin']) {
  const app = express()
  app.use(express.json())
  registerWebLoginRoute(app, {
    db: null as unknown as RestApiDeps['db'],
    notifyRenderer: () => {},
    webLogin
  })
  return mountRestApp(app)
}

await describe('POST /api/auth/web-login', () => {
  test('a successful login sets an HttpOnly cookie AND returns the token in the body', async () => {
    const stub: WebLogin = {
      login: async (email) => ({
        ok: true,
        token: 'szw_test-token',
        cookieName: 'slayzone_web_session',
        maxAgeSec: 604800
      })
    }
    const rest = await mount(stub)
    try {
      const res = await fetch(`${rest.url}/api/auth/web-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'alice@example.com', password: 'correct-horse' })
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; token: string }
      expect(body.ok).toBe(true)
      expect(body.token).toBe('szw_test-token')

      const setCookie = res.headers.get('set-cookie') ?? ''
      expect(setCookie.includes('slayzone_web_session=szw_test-token')).toBe(true)
      expect(setCookie.includes('HttpOnly')).toBe(true)
      expect(setCookie.includes('Secure')).toBe(true)
      expect(setCookie.includes('SameSite=Lax')).toBe(true)
      expect(setCookie.includes('Max-Age=604800')).toBe(true)
    } finally {
      await rest.close()
    }
  })

  test('a failed login (bad credentials) is 401, uniform message, no cookie', async () => {
    const stub: WebLogin = {
      login: async () => ({ ok: false, error: 'invalid email or password' })
    }
    const rest = await mount(stub)
    try {
      const res = await fetch(`${rest.url}/api/auth/web-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong' })
      })
      expect(res.status).toBe(401)
      const body = (await res.json()) as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
      expect(body.error).toBe('invalid email or password')
      expect(res.headers.get('set-cookie')).toBe(null)
    } finally {
      await rest.close()
    }
  })

  test('400 for a missing / blank email or password, never reaching the capability', async () => {
    let called = false
    const stub: WebLogin = {
      login: async () => {
        called = true
        return { ok: true, token: 't', cookieName: 'c', maxAgeSec: 1 }
      }
    }
    const rest = await mount(stub)
    try {
      for (const body of [
        {},
        { email: '' },
        { email: '  ' },
        { email: 'a@b.c' }, // password missing
        { email: 'a@b.c', password: '' },
        { password: 'x' } // email missing
      ]) {
        const res = await fetch(`${rest.url}/api/auth/web-login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        })
        expect(res.status).toBe(400)
      }
      expect(called).toBe(false)
    } finally {
      await rest.close()
    }
  })

  test('503 when the capability slot is absent (no hub-auth on this host)', async () => {
    const rest = await mount(undefined)
    try {
      const res = await fetch(`${rest.url}/api/auth/web-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.c', password: 'x' })
      })
      expect(res.status).toBe(503)
    } finally {
      await rest.close()
    }
  })

  test('500 with a message when the capability throws', async () => {
    const stub: WebLogin = {
      login: async () => {
        throw new Error('better-auth db locked')
      }
    }
    const rest = await mount(stub)
    try {
      const res = await fetch(`${rest.url}/api/auth/web-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.c', password: 'x' })
      })
      expect(res.status).toBe(500)
      const body = (await res.json()) as { message: string }
      expect(body.message).toBe('better-auth db locked')
    } finally {
      await rest.close()
    }
  })

  test('the SAME failure response for a nonexistent account and a wrong password', async () => {
    // The route must not unwrap a distinction the capability itself doesn't
    // make — asserted here by giving the stub only ONE failure shape and
    // confirming both "user cases" a caller might try produce it identically.
    const stub: WebLogin = {
      login: async () => ({ ok: false, error: 'invalid email or password' })
    }
    const rest = await mount(stub)
    try {
      const noSuchUser = await fetch(`${rest.url}/api/auth/web-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'ghost@example.com', password: 'whatever' })
      })
      const wrongPassword = await fetch(`${rest.url}/api/auth/web-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'real@example.com', password: 'wrong' })
      })
      expect(noSuchUser.status).toBe(wrongPassword.status)
      expect(await noSuchUser.text()).toBe(await wrongPassword.text())
    } finally {
      await rest.close()
    }
  })
})
