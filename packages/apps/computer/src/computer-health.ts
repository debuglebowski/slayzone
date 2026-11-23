import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { cpus, freemem, totalmem } from 'node:os'
import { promisify } from 'node:util'
import { collectProcessStats } from '@slayzone/processes/pid-stats'
import type { ComputerAgentResources } from '@slayzone/platform/slayzone-config'
import type { ComputerHealth } from '@slayzone/computer-transport/shared'
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

interface ChatInventorySource {
  inventory(): ChatInventory
  canHibernate(tabId: string): Promise<boolean>
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

async function sampleHostMemory() {
  let memory = parseLinuxMemory('', '')
  let nativePressure = false
  if (process.platform === 'linux') {
    const [meminfo, psi] = await Promise.all([
      readFile('/proc/meminfo', 'utf8').catch(() => ''),
      readFile('/proc/pressure/memory', 'utf8').catch(() => '')
    ])
    memory = parseLinuxMemory(meminfo, psi)
  } else if (process.platform === 'darwin') {
    // os.freemem() counts empty pages. File-backed pages can be reclaimed too.
    const [vm, level] = await Promise.all([
      exec('/usr/bin/vm_stat', [], { timeout: 1_000 }).catch(() => null),
      exec('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], {
        timeout: 1_000
      }).catch(() => null)
    ])
    const stats = vm?.stdout ?? ''
    const pageSize = Number(/page size of (\d+) bytes/.exec(stats)?.[1])
    const free = Number(/^Pages free:\s+(\d+)/m.exec(stats)?.[1])
    const fileBacked = Number(/^File-backed pages:\s+(\d+)/m.exec(stats)?.[1])
    if (pageSize > 0 && Number.isFinite(free) && Number.isFinite(fileBacked))
      memory.memoryAvailable = (free + fileBacked) * pageSize
    nativePressure = Number(level?.stdout.trim()) >= 2
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
  let memory = parseLinuxMemory('', '')
  let pressure = false
  let lastCpu = cpuTimes()
  let cpuPercent: number | null = null
  let sampling = false
  let measuring = false
  let reclaiming = false
  let sampleFootprintAt = 0
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
    resources: () => ({ cap: cap(), pressure: pressure || sampledAt === 0, warmPoolSize }),
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
    if (stopped || config.hibernate === false) return false
    const { reserved, queued } = admission.load()
    return pressure || reserved > cap() || (queued > 0 && reserved >= cap())
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
        async () => (await chat.canHibernate(candidate.tabId)) && needsReclamation()
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
      memory = sample.memory
      sampledAt = Date.now()
      const cpu = cpuTimes()
      const elapsed = cpu.total - lastCpu.total
      if (elapsed > 0)
        cpuPercent = Math.max(0, Math.min(100, 100 * (1 - (cpu.idle - lastCpu.idle) / elapsed)))
      lastCpu = cpu
      const use = isolation?.memoryUsage()
      const minAvailable = threshold + (pressure ? 2 : 0)
      pressure =
        sample.nativePressure ||
        memory.memoryAvailable * 100 < memory.memoryTotal * minAvailable ||
        (memory.memoryPressure ?? 0) >= PSI_PRESSURE_PERCENT ||
        (use !== undefined && isolation !== null && use >= isolation.memoryLimit * 0.95)
      admission.recheck()
      const load = admission.load()
      if (!measuring && !pressure && sampledAt >= sampleFootprintAt && load.pids.length > 0) {
        sampleFootprintAt = sampledAt + FOOTPRINT_INTERVAL_MS
        void sampleFootprint(load.pids, use).catch((error) =>
          opts.log('agent memory estimate failed', { error: String(error) })
        )
      }
      // Give the warm pool a chance to exit before stopping a real conversation.
      if (!reclaiming && load.warm === 0 && needsReclamation()) {
        reclaiming = true
        void reclaimIdleChat()
          .catch((error) => opts.log('idle chat hibernation failed', { error: String(error) }))
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
        oomIsolation: isolation !== null
      }
    },
    stop() {
      stopped = true
      clearInterval(timer)
    }
  }
}
