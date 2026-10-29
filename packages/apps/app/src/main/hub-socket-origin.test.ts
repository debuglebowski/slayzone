/**
 * The app document's hub sockets lose `Origin` in main; nothing else does.
 *
 * The hub half (an absent Origin is admitted, `file://` / localhost are refused on a
 * hub other machines reach) is pinned in hub `ws-origin.test.ts`.
 */
import { describe, expect, test } from 'vitest'
import { attachHubSocketOriginStrip, shouldStripHubSocketOrigin } from './hub-socket-origin'

const PROD = 'file:///Applications/SlayZone.app/Contents/Resources/app.asar/out/renderer/index.html'
const DEV = 'http://localhost:5173'
const REMOTE = 'wss://slay.normain.com/trpc'

const ws = (url: string, frameUrl: string | undefined) => ({
  resourceType: 'webSocket',
  url,
  frameUrl
})

describe('shouldStripHubSocketOrigin', () => {
  test('the app document dialing a hub: packaged, dev, task window, floating panel', () => {
    expect(shouldStripHubSocketOrigin(ws(REMOTE, PROD), PROD), 'packaged').toBe(true)
    expect(shouldStripHubSocketOrigin(ws(`${REMOTE}?windowId=3`, PROD), PROD), 'windowId').toBe(true)
    expect(shouldStripHubSocketOrigin(ws(REMOTE, `${DEV}/`), DEV), 'dev server').toBe(true)
    expect(
      shouldStripHubSocketOrigin(ws(REMOTE, `${PROD}?taskId=t1&windowId=2`), PROD),
      'task window'
    ).toBe(true)
    expect(
      shouldStripHubSocketOrigin(ws(REMOTE, `${DEV}?floating=global-agent-panel`), DEV),
      'floating panel'
    ).toBe(true)
    expect(
      shouldStripHubSocketOrigin(ws('ws://127.0.0.1:51001/trpc?windowId=1', PROD), PROD),
      'the local hub too: one rule for every hub'
    ).toBe(true)
  })

  test('any page that is not the app document keeps its Origin', () => {
    for (const frameUrl of [
      'https://evil.example/', // a webview popup (this session hosts them)
      'slz-file://app/Users/me/artifact.html', // an artifact iframe
      'file:///Users/me/Downloads/page.html', // another local file
      'http://localhost:3000/', // another local dev server
      'about:blank',
      undefined // no frame reported (or it was disposed)
    ]) {
      expect(shouldStripHubSocketOrigin(ws(REMOTE, frameUrl), PROD), `${frameUrl}`).toBe(false)
      expect(shouldStripHubSocketOrigin(ws(REMOTE, frameUrl), DEV), `${frameUrl} (dev)`).toBe(
        false
      )
    }
  })

  test('only a hub socket: not other sockets, not HTTP', () => {
    for (const url of [
      'wss://example.convex.cloud/api/1.0/sync', // Convex
      'ws://localhost:5173/?token=x', // Vite HMR
      'wss://slay.normain.com/computers', // the computer endpoint (never the renderer's)
      'wss://slay.normain.com/trpc/extra',
      'not a url'
    ]) {
      expect(shouldStripHubSocketOrigin(ws(url, PROD), PROD), url).toBe(false)
    }
    expect(
      shouldStripHubSocketOrigin(
        { resourceType: 'xhr', url: 'https://slay.normain.com/trpc', frameUrl: PROD },
        PROD
      ),
      'an HTTP request to the same path'
    ).toBe(false)
  })
})

type Listener = (
  details: Record<string, unknown>,
  callback: (response: { requestHeaders?: Record<string, string> }) => void
) => void

function fakeSession() {
  let filter: unknown
  let listener: Listener | null = null
  const sess = {
    webRequest: {
      onBeforeSendHeaders: (f: unknown, l: Listener) => {
        filter = f
        listener = l
      }
    }
  }
  const send = (details: Record<string, unknown>) => {
    let response: { requestHeaders?: Record<string, string> } | undefined
    listener!(details, (r) => {
      response = r
    })
    return response
  }
  return { sess: sess as never, filter: () => filter, send }
}

const HANDSHAKE = {
  'User-Agent': 'Mozilla/5.0',
  Origin: 'file://',
  Cookie: 'ARRAffinity=abc',
  'Sec-WebSocket-Version': '13'
}

describe('attachHubSocketOriginStrip', () => {
  test('listens on ws and wss only', () => {
    const f = fakeSession()
    attachHubSocketOriginStrip(f.sess, PROD)
    expect(f.filter()).toEqual({ urls: ['ws://*/*', 'wss://*/*'] })
  })

  test('removes Origin from an app hub socket and nothing else', () => {
    const f = fakeSession()
    attachHubSocketOriginStrip(f.sess, PROD)
    const res = f.send({
      resourceType: 'webSocket',
      url: REMOTE,
      frame: { url: PROD },
      requestHeaders: { ...HANDSHAKE }
    })
    expect(res?.requestHeaders).toEqual({
      'User-Agent': 'Mozilla/5.0',
      Cookie: 'ARRAffinity=abc',
      'Sec-WebSocket-Version': '13'
    })
  })

  test('matches the header name case-insensitively', () => {
    const f = fakeSession()
    attachHubSocketOriginStrip(f.sess, DEV)
    const res = f.send({
      resourceType: 'webSocket',
      url: REMOTE,
      frame: { url: `${DEV}/` },
      requestHeaders: { origin: DEV, 'user-agent': 'x' }
    })
    expect(res?.requestHeaders).toEqual({ 'user-agent': 'x' })
  })

  test('leaves every other request untouched', () => {
    const f = fakeSession()
    attachHubSocketOriginStrip(f.sess, PROD)
    const res = f.send({
      resourceType: 'webSocket',
      url: REMOTE,
      frame: { url: 'https://evil.example/' },
      requestHeaders: { ...HANDSHAKE }
    })
    expect(res, 'empty response = headers as sent').toEqual({})
  })

  test('a frame disposed before the handshake fails closed', () => {
    const f = fakeSession()
    attachHubSocketOriginStrip(f.sess, PROD)
    const frame = {
      get url(): string {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed')
      }
    }
    const res = f.send({
      resourceType: 'webSocket',
      url: REMOTE,
      frame,
      requestHeaders: { ...HANDSHAKE }
    })
    expect(res).toEqual({})
  })
})
