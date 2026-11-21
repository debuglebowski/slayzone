import { describe, expect, it } from 'vitest'
import { parseSpatialRoute, spatialRouteSearch } from './spatial-route'

describe('parseSpatialRoute', () => {
  it('returns null when the page is not in spatial mode', () => {
    expect(parseSpatialRoute('')).toBeNull()
    expect(parseSpatialRoute('?windowId=3')).toBeNull()
  })

  it('parses the launcher', () => {
    expect(parseSpatialRoute('?spatial=launcher')).toEqual({ panel: 'launcher' })
  })

  it('parses a project board', () => {
    expect(parseSpatialRoute('?spatial=board&project=p1')).toEqual({
      panel: 'board',
      projectId: 'p1'
    })
  })

  it('parses a task', () => {
    expect(parseSpatialRoute('?spatial=task&task=t1')).toEqual({ panel: 'task', taskId: 't1' })
  })

  it('accepts a search string without the leading ?', () => {
    expect(parseSpatialRoute('spatial=task&task=t1')).toEqual({ panel: 'task', taskId: 't1' })
  })

  it('falls back to the launcher when a panel is missing its id', () => {
    expect(parseSpatialRoute('?spatial=board')).toEqual({ panel: 'launcher' })
    expect(parseSpatialRoute('?spatial=task&task=')).toEqual({ panel: 'launcher' })
  })

  it('falls back to the launcher for an unknown panel', () => {
    expect(parseSpatialRoute('?spatial=hologram')).toEqual({ panel: 'launcher' })
  })
})

describe('spatialRouteSearch', () => {
  it('round-trips every panel', () => {
    for (const route of [
      { panel: 'launcher' },
      { panel: 'board', projectId: 'p 1' },
      { panel: 'task', taskId: 't&1' }
    ] as const) {
      expect(parseSpatialRoute(spatialRouteSearch(route))).toEqual(route)
    }
  })
})
