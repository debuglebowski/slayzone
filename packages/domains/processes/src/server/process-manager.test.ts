import { spawn, type ChildProcess } from 'child_process'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  createProcess,
  initProcessManagerWith,
  killProcess,
  listAllProcesses,
  listForTask,
  restartProcess,
  setProjectCwdResolver,
  spawnProcess,
  stopProcess
} from './process-manager'
import { setProcessBackend } from './process-backend'
import type { ProcessBackend, ProcHandle } from './process-backend'
import type { ProcessPersistence } from './process-persistence'

// Every section below is ONE sequential scenario against the process manager's
// module state; vitest runs tests in declaration order, so later tests read the
// state earlier ones produced.

function testSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function ids(list: Array<{ id: string }>): string[] {
  return list.map((p) => p.id).sort()
}

type ExitCb = (e: { code: number | null; signal: string | null }) => void | Promise<void>

describe('listForTask scoping', () => {
  let projA = ''
  let projB = ''
  let taskProc = ''

  // Two projects, each with a project-scoped process, plus one task-scoped process.
  beforeAll(async () => {
    projA = await createProcess('proj-a', null, 'a dev', 'echo a', '/tmp', false)
    projB = await createProcess('proj-b', null, 'b dev', 'echo b', '/tmp', false)
    taskProc = await createProcess('proj-a', 'task-1', 'task dev', 'echo t', '/tmp', false)
  })

  // Task view: own task's processes + its project's project-scoped ones.
  test('task view lists task-scoped + own-project processes', () => {
    expect(ids(listForTask('task-1', 'proj-a'))).toEqual([projA, taskProc].sort())
  })

  // Regression (Home/project view passes taskId=null): `p.taskId === taskId`
  // degenerated to `p.taskId === null`, leaking every project's processes.
  test('project view lists only that project, no cross-project leak', () => {
    expect(ids(listForTask(null, 'proj-a'))).toEqual([projA])
  })
  test('project view excludes task-scoped processes', () => {
    expect(ids(listForTask(null, 'proj-a'))).not.toContain(taskProc)
  })
  test("project view excludes other projects' processes", () => {
    expect(ids(listForTask(null, 'proj-a'))).not.toContain(projB)
  })

  // No scope at all → nothing, not the whole table.
  test('null task + null project lists nothing', () => {
    expect(listForTask(null, null)).toHaveLength(0)
  })
})

// --- reapSurvivorsAfterUnplannedExit: doSpawn's onExit sweeps the leader's
//     process group when the exit was NOT manager-initiated, and must not
//     double-sweep a manager-initiated stop (proc.handle nulled first there,
//     so the `proc.handle !== handle` guard short-circuits before it). ---
describe('reapSurvivorsAfterUnplannedExit', () => {
  const sweepKillCalls: Array<{ pid: number; sig?: string }> = []
  let capturedExit: ExitCb | null = null
  const controllableHandle: ProcHandle = {
    pid: 424242,
    onData: () => ({ dispose() {} }),
    onExit: (cb) => {
      capturedExit = cb
      return {
        dispose() {
          capturedExit = null
        }
      }
    },
    kill: () => {}
  }
  const sweepBackend: ProcessBackend = {
    spawn: () => controllableHandle,
    getCommandLine: async () => null,
    killByPid: (pid, sig) => {
      sweepKillCalls.push({ pid, sig })
    }
  }
  let crashId = ''
  let stoppedId = ''

  beforeAll(() => {
    setProcessBackend(sweepBackend)
  })

  test('doSpawn registers an onExit handler', async () => {
    crashId = await spawnProcess(null, null, 'crashy', 'echo crashy', '/tmp', false)
    expect(capturedExit).not.toBeNull()
  })
  test("an unplanned exit sweeps the leader pid's process group", () => {
    capturedExit!({ code: 1, signal: null }) // simulate the leader dying on its own
    expect(sweepKillCalls.map((c) => c.pid)).toContain(424242)
    killProcess(crashId)
  })

  test('doSpawn registers an onExit handler on the second spawn too', async () => {
    sweepKillCalls.length = 0
    stoppedId = await spawnProcess(null, null, 'stoppable', 'echo stoppable', '/tmp', false)
    expect(capturedExit).not.toBeNull()
  })
  test('a manager-initiated stop does not additionally sweep via onExit', () => {
    stopProcess(stoppedId)
    // Same underlying handle/callback, fired again — mirrors the real process
    // finally exiting *after* stopProcess already nulled proc.handle.
    capturedExit!({ code: 0, signal: null })
    expect(sweepKillCalls).toEqual([])
    killProcess(stoppedId)
  })
})

// --- the pgrep survivor snapshot must actually log what it finds, not
//     just call killByPid. The fake handles above use a pid nothing real
//     answers to, so `pgrep -g <pid>` never matches and that branch never
//     runs — exercise it against a real detached process instead, so
//     `pgrep -g <realPid>` has a genuine survivor to find. ---
describe('pgrep survivor snapshot logs what it finds', () => {
  let real: ChildProcess | undefined
  let realPid: number | undefined
  let capturedRealExit: ExitCb | null = null
  const logKillCalls: Array<{ pid: number; sig?: string }> = []
  let logId = ''

  afterAll(() => {
    if (logId) killProcess(logId)
    real?.kill('SIGKILL') // clean up our own test process rather than waiting out its 5s sleep
    setProcessBackend(null)
  })

  test('test setup: real detached process has a pid', () => {
    real = spawn('sleep', ['5'], { detached: true, stdio: 'ignore' })
    realPid = real.pid
    expect(realPid).not.toBeUndefined()
  })

  test('doSpawn registers an onExit handler for the real-pid case', async () => {
    const realPidHandle: ProcHandle = {
      pid: realPid,
      onData: () => ({ dispose() {} }),
      onExit: (cb) => {
        capturedRealExit = cb
        return {
          dispose() {
            capturedRealExit = null
          }
        }
      },
      kill: () => {}
    }
    setProcessBackend({
      spawn: () => realPidHandle,
      getCommandLine: async () => null,
      killByPid: (pid, sig) => {
        logKillCalls.push({ pid, sig })
      }
    })

    logId = await spawnProcess(null, null, 'logtest', 'echo logtest', '/tmp', false)
    expect(capturedRealExit).not.toBeNull()
  })

  test('an unplanned exit with a live survivor logs the survivor pid into the process log', () => {
    // Simulate the leader dying while realPid's own (still-alive) group is the survivor.
    capturedRealExit!({ code: 1, signal: null })

    const logBuffer = listAllProcesses().find((p) => p.id === logId)?.logBuffer ?? []
    expect(
      logBuffer.some((line) => line.includes(String(realPid)) && line.includes('still alive')),
      logBuffer.join('\n')
    ).toBe(true)
  })
  test('the survivor group is still swept via killByPid alongside the diagnostic log', () => {
    expect(logKillCalls.map((c) => c.pid)).toContain(realPid)
  })
})

// --- the actual bug: a leader that exits while a descendant survives the
//     *entire* sweep (SIGTERM -> poll -> SIGKILL) must be reported as
//     'orphaned', never a false 'completed'/'error' — and it must keep an
//     identifying pid and log a line even though autoRestart is false. Use
//     a killByPid that's a deliberate no-op so a real detached process
//     genuinely outlives the whole escalation window. ---
describe('leader exit with a survivor that outlives the sweep → orphaned', () => {
  let survivor: ChildProcess | undefined
  let survivorPid: number | undefined
  let capturedOrphanExit: ExitCb | null = null
  const noopKillCalls: Array<{ pid: number; sig?: string }> = []
  let orphanId = ''
  const orphanProc = (): ReturnType<typeof listAllProcesses>[number] | undefined =>
    listAllProcesses().find((p) => p.id === orphanId)

  afterAll(() => {
    if (orphanId) killProcess(orphanId)
    survivor?.kill('SIGKILL')
    setProcessBackend(null)
  })

  test('test setup: orphan survivor has a pid', () => {
    survivor = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    survivorPid = survivor.pid
    expect(survivorPid).not.toBeUndefined()
  })

  test('doSpawn registers an onExit handler for the orphan case', async () => {
    const orphanHandle: ProcHandle = {
      pid: survivorPid,
      onData: () => ({ dispose() {} }),
      onExit: (cb) => {
        capturedOrphanExit = cb
        return {
          dispose() {
            capturedOrphanExit = null
          }
        }
      },
      kill: () => {}
    }
    setProcessBackend({
      spawn: () => orphanHandle,
      getCommandLine: async () => null,
      killByPid: (pid, sig) => {
        noopKillCalls.push({ pid, sig }) // deliberately never actually kills `survivor`
      }
    })

    orphanId = await spawnProcess(null, null, 'orphantest', 'echo orphantest', '/tmp', false)
    expect(capturedOrphanExit).not.toBeNull()
  })

  test("a leader exit with a survivor that outlives the sweep -> status 'orphaned'", async () => {
    await capturedOrphanExit!({ code: 0, signal: null })
    expect(orphanProc()?.status).toBe('orphaned')
  })
  test("an orphaned record keeps the dead leader's pid as an identifier, not null", () => {
    expect(orphanProc()?.pid).toBe(survivorPid)
  })
  test('an orphaned exit is logged even though autoRestart is false', () => {
    expect((orphanProc()?.logBuffer ?? []).some((line) => line.includes('orphaned'))).toBe(true)
  })
  test('the sweep sent SIGTERM to the survivor group', () => {
    expect(noopKillCalls).toContainEqual({ pid: survivorPid, sig: 'SIGTERM' })
  })
  test('the sweep escalated to SIGKILL after the survivor outlived SIGTERM', () => {
    expect(noopKillCalls).toContainEqual({ pid: survivorPid, sig: 'SIGKILL' })
  })
})

// --- reapStaleIfNeeded (the cross-restart recovery path, reached when a
//     row is reloaded from persistence with a pid but no live handle) must
//     also catch a leader that's already dead while its old process group
//     still has a live member. Before this fix, `getCommandLine` on the
//     already-dead leader pid returned null and the function bailed out
//     silently, abandoning the orphan and colliding with it on next spawn. ---
describe('reapStaleIfNeeded catches a dead leader with a live group member', () => {
  let staleSurvivor: ChildProcess | undefined
  let staleSurvivorPid: number | undefined
  const staleId = 'stale-restart-test-id'
  const staleSweepCalls: Array<{ pid: number; sig?: string }> = []

  afterAll(async () => {
    // restartProcess also scheduled a real doSpawn ~500ms out (against this
    // fake backend) — wait for it to land *before* killProcess, so killProcess
    // clears the title-poll interval that spawn starts rather than tearing
    // this record down first and leaving that interval to leak forever.
    await testSleep(700)
    killProcess(staleId)
    staleSurvivor?.kill('SIGKILL')
    setProcessBackend(null)
  })

  test('test setup: stale-recovery survivor has a pid', () => {
    staleSurvivor = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    staleSurvivorPid = staleSurvivor.pid
    expect(staleSurvivorPid).not.toBeUndefined()
  })

  test("reapStaleIfNeeded sweeps the dead leader's old group, not just the leader pid itself", async () => {
    const fakePersistence: ProcessPersistence = {
      loadAll: async () => [
        {
          id: staleId,
          task_id: null,
          project_id: null,
          label: 'stale',
          command: 'echo stale',
          cwd: '/tmp',
          auto_restart: 0,
          pid: staleSurvivorPid ?? null // simulates a pid persisted before an uncontrolled app exit
        }
      ],
      insert: async () => {},
      update: async () => {},
      remove: async () => {},
      updatePid: async () => {},
      recordPid: async () => {},
      listPidHistory: async () => [],
      removePidHistory: async () => {}
    }
    await initProcessManagerWith(fakePersistence)

    const inertHandle: ProcHandle = {
      pid: 999999,
      onData: () => ({ dispose() {} }),
      onExit: () => ({ dispose() {} }),
      kill: () => {}
    }
    setProcessBackend({
      spawn: () => inertHandle,
      getCommandLine: async () => null, // the leader pid itself is already dead
      killByPid: (pid, sig) => {
        staleSweepCalls.push({ pid, sig })
        if (pid === staleSurvivorPid && sig === 'SIGKILL') staleSurvivor!.kill('SIGKILL')
      }
    })

    await restartProcess(staleId) // awaits reapStaleIfNeeded internally

    expect(staleSweepCalls).toContainEqual({ pid: staleSurvivorPid, sig: 'SIGTERM' })
  })
})

// --- reapKnownHistory: a *normal-looking* restart (hadLiveHandle=true,
//     never surfaces 'orphaned', reapStaleIfNeeded is skipped entirely for
//     this kind of transition by design) can still silently leak a
//     descendant if its own kill() never actually reached it — e.g. an
//     intermediate hop in a multi-process script chain that escaped the
//     group signal. Before this fix, nothing ever looked back at that
//     generation once a *later* restart's spawn overwrote proc.pid — it
//     sat forever, invisible to reapStaleIfNeeded (which only ever
//     inspects the current pid). A history-backed sweep must catch it on
//     the NEXT restart, however many generations later. ---
describe('reapKnownHistory', () => {
  let genA: ChildProcess | undefined
  let genAPid: number | undefined
  const historyByProcessId = new Map<string, Array<{ pid: number; spawnedAt: string }>>()
  const historyPersistence: ProcessPersistence = {
    loadAll: async () => [],
    insert: async () => {},
    update: async () => {},
    remove: async () => {},
    updatePid: async () => {},
    recordPid: async (id, pid) => {
      historyByProcessId.set(id, [
        ...(historyByProcessId.get(id) ?? []),
        { pid, spawnedAt: new Date().toISOString() }
      ])
    },
    listPidHistory: async (id) => historyByProcessId.get(id) ?? [],
    removePidHistory: async (id, pid) => {
      historyByProcessId.set(
        id,
        (historyByProcessId.get(id) ?? []).filter((e) => e.pid !== pid)
      )
    }
  }
  const FAKE_GEN_B_PID = 987654321 // arbitrary — generation B is never actually spawned for real
  const multiGenKillCalls: Array<{ pid: number; sig?: string }> = []
  let multiGenId = ''
  const genAInHistory = async (): Promise<boolean> =>
    (await historyPersistence.listPidHistory(multiGenId)).some((e) => e.pid === genAPid)

  afterAll(async () => {
    await testSleep(700)
    if (multiGenId) killProcess(multiGenId)
    genA?.kill('SIGKILL')
    setProcessBackend(null)
  })

  test('test setup: generation A has a pid', () => {
    genA = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    genAPid = genA.pid
    expect(genAPid).not.toBeUndefined()
  })

  test("generation A's pid is recorded in history on spawn", async () => {
    await initProcessManagerWith(historyPersistence)

    const genAHandle: ProcHandle = {
      pid: genAPid,
      onData: () => ({ dispose() {} }),
      onExit: () => ({ dispose() {} }),
      kill: () => {} // deliberately doesn't reach genA — simulates a kill that never lands
    }
    const genBHandle: ProcHandle = {
      pid: FAKE_GEN_B_PID,
      onData: () => ({ dispose() {} }),
      onExit: () => ({ dispose() {} }),
      kill: () => {}
    }
    let spawnCalls = 0
    setProcessBackend({
      spawn: () => (spawnCalls++ === 0 ? genAHandle : genBHandle),
      getCommandLine: async () => null,
      killByPid: (pid, sig) => {
        multiGenKillCalls.push({ pid, sig })
        if (pid === genAPid && sig === 'SIGKILL') genA!.kill('SIGKILL')
      }
    })

    multiGenId = await spawnProcess(null, null, 'multigen', 'echo multigen', '/tmp', false)
    expect(await genAInHistory()).toBe(true)
  })

  // Restart #1: hadLiveHandle=true (genA looks perfectly healthy) — its own
  // kill() never actually reaches genA (real process, stays alive).
  // reapStaleIfNeeded is skipped for this transition; reapKnownHistory
  // correctly defers on genA too, since it's still the CURRENT pid here.
  test('a restart never touches the still-current generation via history (that is reapStaleIfNeeded’s job)', async () => {
    await restartProcess(multiGenId)
    await testSleep(700) // let the scheduled doSpawn land, assigning generation B
    expect(multiGenKillCalls.filter((c) => c.pid === genAPid)).toEqual([])
  })
  test("generation A is still in history — its leak hasn't been discovered yet", async () => {
    expect(await genAInHistory()).toBe(true)
  })

  // Restart #2: generation B is now current; generation A is a superseded,
  // already-forgotten-by-the-single-pid-column leak. Only reapKnownHistory
  // can find it now.
  test('reapKnownHistory sweeps a generation left behind by an earlier, clean-looking restart', async () => {
    await restartProcess(multiGenId)
    expect(multiGenKillCalls).toContainEqual({ pid: genAPid, sig: 'SIGTERM' })
    expect(multiGenKillCalls).toContainEqual({ pid: genAPid, sig: 'SIGKILL' })
  })
  test('the swept generation is pruned from history once resolved', async () => {
    expect(await genAInHistory()).toBe(false)
  })
})

// --- sweepAllHistoryOnBoot: initProcessManagerWith must sweep every row's
//     older history entries too, not just whatever reapStaleIfNeeded checks
//     on next explicit restart — this is what recovers an orphan across a
//     full app restart even for a row nobody manually restarts again. Also
//     covers pruning: a fully-dead history entry must be forgotten without
//     ever being sent a signal, and the row's CURRENT pid must be left
//     alone (that one is reapStaleIfNeeded's domain, not touched at boot). ---
describe('sweepAllHistoryOnBoot', () => {
  let bootOrphan: ChildProcess | undefined
  let bootOrphanPid: number | undefined
  const bootRowId = 'boot-sweep-test-id'
  const currentPid = 555555 // the row's "current" pid — must be left alone
  const deadPid = 8888887 // answers to nothing — must be pruned, never signaled
  const bootKillCalls: Array<{ pid: number; sig?: string }> = []

  afterAll(() => {
    bootOrphan?.kill('SIGKILL')
    killProcess(bootRowId)
    setProcessBackend(null)
  })

  test('test setup: boot-sweep orphan has a pid', () => {
    bootOrphan = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    bootOrphanPid = bootOrphan.pid
    expect(bootOrphanPid).not.toBeUndefined()
  })

  test('a boot-time sweep reaps a stale history entry even though the row was never restarted this session', async () => {
    const bootHistoryPersistence: ProcessPersistence = {
      loadAll: async () => [
        {
          id: bootRowId,
          task_id: null,
          project_id: null,
          label: 'boot',
          command: 'echo boot',
          cwd: '/tmp',
          auto_restart: 0,
          pid: currentPid
        }
      ],
      insert: async () => {},
      update: async () => {},
      remove: async () => {},
      updatePid: async () => {},
      recordPid: async () => {},
      listPidHistory: async (id) =>
        id === bootRowId
          ? [
              { pid: bootOrphanPid!, spawnedAt: '' },
              { pid: deadPid, spawnedAt: '' },
              { pid: currentPid, spawnedAt: '' }
            ]
          : [],
      removePidHistory: async () => {}
    }

    setProcessBackend({
      spawn: () => ({
        pid: undefined,
        onData: () => ({ dispose() {} }),
        onExit: () => ({ dispose() {} }),
        kill: () => {}
      }),
      getCommandLine: async () => null,
      killByPid: (pid, sig) => {
        bootKillCalls.push({ pid, sig })
        if (pid === bootOrphanPid && sig === 'SIGKILL') bootOrphan!.kill('SIGKILL')
      }
    })

    await initProcessManagerWith(bootHistoryPersistence) // fires sweepAllHistoryOnBoot internally
    // sweepAllHistoryOnBoot is fire-and-forget inside initProcessManagerWith —
    // give its reap (SIGTERM -> 2s poll -> SIGKILL) time to complete.
    await testSleep(2500)

    expect(bootKillCalls.map((c) => c.pid)).toContain(bootOrphanPid)
  })
  test('a fully-dead history entry is pruned silently, never sent a signal', () => {
    expect(bootKillCalls.map((c) => c.pid)).not.toContain(deadPid)
  })
  test("the row's current pid is left alone by the boot sweep", () => {
    expect(bootKillCalls.map((c) => c.pid)).not.toContain(currentPid)
  })
})

// --- setProjectCwdResolver: a project-scoped process must spawn using the
//     resolver's live path when one is wired, self-healing its stored cwd
//     in the process — this is exactly the "renamed project folder" bug: a
//     cwd snapshotted at creation time must never be trusted forever. A
//     task-scoped process (which may run in its own worktree) must never
//     consult the resolver at all. A resolver that doesn't know a project
//     (returns null) must fall back to the stored cwd, not throw or spawn
//     into an empty path. ---
describe('setProjectCwdResolver', () => {
  const spawnedCwds: string[] = []
  const projectPaths = new Map<string, string>([['proj-moved', '/new/live/path']])
  let movedId = ''
  let restartId = ''

  beforeAll(() => {
    setProcessBackend({
      spawn: (spec) => {
        spawnedCwds.push(spec.cwd)
        return {
          pid: 555111,
          onData: () => ({ dispose() {} }),
          onExit: () => ({ dispose() {} }),
          kill: () => {}
        }
      },
      getCommandLine: async () => null,
      killByPid: () => {}
    })
    setProjectCwdResolver(async (projectId) => projectPaths.get(projectId) ?? null)
  })

  afterAll(() => {
    setProjectCwdResolver(null)
    setProcessBackend(null)
  })

  test("a project-scoped process spawns using the resolver's live cwd, not the stale stored one", async () => {
    movedId = await spawnProcess(
      'proj-moved',
      null,
      'moved dev',
      'echo moved',
      '/old/stale/path',
      false
    )
    expect(spawnedCwds.at(-1)).toBe('/new/live/path')
  })
  test('the resolved cwd self-heals the in-memory record', () => {
    expect(listAllProcesses().find((p) => p.id === movedId)?.cwd).toBe('/new/live/path')
    killProcess(movedId)
  })

  test('a task-scoped process ignores the resolver and keeps its own (worktree) cwd', async () => {
    const taskScopedId = await spawnProcess(
      'proj-moved',
      'task-in-moved-proj',
      'worktree dev',
      'echo worktree',
      '/task/own/worktree',
      false
    )
    expect(spawnedCwds.at(-1)).toBe('/task/own/worktree')
    killProcess(taskScopedId)
  })

  test('a resolver returning null (e.g. a deleted project) falls back to the stored cwd', async () => {
    const unresolvedId = await spawnProcess(
      'proj-unknown',
      null,
      'unresolved dev',
      'echo unresolved',
      '/still/stored/path',
      false
    )
    expect(spawnedCwds.at(-1)).toBe('/still/stored/path')
    killProcess(unresolvedId)
  })

  // restartProcess must also re-resolve — the realistic bug scenario is a
  // project renamed sometime AFTER a process was first created, discovered
  // only on a later restart rather than at the original spawn.
  test('initial spawn before the project is renamed uses the stored cwd (resolver has nothing yet)', async () => {
    restartId = await spawnProcess(
      'proj-restart',
      null,
      'restart dev',
      'echo restart',
      '/old/before/rename',
      false
    )
    expect(spawnedCwds.at(-1)).toBe('/old/before/rename')
  })
  test('restartProcess re-resolves a project-scoped cwd too, not just a fresh spawnProcess', async () => {
    projectPaths.set('proj-restart', '/new/after/rename')
    await restartProcess(restartId)
    await testSleep(700) // let restartProcess's scheduled doSpawn land
    expect(spawnedCwds.at(-1)).toBe('/new/after/rename')
  })
  test('the restart-time resolution also self-heals the stored record', () => {
    expect(listAllProcesses().find((p) => p.id === restartId)?.cwd).toBe('/new/after/rename')
    killProcess(restartId)
  })
})
