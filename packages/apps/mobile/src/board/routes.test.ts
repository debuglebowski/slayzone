import { newTaskHref } from './routes'

describe('newTaskHref', () => {
  it('names the hub, the project and the optional status and parent', () => {
    expect(newTaskHref({ hub: 'work.example:8788', project: 'p 1' })).toBe(
      '/new-task?hub=work.example%3A8788&project=p%201'
    )
    expect(newTaskHref({ hub: 'h', project: 'p', status: 'in_progress', parent: 't' })).toBe(
      '/new-task?hub=h&project=p&status=in_progress&parent=t'
    )
  })
})
