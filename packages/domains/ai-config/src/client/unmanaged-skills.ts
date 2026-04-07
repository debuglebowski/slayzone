import type { CliProvider, ContextTreeEntry } from '../shared'

export interface UnmanagedSkillRow {
  slug: string
  locations: Array<{
    path: string
    relativePath: string
    provider?: CliProvider
  }>
}

export function skillSlugFromContextPath(relativePath: string): string | null {
  const normalized = relativePath.split('\\').join('/')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length === 0) return null

  const fileName = parts[parts.length - 1]
  if (fileName === 'SKILL.md') {
    if (parts.length < 2) return null
    return parts[parts.length - 2]
  }

  if (fileName.toLowerCase().endsWith('.md')) {
    return fileName.slice(0, -3)
  }

  return null
}

export function computeUnmanagedSkillRows(tree: ContextTreeEntry[]): UnmanagedSkillRow[] {
  const bySlug = new Map<string, UnmanagedSkillRow>()

  for (const entry of tree) {
    if (entry.category !== 'skill') continue
    if (!entry.exists) continue
    if (entry.linkedItemId !== null) continue
    if (entry.syncHealth !== 'unmanaged') continue

    const slug = skillSlugFromContextPath(entry.relativePath)
    if (!slug) continue

    const current = bySlug.get(slug) ?? {
      slug,
      locations: []
    }

    if (!current.locations.some((location) => location.path === entry.path)) {
      current.locations.push({
        path: entry.path,
        relativePath: entry.relativePath,
        provider: entry.provider
      })
    }
    bySlug.set(slug, current)
  }

  return [...bySlug.values()]
    .map((item) => ({
      ...item,
      locations: [...item.locations].sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    }))
}
