import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { cpus, freemem, totalmem } from 'node:os'
import { promisify } from 'node:util'
import { collectProcessStats } from '@slayzone/processes/pid-stats'
import type { ComputerAgentResources } from '@slayzone/platform/slayzone-config'
import type { ChatHibernateCheck, ComputerHealth } from '@slayzone/computer-transport/shared'
import type { AgentIsolation } from './agent-isolation'
import {
  createSpawnAdmission,
  defaultAdmissionConcurrency,
  type AdmissionEvent
} from './spawn-admission'

const MIB = 1024 * 1024
const MIN_AGENT_BYTES = 512 * MIB
const SAMPLE_INTERVAL_MS = 2_000
const FOOTPRINT_INTERVAL_MS = 20_000
const PSI_PRESSURE_PERCENT = 2
/** How often idle-close looks for chats past the hub's window (the hub's pty sweep runs every 10s too). */
const IDLE_CLOSE_INTERVAL_MS = 10_000
const exec = promisify(execFile)

export interface HibernateCandidate {
  tabId: string
  taskId: string
  idleSince: number
  hibernate(allowed: () => Promise<boolean>): Promise<boolean>
}

export interface ChatInventory {
  hibernated: number
  candidates: HibernateCandidate[]
}

/** One hub's chats on this computer. */
export interface ChatInventorySource {
  inventory(): ChatInventory
  /** Ask the hub (`chat.hibernateCheck`): ownership, pinned tasks, and for `idle` its setting. */
  canHibernate(tabId: string, check: ChatHibernateCheck): Promise<boolean>
  /**
   * The hub's idle-close window (`chat.idlePolicy`): the user's "Auto-close idle
   * agents" setting. `null` = off, unknown, or a hub from before idle-close.
   */
  idleCloseMs?(): Promise<number | null>
}

export function parseLinuxMemory(meminfo: string, psi: string) {
  const total = /^MemTotal:\s+(\d+) kB/m.exec(meminfo)
  const available = /^MemAvailable:\s+(\d+) kB/m.exec(meminfo)
  const stalled = /^full\s+avg10=(\d+(?:\.\d+)?)/m.exec(psi)
  return {
    memoryTotal: total ? Number(total[1]) * 1024 : totalmem(),
    memoryAvailable: available ? Number(available[1]) * 1024 : freemem(),
    memoryPressure: stalled ? Number(stalled[1]) : null
  }
}

/**
 * `sysctl -n kern.memorystatus_level kern.memorystatus_vm_pressure_level`: the
 * percent of memory macOS counts as available (what `memory_pressure` prints as
 * "System-wide memory free percentage") and its pressure level (1 normal, 2 warn,
 * 4 critical). Null without a usable percent.
 */
export function parseDarwinMemoryStatus(
  stdout: string
): { freePercent: number; pressureLevel: number | null } | null {
  const [level, pressure] = stdout.trim().split(/\s+/)
  if (!level || !/^\d+$/.test(level) || Number(level) > 100) return null
  return {
    freePercent: Number(level),
    pressureLevel: pressure && /^\d+$/.test(pressure) ? Number(pressure) : null
  }
}

export interface HostMemorySample {
  memory: ReturnType<typeof parseLinuxMemory>
  nativePressure: boolean
}

/** Null when this sample could not be taken: the caller keeps its previous reading. */
async function sampleHostMemory(): Promise<HostMemorySample | null> {
  let memory = parseLinuxMemory('', '')
  let nativePressure = false
  if (process.platform === 'linux') {
    const [meminfo, psi] = await Promise.all([
      readFile('/proc/meminfo', 'utf8').catch(() => ''),
      readFile('/proc/pressure/memory', 'utf8').catch(() => '')
    ])
    memory = parseLinuxMemory(meminfo, psi)
  } else if (process.platform === 'darwin') {
    // Never os.freemem() here: macOS keeps RAM full of cache it can reclaim, so
    // free pages alone read as pressure on an idle 64 GB Mac.
    const status = await exec(
      '/usr/sbin/sysctl',
      ['-n', 'kern.memorystatus_level', 'kern.memorystatus_vm_pressure_level'],
      { timeout: 1_000 }
    ).catch(() => null)
    const parsed = parseDarwinMemoryStatus(status?.stdout ?? '')
    if (!parsed) return null
    memory.memoryAvailable = Math.floor((memory.memoryTotal * parsed.freePercent) / 100)
    nativePressure = (parsed.pressureLevel ?? 0) >= 2
  }
  const limit = process.constrainedMemory?.()
  if (limit && limit < memory.memoryTotal) {
    memory.memoryTotal = limit
    memory.memoryAvailable = Math.min(memory.memoryAvailable, process.availableMemory?.() ?? limit)
  }
  memory.memoryAvailable = Math.min(memory.memoryAvailable, memory.memoryTotal)
  return { memory, nativePressure }
}

function cpuTimes() {
  let idle = 0
  let total = 0
  for (const cpu of cpus()) {
    idle += cpu.times.idle
    total += Object.values(cpu.times).reduce((sum, ms) => sum + ms, 0)
  }
  return { idle, total }
}

export function createComputerHealth(opts: {
  /**
   * Act on what it measures: hold background and warm starts under pressure or at
   * the cap, bound the warm pool, hibernate idle chats to free memory. False (the
   * desktop app's own computer unless it opts in, `agentMemoryManaged`): starts are
   * admitted as before, and the health report is measured only. Idle-close (the
   * hub's setting, `ChatInventorySource.idleCloseMs`) runs either way.
   */
  managed: boolean
  config: ComputerAgentResources
  isolation: AgentIsolation | null
  chats(): Iterable<ChatInventorySource>
  sampleMemory?: typeof sampleHostMemory
  onAdmissionEvent(event: AdmissionEvent): void
  log(message: string, data?: Record<string, unknown>): void
}) {
  const { config, isolation } = opts
  const threshold = config.minAvailableMemoryPercent ?? 15
  const idleMs = config.idleBeforeHibernateMs ?? 5 * 60_000
  const pinned = new Set(config.pinnedTaskIds)
  const warmPoolSize = config.warmPoolSize ?? 1
  const startConcurrency = config.startConcurrency ?? defaultAdmissionConcurrency()
  let footprint = MIN_AGENT_BYTES
  let sampledAt = 0
  /** A sample was attempted. Starts wait for the first one, not for its success. */
  let settled = false
  let memory = parseLinuxMemory('', '')
  let pressure = false
  let lastCpu = cpuTimes()
  let cpuPercent: number | null = null
  let sampling = false
  let measuring = false
  let reclaiming = false
  let sampleFootprintAt = 0
  let idleCloseAt = 0
  let stopped = false

  const cap = () => {
    if (typeof config.maxLiveAgents === 'number') return config.maxLiveAgents
    const budget = Math.min(
      memory.memoryTotal * (1 - threshold / 100),
      isolation?.memoryLimit ?? Infinity
    )
    return Math.max(1, Math.floor(budget / footprint))
  }

  const admission = createSpawnAdmission({
    concurrency: startConcurrency,
    ...(opts.managed
      ? { resources: () => ({ cap: cap(), pressure: pressure || !settled, warmPoolSize }) }
      : {}),
    onEvent: opts.onAdmissionEvent
  })

  async function sampleFootprint(pids: number[], usage: number | undefined): Promise<void> {
    measuring = true
    try {
      const stats = await collectProcessStats(new Map(pids.map((pid) => [String(pid), pid])))
      const sizes = Object.values(stats)
        .map(({ rss }) => rss * 1024)
        .filter(Number.isFinite)
        .sort((a, b) => a - b)
      const percentile = sizes[Math.ceil(sizes.length * 0.9) - 1] ?? 0
      const groupAverage = usage !== undefined && Number.isFinite(usage) ? usage / pids.length : 0
      // Raise the estimate immediately. Let it fall gradually as heavier agents leave.
      footprint = Math.max(MIN_AGENT_BYTES, percentile, groupAverage, Math.floor(footprint * 0.9))
    } finally {
      measuring = false
    }
  }

  function needsReclamation(): boolean {
    if (stopped || !opts.managed || config.hibernate === false) return false
    const { reserved, queued } = admission.load()
    return pressure || reserved > cap() || (queued > 0 && reserved >= cap())
  }

  /**
   * Idle-close: hibernate every chat idle past its hub's window, pressure or not —
   * the user's setting, so it applies whether or not this computer manages memory.
   * The hub re-checks each one (`reason: 'idle'`). `agentResources.hibernate: false`
   * and `pinnedTaskIds` still exempt chats on this machine.
   */
  async function closeIdleChats(): Promise<void> {
    for (const chat of [...opts.chats()]) {
      if (stopped || !chat.idleCloseMs) continue
      const due = chat
        .inventory()
        .candidates.filter((candidate) => !pinned.has(candidate.taskId))
        .sort((a, b) => a.idleSince - b.idleSince)
      // No request to a hub with nothing that could hibernate.
      if (due.length === 0) continue
      const windowMs = await chat.idleCloseMs()
      if (windowMs === null) continue
      for (const candidate of due) {
        if (stopped) return
        // Oldest first: the rest are idle for less.
        if (Date.now() - candidate.idleSince < windowMs) break
        const hibernated = await candidate.hibernate(
          async () =>
            !stopped &&
            (await chat.canHibernate(candidate.tabId, {
              reason: 'idle',
              idleForMs: Date.now() - candidate.idleSince
            }))
        )
        if (hibernated)
          opts.log('idle chat hibernated (idle-close)', {
            taskId: candidate.taskId,
            tabId: candidate.tabId,
            idleMs: Date.now() - candidate.idleSince,
            windowMs
          })
      }
    }
  }

  async function reclaimIdleChat(): Promise<void> {
    const now = Date.now()
    const candidates = [...opts.chats()]
      .flatMap((chat) => chat.inventory().candidates.map((candidate) => ({ chat, candidate })))
      .filter(
        ({ candidate }) => !pinned.has(candidate.taskId) && now - candidate.idleSince >= idleMs
      )
      .sort((a, b) => a.candidate.idleSince - b.candidate.idleSince)
    for (const { chat, candidate } of candidates) {
      if (!needsReclamation()) return
      const hibernated = await candidate.hibernate(
        async () =>
          (await chat.canHibernate(candidate.tabId, { reason: 'pressure' })) && needsReclamation()
      )
      if (hibernated) {
        opts.log('idle chat hibernated', {
          taskId: candidate.taskId,
          tabId: candidate.tabId,
          idleMs: now - candidate.idleSince,
          pressure
        })
        return
      }
    }
  }

  async function sample(): Promise<void> {
    if (sampling || stopped) return
    sampling = true
    try {
      const sample = await (opts.sampleMemory ?? sampleHostMemory)()
      if (stopped) return
      settled = true
      const now = Date.now()
      const cpu = cpuTimes()
      const elapsed = cpu.total - lastCpu.total
      if (elapsed > 0)
        cpuPercent = Math.max(0, Math.min(100, 100 * (1 - (cpu.idle - lastCpu.idle) / elapsed)))
      lastCpu = cpu
      const use = isolation?.memoryUsage()
      // A failed sample is skipped: memory and pressure keep their last reading.
      if (sample) {
        memory = sample.memory
        sampledAt = now
        const minAvailable = threshold + (pressure ? 2 : 0)
        pressure =
          sample.nativePressure ||
          memory.memoryAvailable * 100 < memory.memoryTotal * minAvailable ||
          (memory.memoryPressure ?? 0) >= PSI_PRESSURE_PERCENT ||
          (use !== undefined && isolation !== null && use >= isolation.memoryLimit * 0.95)
      }
      admission.recheck()
      const load = admission.load()
      if (!measuring && !pressure && now >= sampleFootprintAt && load.pids.length > 0) {
        sampleFootprintAt = now + FOOTPRINT_INTERVAL_MS
        void sampleFootprint(load.pids, use).catch((error) =>
          opts.log('agent memory estimate failed', { error: String(error) })
        )
      }
      // Give the warm pool a chance to exit before stopping a real conversation.
      // One hibernation pass at a time: memory reclamation first, idle-close otherwise.
      if (!reclaiming && load.warm === 0 && needsReclamation()) {
        reclaiming = true
        void reclaimIdleChat()
          .catch((error) => opts.log('idle chat hibernation failed', { error: String(error) }))
          .finally(() => {
            reclaiming = false
          })
      } else if (!reclaiming && config.hibernate !== false && now >= idleCloseAt) {
        idleCloseAt = now + IDLE_CLOSE_INTERVAL_MS
        reclaiming = true
        void closeIdleChats()
          .catch((error) => opts.log('idle-close failed', { error: String(error) }))
          .finally(() => {
            reclaiming = false
          })
      }
    } finally {
      sampling = false
    }
  }

  const tick = () =>
    void sample().catch((error) =>
      opts.log('computer health sample failed', { error: String(error) })
    )
  const timer = setInterval(tick, SAMPLE_INTERVAL_MS)
  timer.unref()
  tick()

  return {
    admission,
    snapshot(): ComputerHealth {
      const { live, warm, queued } = admission.load()
      return {
        ...memory,
        sampledAt,
        cpuPercent,
        pressure,
        live,
        warm,
        queued,
        hibernated: [...opts.chats()].reduce(
          (count, chat) => count + chat.inventory().hibernated,
          0
        ),
        cap: cap(),
        managed: opts.managed,
        oomIsolation: isolation !== null
      }
    },
    stop() {
      stopped = true
      clearInterval(timer)
    }
  }
}
