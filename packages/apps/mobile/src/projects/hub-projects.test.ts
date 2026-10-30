import { boardOf, feedOf, homeHub, projectOf, taskOf, workHub } from '../hubs/testing'
import { findProjectRow, mergeHubProjects, projectTasks } from './hub-projects'

describe('mergeHubProjects', () => {
  it("groups every hub's projects under its hub, hubs in sign-in order, projects in board order", () => {
    const groups = mergeHubProjects([
      feedOf(homeHub, boardOf({ projects: [projectOf('h1', { name: 'Site' }), projectOf('h2')] })),
      feedOf(workHub, boardOf({ projects: [projectOf('w1', { name: 'API' })] }))
    ])
    expect(groups.map((g) => g.hub.id)).toEqual([homeHub.id, workHub.id])
    expect(groups[0].projects.map((r) => r.project.name)).toEqual(['Site', 'h2'])
    expect(groups[1].projects[0]).toMatchObject({ hubId: workHub.id, hubLabel: workHub.label })
  })

  it('keys rows by hub AND project id: two hubs may share a project id', () => {
    const groups = mergeHubProjects([
      feedOf(homeHub, boardOf({ projects: [projectOf('same')] })),
      feedOf(workHub, boardOf({ projects: [projectOf('same')] }))
    ])
    const keys = groups.flatMap((g) => g.projects.map((r) => r.key))
    expect(new Set(keys).size).toBe(2)
  })

  it('lists a hub that has delivered nothing yet as loading, with no projects', () => {
    const [group] = mergeHubProjects([feedOf(homeHub, undefined)])
    expect(group).toMatchObject({ loading: true, projects: [] })
  })

  it("says what is wrong with a hub (the board's banner rules)", () => {
    const [group] = mergeHubProjects([
      feedOf(homeHub, undefined, {
        board: {
          data: undefined,
          pending: false,
          error: 'hub requires authentication',
          refreshing: false
        }
      })
    ])
    expect(group.problem).toMatchObject({ kind: 'failed', message: 'hub requires authentication' })
    expect(group.loading).toBe(false)
  })
})

describe('findProjectRow', () => {
  it("finds one hub's project by id", () => {
    const feed = feedOf(workHub, boardOf({ projects: [projectOf('w1')] }))
    expect(findProjectRow(feed, 'w1')).toMatchObject({ hubId: workHub.id, project: { id: 'w1' } })
    expect(findProjectRow(feed, 'nope')).toBeNull()
  })
})

describe('projectTasks', () => {
  it("is the project's top-level tasks, in board order, as task rows of its hub", () => {
    const feed = feedOf(
      homeHub,
      boardOf({
        projects: [projectOf('p'), projectOf('q')],
        tasks: [
          taskOf('a', { project_id: 'p' }),
          taskOf('other', { project_id: 'q' }),
          taskOf('sub', { project_id: 'p', parent_id: 'a' }),
          taskOf('b', { project_id: 'p' })
        ]
      })
    )
    const rows = projectTasks(feed, 'p')
    expect(rows.map((r) => r.task.id)).toEqual(['a', 'b'])
    expect(rows[0]).toMatchObject({ hubId: homeHub.id, project: { id: 'p' } })
  })
})
