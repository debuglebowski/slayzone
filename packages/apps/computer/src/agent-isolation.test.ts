/**
 * Linux agent memory isolation, on a scratch directory laid out like cgroupfs and
 * /proc (plain files stand in for the kernel's). What it must guarantee: no limit of
 * ours kills an agent (soft `memory.high`, swap kept, no per-agent OOM group), and a
 * failure at any step starts the agent anyway instead of failing its spawn.
 */
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_JOIN_CHECK_MS,
  agentLauncher,
  createAgentIsolation,
  slayzoneServiceCgroup,
  type AgentIsolationHost
} from './agent-isolation'

const GiB = 1024 ** 3
const SERVICE = 'user.slice/slayzone-computer-main.service'

let root: string
let host: AgentIsolationHost
let service: string
let agents: string
let log: ReturnType<typeof vi.fn<(message: string, details?: Record<string, unknown>) => void>>

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'agent-isolation-'))
  host = { platform: 'linux', cgroupRoot: join(root, 'cgroup'), procRoot: join(root, 'proc') }
  service = join(host.cgroupRoot, SERVICE)
  agents = join(service, 'agents')
  mkdirSync(service, { recursive: true })
  mkdirSync(join(host.procRoot, 'self'), { recursive: true })
  writeFileSync(join(host.procRoot, 'self', 'cgroup'), `0::/${SERVICE}/supervisor\n`)
  writeFileSync(join(service, 'cgroup.procs'), '101\n102\n')
  writeFileSync(join(service, 'memory.max'), 'max\n')
  writeFileSync(join(host.cgroupRoot, 'user.slice', 'memory.max'), `${10 * GiB}\n`)
  log = vi.fn()
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

const read = (path: string) => readFileSync(path, 'utf8')

describe('slayzoneServiceCgroup', () => {
  it('finds the service even when systemd moved the main pid into a child', () => {
    expect(slayzoneServiceCgroup(`0::/${SERVICE}/supervisor\n`, '/cg')).toBe(`/cg/${SERVICE}`)
  })

  it('is null outside a SlayZone service', () => {
    expect(slayzoneServiceCgroup('0::/user.slice/other.service\n', '/cg')).toBeNull()
  })
})

describe('createAgentIsolation', () => {
  it('is off outside Linux', () => {
    expect(createAgentIsolation(16 * GiB, log, { ...host, platform: 'darwin' })).toBeNull()
  })

  it('is off outside a SlayZone service', () => {
    writeFileSync(join(host.procRoot, 'self', 'cgroup'), '0::/user.slice/other.service\n')
    expect(createAgentIsolation(16 * GiB, log, host)).toBeNull()
  })

  it('budgets 80% of the tightest enclosing limit', () => {
    expect(createAgentIsolation(16 * GiB, log, host)?.memoryLimit).toBe(Math.floor(8 * GiB))
  })

  it('sets only a soft limit, and keeps swap', () => {
    const isolation = createAgentIsolation(16 * GiB, log, host)
    expect(read(join(agents, 'memory.high'))).toBe(String(isolation?.memoryLimit))
    expect(read(join(agents, 'memory.max'))).toBe('max')
    expect(read(join(agents, 'memory.swap.max'))).toBe('max')
  })

  it('lifts the hard limit and swap ban an earlier computer left on the cgroup', () => {
    mkdirSync(agents)
    writeFileSync(join(agents, 'memory.max'), String(4 * GiB))
    writeFileSync(join(agents, 'memory.swap.max'), '0')
    createAgentIsolation(16 * GiB, log, host)
    expect(read(join(agents, 'memory.max'))).toBe('max')
    expect(read(join(agents, 'memory.swap.max'))).toBe('max')
  })

  it('moves the service processes into the supervisor leaf and delegates memory', () => {
    createAgentIsolation(16 * GiB, log, host)
    expect(existsSync(join(service, 'supervisor', 'cgroup.procs'))).toBe(true)
    expect(read(join(service, 'cgroup.subtree_control'))).toBe('+memory')
    expect(read(join(agents, 'cgroup.subtree_control'))).toBe('+memory')
  })

  it('is off, and says why, when the cgroup cannot be set up', () => {
    rmSync(join(service, 'cgroup.procs'))
    expect(createAgentIsolation(16 * GiB, log, host)).toBeNull()
    expect(log).toHaveBeenCalledWith('Linux agent memory isolation unavailable', {
      operation: 'move service processes to supervisor cgroup',
      error: expect.stringContaining('ENOENT')
    })
  })

  it('reads agent usage without reclaimable page cache', () => {
    const isolation = createAgentIsolation(16 * GiB, log, host)
    writeFileSync(join(agents, 'memory.current'), '5000\n')
    writeFileSync(join(agents, 'memory.stat'), 'anon 3000\ninactive_file 1200\n')
    expect(isolation?.memoryUsage()).toBe(3800)
  })
})

describe('launch', () => {
  it('gives each agent its own cgroup, without an OOM group', () => {
    const launch = createAgentIsolation(16 * GiB, log, host)!.launch('/bin/claude', ['--x'])
    const group = launch.args[3]
    expect(launch.file).toBe('/bin/sh')
    expect(group.startsWith(join(agents, 'agent-'))).toBe(true)
    expect(launch.args.slice(4)).toEqual(['/bin/claude', '--x'])
    expect(existsSync(join(group, 'memory.oom.group'))).toBe(false)
  })

  it('starts the agent without a cgroup when its cgroup cannot be created', () => {
    const isolation = createAgentIsolation(16 * GiB, log, host)!
    rmSync(agents, { recursive: true })
    const launch = isolation.launch('/bin/claude', ['--x'])
    expect(launch.file).toBe('/bin/sh')
    expect(launch.args.slice(-2)).toEqual(['/bin/claude', '--x'])
    expect(launch.args.some((arg) => arg.startsWith(agents))).toBe(false)
    expect(log).toHaveBeenCalledWith(
      'agent memory cgroup unavailable, starting the agent without it',
      { error: expect.stringContaining('ENOENT') }
    )
  })

  it('kills the whole cgroup on close', () => {
    const launch = createAgentIsolation(16 * GiB, log, host)!.launch('/bin/true', [])
    launch.close()
    expect(read(join(launch.args[3], 'cgroup.kill'))).toBe('1')
  })

  describe('the launcher script', () => {
    const run = (args: string[]) => spawnSync('/bin/sh', args, { encoding: 'utf8' })

    it('joins the cgroup, then runs the agent with its arguments unchanged', () => {
      const launch = createAgentIsolation(16 * GiB, log, host)!.launch('/bin/echo', ['a b', '$c'])
      const result = run(launch.args)
      expect(result.status).toBe(0)
      expect(result.stdout).toBe('a b $c\n')
      expect(read(join(launch.args[3], 'cgroup.procs'))).toMatch(/^\d+$/)
    })

    it('still runs the agent when it cannot join the cgroup', () => {
      const launch = createAgentIsolation(16 * GiB, log, host)!.launch('/bin/echo', ['ran'])
      rmSync(launch.args[3], { recursive: true })
      const result = run(launch.args)
      expect(result.status).toBe(0)
      expect(result.stdout).toBe('ran\n')
      expect(result.stderr).toBe('')
    })
  })

  describe('started', () => {
    const membership = (pid: number, path: string) => {
      mkdirSync(join(host.procRoot, String(pid)), { recursive: true })
      writeFileSync(join(host.procRoot, String(pid), 'cgroup'), `0::${path}\n`)
    }

    it('logs an agent that did not join its cgroup', () => {
      vi.useFakeTimers()
      const launch = createAgentIsolation(16 * GiB, log, host)!.launch('/bin/true', [])
      membership(4242, `/${SERVICE}/supervisor`)
      launch.started(4242)
      vi.advanceTimersByTime(AGENT_JOIN_CHECK_MS)
      expect(log).toHaveBeenCalledWith('agent runs outside its memory cgroup', {
        pid: 4242,
        group: launch.args[3],
        cgroup: `/${SERVICE}/supervisor`
      })
    })

    it('is quiet for an agent in its cgroup, an agent gone, or one closed', () => {
      vi.useFakeTimers()
      const isolation = createAgentIsolation(16 * GiB, log, host)!
      const joined = isolation.launch('/bin/true', [])
      membership(1, joined.args[3].slice(host.cgroupRoot.length))
      joined.started(1)
      isolation.launch('/bin/true', []).started(2) // no /proc entry: exited
      const closed = isolation.launch('/bin/true', [])
      membership(3, `/${SERVICE}/supervisor`)
      closed.started(3)
      closed.close()
      vi.advanceTimersByTime(AGENT_JOIN_CHECK_MS)
      expect(log).not.toHaveBeenCalled()
    })
  })
})

describe('agentLauncher', () => {
  it('is the isolation when there is one', () => {
    const isolation = createAgentIsolation(16 * GiB, log, host)!
    expect(agentLauncher(isolation, 'linux')).toBe(isolation.launch)
  })

  it('on Linux without isolation, only prefers agents for the OOM killer', () => {
    const launch = agentLauncher(null, 'linux')!('/bin/echo', ['ok'])
    expect(launch.args[1]).toContain('oom_score_adj')
    const result = spawnSync('/bin/sh', launch.args, { encoding: 'utf8' })
    expect(result.stdout).toBe('ok\n')
  })

  it('is nothing elsewhere', () => {
    expect(agentLauncher(null, 'darwin')).toBeUndefined()
  })
})
