import type { Project, ProjectGroup, TopLevelEntryRef } from '@slayzone/projects-contracts'

export function sidebarTopLevelRefs(
  projects: Project[],
  groups: ProjectGroup[]
): TopLevelEntryRef[] {
  const groupIds = new Set(groups.map((g) => g.id))
  return [
    ...projects
      .filter((p) => !p.group_id || !groupIds.has(p.group_id))
      .map((p) => ({ kind: 'project' as const, id: p.id, sort_order: p.sort_order ?? 0 })),
    ...groups.map((g) => ({ kind: 'group' as const, id: g.id, sort_order: g.sort_order ?? 0 }))
  ]
    .sort(
      (a, b) =>
        a.sort_order - b.sort_order || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)
    )
    .map(({ kind, id }) => ({ kind, id }))
}

/** Keep each hub's write complete and preserve its relative entry order. */
export function partitionSidebarOrder(
  entries: TopLevelEntryRef[],
  projectHubs: ReadonlyMap<string, string>,
  groupHubs: ReadonlyMap<string, string>,
  defaultHubId: string
): Map<string, TopLevelEntryRef[]> {
  const buckets = new Map<string, TopLevelEntryRef[]>()
  for (const entry of entries) {
    const hubId = (entry.kind === 'group' ? groupHubs : projectHubs).get(entry.id) ?? defaultHubId
    const bucket = buckets.get(hubId) ?? []
    bucket.push(entry)
    buckets.set(hubId, bucket)
  }
  return buckets
}

/**
 * Hub databases own their relative project/folder order; the view owns how
 * those independent lists interleave. Persist hub slots rather than entry IDs
 * so folder creation/deletion and membership changes still follow server order.
 * Missing hubs leave their saved slots intact; new entries append. Only display
 * ranks change, never canonical rows or group-member sort orders.
 */
export function applySidebarHubOrder(
  projects: Project[],
  groups: ProjectGroup[],
  projectHubs: ReadonlyMap<string, string>,
  groupHubs: ReadonlyMap<string, string>,
  defaultHubId: string,
  hubOrder: readonly string[]
): { projects: Project[]; groups: ProjectGroup[] } {
  if (hubOrder.length === 0) return { projects, groups }
  const entries = sidebarTopLevelRefs(projects, groups)
  const buckets = partitionSidebarOrder(entries, projectHubs, groupHubs, defaultHubId)
  const offsets = new Map<string, number>()
  const ranks = new Map<string, number>()
  const key = (entry: TopLevelEntryRef) => `${entry.kind}:${entry.id}`
  for (const hubId of hubOrder) {
    const offset = offsets.get(hubId) ?? 0
    const entry = buckets.get(hubId)?.[offset]
    if (!entry) continue
    ranks.set(key(entry), ranks.size)
    offsets.set(hubId, offset + 1)
  }
  for (const entry of entries) {
    if (!ranks.has(key(entry))) ranks.set(key(entry), ranks.size)
  }
  return {
    projects: projects.map((p) => {
      const rank = ranks.get(`project:${p.id}`)
      return rank === undefined ? p : { ...p, sort_order: rank }
    }),
    groups: groups.map((g) => ({ ...g, sort_order: ranks.get(`group:${g.id}`)! }))
  }
}
