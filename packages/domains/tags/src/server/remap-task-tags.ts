import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { TAG_PRESETS } from '../shared/presets'

/**
 * Tags belong to a project, so a task moved to another project brings its tags along
 * by NAME: each link to a tag of another project is re-pointed at the target
 * project's tag of the same name, created there when it has none. A created tag
 * keeps its colours unless the target already uses that pair (`tags_project_color_unique`):
 * then the first free preset, and past those a pair derived from the original.
 *
 * Runs inside the caller's transaction (the task domain's `task:move-project`).
 * Pure better-sqlite3, so it is safe in the DB worker. Answers the created tag ids.
 */
export function remapTaskTagsToProject(
  db: Database,
  taskIds: readonly string[],
  targetProjectId: string
): string[] {
  const linksOf = db.prepare(
    `SELECT tt.tag_id, tg.project_id, tg.name, tg.color, tg.text_color
       FROM task_tags tt JOIN tags tg ON tg.id = tt.tag_id
      WHERE tt.task_id = ?`
  )
  const targetTagByName = db.prepare('SELECT id FROM tags WHERE project_id = ? AND name = ?')
  const unlink = db.prepare('DELETE FROM task_tags WHERE task_id = ? AND tag_id = ?')
  const link = db.prepare('INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)')

  const created: string[] = []
  const byName = new Map<string, string>()
  const targetTagFor = (source: { name: string; color: string; text_color: string }): string => {
    const known = byName.get(source.name)
    if (known) return known
    const existing = targetTagByName.get(targetProjectId, source.name) as { id: string } | undefined
    const id = existing?.id ?? createTag(db, targetProjectId, source)
    if (!existing) created.push(id)
    byName.set(source.name, id)
    return id
  }

  for (const taskId of taskIds) {
    const links = linksOf.all(taskId) as Array<{
      tag_id: string
      project_id: string
      name: string
      color: string
      text_color: string
    }>
    for (const l of links) {
      if (l.project_id === targetProjectId) continue
      const targetTagId = targetTagFor(l)
      unlink.run(taskId, l.tag_id)
      link.run(taskId, targetTagId)
    }
  }
  return created
}

function createTag(
  db: Database,
  projectId: string,
  source: { name: string; color: string; text_color: string }
): string {
  const used = new Set(
    (
      db
        .prepare('SELECT color, text_color FROM tags WHERE project_id = ?')
        .all(projectId) as Array<{
        color: string
        text_color: string
      }>
    ).map((t) => colorKey(t.color, t.text_color))
  )
  const colors = freeColors(source, used)
  const { m } = db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM tags WHERE project_id = ?')
    .get(projectId) as { m: number }
  const id = randomUUID()
  db.prepare(
    'INSERT INTO tags (id, project_id, name, color, text_color, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, projectId, source.name, colors.color, colors.textColor, m + 1)
  return id
}

const colorKey = (color: string, textColor: string): string =>
  `${color.toLowerCase()}:${textColor.toLowerCase()}`

/** The source's colours if free in the target, else the first free preset, else a derived pair. */
export function freeColors(
  source: { color: string; text_color: string },
  used: ReadonlySet<string>
): { color: string; textColor: string } {
  if (!used.has(colorKey(source.color, source.text_color)))
    return { color: source.color, textColor: source.text_color }
  const preset = TAG_PRESETS.find((p) => !used.has(colorKey(p.bg, p.text)))
  if (preset) return { color: preset.bg, textColor: preset.text }
  // Every preset is taken: keep the background, nudge the text colour until the pair is free.
  const base = /^#[0-9a-f]{6}$/i.test(source.text_color)
    ? Number.parseInt(source.text_color.slice(1), 16)
    : 0xffffff
  for (let step = 1; step <= 0xffffff; step++) {
    const textColor = `#${((base + step) % 0x1000000).toString(16).padStart(6, '0')}`
    if (!used.has(colorKey(source.color, textColor))) return { color: source.color, textColor }
  }
  throw new Error('No free tag colour pair')
}
