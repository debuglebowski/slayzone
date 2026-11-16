// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installUserLinkActivationReport, plainLinkActivationUrl } from './browser-link-activation'

function click(target: Element, init: MouseEventInit = {}): MouseEvent {
  const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init })
  target.dispatchEvent(e)
  return e
}

function linkEvent(html: string, init: MouseEventInit = {}): string | null {
  document.body.innerHTML = html
  let seen: string | null = 'unset'
  const listener = (e: Event) => {
    seen = plainLinkActivationUrl(e as MouseEvent)
  }
  window.addEventListener('click', listener, true)
  click(document.querySelector('[data-hit]')!, init)
  window.removeEventListener('click', listener, true)
  return seen
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('plainLinkActivationUrl', () => {
  it('a plain click on a link (or inside one) gives its absolute URL', () => {
    expect(linkEvent('<a data-hit href="http://localhost:3000/x#y">go</a>')).toBe(
      'http://localhost:3000/x#y'
    )
    expect(linkEvent('<a href="http://192.168.1.5/"><span data-hit>in</span></a>')).toBe(
      'http://192.168.1.5/'
    )
    expect(linkEvent('<a data-hit target="_top" href="https://example.com/">t</a>')).toBe(
      'https://example.com/'
    )
  })
  it('anything else is no link activation', () => {
    expect(linkEvent('<button data-hit>b</button>')).toBeNull()
    expect(linkEvent('<a data-hit href="javascript:void 0">j</a>')).toBeNull()
    expect(linkEvent('<a data-hit target="_blank" href="http://localhost/">n</a>')).toBeNull()
    expect(linkEvent('<a data-hit download href="http://localhost/f">d</a>')).toBeNull()
    expect(linkEvent('<a data-hit href="http://localhost/">m</a>', { metaKey: true })).toBeNull()
    expect(linkEvent('<a data-hit href="http://localhost/">c</a>', { ctrlKey: true })).toBeNull()
    expect(linkEvent('<a data-hit href="http://localhost/">s</a>', { shiftKey: true })).toBeNull()
    expect(linkEvent('<a data-hit href="http://localhost/">mid</a>', { button: 1 })).toBeNull()
  })
})

describe('installUserLinkActivationReport', () => {
  it('reports only trusted clicks: a page’s synthetic click on a link reports nothing', () => {
    const report = vi.fn()
    installUserLinkActivationReport(report)
    document.body.innerHTML = '<a id="l" href="http://localhost:3000/">go</a>'
    const a = document.getElementById('l')!
    click(a)
    ;(a as HTMLAnchorElement).click()
    expect(report).not.toHaveBeenCalled()
  })
})
