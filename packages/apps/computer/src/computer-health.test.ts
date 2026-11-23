import { expect, test, vi } from 'vitest'
import {
  createComputerHealth,
  parseDarwinMemoryStatus,
  type HibernateCandidate
} from './computer-health'

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
    managed: true,
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

const idleChat = (hibernated: string[]) => ({
  inventory: () => ({
    hibernated: hibernated.length,
    candidates: [
      {
        tabId: 'idle',
        taskId: 'idle',
        idleSince: 0,
        async hibernate(allow: () => Promise<boolean>) {
          if (!(await allow())) return false
          hibernated.push('idle')
          return true
        }
      }
    ]
  }),
  canHibernate: async () => true
})

test('an unmanaged computer (the desktop app computer) neither holds starts nor hibernates chats', async () => {
  vi.useFakeTimers().setSystemTime(10 * 60_000)
  const hibernated: string[] = []
  const health = createComputerHealth({
    managed: false,
    config: {},
    isolation: null,
    chats: () => [idleChat(hibernated)],
    sampleMemory: async () => ({
      memory: { memoryTotal: 100, memoryAvailable: 1, memoryPressure: 50 },
      nativePressure: true
    }),
    onAdmissionEvent() {},
    log() {}
  })
  try {
    await vi.advanceTimersByTimeAsync(0)
    const started: string[] = []
    health.admission.enqueue('background', (slot) => {
      started.push('background')
      slot.track(1)
      slot.release()
    })
    expect(started).toEqual(['background'])
    expect(health.admission.acceptsWarm()).toBe(true)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(hibernated).toEqual([])
    expect(health.snapshot()).toMatchObject({ managed: false, pressure: true, live: 1 })
  } finally {
    health.stop()
    vi.useRealTimers()
  }
})

test('a managed computer reclaims an idle chat under pressure', async () => {
  vi.useFakeTimers().setSystemTime(10 * 60_000)
  const hibernated: string[] = []
  const health = createComputerHealth({
    managed: true,
    config: {},
    isolation: null,
    chats: () => [idleChat(hibernated)],
    sampleMemory: async () => ({
      memory: { memoryTotal: 100, memoryAvailable: 1, memoryPressure: 0 },
      nativePressure: false
    }),
    onAdmissionEvent() {},
    log() {}
  })
  try {
    await vi.advanceTimersByTimeAsync(0)
    expect(hibernated).toEqual(['idle'])
    expect(health.snapshot()).toMatchObject({ managed: true, pressure: true })
  } finally {
    health.stop()
    vi.useRealTimers()
  }
})

test('a failed memory sample is skipped: it neither reports pressure nor holds starts', async () => {
  vi.useFakeTimers().setSystemTime(100_000)
  const health = createComputerHealth({
    managed: true,
    config: {},
    isolation: null,
    chats: () => [],
    sampleMemory: async () => null,
    onAdmissionEvent() {},
    log() {}
  })
  try {
    await vi.advanceTimersByTimeAsync(0)
    const started: string[] = []
    health.admission.enqueue('background', (slot) => {
      started.push('background')
      slot.release()
    })
    expect(started).toEqual(['background'])
    expect(health.snapshot()).toMatchObject({ pressure: false, sampledAt: 0 })
  } finally {
    health.stop()
    vi.useRealTimers()
  }
})

test('a failed sample keeps the previous reading', async () => {
  vi.useFakeTimers().setSystemTime(100_000)
  let fail = false
  const health = createComputerHealth({
    managed: true,
    config: {},
    isolation: null,
    chats: () => [],
    sampleMemory: async () =>
      fail
        ? null
        : {
            memory: { memoryTotal: 100, memoryAvailable: 60, memoryPressure: 0 },
            nativePressure: false
          },
    onAdmissionEvent() {},
    log() {}
  })
  try {
    await vi.advanceTimersByTimeAsync(0)
    const first = health.snapshot()
    fail = true
    await vi.advanceTimersByTimeAsync(4_000)
    expect(health.snapshot()).toMatchObject({
      memoryAvailable: 60,
      sampledAt: first.sampledAt,
      pressure: false
    })
  } finally {
    health.stop()
    vi.useRealTimers()
  }
})

test('parses macOS memorystatus: percent free as macOS sees it, and the pressure level', () => {
  expect(parseDarwinMemoryStatus('85\n1\n')).toEqual({ freePercent: 85, pressureLevel: 1 })
  expect(parseDarwinMemoryStatus('7\n4\n')).toEqual({ freePercent: 7, pressureLevel: 4 })
  expect(parseDarwinMemoryStatus('42\n')).toEqual({ freePercent: 42, pressureLevel: null })
  for (const bad of ['', 'x\n1', '101\n1', '-1\n1', '4.5\n1'])
    expect(parseDarwinMemoryStatus(bad)).toBeNull()
})
