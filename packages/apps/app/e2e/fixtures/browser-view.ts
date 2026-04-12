/**
 * Shared helpers for browser-view E2E tests.
 *
 * All helpers assume a task tab is open and the test is running inside
 * the shared Electron worker fixture.
 */
import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { pressShortcut } from './shortcuts'

// ── IPC bridge ──────────────────────────────────────────────────────

/** Invoke an IPC channel directly via the renderer's __testInvoke bridge. */
export async function testInvoke(page: Page, channel: string, ...args: unknown[]): Promise<unknown> {
  return page.evaluate(async ({ c, a }) => {
    const invoke = (window as unknown as { __testInvoke?: (ch: string, ...rest: unknown[]) => Promise<unknown> }).__testInvoke
    if (!invoke) throw new Error('__testInvoke unavailable in e2e')
    return invoke(c, ...(a ?? []))
  }, { c: channel, a: args })
}

/** Simulate a main→renderer IPC event via the renderer's __testEmit bridge. */
export async function testEmit(page: Page, channel: string, data: unknown): Promise<void> {
  await page.evaluate(({ c, d }) => {
    const emit = (window as unknown as { __testEmit?: (ch: string, data: unknown) => void }).__testEmit
    if (!emit) throw new Error('__testEmit unavailable in e2e')
    emit(c, d)
  }, { c: channel, d: data })
}

// ── Locator helpers ─────────────────────────────────────────────────

export const urlInput = (page: Page) =>
  page.locator('input[placeholder="Enter URL..."]:visible').first()

export const tabBar = (page: Page) =>
  page.locator('.h-10.overflow-x-auto:visible').first()

export const tabEntries = (page: Page) =>
  tabBar(page).locator('[role="button"]:not(:has(.lucide-plus))')

export const newTabBtn = (page: Page) =>
  tabBar(page).locator('button:has(.lucide-plus)').first()

// ── Focus & shortcut helpers ────────────────────────────────────────

/** Move focus away from any editor/text input so app-level shortcuts fire. */
export async function focusForAppShortcut(page: Page): Promise<void> {
  await page.keyboard.press('Escape').catch(() => {})
  const sidebar = page.locator('[data-slot="sidebar"]').first()
  if (await sidebar.isVisible().catch(() => false)) {
    await sidebar.click({ position: { x: 12, y: 12 } }).catch(() => {})
  } else {
    await page.locator('#root').click({ position: { x: 12, y: 12 } }).catch(() => {})
  }
}

/**
 * Ensure the browser panel is open. Retries the Cmd+B shortcut up to 5 times
 * with a small delay between attempts (handles race where isActive hasn't
 * propagated yet after beforeAll's task navigation).
 */
export async function ensureBrowserPanelVisible(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (await urlInput(page).isVisible().catch(() => false)) return
    await focusForAppShortcut(page)
    await page.waitForTimeout(150)
    await page.keyboard.press('Meta+b')
    await page.waitForTimeout(300)
  }
  await expect(urlInput(page)).toBeVisible({ timeout: 5000 })
}

/** Close the browser panel if it's currently visible. */
export async function ensureBrowserPanelHidden(page: Page): Promise<void> {
  if (await urlInput(page).isVisible().catch(() => false)) {
    await focusForAppShortcut(page)
    await page.waitForTimeout(150)
    await page.keyboard.press('Meta+b')
    await expect(urlInput(page)).not.toBeVisible({ timeout: 5000 })
  }
}

// ── Task navigation ─────────────────────────────────────────────────

export async function openTaskViaSearch(page: Page, title: string): Promise<void> {
  await pressShortcut(page, 'search')
  const input = page.getByPlaceholder('Search files, tasks, projects...')
  await expect(input).toBeVisible()
  await input.fill(title)
  await page.keyboard.press('Enter')
  await expect(input).not.toBeVisible()
}

// ── View helpers ────────────────────────────────────────────────────

export async function getViewsForTask(page: Page, taskId: string): Promise<string[]> {
  return (await testInvoke(page, 'browser:get-views-for-task', taskId)) as string[]
}

export async function getAllViewIds(page: Page): Promise<string[]> {
  return (await testInvoke(page, 'browser:get-all-view-ids')) as string[]
}

/** Wait for at least one view to exist for a task and return the first viewId. */
export async function getActiveViewId(page: Page, taskId: string): Promise<string> {
  let viewId = ''
  await expect.poll(async () => {
    const views = await getViewsForTask(page, taskId)
    viewId = views?.[0] ?? ''
    return viewId
  }, { timeout: 10000 }).toBeTruthy()
  return viewId
}
