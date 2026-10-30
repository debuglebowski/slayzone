import { boardOf, feedOf, homeHub, projectOf, taskOf, workHub } from '../hubs/testing'
import { searchTasks } from './task-search'

const feeds = () => [
  feedOf(
    homeHub,
    boardOf({
      projects: [projectOf('p', { name: 'Home' })],
      tasks: [
        taskOf('h1', { title: 'Fix login bug', description: 'Users see a blank page' }),
        taskOf('h2', { title: 'Write docs', description: 'Explain the login flow in detail' }),
        taskOf('h3', { title: 'Login', parent_id: 'h1' }),
        taskOf('tmp', { title: 'login scratch', is_temporary: true })
      ]
    })
  ),
  feedOf(workHub, undefined),
  feedOf(
    workHub,
    boardOf({
      projects: [projectOf('p', { name: 'Work' })],
      tasks: [taskOf('h1', { title: 'Login page redesign', description: null })]
    })
  )
]

describe('searchTasks', () => {
  it('finds titles and descriptions of every hub, best title matches first', () => {
    const results = searchTasks(feeds(), 'login')
    expect(results.map((r) => [r.hubLabel, r.task.id, r.matchedIn])).toEqual([
      [homeHub.label, 'h3', 'title'], // exact title
      [workHub.label, 'h1', 'title'], // title prefix
      [homeHub.label, 'h1', 'title'], // in the title
      [homeHub.label, 'h2', 'description']
    ])
    // Keyed by hub and task: the two hubs' "h1" are different rows.
    expect(new Set(results.map((r) => r.key)).size).toBe(4)
    expect(results[3].project?.name).toBe('Home')
  })

  it('matches every word, anywhere, ignoring case; a description hit carries its excerpt', () => {
    const [hit] = searchTasks(feeds(), 'FLOW explain')
    expect(hit.task.id).toBe('h2')
    expect(hit.excerpt).toContain('Explain the login flow')
    expect(searchTasks(feeds(), '  ')).toEqual([])
    expect(searchTasks(feeds(), 'nothing-like-this')).toEqual([])
  })
})
