import { test, expect, resetApp } from '../fixtures/electron'

declare global {
  interface Window {
    __testInvoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  }
}

type SidecarStatus = {
  health: 'starting' | 'ready' | 'restarting' | 'failed'
  port: number | null
  pid: number | null
  restarts: number
  totalRespawns: number
  dbPath: string | null
  uptimeMs: number | null
}

/**
 * Slice 7 — embedded server crash + recovery.
 *
 * Kills the supervised @slayzone/server side-car child with SIGKILL and
 * asserts the supervisor respawns it to a healthy state. A healthy-crash
 * respawn is immediate (no backoff) and does NOT move `restarts` — the
 * lifetime `totalRespawns` counter is the observable signal.
 */
test.describe('Sidecar crash recovery', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('supervisor respawns a SIGKILLed sidecar back to ready', async ({
    electronApp,
    mainWindow
  }) => {
    const status = async (): Promise<SidecarStatus> =>
      (await mainWindow.evaluate(() =>
        window.__testInvoke('app:get-sidecar-status')
      )) as SidecarStatus

    // Sidecar boots off the critical path — wait for the first healthy state.
    await expect.poll(async () => (await status()).health, { timeout: 30_000 }).toBe('ready')

    const before = await status()
    expect(before.pid).toBeTruthy()

    await electronApp.evaluate((_electron, pid) => {
      process.kill(pid, 'SIGKILL')
    }, before.pid!)

    // Respawned: healthy again, new pid, lifetime counter moved.
    await expect
      .poll(
        async () => {
          const s = await status()
          return s.health === 'ready' && s.pid !== before.pid
            ? { respawns: s.totalRespawns - before.totalRespawns }
            : null
        },
        { timeout: 20_000 }
      )
      .toEqual({ respawns: 1 })
  })
})
