import { describe, expect, it } from 'vitest'
import { buildCreateTaskFormDefaults } from './createTaskFormDefaults'

describe('buildCreateTaskFormDefaults', () => {
  it('returns blank defaults when no prefill is provided', () => {
    expect(buildCreateTaskFormDefaults()).toEqual({
      projectId: '',
      title: '',
      description: '',
      status: 'inbox',
      priority: 3,
      dueDate: null,
      tagIds: [],
    })
  })

  it('merges the fallback project id with the task draft', () => {
    expect(buildCreateTaskFormDefaults({
      projectId: 'project-1',
      title: 'Link: Docs',
      description: 'https://example.com/docs',
      status: 'todo',
      priority: 2,
      dueDate: '2026-04-01',
    }, 'fallback-project')).toEqual({
      projectId: 'project-1',
      title: 'Link: Docs',
      description: 'https://example.com/docs',
      status: 'todo',
      priority: 2,
      dueDate: '2026-04-01',
      tagIds: [],
    })
  })

  it('uses the fallback project id when the draft does not provide one', () => {
    expect(buildCreateTaskFormDefaults({ title: 'Quick task' }, 'fallback-project')).toEqual({
      projectId: 'fallback-project',
      title: 'Quick task',
      description: '',
      status: 'inbox',
      priority: 3,
      dueDate: null,
      tagIds: [],
    })
  })
})
