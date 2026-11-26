import type { Locator, Page } from '@playwright/test'
import { expect, seed } from './electron'

// Helpers for specs that drive the task panel layout (docs/plans/panel-model.md):
// seed a task with a stored `panel_layout`, open it, read panel geometry, drag.

/** The kind of each primary (legacy-id) instance. */
const KIND_OF: Record<string, string> = {
  terminal: 'agent',
  browser: 'browser',
  editor: 'editor',
  artifacts: 'artifacts',
  diff: 'git',
  settings: 'settings',
  processes: 'processes'
}

export interface SlotSpec {
  id: string
  tabs: string[]
  weight?: number
  name?: string
  active?: string
}

export interface ColumnSpec {
  id: string
  slots: SlotSpec[]
}

/**
 * A v1 TaskLayout; every column is `1fr`. Primary instances by their legacy id;
 * another instance as `<kind>:<id>` (e.g. `git:aaaa1111`), its settings in `settings`.
 */
export function layoutOf(columns: ColumnSpec[], settings: Record<string, object> = {}) {
  const instances: Record<string, { id: string; kind: string; settings: object }> = {}
  return {
    v: 1,
    rev: 1,
    layoutId: 'classic',
    columns: columns.map((c) => ({
      id: c.id,
      size: { unit: 'fr', value: 1 },
      slots: c.slots.map((s) => {
        for (const id of s.tabs)
          instances[id] = {
            id,
            kind: KIND_OF[id] ?? id.split(':')[0],
            settings: settings[id] ?? {}
          }
        return {
          id: s.id,
          weight: s.weight ?? 1,
          activeInstanceId: s.active ?? s.tabs[0],
          tabs: s.tabs.map((instanceId) => ({ instanceId })),
          ...(s.name ? { name: s.name } : {})
        }
      })
    })),
    instances
  }
}

/** Create a task with `layout` stored and open its tab; resolves once `waitFor` panels show. */
export async function openTaskWithLayout(
  page: Page,
  projectId: string,
  title: string,
  layout: ReturnType<typeof layoutOf>,
  waitFor: string[],
  /** `agentId` for the new task; `update`: more fields stored with the layout (browserTabs …). */
  opts: { agentId?: string; update?: Record<string, unknown> } = {}
): Promise<string> {
  const s = seed(page)
  const t = await s.createTask({
    projectId,
    title,
    status: 'todo',
    ...(opts.agentId ? { agentId: opts.agentId } : {})
  } as Parameters<typeof s.createTask>[0])
  await s.updateTask({ id: t.id, panelLayout: layout, ...opts.update } as Parameters<
    typeof s.updateTask
  >[0])
  await s.refreshData()
  await expect(async () => {
    await page.evaluate((id) => {
      const fn = (window as Window & { __slayzone_openTask?: (i: string) => void })
        .__slayzone_openTask
      if (!fn) throw new Error('__slayzone_openTask not exposed yet')
      fn(id)
    }, t.id)
    await expect.poll(() => activeTaskId(page), { timeout: 5_000 }).toBe(t.id)
    // The tab switch commits with the new page (a transition): until its detail
    // page has mounted, the previous task's page is still the one on screen.
    await expect
      .poll(
        () =>
          page.evaluate(
            (id) => performance.getEntriesByName(`sz:taskDetail:${id}:mount`).length,
            t.id
          ),
        { timeout: 5_000 }
      )
      .toBeGreaterThan(0)
    for (const id of waitFor) await expect(panel(page, id)).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 20_000 })
  return t.id
}

/** The task id of the active app tab (from the exposed tab store), or null. */
export async function activeTaskId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const state = (
      window as unknown as {
        __slayzone_tabStore?: {
          getState?: () => { tabs?: { taskId?: string }[]; activeTabIndex: number }
        }
      }
    ).__slayzone_tabStore?.getState?.()
    return state?.tabs?.[state.activeTabIndex]?.taskId ?? null
  })
}

/** The visible task page's panel strip. */
export const strip = (page: Page): Locator => page.locator('#task-panels:visible')

export const panel = (page: Page, id: string): Locator =>
  strip(page).locator(`[data-panel-id="${id}"]`)

export const tab = (page: Page, id: string): Locator =>
  strip(page).locator(`[data-panel-tab="${id}"]`)

export const slot = (page: Page, id: string): Locator =>
  strip(page).locator(`[data-slot-id="${id}"]`).first()

export async function box(locator: Locator) {
  const b = await locator.boundingBox()
  if (!b) throw new Error('element has no box')
  return b
}

/** Tab ids of a group's strip, in DOM order. */
export async function stripTabs(page: Page, slotId: string): Promise<string[]> {
  return strip(page)
    .locator(`[data-tabstrip="${slotId}"] [data-panel-tab]`)
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.panelTab ?? ''))
}

/** Rounded boxes of every shown panel and tab in the strip, keyed by id. */
export async function layoutBoxes(page: Page): Promise<Record<string, number[]>> {
  return strip(page).evaluate((root) => {
    const out: Record<string, number[]> = {}
    for (const el of root.querySelectorAll<HTMLElement>('[data-panel-id], [data-panel-tab]')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      const key = el.dataset.panelTab ? `tab:${el.dataset.panelTab}` : (el.dataset.panelId ?? '')
      out[key] = [r.left, r.top, r.width, r.height].map(Math.round)
    }
    return out
  })
}

/**
 * Press on `from`'s center and move to the point at (rx, ry) of `to`'s box, in
 * steps (past dnd-kit's 5px activation). `whileHeld` runs before the release.
 */
export async function dragTo(
  page: Page,
  from: Locator,
  to: Locator,
  rx: number,
  ry: number,
  whileHeld?: () => Promise<void>
): Promise<void> {
  const a = await box(from)
  const b = await box(to)
  const sx = a.x + a.width / 2
  const sy = a.y + a.height / 2
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  await page.mouse.move(sx + 12, sy + 4, { steps: 4 })
  await page.mouse.move(b.x + b.width * rx, b.y + b.height * ry, { steps: 12 })
  // One more nudge so the last hit-test runs at the final point.
  await page.mouse.move(b.x + b.width * rx + 1, b.y + b.height * ry, { steps: 2 })
  if (whileHeld) await whileHeld()
  await page.mouse.up()
}

/** Resolves once no animation runs (a drop has settled). */
export async function settled(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length)
    )
    .toBe(0)
}

/** The stored layout of a task, as the hub returns it. */
export async function storedLayout(page: Page, taskId: string) {
  const tasks = (await seed(page).getTasks()) as { id: string; panel_layout?: unknown }[]
  return tasks.find((t) => t.id === taskId)?.panel_layout as
    | ReturnType<typeof layoutOf>
    | null
    | undefined
}

/** `[[slotTabs]]` per column of a stored layout. */
export function shapeOf(layout: ReturnType<typeof layoutOf> | null | undefined) {
  return (layout?.columns ?? []).map((c) => c.slots.map((s) => s.tabs.map((t) => t.instanceId)))
}
