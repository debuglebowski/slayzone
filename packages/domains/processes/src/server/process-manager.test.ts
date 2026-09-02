import { spawn } from 'child_process'
import {
  createProcess,
  killProcess,
  listAllProcesses,
  listForTask,
  spawnProcess,
  stopProcess
} from './process-manager'
import { setProcessBackend } from './process-backend'
import type { ProcessBackend, ProcHandle } from './process-backend'

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

  console.log('process-manager: all passed')
}

void main()
