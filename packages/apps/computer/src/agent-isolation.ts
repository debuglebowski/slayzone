import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Linux agent memory isolation (cgroup v2, under a systemd unit that delegates the
 * memory controller — see `renderSystemdUnit`).
 *
 * Agents share one `agents` cgroup with a SOFT limit (`memory.high`): past it the
 * kernel reclaims their memory (swap included) and slows them down, it never kills
 * them. A hard `memory.max` with swap off used to OOM-kill an agent mid-turn where
 * swap would have absorbed the peak. Each agent gets its own leaf cgroup so `close`
 * reaches every descendant (`cgroup.kill`), including ones that left its process
 * group.
 *
 * Isolation is best effort at every step: a host where it cannot be set up runs
 * agents without it, an agent whose cgroup cannot be created starts without one,
 * and an agent whose launcher cannot join its cgroup still runs. Each is logged.
 */

export const PREFER_AGENT_FOR_OOM = '{ printf 300 > /proc/self/oom_score_adj; } 2>/dev/null || :'
/** Joining the cgroup is best effort: an agent that cannot join still starts (and
 *  the computer logs it, see `started`). It used to exit 125, unexplained. */
export const ISOLATED_AGENT_LAUNCHER = [
  'group=$1',
  'shift',
  '{ printf "%s" "$$" > "$group/cgroup.procs"; } 2>/dev/null || :',
  PREFER_AGENT_FOR_OOM,
  'exec "$@"'
].join('\n')
/** How long after a spawn the computer checks the agent joined its cgroup. */
export const AGENT_JOIN_CHECK_MS = 2_000

export interface AgentLaunch {
  file: string
  args: string[]
  /** The spawn succeeded with this pid. */
  started(pid: number): void
  close(): void
}

export interface AgentIsolation {
  memoryLimit: number
  memoryUsage(): number
  launch: AgentLauncher
}

export type AgentLauncher = (file: string, args: string[]) => AgentLaunch

type Log = (message: string, details?: Record<string, unknown>) => void

/** Where the kernel interfaces live; tests point them at a scratch directory. */
export interface AgentIsolationHost {
  platform: NodeJS.Platform
  cgroupRoot: string
  procRoot: string
}

const LINUX_HOST: AgentIsolationHost = {
  platform: process.platform,
  cgroupRoot: '/sys/fs/cgroup',
  procRoot: '/proc'
}

/** The agent runs as is, preferred by the kernel's OOM killer over the computer. */
function unisolatedLaunch(file: string, args: string[]): AgentLaunch {
  return {
    file: '/bin/sh',
    args: ['-c', `${PREFER_AGENT_FOR_OOM}\nexec "$@"`, 'sh', file, ...args],
    started() {
      // Nothing to check: no cgroup to join.
    },
    close() {
      // Nothing to release: the shell prefix holds no resources.
    }
  }
}

export function agentLauncher(
  isolation: AgentIsolation | null,
  platform: NodeJS.Platform = process.platform
): AgentLauncher | undefined {
  if (isolation) return isolation.launch
  if (platform !== 'linux') return undefined
  return unisolatedLaunch
}

/** Find the enclosing SlayZone service, including when systemd already moved its main PID. */
export function slayzoneServiceCgroup(
  membership: string,
  cgroupRoot: string = LINUX_HOST.cgroupRoot
): string | null {
  const path = /^0::(\/[^\n]*)/m.exec(membership)?.[1]
  const parts = path?.split('/').filter(Boolean)
  const service = parts?.findIndex((part) =>
    /^slayzone-(?:computer|session-host)(?:-[^/]+)?\.service$/.test(part)
  )
  return parts && service !== undefined && service >= 0
    ? join(cgroupRoot, ...parts.slice(0, service + 1))
    : null
}

function fileNumber(path: string): number {
  try {
    return Number(readFileSync(path, 'utf8').trim())
  } catch {
    return Number.NaN
  }
}

function directory(path: string): void {
  try {
    mkdirSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/** Lift a hard limit; a kernel without the file (no swap accounting) has none to lift. */
function unlimited(path: string): void {
  try {
    writeFileSync(path, 'max')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export function createAgentIsolation(
  totalMemory: number,
  log: Log,
  host: AgentIsolationHost = LINUX_HOST
): AgentIsolation | null {
  if (host.platform !== 'linux') return null
  const { cgroupRoot, procRoot } = host
  let agents: string
  let memoryLimit: number
  let operation = 'find service cgroup'
  try {
    const service = slayzoneServiceCgroup(
      readFileSync(join(procRoot, 'self', 'cgroup'), 'utf8'),
      cgroupRoot
    )
    if (!service) return null
    let available = totalMemory
    for (let path = service; path.length > cgroupRoot.length; path = join(path, '..')) {
      const limit = fileNumber(join(path, 'memory.max'))
      if (limit > 0) available = Math.min(available, limit)
    }
    memoryLimit = Math.floor(available * 0.8)
    // Domain controllers require an empty internal cgroup. Move the service's
    // daemon processes into a leaf on systemd versions without DelegateSubgroup.
    const supervisor = join(service, 'supervisor')
    operation = 'move service processes to supervisor cgroup'
    directory(supervisor)
    for (const pid of readFileSync(join(service, 'cgroup.procs'), 'utf8').trim().split(/\s+/)) {
      if (!pid) continue
      try {
        writeFileSync(join(supervisor, 'cgroup.procs'), pid)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    operation = 'enable service memory controller'
    writeFileSync(join(service, 'cgroup.subtree_control'), '+memory')
    agents = join(service, 'agents')
    operation = 'configure the agent memory cgroup'
    directory(agents)
    writeFileSync(join(agents, 'cgroup.subtree_control'), '+memory')
    // Soft limit only: reclaim and throttling, never an OOM kill of our making.
    writeFileSync(join(agents, 'memory.high'), String(memoryLimit))
    // A cgroup kept from an earlier computer (upgraded in place under the same
    // service) still has the hard limit and no swap: lift both.
    unlimited(join(agents, 'memory.max'))
    unlimited(join(agents, 'memory.swap.max'))
  } catch (error) {
    log('Linux agent memory isolation unavailable', { operation, error: String(error) })
    return null
  }

  return {
    memoryLimit,
    memoryUsage() {
      try {
        const stats = readFileSync(join(agents, 'memory.stat'), 'utf8')
        const reclaimable = Number(/^inactive_file (\d+)/m.exec(stats)?.[1] ?? 0)
        return Math.max(0, fileNumber(join(agents, 'memory.current')) - reclaimable)
      } catch {
        return Number.NaN
      }
    },
    launch(file, args) {
      let group: string
      try {
        group = mkdtempSync(join(agents, 'agent-'))
      } catch (error) {
        log('agent memory cgroup unavailable, starting the agent without it', {
          error: String(error)
        })
        return unisolatedLaunch(file, args)
      }
      let closed = false
      const close = () => {
        closed = true
        // Include descendants that escaped the agent's process group.
        try {
          writeFileSync(join(group, 'cgroup.kill'), '1')
        } catch {
          // Older kernels lack cgroup.kill. Existing process-group cleanup still runs.
        }
        // Killed children leave the group asynchronously.
        const remove = (left: number) => {
          try {
            rmdirSync(group)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && left > 0) {
              setTimeout(() => remove(left - 1), 250).unref()
            }
          }
        }
        remove(8)
      }
      // The launcher joins the cgroup before it execs the agent; it cannot report a
      // failure itself (the agent's stdout/stderr are the agent's), so check here.
      const expected = group.slice(cgroupRoot.length)
      const started = (pid: number) => {
        setTimeout(() => {
          if (closed) return
          let membership: string
          try {
            membership = readFileSync(join(procRoot, String(pid), 'cgroup'), 'utf8')
          } catch {
            return // Already gone.
          }
          const actual = /^0::(\/[^\n]*)/m.exec(membership)?.[1]
          if (actual === expected || actual?.startsWith(`${expected}/`)) return
          log('agent runs outside its memory cgroup', { pid, group, cgroup: actual ?? null })
        }, AGENT_JOIN_CHECK_MS).unref()
      }
      // Keep the spawned PID and process group stable. Arguments stay separate
      // from the script and are delivered unchanged to the executable.
      return {
        file: '/bin/sh',
        args: ['-c', ISOLATED_AGENT_LAUNCHER, 'sh', group, file, ...args],
        started,
        close
      }
    }
  }
}
