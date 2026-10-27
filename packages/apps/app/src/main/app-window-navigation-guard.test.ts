import { describe, expect, test } from 'vitest'
import { resolveAppWindowNavigation } from './app-window-navigation-guard'

const PROD = 'file:///Applications/SlayZone.app/Contents/Resources/app.asar/out/renderer/index.html'
const DEV = 'http://localhost:5173/'

describe('resolveAppWindowNavigation', () => {
  test('a website opens externally instead of replacing the app (PDF viewer fallback)', () => {
    expect(resolveAppWindowNavigation(PROD, 'https://example.com/fallback')).toBe('open-external')
    expect(resolveAppWindowNavigation(DEV, 'http://example.com/')).toBe('open-external')
  })

  test('mailto opens externally', () => {
    expect(resolveAppWindowNavigation(PROD, 'mailto:a@b.c')).toBe('open-external')
  })

  test('the app may navigate within itself', () => {
    expect(resolveAppWindowNavigation(PROD, `${PROD}?taskId=t1`)).toBe('allow')
    expect(resolveAppWindowNavigation(DEV, 'http://localhost:5173/?taskId=t1')).toBe('allow')
  })

  test('the dev server origin is the app only on its exact port', () => {
    expect(resolveAppWindowNavigation(DEV, 'http://localhost:3000/')).toBe('open-external')
  })

  test('another local file or app protocol is blocked outright', () => {
    expect(resolveAppWindowNavigation(PROD, 'file:///etc/passwd')).toBe('block')
    expect(resolveAppWindowNavigation(PROD, 'slz-file://app/Users/me/a.html')).toBe('block')
    expect(resolveAppWindowNavigation(PROD, 'figma://file/x')).toBe('block')
    expect(resolveAppWindowNavigation(PROD, 'not a url')).toBe('block')
  })

  test('before the first commit (no current URL) only external routing applies', () => {
    expect(resolveAppWindowNavigation('', 'https://example.com/')).toBe('open-external')
    expect(resolveAppWindowNavigation('', 'file:///x/index.html')).toBe('block')
  })
})
