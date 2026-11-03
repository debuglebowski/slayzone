/**
 * Background update checks never leave a rejected promise unhandled.
 *
 * Packaged pilot 2026-11-03: every boot recorded `main.unhandled_rejection`. The
 * boot check was `try { checkForUpdatesAndNotify() } catch {}` — the try only sees a
 * synchronous throw, and the check REJECTS (there: ENOENT on app-update.yml, a build
 * without publish config; on any build: offline, DNS, server errors). The failure is
 * already reported once by the updater's own 'error' event.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// A PLAIN stub, not vi.fn: vi.fn attaches its own handler to a returned promise
// (for mock.results), which marks the rejection handled and hides the bug.
const updater = vi.hoisted(() => ({
  impl: (() => Promise.resolve(null)) as () => Promise<unknown>,
  calls: 0,
  powerHandlers: new Map<string, () => void>()
}))

vi.mock('electron', () => ({
  app: { isPackaged: true },
  BrowserWindow: { getAllWindows: () => [] },
  powerMonitor: {
    on: (event: string, handler: () => void) => updater.powerHandlers.set(event, handler)
  },
  autoUpdater: { on: () => {} }
}))
vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: {
      autoInstallOnAppQuit: false,
      on: () => {},
      checkForUpdatesAndNotify: () => {
        updater.calls += 1
        return updater.impl()
      }
    }
  }
}))
vi.mock('@slayzone/diagnostics/server', () => ({ recordDiagnosticEvent: () => {} }))
vi.mock('./menu-events', () => ({ menuEvents: { emit: () => {} } }))

import { initAutoUpdater } from './auto-updater'

const unhandled: unknown[] = []
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason)
}

async function settle(): Promise<void> {
  // Node reports an unhandled rejection after the microtask queue drains.
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r))
}

beforeEach(() => {
  unhandled.length = 0
  updater.impl = () => Promise.resolve(null)
  updater.calls = 0
  updater.powerHandlers.clear()
  process.on('unhandledRejection', onUnhandled)
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  process.off('unhandledRejection', onUnhandled)
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const missingConfig = (): Promise<never> =>
  Promise.reject(
    Object.assign(new Error('ENOENT: no such file or directory, open app-update.yml'), {
      code: 'ENOENT'
    })
  )

describe('initAutoUpdater', () => {
  test('a failing boot check is handled', async () => {
    updater.impl = missingConfig
    initAutoUpdater()
    await settle()
    expect(updater.calls).toBe(1)
    expect(unhandled).toEqual([])
  })

  test('failing periodic and resume checks are handled too', async () => {
    updater.impl = missingConfig
    initAutoUpdater()
    vi.advanceTimersByTime(60 * 60 * 1000)
    updater.powerHandlers.get('resume')?.()
    await settle()
    expect(updater.calls).toBe(3)
    expect(unhandled).toEqual([])
  })

  test('a check that throws synchronously does not escape either', async () => {
    updater.impl = () => {
      throw new Error('updater not constructible')
    }
    expect(() => initAutoUpdater()).not.toThrow()
    expect(() => vi.advanceTimersByTime(60 * 60 * 1000)).not.toThrow()
    expect(() => updater.powerHandlers.get('resume')?.()).not.toThrow()
    await settle()
    expect(unhandled).toEqual([])
  })
})
