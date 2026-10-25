import { describe, expect, it } from 'vitest'
import { BOOT_MARKS, buildBootTimingsPayload, LONG_TASK_WINDOW_MS } from './bootTimings'

describe('buildBootTimingsPayload', () => {
  it('rounds the marks it finds, nulls the rest, and counts long tasks in the window only', () => {
    const at: Record<string, number> = {
      [BOOT_MARKS.tabStoreStart]: 266.4,
      [BOOT_MARKS.tabStoreEnd]: 291.6,
      [BOOT_MARKS.activeTabDetail]: 512.2
    }
    const payload = buildBootTimingsPayload({
      markAt: (name) => at[name] ?? null,
      longTasks: [
        { startTime: 900, duration: 120.4 },
        { startTime: 4000, duration: 300 },
        { startTime: LONG_TASK_WINDOW_MS + 1, duration: 999 }
      ],
      navigationType: 'reload',
      resources: [
        { initiatorType: 'script' },
        { initiatorType: 'script' },
        { initiatorType: 'css' }
      ]
    })
    expect(payload).toEqual({
      nav: 'reload',
      marks: {
        tabStoreStart: 266,
        tabStoreEnd: 292,
        reactMount: null,
        appMounted: null,
        themeEnd: null,
        dataReady: null,
        activeTabDetail: 512,
        allHydrated: null
      },
      longTasks: { n: 2, totalMs: 420, maxMs: 300, windowMs: LONG_TASK_WINDOW_MS },
      resources: { total: 3, scripts: 2 }
    })
    // One row per boot: keep it small.
    expect(JSON.stringify(payload).length).toBeLessThan(400)
  })
})
