import type { BoardData } from '../hub-board'
import { boardOf, projectOf, taskOf } from '../hubs/testing'
import { blockerCandidates, isBlocked, projectTags, subtasksOf, toggleTag } from './organise'

const tag = (id: string, project_id: string) => ({
  id,
  project_id,
  name: id,
  color: 'tag-bg',
  text_color: 'tag-fg',
  sort_order: 0,
  created_at: ''
})

function board(): BoardData {
  const b = boardOf({
    projects: [
      projectOf('p'),
      projectOf('q', {
        columns_config: [
          { id: 'open', label: 'Open', color: 'col-blue', position: 0, category: 'unstarted' },
          { id: 'closed', label: 'Closed', color: 'col-green', position: 1, category: 'completed' }
        ]
      })
    ],
    tasks: [
      taskOf('t', { title: 'The task' }),
      taskOf('s2', { parent_id: 't', title: 'Second' }),
      taskOf('other', { title: 'Other work' }),
      taskOf('s1', { parent_id: 't', title: 'First' }),
      taskOf('finished', { title: 'Finished', status: 'done' }),
      taskOf('q-open', { project_id: 'q', title: 'Q open', status: 'open' }),
      taskOf('q-closed', { project_id: 'q', title: 'Q closed', status: 'closed' })
    ]
  })
  return {
    ...b,
    tags: [tag('red', 'p'), tag('blue', 'q'), tag('green', 'p')],
    taskTags: { t: ['green'] },
    blockedTaskIds: ['other']
  } as BoardData
}

describe('subtasksOf', () => {
  it("the task's subtasks, in board order", () => {
    expect(subtasksOf(board(), 't').map((s) => s.id)).toEqual(['s2', 's1'])
    expect(subtasksOf(board(), 'other')).toEqual([])
  })
})

describe('tags', () => {
  it("the task's project's tags only", () => {
    expect(projectTags(board(), 'p').map((t) => t.id)).toEqual(['red', 'green'])
  })

  it('toggles a tag in the task’s tag ids', () => {
    expect(toggleTag(['green'], 'red')).toEqual(['green', 'red'])
    expect(toggleTag(['green', 'red'], 'green')).toEqual(['red'])
  })
})

describe('blockers', () => {
  it('any open task of the same hub but itself and its current blockers', () => {
    const ids = blockerCandidates(board(), 't', ['s1'], '').map((t) => t.id)
    // `finished` (default workflow: done) and `q-closed` (its project's completed column) are closed.
    expect(ids).toEqual(['s2', 'other', 'q-open'])
  })

  it('filters by title', () => {
    expect(blockerCandidates(board(), 't', [], ' WORK ').map((t) => t.id)).toEqual(['other'])
  })

  it('blocked = the board says so (a blocker, or the flag)', () => {
    expect(isBlocked(board(), 'other')).toBe(true)
    expect(isBlocked(board(), 't')).toBe(false)
  })
})
