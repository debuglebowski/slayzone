/**
 * VERIFICATION spec for commit 45a8c880 — terminal WebGL atlas instrumentation.
 * Drives a real terminal mount + window resize, then reads the diagnostics
 * ring buffer (window.__slayzone_terminalDiag) to confirm events are recorded
 * with geometry. Not part of the regression suite — a /verify driver.
 */
import {
  test,
  expect,
  seed,
  resetApp,
  clickProject,
  TEST_PROJECT_PATH
} from '../fixtures/electron'
import { getMainSessionId, waitForPtySession, openTaskTerminal } from '../fixtures/terminal'

interface DiagEvent {
  t: number
  sessionId: string
  event: string
  site?: string
  geom?: {
    cellDeviceW: number
    cellDeviceH: number
    cellCssW: number
    cellCssH: number
    dpr: number
    cols: number
    rows: number
  }
  dirty?: boolean
}

test.describe('WebGL atlas diagnostics instrumentation', () => {
  let projectAbbrev: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Diag Verify',
      color: '#22d3ee',
      path: TEST_PROJECT_PATH
    })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    const t = await s.createTask({
      projectId: p.id,
      title: 'Diag verify task',
      status: 'in_progress'
    })
    taskId = t.id
    await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.update.mutate({ id, terminalMode: 'terminal' }),
      taskId
    )
    await s.refreshData()
  })

  test('records webgl/fit events with geometry, resize fires a fresh fit', async ({
    mainWindow,
    electronApp
  }) => {
    test.setTimeout(90_000)

    const logs: string[] = []
    mainWindow.on('console', (m) => {
      const t = m.text()
      if (t.includes('[term-diag]')) logs.push(t)
    })

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Diag verify task' })
    const sessionId = getMainSessionId(taskId)
    await waitForPtySession(mainWindow, sessionId)

    // The diag global must exist once Terminal.tsx (importing the module) mounts.
    await expect
      .poll(
        async () =>
          mainWindow.evaluate(
            () =>
              typeof (window as unknown as { __slayzone_terminalDiag?: unknown })
                .__slayzone_terminalDiag
          ),
        { timeout: 15_000 }
      )
      .toBe('object')

    const readDiag = (prefix: string): Promise<DiagEvent[]> =>
      mainWindow.evaluate(
        (p) =>
          (
            window as unknown as {
              __slayzone_terminalDiag: { dump: (s?: string) => DiagEvent[] }
            }
          ).__slayzone_terminalDiag.dump(p),
        prefix
      )

    // Wait until the initial fit has been recorded for this session.
    await expect
      .poll(async () => (await readDiag(taskId)).some((e) => e.event === 'fit'), {
        timeout: 15_000
      })
      .toBe(true)

    const afterMount = await readDiag(taskId)
    console.log('[verify] events after mount:', JSON.stringify(afterMount, null, 1))

    // A fit event must carry real cell geometry.
    const fitWithGeom = afterMount.find((e) => e.event === 'fit' && e.geom)
    expect(fitWithGeom, 'a fit event with geometry').toBeTruthy()
    expect(fitWithGeom!.geom!.cellDeviceW).toBeGreaterThan(0)
    expect(fitWithGeom!.geom!.cellDeviceH).toBeGreaterThan(0)
    expect(fitWithGeom!.geom!.cols).toBeGreaterThan(0)

    const fitCountBefore = afterMount.filter((e) => e.event === 'fit').length

    // Probe: resize the OS window → Terminal's ResizeObserver → fit() → diag.
    const sizes = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(
        (w) =>
          !w.isDestroyed() &&
          w.webContents.getURL() !== 'about:blank' &&
          !w.webContents.getURL().startsWith('data:')
      )
      if (!win) return { before: null, after: null }
      const before = win.getSize()
      win.setSize(1240, 880)
      win.center()
      return { before, after: win.getSize() }
    })
    console.log('[verify] window resize:', JSON.stringify(sizes))

    await expect
      .poll(async () => (await readDiag(taskId)).filter((e) => e.event === 'fit').length, {
        timeout: 10_000
      })
      .toBeGreaterThan(fitCountBefore)

    const afterResize = await readDiag(taskId)
    const resizeFits = afterResize.filter((e) => e.event === 'fit' && e.site === 'resize-observer')
    const probeFit = resizeFits[resizeFits.length - 1]
    console.log('[verify] probe resize-observer fit:', JSON.stringify(probeFit, null, 1))
    expect(probeFit, 'a resize-observer fit event').toBeTruthy()

    // THE FIX: a post-startup fit must schedule an atlas correction. Startup
    // corrections all fire within ~750ms of webgl-load; the probe fit happens
    // seconds later, so an atlas-correct at-or-after probeFit.t can only be the
    // post-fit correction scheduleAtlasCorrection() now triggers.
    await expect
      .poll(
        async () =>
          (await readDiag(taskId)).some(
            (e) => e.event === 'atlas-correct' && e.t >= probeFit.t
          ),
        { timeout: 5_000 }
      )
      .toBe(true)

    const final = await readDiag(taskId)
    const postFitCorrection = final.find(
      (e) => e.event === 'atlas-correct' && e.t >= probeFit.t
    )
    console.log(
      '[verify] post-fit atlas-correct:',
      JSON.stringify(postFitCorrection, null, 1)
    )
    console.log('[verify] webgl-load present:', final.some((e) => e.event === 'webgl-load'))
    console.log(
      '[verify] atlas-correct count:',
      final.filter((e) => e.event === 'atlas-correct').length
    )
    console.log('[verify] dirty events:', JSON.stringify(final.filter((e) => e.dirty)))
    console.log('[verify] console [term-diag] lines captured:', logs.length)
    for (const l of logs.slice(0, 40)) console.log('  ', l)
  })
})
