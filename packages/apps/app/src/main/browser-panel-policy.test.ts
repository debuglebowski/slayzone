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
