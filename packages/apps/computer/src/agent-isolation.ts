import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CGROUP_ROOT = '/sys/fs/cgroup'
const PREFER_AGENT_FOR_OOM = '{ printf 300 > /proc/self/oom_score_adj; } 2>/dev/null || :'
const ISOLATED_AGENT_LAUNCHER = [
  'group=$1',
  'shift',
  'printf "%s" "$$" > "$group/cgroup.procs" || exit 125',
  PREFER_AGENT_FOR_OOM,
  'exec "$@"'
].join('\n')

export interface AgentLaunch {
  file: string
  args: string[]
  close(): void
}

export interface AgentIsolation {
  memoryLimit: number
  memoryUsage(): number
  launch: AgentLauncher
}

export type AgentLauncher = (file: string, args: string[]) => AgentLaunch

export function agentLauncher(isolation: AgentIsolation | null): AgentLauncher | undefined {
  if (isolation) return isolation.launch
  if (process.platform !== 'linux') return undefined
  return (file, args) => ({
    file: '/bin/sh',
    args: ['-c', `${PREFER_AGENT_FOR_OOM}\nexec "$@"`, 'sh', file, ...args],
    close() {
      // Nothing to release: the shell prefix holds no resources.
    }
  })
}

/** Find the enclosing SlayZone service, including when systemd already moved its main PID. */
export function slayzoneServiceCgroup(membership: string): string | null {
  const path = /^0::(\/[^\n]*)/m.exec(membership)?.[1]
  const parts = path?.split('/').filter(Boolean)
  const service = parts?.findIndex((part) =>
    /^slayzone-(?:computer|session-host)(?:-[^/]+)?\.service$/.test(part)
  )
  return parts && service !== undefined && service >= 0
    ? join(CGROUP_ROOT, ...parts.slice(0, service + 1))
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

export function createAgentIsolation(
  totalMemory: number,
  log: (message: string, details?: Record<string, unknown>) => void
): AgentIsolation | null {
  if (process.platform !== 'linux') return null
  let agents: string
  let memoryLimit: number
  let operation = 'find service cgroup'
  try {
    const service = slayzoneServiceCgroup(readFileSync('/proc/self/cgroup', 'utf8'))
    if (!service) return null
    let available = totalMemory
    for (let path = service; path !== CGROUP_ROOT; path = join(path, '..')) {
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
    writeFileSync(join(agents, 'memory.max'), String(memoryLimit))
    writeFileSync(join(agents, 'memory.high'), String(Math.floor(memoryLimit * 0.95)))
    // The limit applies to RAM on swap-enabled hosts as well.
    try {
      writeFileSync(join(agents, 'memory.swap.max'), '0')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
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
      const group = mkdtempSync(join(agents, 'agent-'))
      const close = () => {
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
      try {
        writeFileSync(join(group, 'memory.oom.group'), '1')
      } catch (error) {
        close()
        throw error
      }
      // Keep the spawned PID and process group stable. Arguments stay separate
      // from the script and are delivered unchanged to the executable.
      return {
        file: '/bin/sh',
        args: ['-c', ISOLATED_AGENT_LAUNCHER, 'sh', group, file, ...args],
        close
      }
    }
  }
}
