/**
 * The browser panel's SESSION-LEVEL request policy: every request of every panel
 * session is decided here (Electron `webRequest.onBeforeRequest`), so a whole class of
 * bypass — a scheme nobody listed, an address in a form nobody parsed, a subresource
 * nobody tracked — cannot exist.
 *
 *  - UNTRUSTED SESSION: the isolated partition (tabs opened for an agent on another
 *    computer) and every remote hub's partition: http/https to PUBLIC addresses (name,
 *    every IP form, DNS), plus about:blank and inert data:/blob: subresources — from
 *    any frame, popup or worker of the session. Nothing else — no file:, slz-file:,
 *    extension or custom scheme.
 *  - The user's own browser: as before, except that a local file (slz-file:) is never
 *    a subresource of a web page. An untrusted caller never acts in it at all
 *    (`untrustedOpRefusal`), whatever the tab's history (review 4 HIGH 1, MEDIUM 2).
 */
import { describe, expect, test } from 'vitest'
import {
  PanelNetworkPolicy,
  panelMarkerNeeded,
  untrustedOpRefusal,
  untrustedPermissionAllowed,
  UserLocalAccess,
  type PanelRequest
} from './browser-panel-policy'

const dns: Record<string, string[]> = {
  'public.test': ['93.184.216.34'],
  'rebind.test': ['10.0.0.7'],
  'mapped.test': ['::ffff:7f00:1'],
  'dual.test': ['93.184.216.34', '127.0.0.1']
}
const lookup = async (host: string): Promise<string[]> => {
  const r = dns[host]
  if (!r) throw new Error('ENOTFOUND')
  return r
}
const policy = () => new PanelNetworkPolicy(lookup)
const req = (url: string, over: Partial<PanelRequest> = {}): PanelRequest => ({
  url,
  resourceType: 'subFrame',
  webContentsId: 7,
  topUrl: 'https://public.test/page',
  ...over
})
const remote = { untrustedSession: true }
const local = { untrustedSession: false }

describe('untrusted: a remote hub’s partition', () => {
  for (const url of [
    'https://public.test/x',
    'http://93.184.216.34/',
    'wss://public.test/socket',
    'about:blank'
  ]) {
    test(`allows ${url}`, async () => {
      expect(await policy().decide(req(url), remote)).toBe('allow')
    })
  }
  test('inert data:/blob: subresources are allowed, never as a document or frame', async () => {
    const p = policy()
    expect(
      await p.decide(req('data:image/png;base64,AA==', { resourceType: 'image' }), remote)
    ).toBe('allow')
    expect(await p.decide(req('blob:https://public.test/1', { resourceType: 'xhr' }), remote)).toBe(
      'allow'
    )
    expect(
      await p.decide(req('data:text/html,<b>x</b>', { resourceType: 'subFrame' }), remote)
    ).toBe('block')
  })
  // review 3 HIGH 3: slz-file iframe of ~/.ssh/id_rsa, then a screenshot.
  for (const url of [
    'slz-file:///Users/u/.ssh/id_rsa',
    'file:///Users/u/.ssh/id_rsa',
    'chrome-extension://abc/p.html',
    'chrome://settings',
    'devtools://devtools/x',
    'figma://file/1',
    'view-source:https://public.test/'
  ]) {
    test(`blocks ${url.split(':')[0]}: in any position`, async () => {
      const p = policy()
      expect(await p.decide(req(url), remote)).toBe('block')
      expect(await p.decide(req(url, { resourceType: 'mainFrame' }), remote)).toBe('block')
    })
  }
  // review 3 HIGH 2: every textual form of loopback/private.
  for (const url of [
    'http://[::ffff:127.0.0.1]:51100/',
    'http://[::ffff:7f00:1]:51100/',
    'http://[::ffff:a00:1]/',
    'http://[::7f00:1]/',
    'http://[64:ff9b::7f00:1]/',
    'http://[2002:7f00:1::1]/',
    'http://[fec0::1]/',
    'http://0x7f.1:51100/',
    'http://2130706433/',
    'http://127.1/',
    'http://localhost:51100/',
    'http://app.localhost/',
    'http://printer.local/',
    'http://169.254.169.254/',
    'http://100.64.0.1/',
    'http://rebind.test/',
    'http://mapped.test/',
    'http://dual.test/',
    'http://unresolvable.test/'
  ]) {
    test(`blocks ${url}`, async () => {
      expect(await policy().decide(req(url, { resourceType: 'mainFrame' }), remote)).toBe('block')
    })
  }
})

describe('a request with no web contents (service / shared worker) is judged by its session', () => {
  test('in an untrusted session: blocked to this machine, resolved in that session', async () => {
    const seen: unknown[] = []
    const p = new PanelNetworkPolicy(async (host, _wc, resolveIn) => {
      seen.push(resolveIn)
      return lookup(host)
    })
    const worker = { webContentsId: null, resourceType: 'xhr' }
    expect(await p.decide(req('http://127.0.0.1:51100/', worker), remote)).toBe('block')
    expect(await p.decide(req('http://rebind.test/', worker), { ...remote, resolveIn: 'S' })).toBe(
      'block'
    )
    expect(seen).toEqual(['S'])
    expect(await p.decide(req('slz-file:///Users/u/x', worker), remote)).toBe('block')
  })
})

describe('untrustedOpRefusal: an untrusted caller never acts in the user’s own browser', () => {
  test('refused in the user’s own session, whatever the tab did before', () => {
    expect(untrustedOpRefusal(true, false)).toMatch(/user's own browser.*isolated tabs/)
  })
  test('allowed in an untrusted session; a trusted caller anywhere', () => {
    expect(untrustedOpRefusal(true, true)).toBeNull()
    expect(untrustedOpRefusal(false, false)).toBeNull()
    expect(untrustedOpRefusal(false, true)).toBeNull()
  })
})

describe('trusted: the user’s own local-partition tab', () => {
  test('local files open as documents, and a local file’s own subresources load', async () => {
    const p = policy()
    expect(
      await p.decide(req('slz-file:///Users/u/notes.html', { resourceType: 'mainFrame' }), local)
    ).toBe('allow')
    expect(
      await p.decide(
        req('slz-file:///Users/u/img.png', {
          resourceType: 'image',
          topUrl: 'slz-file:///Users/u/notes.html'
        }),
        local
      )
    ).toBe('allow')
  })
  test('a web page never embeds a local file (iframe, image, fetch), referrer or not', async () => {
    const p = policy()
    for (const resourceType of ['subFrame', 'image', 'xhr', 'other']) {
      expect(
        await p.decide(
          req('slz-file:///Users/u/.ssh/id_rsa', { resourceType, topUrl: 'https://public.test/x' }),
          local
        )
      ).toBe('block')
    }
  })
  test('localhost and LAN stay open to the user', async () => {
    expect(
      await policy().decide(req('http://localhost:3000/', { resourceType: 'mainFrame' }), local)
    ).toBe('allow')
  })
})

describe('checkTarget (before an untrusted navigation)', () => {
  test('public passes; private in any form refused', async () => {
    await expect(policy().checkTarget('https://public.test/')).resolves.toBeUndefined()
    await expect(policy().checkTarget('http://[::ffff:7f00:1]:51100/')).rejects.toThrow(
      /this computer or its private network/
    )
    await expect(policy().checkTarget('slz-file:///x')).rejects.toThrow(/not allowed/)
  })
})

describe('the panel marker header goes only where a hub may listen (review 3 LOW)', () => {
  const hubs = new Set(['hub.example.com'])
  test('this machine, the private network (any IP form) and registered hubs get it', () => {
    for (const url of [
      'http://127.0.0.1:51100/api/x',
      'http://[::ffff:7f00:1]:51100/',
      'http://localhost:3000/',
      'http://192.168.1.5/',
      'https://hub.example.com/trpc',
      'wss://HUB.example.com/trpc'
    ]) {
      expect(panelMarkerNeeded(url, hubs)).toBe(true)
    }
  })
  test('other sites never see it', () => {
    for (const url of [
      'https://github.com/',
      'https://public.test/x',
      'data:image/png;base64,AA'
    ]) {
      expect(panelMarkerNeeded(url, hubs)).toBe(false)
    }
  })
})

describe('untrusted sessions: permissions are deny-by-default (review 5 HIGH)', () => {
  test('nothing sensitive is granted', () => {
    for (const p of [
      'media',
      'clipboard-read',
      'clipboard-sanitized-write',
      'midi',
      'midiSysex',
      'geolocation',
      'notifications',
      'display-capture',
      'fullscreen',
      'pointerLock',
      'keyboardLock',
      'idle-detection',
      'window-management',
      'storage-access',
      'top-level-storage-access',
      'fileSystem',
      'hid',
      'serial',
      'usb',
      'bluetooth',
      'openExternal',
      'speaker-selection',
      'unknown',
      'some-future-permission'
    ]) {
      expect(untrustedPermissionAllowed(p), p).toBe(false)
    }
  })
  test('only the harmless allow-list passes', () => {
    expect(untrustedPermissionAllowed('mediaKeySystem')).toBe(true)
  })
})

describe('the user’s own remote-hub tabs: local addresses only on the user’s own act (review 6 F2)', () => {
  const WC = 7
  const setup = () => {
    let t = 1_000
    const access = new UserLocalAccess(() => t)
    const p = policy()
    const decide = (url: string, over: Partial<PanelRequest> = {}) =>
      p.decide(req(url, over), {
        untrustedSession: true,
        userAccess: (r, nonPublic) => access.allows(r, { nonPublic })
      })
    return { access, decide, advance: (ms: number) => (t += ms) }
  }
  const main = { resourceType: 'mainFrame', topUrl: 'https://public.test/page' }

  test('the user types a local address: it opens, and its own page loads its resources', async () => {
    const { access, decide } = setup()
    access.userNavigates(WC, 'http://localhost:3000/')
    expect(await decide('http://localhost:3000/', main)).toBe('allow')
    // The user's local page: its subresources and API calls on this machine load.
    const onPage = { resourceType: 'xhr', topUrl: 'http://localhost:3000/' }
    expect(await decide('http://localhost:3000/app.js', onPage)).toBe('allow')
    expect(await decide('http://127.0.0.1:8080/api', onPage)).toBe('allow')
  })
  test('a typed grant is for that address, once', async () => {
    const { access, decide } = setup()
    access.userNavigates(WC, 'http://localhost:3000/')
    expect(await decide('http://192.168.1.1/', main)).toBe('block')
    expect(await decide('http://localhost:3000/', main)).toBe('block')
  })
  test('back / forward / reload from the panel are the user’s act', async () => {
    const { access, decide } = setup()
    access.userNavigates(WC, null)
    expect(await decide('http://localhost:3000/', main)).toBe('allow')
  })
  test('nothing the hub or a page starts by itself reaches this machine', async () => {
    const { access, decide, advance } = setup()
    // A stored (hub-planted) tab URL loading at start, or a page navigating itself.
    expect(await decide('http://localhost:3000/', main)).toBe('block')
    // A public page's own requests to this machine (local-network CSRF).
    expect(
      await decide('http://127.0.0.1:51100/api/tasks', {
        resourceType: 'xhr',
        topUrl: 'https://public.test/page'
      })
    ).toBe('block')
    // A stale user act does not carry over.
    access.userNavigates(WC, null)
    advance(11_000)
    expect(await decide('http://localhost:3000/', main)).toBe('block')
  })
  test('a public navigation spends the pending act', async () => {
    const { access, decide } = setup()
    access.userNavigates(WC, null)
    expect(await decide('https://public.test/x', main)).toBe('allow')
    expect(await decide('http://localhost:3000/', main)).toBe('block')
  })
  test('without a user-access rule (an isolated session) nothing local ever opens', async () => {
    expect(
      await policy().decide(req('http://localhost:3000/', main), { untrustedSession: true })
    ).toBe('block')
  })
})

describe('a local page the user opened keeps working (follow-up N1)', () => {
  const WC = 7
  const setup = () => {
    let t = 1_000
    const access = new UserLocalAccess(() => t)
    const p = policy()
    const decide = (url: string, over: Partial<PanelRequest> = {}) =>
      p.decide(req(url, over), {
        untrustedSession: true,
        userAccess: (r, nonPublic) => access.allows(r, { nonPublic })
      })
    return { access, decide, advance: (ms: number) => (t += ms) }
  }
  const nav = (topUrl: string, requestId: number, method = 'GET') => ({
    resourceType: 'mainFrame',
    topUrl,
    requestId,
    method
  })
  const BEFORE = 'https://public.test/page'
  const APP = 'http://localhost:3000/'

  test('its own redirect hops load (same request), to another local server too', async () => {
    const { access, decide } = setup()
    access.userNavigates(WC, APP)
    expect(await decide(APP, nav(BEFORE, 1))).toBe('allow')
    // `/` → 302 `/login`: the same request again, the old page still on top.
    expect(await decide('http://localhost:3000/login', nav(BEFORE, 1))).toBe('allow')
    // → 302 to a local auth server: the user's own server chose it.
    expect(await decide('http://127.0.0.1:8080/auth', nav(BEFORE, 1))).toBe('allow')
    // That page's own resources load.
    expect(
      await decide('http://127.0.0.1:8080/auth.js', {
        resourceType: 'script',
        topUrl: 'http://127.0.0.1:8080/auth'
      })
    ).toBe('allow')
  })
  test('a public hop breaks the chain: a public server never picks a local target', async () => {
    const { access, decide } = setup()
    access.userNavigates(WC, APP)
    expect(await decide(APP, nav(BEFORE, 1))).toBe('allow')
    expect(await decide('https://public.test/bounce', nav(BEFORE, 1))).toBe('allow')
    expect(await decide('http://localhost:3000/admin', nav(BEFORE, 1))).toBe('block')
  })
  test('the page reloads itself, navigates in-app (GET or its own form POST), any time later', async () => {
    const { access, decide, advance } = setup()
    access.userNavigates(WC, APP)
    expect(await decide(APP, nav(BEFORE, 1))).toBe('allow')
    advance(60_000)
    // location.reload(), a dev server's full reload, meta refresh.
    expect(await decide(APP, nav(APP, 2))).toBe('allow')
    // In-app navigation, no input at all.
    expect(await decide('http://localhost:3000/settings', nav(APP, 3))).toBe('allow')
    // Its own login form posts to itself.
    expect(await decide('http://localhost:3000/login', nav(APP, 4, 'POST'))).toBe('allow')
  })
  test('the page does not navigate itself to another local address', async () => {
    const { access, decide } = setup()
    access.userNavigates(WC, APP)
    expect(await decide(APP, nav(BEFORE, 1))).toBe('allow')
    expect(await decide('http://192.168.1.1/', nav(APP, 2))).toBe('block')
    expect(await decide('http://192.168.1.1/apply', nav(APP, 3, 'POST'))).toBe('block')
  })
  test('a public server redirecting into the local page the user still has on top: blocked', async () => {
    const { access, decide } = setup()
    access.userNavigates(WC, APP)
    expect(await decide(APP, nav(BEFORE, 1))).toBe('allow')
    // The user types a public address; before it commits, the old local page is on top.
    access.userNavigates(WC, 'https://public.test/')
    expect(await decide('https://public.test/', nav(APP, 2))).toBe('allow')
    expect(await decide('http://localhost:3000/delete-all', nav(APP, 2))).toBe('block')
  })
  test('a page on the user-opened origin, gone public, gets nothing local back', async () => {
    const { access, decide } = setup()
    access.userNavigates(WC, APP)
    expect(await decide(APP, nav(BEFORE, 1))).toBe('allow')
    // The page left for a public site; that site navigates to the local app.
    expect(await decide('https://public.test/', nav(APP, 2))).toBe('allow')
    expect(await decide(APP, nav('https://public.test/', 3))).toBe('block')
  })
})

describe('a link counts only when the user clicked THAT link (follow-up N2)', () => {
  const WC = 7
  const setup = () => {
    let t = 1_000
    const access = new UserLocalAccess(() => t)
    const p = policy()
    const decide = (url: string, over: Partial<PanelRequest> = {}) =>
      p.decide(req(url, over), {
        untrustedSession: true,
        userAccess: (r, nonPublic) => access.allows(r, { nonPublic })
      })
    return { access, decide, advance: (ms: number) => (t += ms) }
  }
  const nav = (requestId: number, method = 'GET') => ({
    resourceType: 'mainFrame',
    topUrl: 'https://public.test/page',
    requestId,
    method
  })

  test('the clicked link opens (GET, that URL, fragment aside)', async () => {
    const { access, decide } = setup()
    access.userActivatesLink(WC, 'http://localhost:5173/docs#intro')
    expect(await decide('http://localhost:5173/docs', nav(1))).toBe('allow')
  })
  test('the page cannot swap the target, POST to it, or reuse the click', async () => {
    const { access, decide, advance } = setup()
    access.userActivatesLink(WC, 'http://localhost:5173/')
    expect(await decide('http://192.168.1.1/apply', nav(1))).toBe('block')
    access.userActivatesLink(WC, 'http://192.168.1.1/apply')
    expect(await decide('http://192.168.1.1/apply', nav(2, 'POST'))).toBe('block')
    access.userActivatesLink(WC, 'http://localhost:5173/')
    expect(await decide('http://localhost:5173/', nav(3))).toBe('allow')
    // Now the user's page: it navigates on its own origin.
    expect(
      await decide('http://localhost:5173/next', { ...nav(4), topUrl: 'http://localhost:5173/' })
    ).toBe('allow')
    access.userActivatesLink(WC, 'http://192.168.1.2/')
    advance(11_000)
    expect(await decide('http://192.168.1.2/', nav(5))).toBe('block')
  })
  test('input alone grants nothing: a page navigating itself to LAN right after a click', async () => {
    const { decide } = setup()
    // No link activation recorded — only the click on the page itself.
    expect(await decide('http://192.168.1.1/', nav(1))).toBe('block')
    expect(await decide('http://192.168.1.1/apply', nav(2, 'POST'))).toBe('block')
  })
})

describe('a reload is the user’s act only when the user asked for it (follow-up N3)', () => {
  const WC = 7
  const setup = () => {
    let t = 1_000
    const access = new UserLocalAccess(() => t)
    const p = policy()
    const decide = (url: string) =>
      p.decide(req(url, { resourceType: 'mainFrame', topUrl: url }), {
        untrustedSession: true,
        userAccess: (r, nonPublic) => access.allows(r, { nonPublic })
      })
    return { access, decide, advance: (ms: number) => (t += ms) }
  }
  const PLANTED = 'http://localhost:3000/'

  test('a hub’s reload-browser event (no shortcut main saw) does not open a planted URL', async () => {
    const { access, decide } = setup()
    access.userReloads(WC, 'shortcut')
    expect(await decide(PLANTED)).toBe('block')
    access.userReloads(WC, undefined)
    expect(await decide(PLANTED)).toBe('block')
  })
  test('the reload shortcut main itself saw: once, and not stale', async () => {
    const { access, decide, advance } = setup()
    access.reloadShortcutPressed()
    access.userReloads(WC, 'shortcut')
    expect(await decide(PLANTED)).toBe('allow')
    access.userReloads(WC, 'shortcut')
    expect(await decide('http://192.168.1.1/')).toBe('block')
    access.reloadShortcutPressed()
    advance(11_000)
    access.userReloads(WC, 'shortcut')
    expect(await decide('http://192.168.1.2/')).toBe('block')
  })
  test('the panel’s own reload button is the user’s act', async () => {
    const { access, decide } = setup()
    access.userReloads(WC, 'panel')
    expect(await decide(PLANTED)).toBe('allow')
  })
})
