import type { Project, ProjectGroup, TopLevelEntryRef } from '@slayzone/projects/shared'

/**
 * One slot in the top-level sidebar list — either an ungrouped project or a
 * group with its (ordered) member projects. Shared by both the rail view
 * (Discord folders) and the tree view (labeled sections).
 */
export type TopLevelEntry =
  | { kind: 'project'; id: string; project: Project }
  | { kind: 'group'; id: string; group: ProjectGroup; projects: Project[] }

/**
 * Merge ungrouped projects and groups into the ordered top-level list. Ordering
 * mirrors the server (`projects-txns.ts` topLevelEntries): by the shared
 * `sort_order` integer space, tie-broken by kind ('group' < 'project') then id,
 * so what the user sees matches what a reorder writes. A project whose
 * `group_id` points at a missing group falls back to top-level (defensive
 * against data drift — never drop a project from the sidebar).
 */
export function buildTopLevelEntries(
  projects: Project[],
  groups: ProjectGroup[]
): TopLevelEntry[] {
  const groupById = new Map(groups.map((g) => [g.id, g]))
  const membersByGroup = new Map<string, Project[]>()
  const ungrouped: Project[] = []
  for (const p of projects) {
    if (p.group_id && groupById.has(p.group_id)) {
      const arr = membersByGroup.get(p.group_id) ?? []
      arr.push(p)
      membersByGroup.set(p.group_id, arr)
    } else {
      ungrouped.push(p)
    }
  }
  for (const arr of membersByGroup.values()) {
    arr.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id.localeCompare(b.id))
  }

  const ranked: Array<TopLevelEntry & { sort_order: number }> = [
    ...ungrouped.map((p) => ({
      kind: 'project' as const,
      id: p.id,
      project: p,
      sort_order: p.sort_order ?? 0
    })),
    ...groups.map((g) => ({
      kind: 'group' as const,
      id: g.id,
      group: g,
      projects: membersByGroup.get(g.id) ?? [],
      sort_order: g.sort_order ?? 0
    }))
  ]
  ranked.sort(
    (a, b) =>
      a.sort_order - b.sort_order || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)
  )
  return ranked.map((e) =>
    e.kind === 'project'
      ? { kind: 'project', id: e.id, project: e.project }
      : { kind: 'group', id: e.id, group: e.group, projects: e.projects }
  )
}

/** Flatten entries into the `reorderTopLevel` payload shape. */
export function entriesToRefs(entries: TopLevelEntry[]): TopLevelEntryRef[] {
  return entries.map((e) => ({ kind: e.kind, id: e.id }))
}
