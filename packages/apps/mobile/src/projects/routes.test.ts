import { PROJECTS, projectHref } from './routes'

describe('project routes', () => {
  it("names a project by its hub address and id, like a task's", () => {
    expect(PROJECTS).toBe('/projects')
    expect(projectHref('hub.example.com', 'p-1')).toBe('/projects/hub.example.com/p-1')
    expect(projectHref('127.0.0.1:8788', 'a/b')).toBe('/projects/127.0.0.1%3A8788/a%2Fb')
  })
})
