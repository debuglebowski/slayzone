import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import {
  PDF_VIEWER_LINK_MESSAGE_TYPE,
  buildPdfViewerLinkBridgeScript,
  parsePdfViewerLinkMessage,
  resolvePdfLinkAction
} from './pdf-viewer-links'

/** Mirrors Electron's PDF viewer frame: `chrome.tabs` has `update` but no `create`. */
function makeViewerFrame() {
  const postMessage = vi.fn()
  const originalUpdate = vi.fn(() => Promise.resolve('orig'))
  const tabs: Record<string, unknown> = { update: originalUpdate, get: vi.fn() }
  const window: Record<string, unknown> = { chrome: { tabs }, top: { postMessage } }
  const run = (): unknown => runInNewContext(buildPdfViewerLinkBridgeScript(), { window, Promise })
  return { tabs, postMessage, originalUpdate, run }
}

const posted = (intent: string, url: string) => [
  { type: PDF_VIEWER_LINK_MESSAGE_TYPE, intent, url },
  '*'
]

describe('PDF viewer link bridge script', () => {
  it('turns ⌘ click (tabs.create active:false) into a background-tab message', () => {
    const f = makeViewerFrame()
    expect(f.run()).toBe('installed')
    ;(f.tabs.create as (p: unknown) => unknown)({ url: 'https://example.com/', active: false })
    expect(f.postMessage).toHaveBeenCalledWith(...posted('background-tab', 'https://example.com/'))
  })

  it('turns ⌘⇧ click (tabs.create active:true) into a foreground-tab message', () => {
    const f = makeViewerFrame()
    f.run()
    ;(f.tabs.create as (p: unknown) => unknown)({ url: 'https://example.com/', active: true })
    expect(f.postMessage).toHaveBeenCalledWith(...posted('foreground-tab', 'https://example.com/'))
  })

  it('turns a bare click (tabs.update with url) into a current-tab message instead of navigating', () => {
    const f = makeViewerFrame()
    f.run()
    ;(f.tabs.update as (...a: unknown[]) => unknown)(2, { url: 'https://example.com/' })
    expect(f.postMessage).toHaveBeenCalledWith(...posted('current-tab', 'https://example.com/'))
    expect(f.originalUpdate).not.toHaveBeenCalled()
  })

  it('passes non-navigation tabs.update calls through', () => {
    const f = makeViewerFrame()
    f.run()
    ;(f.tabs.update as (...a: unknown[]) => unknown)(2, { muted: true })
    expect(f.originalUpdate).toHaveBeenCalledWith(2, { muted: true })
    expect(f.postMessage).not.toHaveBeenCalled()
  })

  it('is idempotent', () => {
    const f = makeViewerFrame()
    f.run()
    const create = f.tabs.create
    expect(f.run()).toBe('already-installed')
    expect(f.tabs.create).toBe(create)
  })
})

describe('parsePdfViewerLinkMessage', () => {
  it('accepts a well-formed http(s) message', () => {
    const msg = {
      type: PDF_VIEWER_LINK_MESSAGE_TYPE,
      intent: 'foreground-tab',
      url: 'https://a.b/'
    }
    expect(parsePdfViewerLinkMessage(msg)).toEqual(msg)
  })

  it.each([
    null,
    'x',
    { type: 'other', intent: 'current-tab', url: 'https://a.b/' },
    { type: PDF_VIEWER_LINK_MESSAGE_TYPE, intent: 'new-window', url: 'https://a.b/' },
    { type: PDF_VIEWER_LINK_MESSAGE_TYPE, intent: 'current-tab', url: 'javascript:alert(1)' },
    { type: PDF_VIEWER_LINK_MESSAGE_TYPE, intent: 'current-tab', url: 'file:///etc/passwd' },
    { type: PDF_VIEWER_LINK_MESSAGE_TYPE, intent: 'current-tab' }
  ])('rejects %j', (data) => {
    expect(parsePdfViewerLinkMessage(data)).toBeNull()
  })
})

describe('resolvePdfLinkAction', () => {
  it('follows the terminal/chat convention', () => {
    expect(resolvePdfLinkAction('background-tab')).toBe('in-app-browser')
    expect(resolvePdfLinkAction('foreground-tab')).toBe('external')
    expect(resolvePdfLinkAction('current-tab')).toBe('external')
  })
})
