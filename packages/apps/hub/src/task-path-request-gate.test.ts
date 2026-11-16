/**
 * Every task-scoped request to a computer (a terminal, process, warm agent or exec
 * started for a task, a file/git read in its scope) waits for the task's staged
 * paths to reach that computer first: the computer judges the request against the
 * task's folders, which it only knows once the `task-path` row landed. S3: a
 * process restarted when its computer connects raced the reconnect handoff.
 */
import { HubToComputerMethods } from '@slayzone/computer-transport/shared'
import { runInPathScope } from '@slayzone/platform/path-scope'
import { expect, test } from 'vitest'
import { createTaskPathRequestGate } from './task-path-request-gate'

function gate() {
  const flushed: Array<[string, string]> = []
  const run = createTaskPathRequestGate({
    flushTaskPaths: async (taskId, computerId) => {
      flushed.push([taskId, computerId])
    }
  })
  return { run, flushed }
}

const taskScope = { kind: 'task', taskId: 't1', projectId: 'p' } as const

test('a spawn naming its task waits for the task’s paths (pty, process, warm adopt)', async () => {
  const g = gate()
  await g.run('pc', HubToComputerMethods.procSpawn, { taskId: 't1', projectId: 'p', cwd: '/w' })
  await g.run('pc', HubToComputerMethods.ptySpawn, { taskId: 't2' })
  await g.run('pc', HubToComputerMethods.ptyWarmAdopt, {
    warmId: 'w',
    taskId: 't3',
    sessionId: 's'
  })
  expect(g.flushed).toEqual([
    ['t1', 'pc'],
    ['t2', 'pc'],
    ['t3', 'pc']
  ])
})

test('any request sent in a task’s path scope (exec, warm spawn, file and git reads) waits too', async () => {
  const g = gate()
  await runInPathScope(taskScope, async () => {
    await g.run('pc', HubToComputerMethods.execRun, { command: 'true', timeoutMs: 1 })
    await g.run('pc', HubToComputerMethods.ptyWarmSpawn, { projectId: 'p' })
    await g.run('pc', HubToComputerMethods.fsReadDir, {})
  })
  expect(g.flushed).toEqual([
    ['t1', 'pc'],
    ['t1', 'pc'],
    ['t1', 'pc']
  ])
})

test('the handoff’s own chat requests, project scopes and unscoped requests do not', async () => {
  const g = gate()
  await runInPathScope(taskScope, () =>
    g.run('pc', HubToComputerMethods.chatRequest, { kind: 'data.import', taskId: 't1' })
  )
  await runInPathScope({ kind: 'project', projectId: 'p' }, () =>
    g.run('pc', HubToComputerMethods.procSpawn, { projectId: 'p' })
  )
  await g.run('pc', HubToComputerMethods.procSpawn, { global: true })
  await g.run('pc', HubToComputerMethods.ptyWrite, { sessionId: 's', data: 'x' })
  expect(g.flushed).toEqual([])
})
