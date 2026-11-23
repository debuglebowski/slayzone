import { expect, test, vi } from 'vitest'
import { createComputerHealth, type HibernateCandidate } from './computer-health'

test('reclaims the longest-idle eligible chat across hubs and stops when pressure clears', async () => {
  vi.useFakeTimers().setSystemTime(100_000)
  const stopped: string[] = []
  const checked: string[] = []
  let available = 10
  const candidate = (taskId: string, idleFor: number): HibernateCandidate => ({
    tabId: taskId,
    taskId,
    idleSince: Date.now() - idleFor,
    async hibernate(allow) {
      if (!(await allow())) return false
      stopped.push(taskId)
      available = 30
      return true
    }
  })
  const source = (candidates: HibernateCandidate[]) => ({
    inventory: () => ({ hibernated: stopped.length, candidates }),
    canHibernate: async (tabId: string) => {
      checked.push(tabId)
      return tabId !== 'hub-pinned'
    }
  })
  const hubs = [
    source([candidate('newer', 15_000), candidate('device-pinned', 45_000)]),
    source([
      candidate('recent', 2_000),
      candidate('oldest-eligible', 25_000),
      candidate('hub-pinned', 40_000)
    ])
  ]
  const health = createComputerHealth({
    config: { idleBeforeHibernateMs: 10_000, pinnedTaskIds: ['device-pinned'] },
    isolation: null,
    chats: () => hubs,
    sampleMemory: async () => ({
      memory: { memoryTotal: 100, memoryAvailable: available, memoryPressure: 0 },
      nativePressure: false
    }),
    onAdmissionEvent() {},
    log() {}
  })
  try {
    await vi.advanceTimersByTimeAsync(0)
    expect(checked).toEqual(['hub-pinned', 'oldest-eligible'])
    expect(stopped).toEqual(['oldest-eligible'])
    await vi.advanceTimersByTimeAsync(4_000)
    expect(health.snapshot().pressure).toBe(false)
    expect(stopped).toEqual(['oldest-eligible'])
  } finally {
    health.stop()
    vi.useRealTimers()
  }
})
