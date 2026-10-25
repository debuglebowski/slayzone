/**
 * Restoring many task tabs at once (a renderer boot) must not build a renderer
 * per terminal.
 *
 * Measured on a 50-tab boot before the fix: every terminal loaded a WebGL
 * renderer whether or not it was visible (Chromium keeps ~16 contexts per
 * renderer, so 35 were force-lost), the frame-time heartbeat read the busy boot
 * as a slow GPU and latched EVERY terminal to the DOM renderer, and each DOM
 * renderer injected a ~790-rule theme stylesheet (38k rules document-wide).
 *
 * Now: a terminal that has not been on screen opens "parked" (no renderer
 * pixels, no stylesheet) and keeps parsing output; revealing it attaches WebGL
 * before the reveal paints; at most 8 WebGL renderers stay live (MRU), and
 * on-screen ones are never evicted.
 */
import type { Page } from '@playwright/test'
import { test, expect, seed, openTaskById, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import { getMainSessionId, waitForPtySession } from '../fixtures/terminal'

interface XTermLike {
  rows: number
  cols: number
  element?: HTMLElement
  buffer: {
    active: {
      length: number
      getLine: (i: number) => { translateToString: (trim?: boolean) => string } | undefined
    }
  }
  onRender: (cb: () => void) => { dispose: () => void }
}

type ProbeWindow = Window & {
  __slayzone_terminalLinks?: Record<string, { _terminal?: XTermLike }>
  __slayzone_tabStore: {
    getState: () => { openTask: (id: string) => void; openTaskInBackground: (id: string) => void }
  }
  __szLost?: number
  __szLongTasks?: number[]
}

const TERMINALS = 12
/** webgl-budget.ts MAX_LIVE_WEBGL_RENDERERS */
const WEBGL_CAP = 8

interface PaneState {
  sid: string
  canvases: number
  domRows: number
  sheetRules: number
  classes: string
}

async function panes(page: Page, sids: string[]): Promise<PaneState[]> {
  return page.evaluate((ids) => {
    const links = (window as unknown as ProbeWindow).__slayzone_terminalLinks ?? {}
    return ids.map((sid) => {
      const el = links[sid]?._terminal?.element
      let sheetRules = 0
      for (const s of Array.from(el?.querySelectorAll('style') ?? [])) {
        sheetRules += (s as HTMLStyleElement).sheet?.cssRules.length ?? 0
      }
      return {
        sid,
        // The WebGL renderer's own canvas: class-less, in .xterm-screen.
        canvases: el
          ? Array.from(el.querySelectorAll('.xterm-screen > canvas')).filter(
              (c) => !/-layer\b/.test(c.className)
            ).length
          : -1,
        domRows: el ? el.querySelectorAll('.xterm-rows').length : -1,
        classes: Array.from(el?.querySelectorAll('canvas') ?? [])
          .map((c) => c.className || '(none)')
          .join('|'),
        sheetRules
      }
    })
  }, sids)
}

async function bufferHas(page: Page, sid: string, needle: string): Promise<boolean> {
  return page.evaluate(
    ({ id, n }) => {
      const t = (window as unknown as ProbeWindow).__slayzone_terminalLinks?.[id]?._terminal
      if (!t) return false
      const buf = t.buffer.active
      for (let i = 0; i < buf.length; i++) {
        if (buf.getLine(i)?.translateToString(true).includes(n)) return true
      }
      return false
    },
    { id: sid, n: needle }
  )
}

test.describe('boot renderer economy', () => {
  const taskIds: string[] = []

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Boot Econ',
      color: '#0ea5e9',
      path: TEST_PROJECT_PATH
    })
    for (let i = 0; i < TERMINALS; i++) {
      const t = await s.createTask({
        projectId: p.id,
        title: `Boot econ ${i}`,
        status: 'in_progress',
        terminalMode: 'terminal'
      })
      taskIds.push(t.id)
    }
    await s.refreshData()
  })

  test('hidden terminals are parked, parse output, and get WebGL on reveal (capped)', async ({
    mainWindow
  }) => {
    test.setTimeout(180_000)
    const sids = taskIds.map(getMainSessionId)

    await mainWindow.evaluate(() => {
      const w = window as unknown as ProbeWindow
      w.__szLost = 0
      window.addEventListener('webglcontextlost', () => w.__szLost!++, true)
      w.__szLongTasks = []
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) w.__szLongTasks!.push(Math.round(e.duration))
      }).observe({ type: 'longtask' })
    })

    // "Boot": one visible tab plus every other tab mounted hidden at once.
    await openTaskById(mainWindow, taskIds[0])
    await mainWindow.evaluate((ids) => {
      const store = (window as unknown as ProbeWindow).__slayzone_tabStore.getState()
      for (const id of ids) store.openTaskInBackground(id)
    }, taskIds.slice(1))
    for (const sid of sids) await waitForPtySession(mainWindow, sid, 30_000)
    await expect
      .poll(
        () =>
          mainWindow.evaluate(
            (ids) =>
              ids.every(
                (id) =>
                  !!(window as unknown as ProbeWindow).__slayzone_terminalLinks?.[id]?._terminal
                    ?.element
              ),
            sids
          ),
        { timeout: 30_000 }
      )
      .toBe(true)

    const visible = (await panes(mainWindow, [sids[0]]))[0]
    const webglAvailable = visible.canvases > 0
    const boot = await panes(mainWindow, sids.slice(1))
    const longTasks = await mainWindow.evaluate(
      () => (window as unknown as ProbeWindow).__szLongTasks ?? []
    )
    console.log(
      `[boot-econ] webgl=${webglAvailable} visible=${JSON.stringify(visible)} ` +
        `hidden canvases=${boot.map((p) => p.canvases).join(',')} ` +
        `hidden domRows=${boot.map((p) => p.domRows).join(',')} ` +
        `hidden sheetRules=${boot.map((p) => p.sheetRules).join(',')} ` +
        `longTasks=${JSON.stringify(longTasks)} maxLongTask=${Math.max(0, ...longTasks)}`
    )
    test.skip(!webglAvailable, 'no WebGL in this environment — parking only applies with WebGL')

    // Never-shown terminals: no WebGL context, no DOM renderer, no theme stylesheet.
    for (const p of boot) {
      expect(p.canvases, `${p.sid} WebGL canvases`).toBe(0)
      expect(p.domRows, `${p.sid} DOM renderer`).toBe(0)
      expect(p.sheetRules, `${p.sid} renderer stylesheet rules`).toBeLessThan(10)
    }

    // A parked terminal keeps parsing output.
    const hidden = sids[5]
    await mainWindow.evaluate(
      (id) =>
        window.getTrpcVanillaClient().pty.write.mutate({ sessionId: id, data: 'echo PARKED-OK\r' }),
      hidden
    )
    await expect
      .poll(() => bufferHas(mainWindow, hidden, 'PARKED-OK'), { timeout: 10_000 })
      .toBe(true)

    // Reveal: WebGL attached and painted by the next frame.
    await mainWindow.evaluate((id) => {
      const w = window as unknown as ProbeWindow & { __szRevealPaints?: number }
      w.__szRevealPaints = 0
      w.__slayzone_terminalLinks![id]._terminal!.onRender(() => w.__szRevealPaints!++)
    }, hidden)
    // Frame by frame from the reveal: the frame the WebGL canvas appears in must
    // already be painted (or the very next one) — never a run of blank frames.
    const reveal = await mainWindow.evaluate(
      async ({ taskId, sid }) => {
        const w = window as unknown as ProbeWindow & { __szRevealPaints?: number }
        const el = w.__slayzone_terminalLinks![sid]._terminal!.element!
        w.__slayzone_tabStore.getState().openTask(taskId)
        let canvasFrame = -1
        let paintFrame = -1
        for (let f = 0; f < 60 && paintFrame < 0; f++) {
          await new Promise((r) => requestAnimationFrame(r))
          const hasCanvas = Array.from(el.querySelectorAll('.xterm-screen > canvas')).some(
            (c) => !/-layer\b/.test(c.className)
          )
          if (hasCanvas && canvasFrame < 0) canvasFrame = f
          if ((w.__szRevealPaints ?? 0) > 0) paintFrame = f
        }
        return { canvasFrame, paintFrame }
      },
      { taskId: taskIds[5], sid: hidden }
    )
    console.log(`[boot-econ] reveal ${JSON.stringify(reveal)}`)
    expect(reveal.canvasFrame, 'WebGL attached on reveal').toBeGreaterThanOrEqual(0)
    expect(reveal.paintFrame, 'painted on reveal').toBeGreaterThanOrEqual(0)
    expect(
      reveal.paintFrame - reveal.canvasFrame,
      'first paint lands in the frame the renderer appears in (or the next)'
    ).toBeLessThanOrEqual(1)
    expect((await panes(mainWindow, [hidden]))[0].canvases).toBe(1)

    // Visit every tab: live WebGL renderers never exceed the budget, and the one
    // on screen always has one.
    for (const id of taskIds) {
      await openTaskById(mainWindow, id)
      const sid = getMainSessionId(id)
      await expect.poll(async () => (await panes(mainWindow, [sid]))[0].canvases).toBe(1)
    }
    await expect
      .poll(async () => (await panes(mainWindow, sids)).filter((p) => p.canvases > 0).length, {
        timeout: 10_000
      })
      .toBeLessThanOrEqual(WEBGL_CAP)
    const lost = await mainWindow.evaluate(() => (window as unknown as ProbeWindow).__szLost ?? 0)
    expect(lost, 'no WebGL context was force-lost').toBe(0)

    // An evicted terminal comes back with WebGL and its output on reveal.
    const evicted = (await panes(mainWindow, sids)).find((p) => p.canvases === 0)
    expect(evicted, 'something was evicted over the cap').toBeTruthy()
    const evictedTask = taskIds[sids.indexOf(evicted!.sid)]
    await openTaskById(mainWindow, evictedTask)
    await expect.poll(async () => (await panes(mainWindow, [evicted!.sid]))[0].canvases).toBe(1)
  })
})
