/**
 * buildTopLevelEntries / entriesToRefs — pure, no electron / better-sqlite3.
 */
import type { Project, ProjectGroup } from '@slayzone/projects/shared'
import { describe, expect, test } from 'vitest'
import { buildTopLevelEntries, entriesToRefs } from './projectGrouping.js'

function proj(id: string, sortOrder: number, groupId: string | null = null): Project {
  return { id, name: id.toUpperCase(), sort_order: sortOrder, group_id: groupId } as Project
}
function group(id: string, sortOrder: number): ProjectGroup {
  return { id, name: '', sort_order: sortOrder, collapsed: 0 } as ProjectGroup
}

describe('buildTopLevelEntries', () => {
  test('ungrouped only → ordered by sort_order', () => {
    const entries = buildTopLevelEntries([proj('b', 1), proj('a', 0), proj('c', 2)], [])
    expect(entries.map((e) => e.id)).toEqual(['a', 'b', 'c'])
  })

  test('interleaves groups + projects by shared sort_order; members ordered', () => {
    const projects = [proj('top', 0), proj('m2', 1, 'g1'), proj('m1', 0, 'g1'), proj('tail', 2)]
    const entries = buildTopLevelEntries(projects, [group('g1', 1)])
    expect(entries.map((e) => `${e.kind}:${e.id}`)).toEqual([
      'project:top',
      'group:g1',
      'project:tail'
    ])
    const g = entries.find((e) => e.kind === 'group')
    expect(g?.kind === 'group' && g.projects.map((p) => p.id)).toEqual(['m1', 'm2'])
  })

  test('orphan group_id falls back to top-level (never dropped)', () => {
    const entries = buildTopLevelEntries([proj('x', 0, 'ghost')], [])
    expect(entries.map((e) => `${e.kind}:${e.id}`)).toEqual(['project:x'])
  })

  test('tie on sort_order → group before project, then id', () => {
    const entries = buildTopLevelEntries([proj('p', 0)], [group('g', 0)])
    expect(entries.map((e) => `${e.kind}:${e.id}`)).toEqual(['group:g', 'project:p'])
  })
})

describe('entriesToRefs', () => {
  test('flattens to {kind,id}', () => {
    const entries = buildTopLevelEntries([proj('a', 0)], [group('g', 1)])
    expect(entriesToRefs(entries)).toEqual([
      { kind: 'project', id: 'a' },
      { kind: 'group', id: 'g' }
    ])
  })
})
