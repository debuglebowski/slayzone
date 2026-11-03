import { beforeAll, describe, expect, test } from 'vitest'
import { createProcess, listForTask } from './process-manager'

// Spawning, stopping and exits run through a routed backend: process-backend.test.ts,
// process-routing.test.ts, process-routed-lifecycle.test.ts.

function ids(list: Array<{ id: string }>): string[] {
  return list.map((p) => p.id).sort()
}

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
