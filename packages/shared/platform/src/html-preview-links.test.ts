import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import {
  HTML_PREVIEW_LINK_MESSAGE_TYPE,
  buildHtmlPreviewLinkBridgeScript,
  isHtmlPreviewFrameUrl,
  parseHtmlPreviewLinkMessage
} from './html-preview-links'

type Listener = (e: unknown) => void

/** Minimal sandboxed-iframe window: listeners on `window`, `top.postMessage`. */
function makePreviewFrame() {
  const postMessage = vi.fn()
  const listeners: Record<string, Listener[]> = {}
  const window: Record<string, unknown> = {
    top: { postMessage },
    addEventListener: (type: string, fn: Listener) => {
      ;(listeners[type] ??= []).push(fn)
    }
  }
  const document = { baseURI: 'slz-file://app/Users/me/a/index.html' }
  const run = (): unknown =>
    runInNewContext(buildHtmlPreviewLinkBridgeScript(), { window, document, URL })
  const dispatch = (type: string, e: unknown) => {
    for (const fn of listeners[type] ?? []) fn(e)
  }
  return { postMessage, listeners, run, dispatch }
}

function anchorTarget(href: string | null) {
  const anchor = { getAttribute: (n: string) => (n === 'href' ? href : null) }
  return { closest: (sel: string) => (sel === 'a[href]' && href !== null ? anchor : null) }
}

function click(href: string | null, init: Partial<Record<string, unknown>> = {}) {
  return {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    defaultPrevented: false,
    target: anchorTarget(href),
    preventDefault: vi.fn(),
    ...init
  }
}

describe('HTML preview link bridge script', () => {
  it('relays a bare http click with its modifiers and stops the frame navigating', () => {
    const f = makePreviewFrame()
    expect(f.run()).toBe('installed')
    const e = click('https://example.com/x')
    f.dispatch('click', e)
    expect(e.preventDefault).toHaveBeenCalled()
    expect(f.postMessage).toHaveBeenCalledWith(
      {
        type: HTML_PREVIEW_LINK_MESSAGE_TYPE,
        url: 'https://example.com/x',
        metaKey: false,
        ctrlKey: false,
        shiftKey: false
      },
      '*'
    )
  })

  it('carries ⌘⇧ modifiers', () => {
    const f = makePreviewFrame()
    f.run()
    f.dispatch('click', click('https://example.com/', { metaKey: true, shiftKey: true }))
    expect(f.postMessage.mock.calls[0][0]).toMatchObject({ metaKey: true, shiftKey: true })
  })

  it('relays mailto links', () => {
    const f = makePreviewFrame()
    f.run()
    f.dispatch('click', click('mailto:a@b.c'))
    expect(f.postMessage.mock.calls[0][0]).toMatchObject({ url: 'mailto:a@b.c' })
  })

  it('leaves hash, relative and non-web links to the page', () => {
    const f = makePreviewFrame()
    f.run()
    for (const href of ['#top', 'other.html', 'javascript:void 0', 'figma://x']) {
      const e = click(href)
      f.dispatch('click', e)
      expect(e.preventDefault).not.toHaveBeenCalled()
    }
    expect(f.postMessage).not.toHaveBeenCalled()
  })

  it('ignores clicks the page already handled, non-anchor clicks and non-primary buttons', () => {
    const f = makePreviewFrame()
    f.run()
    f.dispatch('click', click('https://example.com/', { defaultPrevented: true }))
    f.dispatch('click', click(null))
    f.dispatch('click', click('https://example.com/', { button: 2 }))
    expect(f.postMessage).not.toHaveBeenCalled()
  })

  it('routes a middle click as a ⌘ click (background tab)', () => {
    const f = makePreviewFrame()
    f.run()
    const e = click('https://example.com/m', { button: 1 })
    f.dispatch('auxclick', e)
    expect(e.preventDefault).toHaveBeenCalled()
    expect(f.postMessage.mock.calls[0][0]).toMatchObject({
      url: 'https://example.com/m',
      metaKey: true,
      shiftKey: false
    })
  })

  it('is idempotent', () => {
    const f = makePreviewFrame()
    expect(f.run()).toBe('installed')
    expect(f.run()).toBe('already-installed')
    expect(f.listeners.click).toHaveLength(1)
  })
})

describe('parseHtmlPreviewLinkMessage', () => {
  const ok = {
    type: HTML_PREVIEW_LINK_MESSAGE_TYPE,
    url: 'https://example.com/',
    metaKey: true,
    ctrlKey: false,
    shiftKey: false
  }

  it('accepts a well-formed message', () => {
    expect(parseHtmlPreviewLinkMessage(ok)).toEqual(ok)
  })

  it('accepts mailto', () => {
    expect(parseHtmlPreviewLinkMessage({ ...ok, url: 'mailto:a@b.c' })?.url).toBe('mailto:a@b.c')
  })

  it.each([
    null,
    'x',
    { ...ok, type: 'other' },
    { ...ok, url: 'javascript:alert(1)' },
    { ...ok, url: 'slz-file://app/x' },
    { ...ok, url: 42 },
    { ...ok, metaKey: 'yes' }
  ])('rejects %j', (data) => {
    expect(parseHtmlPreviewLinkMessage(data)).toBeNull()
  })
})

describe('isHtmlPreviewFrameUrl', () => {
  it('matches slz-file documents only', () => {
    expect(isHtmlPreviewFrameUrl('slz-file://app/Users/me/a.html?v=1')).toBe(true)
    expect(isHtmlPreviewFrameUrl('file:///Users/me/a.html')).toBe(false)
    expect(isHtmlPreviewFrameUrl('http://localhost:5173/')).toBe(false)
    expect(isHtmlPreviewFrameUrl('slz-file://app/Users/me/a.pdf')).toBe(false)
  })
})
