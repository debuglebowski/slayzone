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

// --- Idle-close: the hub's "Auto-close idle agents" setting, applied to chats ---

const NO_PRESSURE = async () => ({
  memory: { memoryTotal: 100, memoryAvailable: 90, memoryPressure: 0 },
  nativePressure: false
})

function idleCloseHub(opts: {
  idleCloseMs: number | null | (() => number | null)
  candidates: Array<{ taskId: string; idleFor: number }>
  refuse?: string[]
}) {
  const hibernated: string[] = []
  const checks: Array<{ tabId: string; check: unknown }> = []
  const now = Date.now()
  const candidates: HibernateCandidate[] = opts.candidates.map(({ taskId, idleFor }) => ({
    tabId: `tab-${taskId}`,
    taskId,
    idleSince: now - idleFor,
    async hibernate(allow) {
      if (!(await allow())) return false
      hibernated.push(taskId)
      return true
    }
  }))
  return {
    hibernated,
    checks,
    source: {
      inventory: () => ({
        hibernated: hibernated.length,
        candidates: candidates.filter((c) => !hibernated.includes(c.taskId))
      }),
      canHibernate: async (tabId: string, check?: unknown) => {
        checks.push({ tabId, check })
        return !(opts.refuse ?? []).some((taskId) => tabId === `tab-${taskId}`)
      },
      idleCloseMs: async () =>
        typeof opts.idleCloseMs === 'function' ? opts.idleCloseMs() : opts.idleCloseMs
    }
  }
}

test('idle-close: with the hub setting on, every chat idle past the window hibernates without pressure', async () => {
  vi.useFakeTimers().setSystemTime(10 * 60 * 60_000)
  const hub = idleCloseHub({
    idleCloseMs: 30 * 60_000,
    candidates: [
      { taskId: 'idle-10h', idleFor: 10 * 60 * 60_000 },
      { taskId: 'idle-40m', idleFor: 40 * 60_000 },
      { taskId: 'recent', idleFor: 5 * 60_000 },
      { taskId: 'device-pinned', idleFor: 60 * 60_000 },
      { taskId: 'hub-refused', idleFor: 60 * 60_000 }
    ],
    refuse: ['hub-refused']
  })
  const health = createComputerHealth({
    managed: true,
    config: { pinnedTaskIds: ['device-pinned'] },
    isolation: null,
    chats: () => [hub.source],
    sampleMemory: NO_PRESSURE,
    onAdmissionEvent() {},
    log() {}
  })
  try {
    await vi.advanceTimersByTimeAsync(12_000)
    expect(health.snapshot().pressure).toBe(false)
    expect(hub.hibernated.sort()).toEqual(['idle-10h', 'idle-40m'])
    // The hub is asked with the reason and how long the chat has been idle, so it
    // can re-check its own setting (and engagement) at the moment of hibernation.
    expect(hub.checks).toContainEqual({
      tabId: 'tab-idle-40m',
      check: { reason: 'idle', idleForMs: 40 * 60_000 }
    })
    expect(hub.checks.map((c) => c.tabId)).not.toContain('tab-recent')
    expect(hub.checks.map((c) => c.tabId)).not.toContain('tab-device-pinned')
  } finally {
    health.stop()
    vi.useRealTimers()
  }
})

test('idle-close: a chat hibernates once it crosses the window on a later sweep', async () => {
  vi.useFakeTimers().setSystemTime(10 * 60 * 60_000)
  const hub = idleCloseHub({
    idleCloseMs: 60_000,
    candidates: [{ taskId: 'soon', idleFor: 30_000 }]
  })
  const health = createComputerHealth({
    managed: true,
    config: {},
    isolation: null,
    chats: () => [hub.source],
    sampleMemory: NO_PRESSURE,
    onAdmissionEvent() {},
    log() {}
  })
  try {
    await vi.advanceTimersByTimeAsync(12_000)
    expect(hub.hibernated).toEqual([])
    await vi.advanceTimersByTimeAsync(30_000)
    expect(hub.hibernated).toEqual(['soon'])
  } finally {
    health.stop()
    vi.useRealTimers()
  }
})

test('idle-close: the window is the hub setting; idleBeforeHibernateMs neither lengthens nor shortens it', async () => {
  vi.useFakeTimers().setSystemTime(10 * 60 * 60_000)
  const hub = idleCloseHub({
    idleCloseMs: 60_000,
    candidates: [
      { taskId: 'past-window', idleFor: 2 * 60_000 },
      { taskId: 'within-window', idleFor: 20_000 }
    ]
  })
  const health = createComputerHealth({
    managed: true,
    config: { idleBeforeHibernateMs: 10_000 },
    isolation: null,
    chats: () => [hub.source],
    sampleMemory: NO_PRESSURE,
    onAdmissionEvent() {},
    log() {}
  })
  try {
    await vi.advanceTimersByTimeAsync(12_000)
    expect(hub.hibernated).toEqual(['past-window'])
  } finally {
    health.stop()
    vi.useRealTimers()
  }
})

test('idle-close: off at the hub (or an older hub) hibernates nothing without pressure', async () => {
  vi.useFakeTimers().setSystemTime(10 * 60 * 60_000)
  const off = idleCloseHub({ idleCloseMs: null, candidates: [{ taskId: 'a', idleFor: 3_600_000 }] })
  const olderHub = idleChat([])
  const health = createComputerHealth({
    managed: true,
    config: {},
    isolation: null,
    chats: () => [off.source, olderHub],
    sampleMemory: NO_PRESSURE,
    onAdmissionEvent() {},
    log() {}
  })
  try {
    await vi.advanceTimersByTimeAsync(30_000)
    expect(off.hibernated).toEqual([])
    expect(olderHub.inventory().hibernated).toBe(0)
  } finally {
    health.stop()
    vi.useRealTimers()
  }
})

test('idle-close applies on the desktop app computer too (unmanaged): it is the user setting, not memory management', async () => {
  vi.useFakeTimers().setSystemTime(10 * 60 * 60_000)
  const hub = idleCloseHub({ idleCloseMs: 60_000, candidates: [{ taskId: 'a', idleFor: 3_600_000 }] })
  const health = createComputerHealth({
    managed: false,
    config: {},
    isolation: null,
    chats: () => [hub.source],
    sampleMemory: NO_PRESSURE,
    onAdmissionEvent() {},
    log() {}
  })
  try {
    await vi.advanceTimersByTimeAsync(12_000)
    expect(hub.hibernated).toEqual(['a'])
  } finally {
    health.stop()
    vi.useRealTimers()
  }
})

test('idle-close: agentResources.hibernate=false keeps this computer from hibernating any chat', async () => {
  vi.useFakeTimers().setSystemTime(10 * 60 * 60_000)
  const hub = idleCloseHub({ idleCloseMs: 60_000, candidates: [{ taskId: 'a', idleFor: 3_600_000 }] })
  const health = createComputerHealth({
    managed: true,
    config: { hibernate: false },
    isolation: null,
    chats: () => [hub.source],
    sampleMemory: NO_PRESSURE,
    onAdmissionEvent() {},
    log() {}
  })
  try {
    await vi.advanceTimersByTimeAsync(30_000)
    expect(hub.hibernated).toEqual([])
  } finally {
    health.stop()
    vi.useRealTimers()
  }
})

test('idle-close: the setting turned off between the sweep and the hibernation stops it', async () => {
  vi.useFakeTimers().setSystemTime(10 * 60 * 60_000)
  let window: number | null = 60_000
  const hub = idleCloseHub({
    idleCloseMs: () => window,
    candidates: [{ taskId: 'a', idleFor: 3_600_000 }]
  })
  // The hub's own re-check is what refuses; model it turning the setting off.
  const source = {
    ...hub.source,
    canHibernate: async (tabId: string, check?: unknown) => {
      window = null
      return hub.source.canHibernate(tabId, check).then(() => false)
    }
  }
  const health = createComputerHealth({
    managed: true,
    config: {},
    isolation: null,
    chats: () => [source],
    sampleMemory: NO_PRESSURE,
    onAdmissionEvent() {},
    log() {}
  })
  try {
    await vi.advanceTimersByTimeAsync(30_000)
    expect(hub.hibernated).toEqual([])
  } finally {
    health.stop()
    vi.useRealTimers()
  }
})

test('memory reclamation asks the hub with reason pressure, also with idle-close off', async () => {
  vi.useFakeTimers().setSystemTime(10 * 60 * 60_000)
  const hub = idleCloseHub({ idleCloseMs: null, candidates: [{ taskId: 'a', idleFor: 3_600_000 }] })
  const health = createComputerHealth({
    managed: true,
    config: {},
    isolation: null,
    chats: () => [hub.source],
    sampleMemory: async () => ({
      memory: { memoryTotal: 100, memoryAvailable: 1, memoryPressure: 0 },
      nativePressure: false
    }),
    onAdmissionEvent() {},
    log() {}
  })
  try {
    await vi.advanceTimersByTimeAsync(0)
    expect(hub.hibernated).toEqual(['a'])
    expect(hub.checks).toEqual([{ tabId: 'tab-a', check: { reason: 'pressure' } }])
  } finally {
    health.stop()
    vi.useRealTimers()
  }
})
