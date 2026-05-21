import { describe, expect, it } from 'vitest'
import { fileUrlToSlzFileUrl, slzFileUrlToFileUrl, toSlzFileUrl } from './slz-file-url'

describe('fileUrlToSlzFileUrl', () => {
  it('rewrites empty-host file URL into the slz-file scheme', () => {
    expect(fileUrlToSlzFileUrl('file:///Users/me/page.html')).toBe(
      'slz-file://app/Users/me/page.html'
    )
  })

  it('heals a URL corrupted by one bad round-trip', () => {
    expect(fileUrlToSlzFileUrl('file://app/Users/me/page.html')).toBe(
      'slz-file://app/Users/me/page.html'
    )
  })

  it('heals a URL corrupted by repeated bad round-trips', () => {
    expect(fileUrlToSlzFileUrl('file://appappapp/Users/me/page.html')).toBe(
      'slz-file://app/Users/me/page.html'
    )
  })

  it('leaves non-file URLs untouched', () => {
    expect(fileUrlToSlzFileUrl('https://example.com')).toBe('https://example.com')
  })
})

describe('slzFileUrlToFileUrl', () => {
  it('strips scheme + sentinel host back to empty-host file URL', () => {
    expect(slzFileUrlToFileUrl('slz-file://app/Users/me/page.html')).toBe(
      'file:///Users/me/page.html'
    )
  })

  it('passes non-matching URLs through unchanged', () => {
    expect(slzFileUrlToFileUrl('https://example.com')).toBe('https://example.com')
  })

  it('round-trips without prepending app (regression: file://app... bug)', () => {
    const original = 'file:///Users/me/page.html'
    const forward = fileUrlToSlzFileUrl(original)
    const back = slzFileUrlToFileUrl(forward)
    expect(back).toBe(original)
    // A second open must not accumulate `app`.
    expect(slzFileUrlToFileUrl(fileUrlToSlzFileUrl(back))).toBe(original)
  })
})

describe('toSlzFileUrl', () => {
  it('round-trips with slzFileUrlToFileUrl for absolute paths', () => {
    expect(slzFileUrlToFileUrl(toSlzFileUrl('/Users/me/page.html'))).toBe(
      'file:///Users/me/page.html'
    )
  })
})
