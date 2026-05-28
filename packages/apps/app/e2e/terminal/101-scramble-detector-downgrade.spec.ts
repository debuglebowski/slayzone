/**
 * End-to-end test for the WebGL renderer scramble-detector downgrade flow.
 *
 * Asserts the user-visible contract of T1 (see plan/goal-move-xterm-rendering):
 *
 *   1. When a detection signal fires, a toast surfaces the downgrade with a
 *      "Retry WebGL" action.
 *   2. Clicking Retry re-loads the WebGL renderer for the session.
 *   3. Toggling `terminal_force_compatibility_renderer` to ON disposes the
 *      live WebGL addon and prevents future re-loads for the session.
 *
 * The "downgrade" is simulated via the `window.__slayzone_scrambleDetector`
 * test hook so the test never depends on real GPU state (Playwright runs on
 * SwiftShader in CI — no Metal eviction would ever fire there).
 */
import {
  test,
  expect,
  seed,
  resetApp,
  TEST_PROJECT_PATH
} from '../fixtures/electron'
import { getMainSessionId, openTaskTerminal, waitForPtySession } from '../fixtures/terminal'

interface ScrambleDetectorApi {
  fireDowngrade: (sessionId: string, reason: string) => boolean
  sessions: () => string[]
}

interface DiagEvent {
  t: number
  sessionId: string
  event: 'webgl-load' | 'atlas-correct' | 'fit' | 'webgl-context-loss'
  site?: string
}

test.describe('terminal scramble-detector downgrade flow', () => {
  let projectAbbrev: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Scramble Test',
      color: '#f97316',
      path: TEST_PROJECT_PATH
    })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    const task = await s.createTask({
      projectId: p.id,
      title: 'Scramble detector flow',
      status: 'in_progress'
    })
    await mainWindow.evaluate(
      (id) => window.api.db.updateTask({ id, terminalMode: 'terminal' }),
      task.id
    )
    taskId = task.id
    await s.refreshData()
  })

  test('downgrade fires toast, retry re-loads WebGL, settings flag forces DOM renderer', async ({
    mainWindow
  }) => {
    test.setTimeout(120_000)

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Scramble detector flow' })
    const sid = getMainSessionId(taskId)
    await waitForPtySession(mainWindow, sid)

    // 1. Wait for WebGL load — the scramble-detector registry only registers
    //    once the addon has actually attached.
    await expect
      .poll(
        () =>
          mainWindow.evaluate(
            (id) =>
              (
                window as unknown as {
                  __slayzone_scrambleDetector?: ScrambleDetectorApi
                }
              ).__slayzone_scrambleDetector?.sessions() ?? [],
            sid
          ).then((sessions) => sessions.includes(sid)),
        { timeout: 20_000 }
      )
      .toBe(true)

    // Capture the count of `webgl-load` events for this session pre-downgrade
    // so the post-retry assertion can prove a *new* load fired (vs. the
    // initial mount's load).
    const initialLoads = await mainWindow.evaluate(
      (s: string) =>
        (
          window as unknown as {
            __slayzone_terminalDiag?: { dump: (s?: string) => DiagEvent[] }
          }
        ).__slayzone_terminalDiag
          ?.dump(s)
          .filter((e: DiagEvent) => e.event === 'webgl-load').length ?? 0,
      sid
    )
    expect(initialLoads, 'WebGL loaded at least once on mount').toBeGreaterThanOrEqual(1)

    // 2. Fire a synthetic Signal C (canary) downgrade via the test hook.
    const fired = await mainWindow.evaluate(
      ([s, r]) =>
        (
          window as unknown as {
            __slayzone_scrambleDetector: ScrambleDetectorApi
          }
        ).__slayzone_scrambleDetector.fireDowngrade(s as string, r as string),
      [sid, 'canary'] as const
    )
    expect(fired, 'fireDowngrade returned true (session was registered)').toBe(true)

    // 3. Toast must appear with the compatibility-renderer message + Retry action.
    const toast = mainWindow.locator('[data-sonner-toast]:visible', {
      hasText: 'compatibility renderer'
    })
    await expect(toast).toBeVisible({ timeout: 5_000 })
    const retry = toast.getByRole('button', { name: /retry webgl/i })
    await expect(retry).toBeVisible()

    // 4. Click Retry → WebGL must re-load. The detector hook adds the session
    //    to `downgradedSessions`; Retry removes it and re-invokes
    //    `triggerWebglLoad`, which schedules another `loadWebglRenderer` →
    //    new `webgl-load` diag event.
    await retry.click()
    await expect
      .poll(
        () =>
          mainWindow.evaluate(
            (s: string) =>
              (
                window as unknown as {
                  __slayzone_terminalDiag?: { dump: (s?: string) => DiagEvent[] }
                }
              ).__slayzone_terminalDiag
                ?.dump(s)
                .filter((e: DiagEvent) => e.event === 'webgl-load').length ?? 0,
            sid
          ),
        { timeout: 10_000 }
      )
      .toBeGreaterThan(initialLoads)

    // 5. Force-compatibility toggle. Flip the setting on, fire another fake
    //    downgrade, click Retry — WebGL must NOT re-load because the gate
    //    inside `triggerWebglLoad` checks `forceCompatRef.current`.
    await mainWindow.evaluate(() =>
      window.api.settings.set('terminal_force_compatibility_renderer', '1')
    )
    // Settings change is observed via the `sz:settings-changed` event the
    // AppearanceProvider listens to. Dispatch it so the provider re-reads.
    await mainWindow.evaluate(() =>
      window.dispatchEvent(new Event('sz:settings-changed'))
    )

    // Wait for the toggle effect to observe the new value and dispose any
    // live addon (the registry should still have the session but the gate
    // will short-circuit further loads).
    await mainWindow.evaluate(
      () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => requestAnimationFrame(() => r()))
          )
        )
    )

    const loadsBeforeForce = await mainWindow.evaluate(
      (s: string) =>
        (
          window as unknown as {
            __slayzone_terminalDiag?: { dump: (s?: string) => DiagEvent[] }
          }
        ).__slayzone_terminalDiag
          ?.dump(s)
          .filter((e: DiagEvent) => e.event === 'webgl-load').length ?? 0,
      sid
    )

    // Trigger downgrade + retry under the force-compat gate.
    await mainWindow.evaluate(
      ([s, r]) =>
        (
          window as unknown as {
            __slayzone_scrambleDetector: ScrambleDetectorApi
          }
        ).__slayzone_scrambleDetector.fireDowngrade(s as string, r as string),
      [sid, 'canary'] as const
    )
    const toast2 = mainWindow
      .locator('[data-sonner-toast]:visible', { hasText: 'compatibility renderer' })
      .last()
    await expect(toast2).toBeVisible({ timeout: 5_000 })
    const retry2 = toast2.getByRole('button', { name: /retry webgl/i })
    await retry2.click()

    // 1.5s grace for the rAF chain in triggerWebglLoad to either fire (would
    // be a regression) or no-op (expected).
    await mainWindow.waitForTimeout(1500)

    const loadsAfterForce = await mainWindow.evaluate(
      (s: string) =>
        (
          window as unknown as {
            __slayzone_terminalDiag?: { dump: (s?: string) => DiagEvent[] }
          }
        ).__slayzone_terminalDiag
          ?.dump(s)
          .filter((e: DiagEvent) => e.event === 'webgl-load').length ?? 0,
      sid
    )
    expect(
      loadsAfterForce,
      'force-compat gate prevented a new WebGL load on Retry'
    ).toBe(loadsBeforeForce)

    // Reset the setting so subsequent tests start clean.
    await mainWindow.evaluate(() =>
      window.api.settings.set('terminal_force_compatibility_renderer', '0')
    )
  })
})
