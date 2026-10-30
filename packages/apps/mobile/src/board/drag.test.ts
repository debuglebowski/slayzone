import { dropTarget } from './drag'

// Kanban: two columns side by side; rows stacked in each.
const targets = {
  columns: [
    { id: 'todo', rect: { x: 0, y: 0, width: 100, height: 400 } },
    { id: 'done', rect: { x: 100, y: 0, width: 100, height: 400 } },
    // A phone's column chip: dropping on it = the end of that column.
    { id: 'review', rect: { x: 0, y: 420, width: 60, height: 30 } }
  ],
  rows: [
    { taskId: 'a', columnId: 'todo', rect: { x: 0, y: 0, width: 100, height: 40 } },
    { taskId: 'b', columnId: 'todo', rect: { x: 0, y: 40, width: 100, height: 40 } },
    { taskId: 'c', columnId: 'done', rect: { x: 100, y: 0, width: 100, height: 40 } }
  ]
}

describe('dropTarget', () => {
  it('lands before the first row whose middle is below the finger', () => {
    expect(dropTarget(targets, { x: 50, y: 10 })).toEqual({ column: 'todo', beforeTaskId: 'a' })
    expect(dropTarget(targets, { x: 50, y: 30 })).toEqual({ column: 'todo', beforeTaskId: 'b' })
    expect(dropTarget(targets, { x: 50, y: 70 })).toEqual({ column: 'todo', beforeTaskId: null })
    expect(dropTarget(targets, { x: 150, y: 300 })).toEqual({ column: 'done', beforeTaskId: null })
  })

  it('a chip is its column end; outside every column = nowhere', () => {
    expect(dropTarget(targets, { x: 30, y: 430 })).toEqual({ column: 'review', beforeTaskId: null })
    expect(dropTarget(targets, { x: 300, y: 10 })).toBeNull()
  })
})
