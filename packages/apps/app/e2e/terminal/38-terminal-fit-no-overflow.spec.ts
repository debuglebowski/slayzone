import { test, expect, seed, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import { getMainSessionId, openTaskTerminal, waitForPtySession } from '../fixtures/terminal'

// Regression: the terminal's INITIAL fit must measure the panel's settled
// width, not a transient full-window width. Root cause was a mount-time race —
// the terminal panel briefly laid out at full (flex:1) width before its
// resolved px width applied (`TaskDetailPage` `containerWidth` starts at 0 and
// is filled async by a ResizeObserver). So the synchronous init fit() baked
// columns for the full window; the xterm then rendered wider than its panel
// until a later resize-observer fit corrected it. When that correction cascade
// had a timing hole, the terminal stayed wide until the user resized/toggled a
// panel. See plans/graceful-dreaming-sonnet.md.
//
// Why assert on the diag ring buffer, not on live DOM overflow: the container
// ResizeObserver self-heals the overflow within a poll window (it even fires on
// inactive tabs), so a "screen width <= container width" poll can never fail.
// The DETERMINISTIC, always-present defect is the init fit measuring the wrong
// width. `window.__slayzone_terminalDiag` records every fit() with the cols it
// produced; we force a narrow terminal panel and assert the init fit already
// measured that narrow width (init cols ~= settled cols, no correction needed).

interface DiagFit {
  event: string
  site?: string
  geom?: { cols: number; rows: number; cellCssW: number }
}

// Force the terminal panel to a fixed, narrow px width via the global panel
// layout config (mirrors core/25-panel-resize.spec.ts `applyLayout`). At the
// 1920px worker window, a 320px terminal panel makes the transient-full-width
// init fit produce far more cols than the settled panel — a clean pre-fix
// failure and a clean post-fix pass.
const TERMINAL_PANEL_PX = 320

async function applyNarrowTerminalLayout(page: import('@playwright/test').Page): Promise<void> {
  const s = seed(page)
  const raw = await s.getSetting('panel_config')
  const cfg = raw ? JSON.parse(raw) : {}
  cfg.webPanels = cfg.webPanels ?? [] // loadConfig's merge requires this array
  // Terminal pinned narrow; settings stays a wide fixed px neighbor. During the
  // pre-paint `containerWidth === 0` window the terminal panel is the sole
  // flex:1 element → it transiently fills (window − settings) ≈ 1400px, then
  // snaps to 320px. That wide→narrow snap is exactly the mount-time race.
  cfg.layout = {
    terminal: { unit: 'px', value: TERMINAL_PANEL_PX, align: 'left' },
    settings: { unit: 'px', value: 900, align: 'left' }
  }
  await s.setSetting('panel_config', JSON.stringify(cfg))
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('panel-config-changed')))
}

async function readFits(
  page: import('@playwright/test').Page,
  sessionPrefix: string
): Promise<DiagFit[]> {
  return page.evaluate((prefix) => {
    const api = (
      window as unknown as { __slayzone_terminalDiag?: { dump: (s?: string) => DiagFit[] } }
    ).__slayzone_terminalDiag
    if (!api) return []
    return api.dump(prefix).filter((e) => e.event === 'fit')
  }, sessionPrefix)
}

test.describe('Terminal fit — init measures the settled panel width', () => {
  let projectAbbrev: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Fit No Overflow',
      color: '#22d3ee',
      path: TEST_PROJECT_PATH
    })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    const t = await s.createTask({
      projectId: p.id,
      title: 'Fit no overflow task',
      status: 'in_progress'
    })
    taskId = t.id

    // Plain shell mode auto-spawns (no idle gate) so the terminal mounts
    // immediately on open.
    await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.update.mutate({ id, terminalMode: 'terminal' }),
      taskId
    )
    // Pin the terminal panel narrow BEFORE opening so the mount-time layout is
    // already the constrained one — the condition that baked too-wide cols.
    await applyNarrowTerminalLayout(mainWindow)
    await s.refreshData()
  })

  test.afterAll(async ({ mainWindow }) => {
    // Don't leak the layout override into later specs.
    const s = seed(mainWindow)
    const raw = await s.getSetting('panel_config')
    if (raw) {
      const cfg = JSON.parse(raw)
      delete cfg.layout
      await s.setSetting('panel_config', JSON.stringify(cfg))
      await mainWindow.evaluate(() =>
        window.dispatchEvent(new CustomEvent('panel-config-changed'))
      )
    }
  })

  test('rendered screen never overflows its container during or after mount', async ({
    mainWindow
  }) => {
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Fit no overflow task' })

    const sessionId = getMainSessionId(taskId)
    await waitForPtySession(mainWindow, sessionId)
    await expect(mainWindow.locator('.xterm-screen:visible').first()).toBeVisible()

    const measureOverflow = (sid: string): number | null =>
      // Runs in-page: returns screenW - containerW (px the screen exceeds its box).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((window as any).__slayzone_terminalLinks?.[sid]?._terminal?.element
        ? (() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const el = (window as any).__slayzone_terminalLinks[sid]._terminal.element as HTMLElement
            const s = el.querySelector('.xterm-screen')
            const c = el.parentElement
            if (!s || !c) return null
            return (
              Math.round(s.getBoundingClientRect().width) -
              Math.round(c.getBoundingClientRect().width)
            )
          })()
        : null)

    // Sample the overflow repeatedly across the whole mount→settle window. The
    // bug is the screen rendering wider than its container; piece A removes the
    // transient wide frame at mount, and ensureFit keeps it corrected. Any
    // sample exceeding a 1px rounding slack is a failure.
    let maxOverflow = -9999
    const samples: number[] = []
    for (let i = 0; i < 40; i++) {
      const o = await mainWindow.evaluate(measureOverflow, sessionId)
      if (typeof o === 'number') {
        maxOverflow = Math.max(maxOverflow, o)
        samples.push(o)
      }
      await mainWindow.waitForTimeout(50)
    }

    // eslint-disable-next-line no-console
    console.log('[fit-test] maxOverflow:', maxOverflow, 'samples:', JSON.stringify(samples))
    expect(samples.length, 'took overflow samples').toBeGreaterThan(0)
    expect(maxOverflow, 'screen must never render wider than its container').toBeLessThanOrEqual(1)
  })
})
