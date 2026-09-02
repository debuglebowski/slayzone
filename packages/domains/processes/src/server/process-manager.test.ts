import { spawn } from 'child_process'
import {
  createProcess,
  initProcessManagerWith,
  killProcess,
  listAllProcesses,
  listForTask,
  restartProcess,
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
const projA = createProcess('proj-a', null, 'a dev', 'echo a', '/tmp', false)
const projB = createProcess('proj-b', null, 'b dev', 'echo b', '/tmp', false)
const taskProc = createProcess('proj-a', 'task-1', 'task dev', 'echo t', '/tmp', false)

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

  let capturedRealExit: ((e: { code: number | null; signal: string | null }) => void) | null =
    null
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
          pid: staleSurvivorPid // simulates a pid persisted before an uncontrolled app exit
        }
      ],
      insert: async () => {},
      update: async () => {},
      remove: async () => {},
      updatePid: async () => {}
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

  console.log('process-manager: all passed')
}

void main()
