import type { TaskMoveBundle } from '@slayzone/task-contracts'

/** Copies use a distinct incoming journal, including when both ends are one hub. */
export const copyImportId = (id: string): string => `${id}-copy`

/** Working artifact filenames begin with the artifact identity, followed by its extension. */
export function remapCopyFilePath(file: string, ids: Record<string, string>): string {
  return file
    .split('/')
    .map((segment) => {
      const dot = segment.indexOf('.')
      const id = dot < 0 ? segment : segment.slice(0, dot)
      return ids[id] ? ids[id] + segment.slice(id.length) : segment
    })
    .join('/')
}

/** Remap only identities and structured references; preserve arbitrary prose. */
export function copiedTaskBundle(source: TaskMoveBundle): TaskMoveBundle {
  if (!source.copy) return source
  const { ids, title, name } = source.copy
  const ref = (value: unknown): unknown => {
    if (typeof value === 'string') return ids[value] ?? value
    if (Array.isArray(value)) return value.map(ref)
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, v]) => [ids[key] ?? key, ref(v)]))
    return value
  }
  const rows = (table: string, entries: Array<Record<string, unknown>>) =>
    entries.map((raw) => {
      const next = Object.fromEntries(
        Object.entries(raw).map(([key, value]) => {
          if (key === 'id' || key.endsWith('_id')) return [key, ref(value)]
          if (typeof value === 'string' && (value.startsWith('[') || value.startsWith('{'))) {
            try {
              return [key, JSON.stringify(ref(JSON.parse(value)))]
            } catch {
              /* plain text */
            }
          }
          if (key === 'description' && typeof value === 'string')
            return [
              key,
              value.replace(/artifact:([\w-]+)/g, (match, id: string) =>
                ids[id] ? `artifact:${ids[id]}` : match
              )
            ]
          return [key, value]
        })
      )
      if (table === 'tasks') {
        if (title && source.rootTaskIds.includes(raw.id as string)) next.title = title
        next.parent_id = ids[raw.parent_id as string] ?? null
        // Session identities and running UI state never fork.
        for (const key of Object.keys(next)) if (/session|conversation/.test(key)) next[key] = null
      }
      if (table === 'terminal_tabs') {
        next.agent_state = 'stopped'
        for (const key of Object.keys(next)) if (/session|conversation/.test(key)) next[key] = null
      }
      if (table === 'projects') {
        next.name = name ?? `${raw.name} (copy)`
        next.icon_image_path =
          typeof raw.icon_image_path === 'string'
            ? raw.icon_image_path.replace(source.project!.projectId, ids[source.project!.projectId])
            : null
      }
      return next
    })
  const remapSettings = (entries: Array<{ key: string; value: string }>) =>
    entries.map(({ key, value }) => {
      for (const [oldId, newId] of Object.entries(ids)) key = key.replaceAll(oldId, newId)
      try {
        value = JSON.stringify(ref(JSON.parse(value)))
      } catch {
        value = String(ref(value))
      }
      return { key, value }
    })
  return {
    moveId: copyImportId(source.moveId),
    rootTaskIds: source.rootTaskIds.map((id) => ids[id]),
    rows: Object.fromEntries(
      Object.entries(source.rows).map(([table, entries]) => [table, rows(table, entries)])
    ) as TaskMoveBundle['rows'],
    tags: source.tags.map((tag) => ({ ...tag, id: ids[tag.id] ?? tag.id })),
    externalDependencies: [],
    ...(source.project
      ? {
          project: {
            ...source.project,
            projectId: ids[source.project.projectId],
            rows: Object.fromEntries(
              Object.entries(source.project.rows).map(([table, entries]) => [
                table,
                rows(table, entries)
              ])
            ) as NonNullable<TaskMoveBundle['project']>['rows'],
            settings: remapSettings(source.project.settings),
            userSettings: remapSettings(source.project.userSettings)
          }
        }
      : {})
  }
}
