import { spawn, type ChildProcess } from 'child_process'
import { afterAll, describe, expect, test, vi } from 'vitest'
import {
  initProcessManagerWith,
  removeProcess,
  listAllProcesses,
  restartProcessDetailed,
  spawnProcess,
  startProcess,
  stopProcess
} from './process-manager'
import { setProcessBackend } from './process-backend'
import type { ProcessPersistence, ProcessRow } from './process-persistence'

// Real processes against the real local backend: these are the bugs a fake
// backend can't show — a run that outlives the app session, and a descendant
// that left the process group. Sequential scenarios over module state.

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The boot probe runs `ps`/`pgrep` per row, off the init path: slow under a loaded box. */
const PROBE_WAIT = { timeout: 15_000 }

const proc = (id: string): ReturnType<typeof listAllProcesses>[number] | undefined =>
  listAllProcesses().find((p) => p.id === id)

function persistenceWith(rows: ProcessRow[]): ProcessPersistence {
  return {
    loadAll: async () => rows,
    insert: async () => {},
    update: async () => {},
    remove: async () => {},
    updatePid: async () => {},
    recordPid: async () => {},
    listPidHistory: async () => [],
    removePidHistory: async () => {}
  }
}

const row = (id: string, command: string, pid: number | null): ProcessRow => ({
  id,
  task_id: null,
  project_id: null,
  label: id,
  command,
  cwd: '/tmp',
  auto_restart: 0,
  pid
})

// --- A run left by the previous app session must not read 'stopped'. This is
//     the Kahuna case: the row loaded 'stopped' while its server kept its port
//     for 23 days, because hydration never looked at the persisted pid. ---
describe('hydration reports a run that outlived the previous session', () => {
  let leader: ChildProcess | undefined
  let groupLeaderGone: ChildProcess | undefined
  let groupSurvivor: number | undefined
  const deadPid = 8888886

  afterAll(() => {
    leader?.kill('SIGKILL')
    if (groupSurvivor) {
      try {
        process.kill(groupSurvivor, 'SIGKILL')
      } catch {
        /* gone */
      }
    }
    for (const id of ['h-leader', 'h-group', 'h-dead', 'h-reused']) removeProcess(id)
    setProcessBackend(null)
  })

  test('setup: a live leader, and a dead leader whose group still has a member', async () => {
    leader = spawn('sleep', ['31'], { detached: true, stdio: 'ignore' })
    // Leader `sh` starts a background `sleep` in its own group, prints its pid, exits.
    groupLeaderGone = spawn('sh', ['-c', 'sleep 32 & echo $!'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const out = await new Promise<string>((resolve) => {
      let buf = ''
      groupLeaderGone!.stdout!.on('data', (d: Buffer) => (buf += d.toString()))
      groupLeaderGone!.on('exit', () => resolve(buf))
    })
    groupSurvivor = Number(out.trim())
    expect(alive(leader.pid!)).toBe(true)
    expect(alive(groupLeaderGone.pid!)).toBe(false)
    expect(alive(groupSurvivor)).toBe(true)
  })

  test('init with those pids persisted', async () => {
    await initProcessManagerWith(
      persistenceWith([
        row('h-leader', 'sleep 31', leader!.pid!),
        row('h-group', 'sh -c sleep', groupLeaderGone!.pid!),
        row('h-dead', 'sleep 1', deadPid),
        row('h-reused', 'something else entirely', leader!.pid!)
      ])
    )
  })
  test("live leader running the same command → 'orphaned'", async () => {
    await vi.waitFor(() => expect(proc('h-leader')?.status).toBe('orphaned'), PROBE_WAIT)
  })
  test('orphaned row keeps its pid', () => {
    expect(proc('h-leader')?.pid).toBe(leader!.pid)
  })
  test("dead leader, live group member → 'orphaned'", async () => {
    await vi.waitFor(() => expect(proc('h-group')?.status).toBe('orphaned'), PROBE_WAIT)
  })
  test("nothing left → 'stopped'", () => {
    expect(proc('h-dead')?.status).toBe('stopped')
  })
  test("pid alive but running another command (reused) → 'stopped'", () => {
    expect(proc('h-reused')?.status).toBe('stopped')
  })
  test('the probe never signals anything', () => {
    expect(alive(leader!.pid!)).toBe(true)
    expect(alive(groupSurvivor!)).toBe(true)
  })

  test('stop on an orphaned row takes its group down → stopped', async () => {
    expect(await stopProcess('h-group')).toBe(true)
    expect(alive(groupSurvivor!)).toBe(false)
    expect(proc('h-group')?.status).toBe('stopped')
  })
  test('start on an orphaned row reaps the leftover, then spawns', async () => {
    const res = await startProcess('h-leader')
    expect(res.ok).toBe(true)
    // This test is the leader's parent: it lingers as a zombie until reaped.
    await vi.waitFor(() => expect(alive(leader!.pid!)).toBe(false), PROBE_WAIT)
    expect(proc('h-leader')?.status).toBe('running')
    expect(proc('h-leader')?.pid).not.toBe(leader!.pid)
  })
})

// --- stop/restart take the whole tree, including a descendant that left the
//     process group (setsid): the group signal never reaches it, so before this
//     it survived every stop, reparented to pid 1, still holding its port. ---
describe('stop and restart take the whole tree', () => {
  // The leader prints the pid of a worker it started in a NEW session/group.
  const script =
    "const c=require('child_process').spawn('sleep',['33'],{detached:true,stdio:'ignore'});" +
    "console.log('worker:'+c.pid);setInterval(()=>{},1000)"
  // `process.execPath` is Electron under the harness, and the backend strips
  // ELECTRON_RUN_AS_NODE from every run (NON_PREFIXED_INFRA): without it set
  // here, `-e` is ignored and a full Electron app starts instead — it exits at
  // once on a headless Linux box and idles windowless on macOS, never printing
  // the worker line. `env` sets it in any user shell (fish included).
  const command = `env ELECTRON_RUN_AS_NODE=1 "${process.execPath}" -e "${script}"`
  let id = ''
  const workerPids: number[] = []

  const workerPid = async (): Promise<number> => {
    let pid = 0
    await vi.waitFor(
      () => {
        const line = [...(proc(id)?.logBuffer ?? [])].reverse().find((l) => l.startsWith('worker:'))
        pid = Number(line?.slice('worker:'.length))
        if (!pid || workerPids.includes(pid)) throw new Error('no new worker yet')
      },
      { timeout: 15_000 }
    )
    workerPids.push(pid)
    return pid
  }

  afterAll(async () => {
    // removeProcess only starts the tree sweep; this fork can exit before it signals
    // anything, leaking the leader (it never exits on its own). stop awaits it.
    if (id) {
      await stopProcess(id)
      removeProcess(id)
    }
    for (const pid of workerPids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    }
  })

  test('setup: run spawns a worker outside its group', async () => {
    id = await spawnProcess(null, null, 'tree', command, '/tmp', false)
    expect(alive(await workerPid())).toBe(true)
  })

  test('start refuses a running row', async () => {
    expect(await startProcess(id)).toEqual({ ok: false, reason: 'already-running' })
  })

  test('restart: the old worker is gone and a new run has a new pid', async () => {
    const oldWorker = workerPids[0]
    const oldPid = proc(id)!.pid
    const res = await restartProcessDetailed(id)
    expect(res.ok).toBe(true)
    expect(alive(oldWorker)).toBe(false)
    if (res.ok) {
      expect(res.pid).not.toBeNull()
      expect(res.pid).not.toBe(oldPid)
    }
    expect(alive(await workerPid())).toBe(true)
  })

  test('stop: the escaped worker is gone too, and the row reads stopped', async () => {
    const worker = workerPids.at(-1)!
    expect(await stopProcess(id)).toBe(true)
    expect(alive(worker)).toBe(false)
    expect(proc(id)?.status).toBe('stopped')
    expect(proc(id)?.pid).toBeNull()
  })

  test('start: a stopped row runs again under the same id', async () => {
    const res = await startProcess(id)
    expect(res).toMatchObject({ ok: true, status: 'running' })
    expect(proc(id)?.status).toBe('running')
    expect(alive(await workerPid())).toBe(true)
  })

  test('start of an unknown id is refused', async () => {
    expect(await startProcess('nope')).toEqual({ ok: false, reason: 'not-found' })
  })
})
