import { createProcess, listForTask } from './process-manager'

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

console.log('process-manager listForTask: all passed')
