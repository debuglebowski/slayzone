import { createTaskInput, type NewTaskDraft } from './create'
import { NO_TEMPLATE } from './fields'
import { newTaskHref } from './routes'

const draft = (fields: Partial<NewTaskDraft> = {}): NewTaskDraft => ({
  projectId: 'p',
  parentId: null,
  title: 'Buy milk',
  status: 'todo',
  priority: 3,
  dueDate: null,
  templateId: NO_TEMPLATE,
  ...fields
})

describe('createTaskInput', () => {
  it('the trimmed title, project, status, priority', () => {
    expect(createTaskInput(draft({ title: '  Buy milk \n' }))).toEqual({
      projectId: 'p',
      title: 'Buy milk',
      status: 'todo',
      priority: 3
    })
  })

  it('a due date, a parent and a template when there are', () => {
    expect(
      createTaskInput(draft({ dueDate: '2026-11-01', parentId: 'parent', templateId: 'tpl' }))
    ).toEqual({
      projectId: 'p',
      title: 'Buy milk',
      status: 'todo',
      priority: 3,
      dueDate: '2026-11-01',
      parentId: 'parent',
      templateId: 'tpl'
    })
  })

  it('no title, nothing to create', () => {
    expect(createTaskInput(draft({ title: '   ' }))).toBeNull()
  })

  it('no project, nothing to create', () => {
    expect(createTaskInput(draft({ projectId: '' }))).toBeNull()
  })
})

describe('newTaskHref', () => {
  it('names the hub and project, and a status and parent when given', () => {
    expect(newTaskHref({ hub: 'work.example:8788', project: 'p 1' })).toBe(
      '/new-task?hub=work.example%3A8788&project=p%201'
    )
    expect(newTaskHref({ hub: 'h', project: 'p', status: 'in_progress', parent: 't' })).toBe(
      '/new-task?hub=h&project=p&status=in_progress&parent=t'
    )
  })
})
