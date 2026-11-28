import { describe, expect, it } from 'vitest'
import type { Project } from '@slayzone/projects-contracts'
import type { Task } from '@slayzone/task-contracts'
import { appendHubTaskHits, HUB_TASK_HITS_MAX } from './hub-task-hits'
import type { RankedResult } from './SearchDialog.algorithm'

const task = (id: string, extra: Partial<Task> = {}) =>
  ({ id, title: `T ${id}`, status: 'todo', priority: 3, project_id: 'p', ...extra }) as Task
const projects = [{ id: 'p', name: 'Proj' }] as Project[]
const local = (id: string): RankedResult => ({
  item: { kind: 'task', id, label: id, sublabel: '', status: 'todo', priority: 3 },
  score: 1,
  positions: new Set(),
  usedPath: false,
  weightedScore: 1
})

describe('appendHubTaskHits', () => {
  it('appends hub hits the board search missed, after its own, in hub order', () => {
    const out = appendHubTaskHits([local('a')], [task('a'), task('b'), task('c')], projects)
    expect(out.map((r) => r.item.id)).toEqual(['a', 'b', 'c'])
    expect(out[1]!.item).toMatchObject({
      kind: 'task',
      label: 'T b',
      sublabel: 'Proj',
      status: 'todo'
    })
  })

  it('caps the hub hits it adds', () => {
    const hits = Array.from({ length: HUB_TASK_HITS_MAX + 5 }, (_, i) => task(`h${i}`))
    expect(appendHubTaskHits([], hits, projects)).toHaveLength(HUB_TASK_HITS_MAX)
  })

  it('no hub hits: the board results as they are', () => {
    const board = [local('a')]
    expect(appendHubTaskHits(board, undefined, projects)).toBe(board)
  })
})
