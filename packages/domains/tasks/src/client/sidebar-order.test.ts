import { describe, expect, test } from 'vitest'
import type { Project, ProjectGroup, TopLevelEntryRef } from '@slayzone/projects-contracts'
import { applySidebarHubOrder, partitionSidebarOrder } from './sidebar-order'

const projects = [
  { id: 'local-project', sort_order: 0, group_id: null },
  { id: 'member', sort_order: 0, group_id: 'open-source' },
  { id: 'dummy', sort_order: 0, group_id: null }
] as Project[]
const groups = [{ id: 'open-source', sort_order: 1 }] as ProjectGroup[]
const projectHubs = new Map([
  ['local-project', 'local'],
  ['member', 'local'],
  ['dummy', 'remote']
])
const groupHubs = new Map([['open-source', 'local']])
const order = (slots: string[], ps = projects, gs = groups) =>
  applySidebarHubOrder(ps, gs, projectHubs, groupHubs, 'local', slots)
const refs: TopLevelEntryRef[] = [
  { kind: 'project', id: 'local-project' },
  { kind: 'project', id: 'dummy' },
  { kind: 'group', id: 'open-source' }
]

describe('federated sidebar ordering', () => {
  test('dummy and Open Source can trade places without changing hub membership', () => {
    const before = order(['local', 'remote', 'local'])
    const after = order(['local', 'local', 'remote'])
    expect(before.projects.find((p) => p.id === 'dummy')!.sort_order).toBeLessThan(
      before.groups[0].sort_order
    )
    expect(after.projects.find((p) => p.id === 'dummy')!.sort_order).toBeGreaterThan(
      after.groups[0].sort_order
    )
    expect(after.projects.find((p) => p.id === 'member')).toBe(projects[1])
    expect(projects[2].sort_order).toBe(0)
  })

  test('partitions a mixed reorder into complete hub-local payloads', () => {
    expect([...partitionSidebarOrder(refs, projectHubs, groupHubs, 'local')]).toEqual([
      ['local', [refs[0], refs[2]]],
      ['remote', [refs[1]]]
    ])
  })

  test('per-hub reorder and membership changes remain authoritative', () => {
    const changed = projects.map((p) => (p.id === 'local-project' ? { ...p, sort_order: 2 } : p))
    const result = order(['local', 'remote', 'local'], changed)
    expect(result.groups[0].sort_order).toBe(0)
    expect(result.projects.find((p) => p.id === 'local-project')!.sort_order).toBe(2)
  })

  test('disconnected hubs retain their slots when they return', () => {
    const slots = ['remote', 'local', 'local']
    const offline = order(
      slots,
      projects.filter((p) => p.id !== 'dummy')
    )
    expect(offline.projects.find((p) => p.id === 'local-project')!.sort_order).toBe(0)
    expect(order(slots).projects.find((p) => p.id === 'dummy')!.sort_order).toBe(0)
  })

  test('new projects and empty groups remain visible; orphan projects stay top-level', () => {
    const newProjects = [...projects, { id: 'new', sort_order: 2, group_id: 'missing' } as Project]
    const newGroups = [...groups, { id: 'empty', sort_order: 3 } as ProjectGroup]
    const result = order(['remote', 'local', 'local'], newProjects, newGroups)
    expect(result.projects.find((p) => p.id === 'new')!.sort_order).toBe(3)
    expect(result.groups.find((g) => g.id === 'empty')!.sort_order).toBe(4)
  })

  test('no preference preserves server ordering and original row references', () => {
    expect(order([])).toEqual({ projects, groups })
    expect(order([]).projects).toBe(projects)
  })
})
