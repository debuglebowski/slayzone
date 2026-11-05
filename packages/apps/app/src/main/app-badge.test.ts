import { describe, expect, it, vi } from 'vitest'
import { applyAppBadge, parseAppBadgePayload, type AppBadgeHost } from './app-badge'

const PNG = 'data:image/png;base64,iVBORw0KGgo='

function host(platform: NodeJS.Platform) {
  return {
    platform,
    setDockBadge: vi.fn<AppBadgeHost['setDockBadge']>(),
    setBadgeCount: vi.fn<AppBadgeHost['setBadgeCount']>(),
    setOverlayIcon: vi.fn<AppBadgeHost['setOverlayIcon']>()
  } satisfies AppBadgeHost
}

describe('parseAppBadgePayload', () => {
  it('accepts a well-formed payload', () => {
    expect(parseAppBadgePayload({ text: '3', count: 3, overlayPng: PNG })).toEqual({
      text: '3',
      count: 3,
      overlayPng: PNG
    })
  })

  it('accepts a cleared badge', () => {
    expect(parseAppBadgePayload({ text: '', count: 0, overlayPng: null })).toEqual({
      text: '',
      count: 0,
      overlayPng: null
    })
  })

  it('rejects junk', () => {
    expect(parseAppBadgePayload(null)).toBeNull()
    expect(parseAppBadgePayload('3')).toBeNull()
    expect(parseAppBadgePayload({ text: 3, count: 3, overlayPng: null })).toBeNull()
    expect(parseAppBadgePayload({ text: '3', count: -1, overlayPng: null })).toBeNull()
    expect(parseAppBadgePayload({ text: '3', count: 1.5, overlayPng: null })).toBeNull()
    expect(parseAppBadgePayload({ text: 'x'.repeat(17), count: 1, overlayPng: null })).toBeNull()
  })

  it('drops an overlay that is not a small png data url', () => {
    expect(
      parseAppBadgePayload({ text: '1', count: 1, overlayPng: 'file:///etc/passwd' })?.overlayPng
    ).toBeNull()
    expect(
      parseAppBadgePayload({
        text: '1',
        count: 1,
        overlayPng: `data:image/png;base64,${'A'.repeat(200_000)}`
      })?.overlayPng
    ).toBeNull()
  })
})

describe('applyAppBadge', () => {
  it('macOS: sets the dock badge text', () => {
    const h = host('darwin')
    applyAppBadge(h, { text: '2·3', count: 4, overlayPng: PNG })
    expect(h.setDockBadge).toHaveBeenCalledWith('2·3')
    expect(h.setBadgeCount).not.toHaveBeenCalled()
    expect(h.setOverlayIcon).not.toHaveBeenCalled()
  })

  it('macOS: clears with an empty string', () => {
    const h = host('darwin')
    applyAppBadge(h, { text: '', count: 0, overlayPng: null })
    expect(h.setDockBadge).toHaveBeenCalledWith('')
  })

  it('Linux: sets the numeric count', () => {
    const h = host('linux')
    applyAppBadge(h, { text: '•', count: 2, overlayPng: null })
    expect(h.setBadgeCount).toHaveBeenCalledWith(2)
    expect(h.setDockBadge).not.toHaveBeenCalled()
  })

  it('Windows: sets the overlay icon with the text as description', () => {
    const h = host('win32')
    applyAppBadge(h, { text: '5', count: 5, overlayPng: PNG })
    expect(h.setOverlayIcon).toHaveBeenCalledWith(PNG, '5')
  })

  it('Windows: clears the overlay when the badge is empty', () => {
    const h = host('win32')
    applyAppBadge(h, { text: '', count: 0, overlayPng: PNG })
    expect(h.setOverlayIcon).toHaveBeenCalledWith(null, '')
  })
})
