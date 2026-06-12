import { execFile } from 'child_process'

export interface PidStats {
  cpu: number // % of one core
  rss: number // kilobytes
}

/** Resolve actual child PIDs (shell wrappers → real commands). Falls back to input PIDs if no children found. */
function resolveChildPids(shellPids: number[], cb: (pidMap: Map<number, number[]>) => void): void {
  execFile('pgrep', ['-P', shellPids.join(',')], (err, stdout) => {
    const map = new Map<number, number[]>()
    if (err || !stdout.trim()) {
      for (const pid of shellPids) map.set(pid, [pid])
      return cb(map)
    }
    const childPids = stdout
      .trim()
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    execFile('ps', ['-o', 'pid=,ppid=', '-p', childPids.join(',')], (err2, stdout2) => {
      if (err2) {
        for (const pid of shellPids) map.set(pid, [pid])
        return cb(map)
      }
      for (const line of stdout2.trim().split('\n')) {
        const parts = line.trim().split(/\s+/)
        if (parts.length < 2) continue
        const [childStr, parentStr] = parts
        const parent = Number(parentStr)
        const child = Number(childStr)
        if (!map.has(parent)) map.set(parent, [])
        map.get(parent)!.push(child)
      }
      for (const pid of shellPids) {
        if (!map.has(pid)) map.set(pid, [pid])
      }
      cb(map)
    })
  })
}

/** Collect CPU/memory stats for a set of PIDs via ps. */
function collectPidStats(pids: number[], cb: (stats: Map<number, PidStats>) => void): void {
  if (pids.length === 0) return cb(new Map())
  execFile('ps', ['-o', 'pid=,%cpu=,rss=', '-p', pids.join(',')], (err, stdout) => {
    const stats = new Map<number, PidStats>()
    if (err) return cb(stats)
    for (const line of stdout.trim().split('\n')) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 3) continue
      stats.set(Number(parts[0]), { cpu: parseFloat(parts[1]), rss: parseInt(parts[2], 10) })
    }
    cb(stats)
  })
}

/**
 * Create a reusable stats poller. Call start()/stop() to control lifecycle.
 * `getPids` returns a map of id → shell PID for each item to track.
 * `onStats` receives aggregated stats keyed by the same ids.
 */
export function createStatsPoller(
  getPids: () => Map<string, number>,
  onStats: (stats: Record<string, PidStats>) => void,
  interval = 3000
): { start: () => void; stop: () => void; ensureStarted: () => void } {
  let timer: ReturnType<typeof setInterval> | null = null

  function stop(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  function tick(): void {
    const pidMap = getPids()
    if (pidMap.size === 0) {
      stop()
      return
    }
    const shellPids = Array.from(pidMap.values())
    resolveChildPids(shellPids, (childMap) => {
      const allPids = Array.from(new Set(Array.from(childMap.values()).flat()))
      if (allPids.length === 0) return
      collectPidStats(allPids, (pidStats) => {
        const result: Record<string, PidStats> = {}
        for (const [id, shellPid] of pidMap) {
          const children = childMap.get(shellPid) ?? [shellPid]
          let cpu = 0,
            rss = 0
          for (const cpid of children) {
            const s = pidStats.get(cpid)
            if (s) {
              cpu += s.cpu
              rss += s.rss
            }
          }
          result[id] = { cpu, rss }
        }
        if (Object.keys(result).length > 0) onStats(result)
      })
    })
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(tick, interval)
    },
    stop,
    /** Start only if there are PIDs to track. Safe to call frequently. */
    ensureStarted() {
      if (timer) return
      if (getPids().size > 0) this.start()
    }
  }
}
