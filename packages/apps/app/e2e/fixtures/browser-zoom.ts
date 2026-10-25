import { expect, type ElectronApplication, type Page } from '@playwright/test'
import { testInvoke } from './browser-view'
import { getTestUrl } from './test-server'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface ViewportMetrics {
  innerWidth: number
  innerHeight: number
}

export async function getRendererZoom(page: Page): Promise<number> {
  return (await testInvoke(page, 'app:get-renderer-zoom-factor')) as number
}

export async function getBrowserZoom(page: Page, viewId: string): Promise<number> {
  return (await testInvoke(page, 'browser:get-zoom-factor', viewId)) as number
}

export async function getNativeBounds(page: Page, viewId: string): Promise<Rect> {
  return (await testInvoke(page, 'browser:get-actual-native-bounds', viewId)) as Rect
}

async function getPlaceholderBounds(page: Page, viewId: string): Promise<Rect> {
  return await page.evaluate((id) => {
    const element = document.querySelector(`[data-view-id="${id}"]`) as HTMLElement | null
    if (!element) throw new Error(`Missing placeholder for view ${id}`)
    const rect = element.getBoundingClientRect()
    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height
    }
  }, viewId)
}

export async function getViewportMetrics(page: Page): Promise<ViewportMetrics> {
  return await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight
  }))
}

export async function getWindowContentBounds(page: Page): Promise<Rect> {
  return (await testInvoke(page, 'window:get-content-bounds')) as Rect
}

export async function getDisplayScaleFactor(page: Page): Promise<number | null> {
  return (await testInvoke(page, 'window:get-display-scale-factor')) as number | null
}

function scaleRect(rect: Rect, scaleX: number, scaleY: number): Rect {
  return {
    x: Math.round(rect.x * scaleX),
    y: Math.round(rect.y * scaleY),
    width: Math.round(rect.width * scaleX),
    height: Math.round(rect.height * scaleY)
  }
}

export async function getExpectedNativeBounds(page: Page, viewId: string): Promise<Rect> {
  const [placeholderBounds, viewportMetrics, contentBounds] = await Promise.all([
    getPlaceholderBounds(page, viewId),
    getViewportMetrics(page),
    getWindowContentBounds(page)
  ])
  const scaleX = contentBounds.width / viewportMetrics.innerWidth
  const scaleY = contentBounds.height / viewportMetrics.innerHeight
  return scaleRect(placeholderBounds, scaleX, scaleY)
}

export async function expectNativeBoundsToMatchZoomAdjustedPlaceholder(
  page: Page,
  viewId: string,
  tolerance = 6
): Promise<void> {
  await expect
    .poll(async () => {
      const nativeBounds = await getNativeBounds(page, viewId)
      const expectedBounds = await getExpectedNativeBounds(page, viewId)
      return (
        Math.abs(nativeBounds.x - expectedBounds.x) <= tolerance &&
        Math.abs(nativeBounds.y - expectedBounds.y) <= tolerance &&
        Math.abs(nativeBounds.width - expectedBounds.width) <= tolerance &&
        Math.abs(nativeBounds.height - expectedBounds.height) <= tolerance
      )
    })
    .toBe(true)
}

/** Load the local fixture page — never the public internet (DNS filters, offline CI). */
export async function navigateToExample(page: Page, viewId: string): Promise<void> {
  await testInvoke(page, 'browser:navigate', viewId, await getTestUrl('/title-zoom-page'))
  await expect
    .poll(async () => (await testInvoke(page, 'browser:get-url', viewId)) as string)
    .toContain('/title-zoom-page')
}

export async function resizeMainWindow(
  electronApp: ElectronApplication,
  width: number,
  height: number
): Promise<void> {
  await electronApp.evaluate(
    ({ BrowserWindow }, size: { width: number; height: number }) => {
      const win = BrowserWindow.getAllWindows().find(
        (w) =>
          !w.isDestroyed() &&
          w.webContents.getURL() !== 'about:blank' &&
          !w.webContents.getURL().startsWith('data:')
      )
      if (!win) throw new Error('Main window not found')
      win.setSize(size.width, size.height)
      win.center()
    },
    { width, height }
  )
}
