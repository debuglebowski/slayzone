import fs from 'node:fs'
import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import type { ElectronApplication, Page } from '@playwright/test'

// Classic layout parity (docs/plans/panel-model.md step 5): the task view renders
// through the layout model (TaskLayoutView) pixel-identically to the legacy flat
// panel strip. The expected boxes below were captured from the build BEFORE the
// renderer swap (`SLZ_PARITY_CAPTURE=<file>` writes them to <file> instead of
// asserting). A strip wider than the window scrolls: its 15px scrollbar is in
// the heights.
//
// Each entry is one flex item of #task-panels (a direct child, or the child of a
// `display: contents` wrapper — the panel hosts that let panels survive moves add
// no box), left to right: [id, x, y, width, height] relative to #task-panels.
// Panels are their data-panel-id, resize handles `|`, the anchor gap `gap`.

type Box = [string, number, number, number, number]

const PANEL_IDS = [
  'terminal',
  'browser',
  'editor',
  'artifacts',
  'diff',
  'settings',
  'processes'
] as const

interface Scenario {
  name: string
  panelVisibility: typeof ALL_OFF
  panelSizes?: Record<string, { unit: 'px' | 'fr' | 'pct'; value: number }>
  /** panel_config overrides applied while this scenario is open. */
  config?: { layout?: Record<string, unknown>; settingsFirst?: boolean }
}

const ALL_OFF: Record<(typeof PANEL_IDS)[number], boolean> = {
  terminal: false,
  browser: false,
  editor: false,
  artifacts: false,
  diff: false,
  settings: false,
  processes: false
}

const SCENARIOS: Scenario[] = [
  { name: 'default', panelVisibility: { ...ALL_OFF, terminal: true, settings: true } },
  {
    name: 'agent-browser-settings',
    panelVisibility: { ...ALL_OFF, terminal: true, browser: true, settings: true }
  },
  {
    name: 'agent-editor-git-settings',
    panelVisibility: { ...ALL_OFF, terminal: true, editor: true, diff: true, settings: true }
  },
  {
    name: 'agent-artifacts-processes',
    panelVisibility: { ...ALL_OFF, terminal: true, artifacts: true, processes: true }
  },
  { name: 'settings-only', panelVisibility: { ...ALL_OFF, settings: true } },
  {
    name: 'everything',
    panelVisibility: {
      terminal: true,
      browser: true,
      editor: true,
      artifacts: true,
      diff: true,
      settings: true,
      processes: true
    }
  },
  {
    name: 'sized-overrides',
    panelVisibility: { ...ALL_OFF, terminal: true, editor: true, settings: true },
    panelSizes: {
      settings: { unit: 'px', value: 600 },
      terminal: { unit: 'fr', value: 2 },
      editor: { unit: 'fr', value: 1 }
    }
  },
  {
    name: 'right-anchored',
    panelVisibility: { ...ALL_OFF, terminal: true, diff: true, settings: true },
    config: {
      layout: {
        terminal: { unit: 'px', value: 300, align: 'left' },
        settings: { unit: 'px', value: 320, align: 'right' }
      }
    }
  },
  {
    name: 'reordered',
    panelVisibility: { ...ALL_OFF, terminal: true, browser: true, settings: true },
    config: { settingsFirst: true }
  }
]

const SIZES: [number, number][] = [
  [1600, 1000],
  [1100, 800]
]

// biome-ignore format: generated table, one entry per line
const EXPECTED: Record<string, Box[]> = {
  'default@1600x1000': [['terminal', 16, 16, 1032, 841], ['|', 1048, 16, 16, 841], ['settings', 1064, 16, 440, 841]],
  'agent-browser-settings@1600x1000': [['terminal', 16, 16, 508, 841], ['|', 524, 16, 16, 841], ['browser', 540, 16, 508, 841], ['|', 1048, 16, 16, 841], ['settings', 1064, 16, 440, 841]],
  'agent-editor-git-settings@1600x1000': [['terminal', 16, 16, 333, 841], ['|', 349, 16, 16, 841], ['editor', 365, 16, 333, 841], ['|', 699, 16, 16, 841], ['diff', 715, 16, 333, 841], ['|', 1048, 16, 16, 841], ['settings', 1064, 16, 440, 841]],
  'agent-artifacts-processes@1600x1000': [['terminal', 16, 16, 428, 841], ['|', 444, 16, 16, 841], ['artifacts', 460, 16, 428, 841], ['|', 888, 16, 16, 841], ['processes', 904, 16, 600, 841]],
  'settings-only@1600x1000': [['settings', 16, 16, 1488, 841]],
  'everything@1600x1000': [['terminal', 16, 16, 200, 826], ['|', 216, 16, 16, 826], ['browser', 232, 16, 200, 826], ['|', 432, 16, 16, 826], ['editor', 448, 16, 250, 826], ['|', 698, 16, 16, 826], ['artifacts', 714, 16, 200, 826], ['|', 914, 16, 16, 826], ['diff', 930, 16, 50, 826], ['|', 980, 16, 16, 826], ['settings', 996, 16, 440, 826], ['|', 1436, 16, 16, 826], ['processes', 1452, 16, 600, 826]],
  'sized-overrides@1600x1000': [['terminal', 16, 16, 571, 841], ['|', 587, 16, 16, 841], ['editor', 603, 16, 285, 841], ['|', 888, 16, 16, 841], ['settings', 904, 16, 600, 841]],
  'right-anchored@1600x1000': [['terminal', 16, 16, 300, 841], ['|', 316, 16, 16, 841], ['diff', 332, 16, 836, 841], ['gap', 1168, 16, 0, 841], ['|', 1168, 16, 16, 841], ['settings', 1184, 16, 320, 841]],
  'reordered@1600x1000': [['settings', 16, 16, 440, 841], ['|', 456, 16, 16, 841], ['terminal', 472, 16, 508, 841], ['|', 980, 16, 16, 841], ['browser', 996, 16, 508, 841]],
  'default@1100x800': [['terminal', 16, 16, 532, 641], ['|', 548, 16, 16, 641], ['settings', 564, 16, 440, 641]],
  'agent-browser-settings@1100x800': [['terminal', 16, 16, 258, 641], ['|', 274, 16, 16, 641], ['browser', 290, 16, 258, 641], ['|', 548, 16, 16, 641], ['settings', 564, 16, 440, 641]],
  'agent-editor-git-settings@1100x800': [['terminal', 16, 16, 200, 641], ['|', 216, 16, 16, 641], ['editor', 232, 16, 250, 641], ['|', 482, 16, 16, 641], ['diff', 498, 16, 50, 641], ['|', 548, 16, 16, 641], ['settings', 564, 16, 440, 641]],
  'agent-artifacts-processes@1100x800': [['terminal', 16, 16, 200, 626], ['|', 216, 16, 16, 626], ['artifacts', 232, 16, 200, 626], ['|', 432, 16, 16, 626], ['processes', 448, 16, 600, 626]],
  'settings-only@1100x800': [['settings', 16, 16, 988, 641]],
  'everything@1100x800': [['terminal', 16, 16, 200, 626], ['|', 216, 16, 16, 626], ['browser', 232, 16, 200, 626], ['|', 432, 16, 16, 626], ['editor', 448, 16, 250, 626], ['|', 698, 16, 16, 626], ['artifacts', 714, 16, 200, 626], ['|', 914, 16, 16, 626], ['diff', 930, 16, 50, 626], ['|', 980, 16, 16, 626], ['settings', 996, 16, 440, 626], ['|', 1436, 16, 16, 626], ['processes', 1452, 16, 600, 626]],
  'sized-overrides@1100x800': [['terminal', 16, 16, 200, 626], ['|', 216, 16, 16, 626], ['editor', 232, 16, 250, 626], ['|', 482, 16, 16, 626], ['settings', 498, 16, 600, 626]],
  'right-anchored@1100x800': [['terminal', 16, 16, 300, 641], ['|', 316, 16, 16, 641], ['diff', 332, 16, 336, 641], ['gap', 668, 16, 0, 641], ['|', 668, 16, 16, 641], ['settings', 684, 16, 320, 641]],
  'reordered@1100x800': [['settings', 16, 16, 440, 641], ['|', 456, 16, 16, 641], ['terminal', 472, 16, 258, 641], ['|', 730, 16, 16, 641], ['browser', 746, 16, 258, 641]],
}

async function resizeWindow(app: ElectronApplication, width: number, height: number) {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows().find(
        (w) =>
          !w.isDestroyed() &&
          w.webContents.getURL() !== 'about:blank' &&
          !w.webContents.getURL().startsWith('data:')
      )
      if (win) win.setSize(size.width, size.height)
    },
    { width, height }
  )
}

/** panel_config = the baseline (`base`, captured before the run) with `patch` applied. */
async function setPanelConfig(page: Page, base: string | null, patch: Scenario['config'] | null) {
  const cfg = base ? JSON.parse(base) : {}
  cfg.webPanels = cfg.webPanels ?? []
  if (patch?.layout) cfg.layout = patch.layout
  if (patch?.settingsFirst)
    cfg.order = ['settings', ...((cfg.order ?? []) as string[]).filter((id) => id !== 'settings')]
  await seed(page).setSetting('panel_config', JSON.stringify(cfg))
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('panel-config-changed')))
}

/** Activate the scenario's task tab and wait until its panel strip shows exactly its panels. */
async function openScenario(page: Page, taskId: string, sc: Scenario) {
  const want = PANEL_IDS.filter((id) => sc.panelVisibility[id]).sort()
  await expect(async () => {
    await page.evaluate((id) => {
      const fn = (window as Window & { __slayzone_openTask?: (i: string) => void })
        .__slayzone_openTask
      if (!fn) throw new Error('__slayzone_openTask not exposed yet')
      fn(id)
    }, taskId)
    await expect
      .poll(
        () =>
          page
            .locator('#task-panels:visible')
            .evaluate((root) => {
              // The strip's flex items, seen through `display: contents` wrappers.
              const items = (el: Element): HTMLElement[] =>
                Array.from(el.children).flatMap((c) =>
                  getComputedStyle(c).display === 'contents' ? items(c) : [c as HTMLElement]
                )
              return items(root)
                .map((el) => el.dataset.panelId)
                .filter((id): id is string => !!id)
                .sort()
            })
            .catch(() => [] as string[]),
        { timeout: 5_000 }
      )
      .toEqual(want)
  }).toPass({ timeout: 20_000 })
}

/** Flex items of the visible #task-panels as [id, x, y, w, h] relative to it. */
async function stripBoxes(page: Page): Promise<Box[]> {
  return page.locator('#task-panels:visible').evaluate((root) => {
    const r = root.getBoundingClientRect()
    const out: [string, number, number, number, number][] = []
    // The strip's flex items, seen through `display: contents` wrappers.
    const items = (el: Element): HTMLElement[] =>
      Array.from(el.children).flatMap((c) =>
        getComputedStyle(c).display === 'contents' ? items(c) : [c as HTMLElement]
      )
    for (const el of items(root)) {
      const b = el.getBoundingClientRect()
      if (b.width === 0 && b.height === 0) continue
      const id =
        el.dataset.panelId ??
        (el.dataset.testid === 'panel-resize-handle'
          ? '|'
          : el.dataset.testid === 'panel-gap'
            ? 'gap'
            : el.tagName.toLowerCase())
      out.push([
        id,
        Math.round(b.left - r.left),
        Math.round(b.top - r.top),
        Math.round(b.width),
        Math.round(b.height)
      ])
    }
    return out.sort((a, b) => a[1] - b[1])
  })
}

/** Boxes once three reads 150ms apart agree (layout settled after a resize/config change). */
async function settledBoxes(page: Page): Promise<Box[]> {
  let prev = ''
  let same = 0
  let boxes: Box[] = []
  await expect
    .poll(
      async () => {
        boxes = await stripBoxes(page)
        const cur = JSON.stringify(boxes)
        same = cur === prev && boxes.length > 0 ? same + 1 : 0
        prev = cur
        return same >= 2
      },
      { intervals: [150], timeout: 10_000 }
    )
    .toBe(true)
  return boxes
}

function expectBoxesClose(actual: Box[], expected: Box[], label: string) {
  expect(
    actual.map((b) => b[0]),
    `${label}: strip children`
  ).toEqual(expected.map((b) => b[0]))
  actual.forEach((box, i) => {
    for (const k of [1, 2, 3, 4] as const) {
      expect(
        Math.abs(box[k] - expected[i][k]),
        `${label}: ${box[0]} [${k}] ${box[k]} vs ${expected[i][k]}`
      ).toBeLessThanOrEqual(1)
    }
  })
}

test.describe('Classic layout parity', () => {
  test.describe.configure({ timeout: 180_000 })
  const taskIds: Record<string, string> = {}
  let baseConfig: string | null = null

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Parity', color: '#0ea5e9', path: TEST_PROJECT_PATH })
    for (const sc of SCENARIOS) {
      const t = await s.createTask({ projectId: p.id, title: `Parity ${sc.name}`, status: 'todo' })
      await s.updateTask({
        id: t.id,
        panelVisibility: sc.panelVisibility,
        ...(sc.panelSizes ? { panelSizes: sc.panelSizes } : {})
      })
      taskIds[sc.name] = t.id
    }
    baseConfig = (await s.getSetting('panel_config')) ?? null
    await s.refreshData()
  })

  test.afterAll(async ({ mainWindow, electronApp }) => {
    await setPanelConfig(mainWindow, baseConfig, null)
    await resizeWindow(electronApp, 1400, 900)
  })

  test('panel boxes match the legacy strip', async ({ mainWindow, electronApp }) => {
    const captured: Record<string, Box[]> = {}
    const capture = process.env.SLZ_PARITY_CAPTURE
    for (const [w, h] of SIZES) {
      await resizeWindow(electronApp, w, h)
      // The window reports its new size before the page relayouts; wait until the
      // viewport has held still for a few frames.
      let lastViewport = ''
      await expect
        .poll(
          async () => {
            const vp = await mainWindow.evaluate(() =>
              JSON.stringify([
                window.outerWidth,
                window.outerHeight,
                window.innerWidth,
                window.innerHeight
              ])
            )
            const ok = vp === lastViewport && vp.startsWith(`[${w},${h},`)
            lastViewport = vp
            return ok
          },
          { intervals: [250], timeout: 10_000 }
        )
        .toBe(true)
      for (const sc of SCENARIOS) {
        await setPanelConfig(mainWindow, baseConfig, sc.config ?? null)
        await openScenario(mainWindow, taskIds[sc.name], sc)
        const key = `${sc.name}@${w}x${h}`
        const boxes = await settledBoxes(mainWindow)
        captured[key] = boxes
        if (!capture) expectBoxesClose(boxes, EXPECTED[key] ?? [], key)
      }
    }
    if (capture) fs.writeFileSync(capture, JSON.stringify(captured, null, 1))
  })
})
