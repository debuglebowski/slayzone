/**
 * hub-sign-in — which approval page `slay hub login` opens in a browser.
 *
 * The page comes from the hub's device-code answer. The CLI opens it only when it is on
 * the hub's own host (the desktop app's rule, `isHubOwnPage`): an answer that names any
 * other site is printed, never opened.
 *
 * Pure Node.
 */
import { describe, expect, test } from 'vitest'
import { openApprovalPage } from './hub-sign-in'

function opener(): { open: (url: string) => void; opened: string[] } {
  const opened: string[] = []
  return { open: (url) => opened.push(url), opened }
}

describe('openApprovalPage', () => {
  test('opens a page on the hub host', () => {
    const o = opener()
    const page = 'https://hub.example.com/device?user_code=ABCD-EFGH'
    expect(openApprovalPage('https://hub.example.com', page, o.open)).toBe(true)
    expect(o.opened).toEqual([page])
  })

  test('opens a page on the hub host when the hub URL carries a path', () => {
    const o = opener()
    const page = 'https://hub.example.com/device'
    expect(openApprovalPage('https://hub.example.com/slayzone', page, o.open)).toBe(true)
    expect(o.opened).toEqual([page])
  })

  test('does not open a page on another host', () => {
    const o = opener()
    expect(
      openApprovalPage('https://hub.example.com', 'https://evil.example.net/device', o.open)
    ).toBe(false)
    expect(o.opened).toEqual([])
  })

  test('does not open a page on the same hostname but another port', () => {
    const o = opener()
    expect(
      openApprovalPage('https://hub.example.com', 'https://hub.example.com:8443/device', o.open)
    ).toBe(false)
    expect(o.opened).toEqual([])
  })

  test('does not open a non-http page', () => {
    const o = opener()
    expect(openApprovalPage('https://hub.example.com', 'file:///etc/passwd', o.open)).toBe(false)
    expect(o.opened).toEqual([])
  })
})
