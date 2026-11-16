/**
 * The hub refuses its API to browser PAGES it does not serve itself — the loopback
 * pivot (a page loaded into SlayZone's own browser panel, or any browser tab on the
 * machine, driving a login-off hub) and DNS rebinding (an attacker hostname resolving
 * to 127.0.0.1). Native clients (desktop main, CLI, computer, mobile) send no
 * `Origin` / `Sec-Fetch-Site` and stay admitted; the hub's own web shell stays
 * admitted as same-origin or an allowed origin.
 */
import { describe, expect, test } from 'vitest'
import {
  apiRequestDecision,
  hostDecision,
  httpRequestRefusal,
  isPublicPath,
  trpcUpgradeDecision
} from './browser-request-guard.js'

const local = {
  loopbackBind: true,
  supervised: true,
  requireLogin: false,
  allowedOrigins: [] as string[],
  publicHosts: [] as string[]
}
const remote = {
  loopbackBind: false,
  supervised: false,
  requireLogin: true,
  allowedOrigins: ['https://hub.example.com'],
  publicHosts: ['hub.example.com']
}
const req = (
  headers: Record<string, string>,
  method = 'GET'
): { method: string; headers: Record<string, string> } => ({ method, headers })

describe('hostDecision (DNS rebinding)', () => {
  test('loopback names and IP literals are this machine', () => {
    for (const h of ['127.0.0.1:51100', 'localhost:51100', '[::1]:51100', '192.168.1.5:51100']) {
      expect(hostDecision(h, local)).toBe('accept')
    }
  })
  test("the hub's public host is accepted", () => {
    expect(hostDecision('hub.example.com', remote)).toBe('accept')
    expect(hostDecision('HUB.example.com:443', remote)).toBe('accept')
  })
  test('any other hostname is a rebind and refused', () => {
    expect(hostDecision('attacker.test:51100', local)).toBe('reject')
    expect(hostDecision('hub.example.com.attacker.test', remote)).toBe('reject')
    expect(hostDecision(undefined, local)).toBe('reject')
  })
})

describe('apiRequestDecision (/api, /mcp)', () => {
  const host = { host: '127.0.0.1:51100' }
  test('native clients: desktop main, slay CLI (node fetch sends sec-fetch-mode only), computer, mobile', () => {
    expect(apiRequestDecision(req({ ...host }), local)).toBe('accept')
    expect(
      apiRequestDecision(
        req({ ...host, 'sec-fetch-mode': 'cors', 'user-agent': 'node' }, 'POST'),
        local
      )
    ).toBe('accept')
  })
  test('a native client that sets an Origin itself (node fetch: sec-fetch-mode, no sec-fetch-site) is native', () => {
    expect(
      apiRequestDecision(
        req({ ...host, origin: 'https://hub.example.com', 'sec-fetch-mode': 'cors' }, 'POST'),
        local
      )
    ).toBe('accept')
  })
  test('an older browser (Origin, no fetch metadata at all) is still judged by its Origin', () => {
    expect(apiRequestDecision(req({ ...host, origin: 'https://evil.test' }, 'POST'), local)).toBe(
      'reject'
    )
  })
  test('anything from inside SlayZone’s browser panel is refused', () => {
    expect(apiRequestDecision(req({ ...host, 'x-slayzone-browser-panel': '1' }), local)).toBe(
      'reject'
    )
    expect(
      apiRequestDecision(
        req({ ...host, 'x-slayzone-browser-panel': '1', 'sec-fetch-site': 'same-origin' }),
        local
      )
    ).toBe('reject')
  })
  test('a cross-site page (any browser tab) is refused', () => {
    expect(
      apiRequestDecision(
        req(
          {
            ...host,
            origin: 'https://evil.test',
            'sec-fetch-site': 'cross-site',
            'sec-fetch-mode': 'cors'
          },
          'POST'
        ),
        local
      )
    ).toBe('reject')
    expect(
      apiRequestDecision(req({ ...host, origin: 'http://localhost:3000' }, 'POST'), local)
    ).toBe('reject')
    expect(apiRequestDecision(req({ ...host, origin: 'null' }, 'POST'), local)).toBe('reject')
    expect(
      apiRequestDecision(
        req({ ...host, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' }),
        local
      )
    ).toBe('reject')
  })
  test('a login-off hub answers only to its own names: no header absence admits another (review 4)', () => {
    // A rebound page's same-origin GET over http sends Host and nothing else — no
    // Origin, no fetch metadata (browsers send Sec-Fetch-* only to https/localhost).
    for (const host of ['attacker.test:51100', 'mymac.local:51100', 'hub.tailnet.ts.net']) {
      expect(apiRequestDecision(req({ host }), local)).toBe('reject')
      expect(apiRequestDecision(req({ host, 'sec-fetch-mode': 'cors' }, 'POST'), local)).toBe(
        'reject'
      )
      // A bearer proves nothing on a hub that verifies none.
      expect(apiRequestDecision(req({ host, authorization: 'Bearer x' }), local)).toBe('reject')
    }
    // Its own names, in any spelling.
    for (const host of ['localhost.:51100', '127.0.0.1:51100', '[::1]:51100', 'LOCALHOST:51100']) {
      expect(apiRequestDecision(req({ host }), local)).toBe('accept')
    }
  })
  test('a login hub admits another name only with a native credential or to sign in', () => {
    const tailnet = 'hub.tailnet.ts.net'
    expect(apiRequestDecision(req({ host: tailnet }), remote)).toBe('reject')
    expect(apiRequestDecision(req({ host: tailnet, authorization: 'Bearer t' }), remote)).toBe(
      'accept'
    )
    expect(
      apiRequestDecision(
        { url: '/api/auth/device/code', method: 'POST', headers: { host: tailnet } },
        remote
      )
    ).toBe('accept')
    // Not a browser page, even with a bearer.
    expect(
      apiRequestDecision(
        req({ host: tailnet, authorization: 'Bearer t', 'sec-fetch-site': 'same-origin' }),
        remote
      )
    ).toBe('reject')
  })
  test('a browser page under an unlisted name is refused, saying which name and how to allow it', () => {
    const r = httpRequestRefusal(
      { url: '/api/x', headers: { host: 'attacker.test:51100', 'sec-fetch-site': 'same-origin' } },
      local
    )
    expect(r?.reason).toBe('host')
    expect(r?.message).toMatch(/attacker\.test/)
    expect(r?.message).toMatch(/SLAYZONE_HUB_ALLOWED_WEB_ORIGINS/)
  })
  test('each refusal says what was refused', () => {
    expect(
      httpRequestRefusal(
        { url: '/api/x', headers: { host: 'h', 'x-slayzone-browser-panel': '1' } },
        local
      )?.reason
    ).toBe('browser-panel')
    expect(
      httpRequestRefusal(
        {
          url: '/api/x',
          method: 'POST',
          headers: {
            host: '127.0.0.1:1',
            origin: 'https://evil.test',
            'sec-fetch-site': 'cross-site',
            'sec-fetch-mode': 'cors'
          }
        },
        local
      )?.message
    ).toMatch(/evil\.test/)
  })
  test('every path is guarded except /health (fails closed), in any spelling', () => {
    for (const url of ['/API/x', '/Mcp', '/api%2fx', '//api//x', '/', '/index.html', '/TRPC']) {
      expect(
        httpRequestRefusal({ url, headers: { host: 'h', 'x-slayzone-browser-panel': '1' } }, local)
          ?.reason
      ).toBe('browser-panel')
    }
    expect(
      httpRequestRefusal(
        { url: '/health', headers: { host: 'h', 'x-slayzone-browser-panel': '1' } },
        local
      )
    ).toBeNull()
    expect(isPublicPath('/HEALTH/')).toBe(true)
  })
  test("the hub's own page (web shell) is admitted: same-origin or an allowed origin", () => {
    expect(
      apiRequestDecision(
        req({ ...host, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }, 'POST'),
        local
      )
    ).toBe('accept')
    expect(
      apiRequestDecision(
        req({ ...host, origin: 'http://127.0.0.1:51100', 'sec-fetch-site': 'same-origin' }, 'POST'),
        local
      )
    ).toBe('accept')
    expect(
      apiRequestDecision(
        req(
          {
            host: 'hub.example.com',
            origin: 'https://hub.example.com',
            'sec-fetch-site': 'same-origin'
          },
          'POST'
        ),
        remote
      )
    ).toBe('accept')
  })
  test('a same-origin claim whose Origin is another host is refused', () => {
    expect(
      apiRequestDecision(
        req({ ...host, origin: 'http://127.0.0.1:9999', 'sec-fetch-site': 'same-origin' }, 'POST'),
        local
      )
    ).toBe('reject')
  })
  test('top-level GET navigations stay (SSO callbacks, links), state changes do not', () => {
    expect(
      apiRequestDecision(
        req({
          host: 'hub.example.com',
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'navigate'
        }),
        remote
      )
    ).toBe('accept')
    expect(
      apiRequestDecision(
        req(
          {
            ...host,
            origin: 'https://evil.test',
            'sec-fetch-site': 'cross-site',
            'sec-fetch-mode': 'navigate'
          },
          'POST'
        ),
        local
      )
    ).toBe('reject')
  })
})

describe('trpcUpgradeDecision (/trpc WebSocket)', () => {
  const host = { host: '127.0.0.1:51100' }
  test('desktop renderer (Origin stripped by main), native clients', () => {
    expect(trpcUpgradeDecision(req({ ...host }), local)).toBe('accept')
  })
  test('a login-off hub answers only to its own names, Origin or not (review 4)', () => {
    expect(trpcUpgradeDecision(req({ host: 'attacker.test:51100' }), local)).toBe('reject')
    expect(trpcUpgradeDecision(req({ host: 'localhost:51100' }), local)).toBe('accept')
    // A login hub: a socket with no Origin is never a browser's; it signs in next.
    expect(trpcUpgradeDecision(req({ host: 'hub.tailnet.ts.net' }), remote)).toBe('accept')
  })
  test('a panel page or a rebound host is refused', () => {
    expect(
      trpcUpgradeDecision(
        req({ ...host, 'x-slayzone-browser-panel': '1', origin: 'http://127.0.0.1:51100' }),
        local
      )
    ).toBe('reject')
    expect(
      trpcUpgradeDecision(
        req({ host: 'attacker.test:51100', origin: 'http://attacker.test:51100' }),
        local
      )
    ).toBe('reject')
  })
  test("on the desktop's hub a loopback page of ANOTHER port is refused, its own page is not", () => {
    expect(trpcUpgradeDecision(req({ ...host, origin: 'http://localhost:3000' }), local)).toBe(
      'reject'
    )
    expect(trpcUpgradeDecision(req({ ...host, origin: 'http://127.0.0.1:51100' }), local)).toBe(
      'accept'
    )
  })
  test('a standalone loopback dev hub keeps admitting the web dev server', () => {
    expect(
      trpcUpgradeDecision(req({ host: '127.0.0.1:51200', origin: 'http://localhost:51735' }), {
        ...local,
        supervised: false
      })
    ).toBe('accept')
  })
  test('a remote hub admits its own public origin', () => {
    expect(
      trpcUpgradeDecision(
        req({ host: 'hub.example.com', origin: 'https://hub.example.com' }),
        remote
      )
    ).toBe('accept')
    expect(
      trpcUpgradeDecision(req({ host: 'hub.example.com', origin: 'https://evil.test' }), remote)
    ).toBe('reject')
  })
})
