import { spawn } from 'child_process'
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

function testSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

function ids(list: Array<{ id: string }>): string[] {
  return list.map((p) => p.id).sort()
}

// Two projects, each with a project-scoped process, plus one task-scoped process.
const projA = await createProcess('proj-a', null, 'a dev', 'echo a', '/tmp', false)
const projB = await createProcess('proj-b', null, 'b dev', 'echo b', '/tmp', false)
const taskProc = await createProcess('proj-a', 'task-1', 'task dev', 'echo t', '/tmp', false)

// Task view: own task's processes + its project's project-scoped ones.
assert(
  ids(listForTask('task-1', 'proj-a')).join(',') === [projA, taskProc].sort().join(','),
  'task view lists task-scoped + own-project processes'
)

// Regression (Home/project view passes taskId=null): `p.taskId === taskId`
// degenerated to `p.taskId === null`, leaking every project's processes.
assert(
  ids(listForTask(null, 'proj-a')).join(',') === [projA].join(','),
  'project view lists only that project, no cross-project leak'
)
assert(
  !ids(listForTask(null, 'proj-a')).includes(taskProc),
  'project view excludes task-scoped processes'
)
assert(
  !ids(listForTask(null, 'proj-a')).includes(projB),
  "project view excludes other projects' processes"
)

// No scope at all → nothing, not the whole table.
assert(listForTask(null, null).length === 0, 'null task + null project lists nothing')

// --- reapSurvivorsAfterUnplannedExit: doSpawn's onExit sweeps the leader's
//     process group when the exit was NOT manager-initiated, and must not
//     double-sweep a manager-initiated stop (proc.handle nulled first there,
//     so the `proc.handle !== handle` guard short-circuits before it). ---
async function main(): Promise<void> {
  const sweepKillCalls: Array<{ pid: number; sig?: string }> = []
  let capturedExit: ((e: { code: number | null; signal: string | null }) => void) | null = null
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
  setProcessBackend(sweepBackend)

  const crashId = await spawnProcess(null, null, 'crashy', 'echo crashy', '/tmp', false)
  assert(capturedExit !== null, 'doSpawn registers an onExit handler')
  capturedExit!({ code: 1, signal: null }) // simulate the leader dying on its own
  assert(
    sweepKillCalls.some((c) => c.pid === 424242),
    "an unplanned exit sweeps the leader pid's process group"
  )
  killProcess(crashId)

  sweepKillCalls.length = 0
  const stoppedId = await spawnProcess(null, null, 'stoppable', 'echo stoppable', '/tmp', false)
  assert(capturedExit !== null, 'doSpawn registers an onExit handler on the second spawn too')
  stopProcess(stoppedId)
  // Same underlying handle/callback, fired again — mirrors the real process
  // finally exiting *after* stopProcess already nulled proc.handle.
  capturedExit!({ code: 0, signal: null })
  assert(
    sweepKillCalls.length === 0,
    'a manager-initiated stop does not additionally sweep via onExit'
  )
  killProcess(stoppedId)

  // --- the pgrep survivor snapshot must actually log what it finds, not
  //     just call killByPid. The fake handles above use a pid nothing real
  //     answers to, so `pgrep -g <pid>` never matches and that branch never
  //     runs — exercise it against a real detached process instead, so
  //     `pgrep -g <realPid>` has a genuine survivor to find. ---
  const real = spawn('sleep', ['5'], { detached: true, stdio: 'ignore' })
  const realPid = real.pid
  assert(realPid !== undefined, 'test setup: real detached process has a pid')

  let capturedRealExit: ((e: { code: number | null; signal: string | null }) => void) | null = null
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
  const logKillCalls: Array<{ pid: number; sig?: string }> = []
  setProcessBackend({
    spawn: () => realPidHandle,
    getCommandLine: async () => null,
    killByPid: (pid, sig) => {
      logKillCalls.push({ pid, sig })
    }
  })

  const logId = await spawnProcess(null, null, 'logtest', 'echo logtest', '/tmp', false)
  assert(capturedRealExit !== null, 'doSpawn registers an onExit handler for the real-pid case')
  // Simulate the leader dying while realPid's own (still-alive) group is the survivor.
  capturedRealExit!({ code: 1, signal: null })

  const logBuffer = listAllProcesses().find((p) => p.id === logId)?.logBuffer ?? []
  assert(
    logBuffer.some((line) => line.includes(String(realPid)) && line.includes('still alive')),
    'an unplanned exit with a live survivor logs the survivor pid into the process log'
  )
  assert(
    logKillCalls.some((c) => c.pid === realPid),
    'the survivor group is still swept via killByPid alongside the diagnostic log'
  )

  killProcess(logId)
  real.kill('SIGKILL') // clean up our own test process rather than waiting out its 5s sleep
  setProcessBackend(null)

  // --- the actual bug: a leader that exits while a descendant survives the
  //     *entire* sweep (SIGTERM -> poll -> SIGKILL) must be reported as
  //     'orphaned', never a false 'completed'/'error' — and it must keep an
  //     identifying pid and log a line even though autoRestart is false. Use
  //     a killByPid that's a deliberate no-op so a real detached process
  //     genuinely outlives the whole escalation window. ---
  {
    const survivor = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    const survivorPid = survivor.pid
    assert(survivorPid !== undefined, 'test setup: orphan survivor has a pid')

    let capturedOrphanExit:
      | ((e: { code: number | null; signal: string | null }) => void | Promise<void>)
      | null = null
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
    const noopKillCalls: Array<{ pid: number; sig?: string }> = []
    setProcessBackend({
      spawn: () => orphanHandle,
      getCommandLine: async () => null,
      killByPid: (pid, sig) => {
        noopKillCalls.push({ pid, sig }) // deliberately never actually kills `survivor`
      }
    })

    const orphanId = await spawnProcess(null, null, 'orphantest', 'echo orphantest', '/tmp', false)
    assert(capturedOrphanExit !== null, 'doSpawn registers an onExit handler for the orphan case')
    await capturedOrphanExit!({ code: 0, signal: null })

    const orphanProc = listAllProcesses().find((p) => p.id === orphanId)
    assert(
      orphanProc?.status === 'orphaned',
      `a leader exit with a survivor that outlives the sweep -> status 'orphaned' (got ${orphanProc?.status})`
    )
    assert(
      orphanProc?.pid === survivorPid,
      "an orphaned record keeps the dead leader's pid as an identifier, not null"
    )
    assert(
      (orphanProc?.logBuffer ?? []).some((line) => line.includes('orphaned')),
      'an orphaned exit is logged even though autoRestart is false'
    )
    assert(
      noopKillCalls.some((c) => c.pid === survivorPid && c.sig === 'SIGTERM'),
      'the sweep sent SIGTERM to the survivor group'
    )
    assert(
      noopKillCalls.some((c) => c.pid === survivorPid && c.sig === 'SIGKILL'),
      'the sweep escalated to SIGKILL after the survivor outlived SIGTERM'
    )

    killProcess(orphanId)
    survivor.kill('SIGKILL')
    setProcessBackend(null)
  }

  // --- reapStaleIfNeeded (the cross-restart recovery path, reached when a
  //     row is reloaded from persistence with a pid but no live handle) must
  //     also catch a leader that's already dead while its old process group
  //     still has a live member. Before this fix, `getCommandLine` on the
  //     already-dead leader pid returned null and the function bailed out
  //     silently, abandoning the orphan and colliding with it on next spawn. ---
  {
    const staleSurvivor = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    const staleSurvivorPid = staleSurvivor.pid
    assert(staleSurvivorPid !== undefined, 'test setup: stale-recovery survivor has a pid')

    const staleId = 'stale-restart-test-id'
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
    const staleSweepCalls: Array<{ pid: number; sig?: string }> = []
    setProcessBackend({
      spawn: () => inertHandle,
      getCommandLine: async () => null, // the leader pid itself is already dead
      killByPid: (pid, sig) => {
        staleSweepCalls.push({ pid, sig })
        if (pid === staleSurvivorPid && sig === 'SIGKILL') staleSurvivor.kill('SIGKILL')
      }
    })

    await restartProcess(staleId) // awaits reapStaleIfNeeded internally

    assert(
      staleSweepCalls.some((c) => c.pid === staleSurvivorPid && c.sig === 'SIGTERM'),
      "reapStaleIfNeeded sweeps the dead leader's old group, not just the leader pid itself"
    )

    // restartProcess also scheduled a real doSpawn ~500ms out (against this
    // fake backend) — wait for it to land *before* killProcess, so killProcess
    // clears the title-poll interval that spawn starts rather than tearing
    // this record down first and leaving that interval to leak forever.
    await testSleep(700)
    killProcess(staleId)
    staleSurvivor.kill('SIGKILL')
    setProcessBackend(null)
  }

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
  {
    const genA = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    const genAPid = genA.pid
    assert(genAPid !== undefined, 'test setup: generation A has a pid')

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
    await initProcessManagerWith(historyPersistence)

    const FAKE_GEN_B_PID = 987654321 // arbitrary — generation B is never actually spawned for real
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
    const multiGenKillCalls: Array<{ pid: number; sig?: string }> = []
    setProcessBackend({
      spawn: () => (spawnCalls++ === 0 ? genAHandle : genBHandle),
      getCommandLine: async () => null,
      killByPid: (pid, sig) => {
        multiGenKillCalls.push({ pid, sig })
        if (pid === genAPid && sig === 'SIGKILL') genA.kill('SIGKILL')
      }
    })

    const multiGenId = await spawnProcess(null, null, 'multigen', 'echo multigen', '/tmp', false)
    assert(
      (await historyPersistence.listPidHistory(multiGenId)).some((e) => e.pid === genAPid),
      "generation A's pid is recorded in history on spawn"
    )

    // Restart #1: hadLiveHandle=true (genA looks perfectly healthy) — its own
    // kill() never actually reaches genA (real process, stays alive).
    // reapStaleIfNeeded is skipped for this transition; reapKnownHistory
    // correctly defers on genA too, since it's still the CURRENT pid here.
    await restartProcess(multiGenId)
    await testSleep(700) // let the scheduled doSpawn land, assigning generation B
    assert(
      !multiGenKillCalls.some((c) => c.pid === genAPid),
      'a restart never touches the still-current generation via history (that is reapStaleIfNeeded’s job)'
    )
    assert(
      (await historyPersistence.listPidHistory(multiGenId)).some((e) => e.pid === genAPid),
      "generation A is still in history — its leak hasn't been discovered yet"
    )

    // Restart #2: generation B is now current; generation A is a superseded,
    // already-forgotten-by-the-single-pid-column leak. Only reapKnownHistory
    // can find it now.
    await restartProcess(multiGenId)
    assert(
      multiGenKillCalls.some((c) => c.pid === genAPid && c.sig === 'SIGTERM') &&
        multiGenKillCalls.some((c) => c.pid === genAPid && c.sig === 'SIGKILL'),
      'reapKnownHistory sweeps a generation left behind by an earlier, clean-looking restart'
    )
    assert(
      !(await historyPersistence.listPidHistory(multiGenId)).some((e) => e.pid === genAPid),
      'the swept generation is pruned from history once resolved'
    )

    await testSleep(700)
    killProcess(multiGenId)
    genA.kill('SIGKILL')
    setProcessBackend(null)
  }

  // --- sweepAllHistoryOnBoot: initProcessManagerWith must sweep every row's
  //     older history entries too, not just whatever reapStaleIfNeeded checks
  //     on next explicit restart — this is what recovers an orphan across a
  //     full app restart even for a row nobody manually restarts again. Also
  //     covers pruning: a fully-dead history entry must be forgotten without
  //     ever being sent a signal, and the row's CURRENT pid must be left
  //     alone (that one is reapStaleIfNeeded's domain, not touched at boot). ---
  {
    const bootOrphan = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    const bootOrphanPid = bootOrphan.pid
    assert(bootOrphanPid !== undefined, 'test setup: boot-sweep orphan has a pid')

    const bootRowId = 'boot-sweep-test-id'
    const currentPid = 555555 // the row's "current" pid — must be left alone
    const deadPid = 8888887 // answers to nothing — must be pruned, never signaled
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

    const bootKillCalls: Array<{ pid: number; sig?: string }> = []
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
        if (pid === bootOrphanPid && sig === 'SIGKILL') bootOrphan.kill('SIGKILL')
      }
    })

    await initProcessManagerWith(bootHistoryPersistence) // fires sweepAllHistoryOnBoot internally
    // sweepAllHistoryOnBoot is fire-and-forget inside initProcessManagerWith —
    // give its reap (SIGTERM -> 2s poll -> SIGKILL) time to complete.
    await testSleep(2500)

    assert(
      bootKillCalls.some((c) => c.pid === bootOrphanPid),
      'a boot-time sweep reaps a stale history entry even though the row was never restarted this session'
    )
    assert(
      !bootKillCalls.some((c) => c.pid === deadPid),
      'a fully-dead history entry is pruned silently, never sent a signal'
    )
    assert(
      !bootKillCalls.some((c) => c.pid === currentPid),
      "the row's current pid is left alone by the boot sweep"
    )

    bootOrphan.kill('SIGKILL')
    killProcess(bootRowId)
    setProcessBackend(null)
  }

  // --- setProjectCwdResolver: a project-scoped process must spawn using the
  //     resolver's live path when one is wired, self-healing its stored cwd
  //     in the process — this is exactly the "renamed project folder" bug: a
  //     cwd snapshotted at creation time must never be trusted forever. A
  //     task-scoped process (which may run in its own worktree) must never
  //     consult the resolver at all. A resolver that doesn't know a project
  //     (returns null) must fall back to the stored cwd, not throw or spawn
  //     into an empty path. ---
  {
    const spawnedCwds: string[] = []
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

    const projectPaths = new Map<string, string>([['proj-moved', '/new/live/path']])
    setProjectCwdResolver(async (projectId) => projectPaths.get(projectId) ?? null)

    const movedId = await spawnProcess(
      'proj-moved',
      null,
      'moved dev',
      'echo moved',
      '/old/stale/path',
      false
    )
    assert(
      spawnedCwds.at(-1) === '/new/live/path',
      "a project-scoped process spawns using the resolver's live cwd, not the stale stored one"
    )
    assert(
      listAllProcesses().find((p) => p.id === movedId)?.cwd === '/new/live/path',
      'the resolved cwd self-heals the in-memory record'
    )
    killProcess(movedId)

    const taskScopedId = await spawnProcess(
      'proj-moved',
      'task-in-moved-proj',
      'worktree dev',
      'echo worktree',
      '/task/own/worktree',
      false
    )
    assert(
      spawnedCwds.at(-1) === '/task/own/worktree',
      'a task-scoped process ignores the resolver and keeps its own (worktree) cwd'
    )
    killProcess(taskScopedId)

    const unresolvedId = await spawnProcess(
      'proj-unknown',
      null,
      'unresolved dev',
      'echo unresolved',
      '/still/stored/path',
      false
    )
    assert(
      spawnedCwds.at(-1) === '/still/stored/path',
      'a resolver returning null (e.g. a deleted project) falls back to the stored cwd'
    )
    killProcess(unresolvedId)

    // restartProcess must also re-resolve — the realistic bug scenario is a
    // project renamed sometime AFTER a process was first created, discovered
    // only on a later restart rather than at the original spawn.
    const restartId = await spawnProcess(
      'proj-restart',
      null,
      'restart dev',
      'echo restart',
      '/old/before/rename',
      false
    )
    assert(
      spawnedCwds.at(-1) === '/old/before/rename',
      'initial spawn before the project is renamed uses the stored cwd (resolver has nothing yet)'
    )
    projectPaths.set('proj-restart', '/new/after/rename')
    await restartProcess(restartId)
    await testSleep(700) // let restartProcess's scheduled doSpawn land
    assert(
      spawnedCwds.at(-1) === '/new/after/rename',
      'restartProcess re-resolves a project-scoped cwd too, not just a fresh spawnProcess'
    )
    assert(
      listAllProcesses().find((p) => p.id === restartId)?.cwd === '/new/after/rename',
      'the restart-time resolution also self-heals the stored record'
    )
    killProcess(restartId)

    setProjectCwdResolver(null)
    setProcessBackend(null)
  }

  console.log('process-manager: all passed')
}

void main()
