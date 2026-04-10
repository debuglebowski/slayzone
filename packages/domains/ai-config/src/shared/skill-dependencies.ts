import type { AiConfigItem } from './types'
import { parseSkillFrontmatter } from './skill-frontmatter'

export interface SkillDependency {
  sourceSlug: string
  targetSlug: string
  type: 'explicit' | 'implicit'
}

/**
 * Parse the depends_on field from frontmatter.
 * Handles JSON array strings (from normalizeFrontmatterValue) and comma-separated strings.
 */
export function parseDependsOn(frontmatter: Record<string, string>): string[] {
  const raw = frontmatter.depends_on
  if (!raw) return []
  const trimmed = raw.trim()
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean)
    } catch { /* fall through */ }
  }
  return trimmed.split(',').map(s => s.trim()).filter(Boolean)
}

/**
 * Set the depends_on field in frontmatter. Removes the key if slugs is empty.
 */
export function setDependsOn(
  frontmatter: Record<string, string>,
  slugs: string[]
): Record<string, string> {
  const result = { ...frontmatter }
  if (slugs.length === 0) {
    delete result.depends_on
  } else {
    result.depends_on = JSON.stringify(slugs)
  }
  return result
}

/**
 * Scan body text for word-boundary matches of known skill slugs.
 * Returns slugs found, excluding selfSlug.
 */
export function extractImplicitReferences(
  body: string,
  allSlugs: string[],
  selfSlug: string
): string[] {
  const found: string[] = []
  for (const slug of allSlugs) {
    if (slug === selfSlug || slug.length < 3) continue
    if (selfSlug.startsWith(slug + '-')) continue
    const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`\\b${escaped}\\b`)
    if (regex.test(body)) found.push(slug)
  }
  return found
}

/**
 * Build a full dependency graph from a list of skills.
 * Returns explicit deps from frontmatter + implicit refs from body text (deduplicated).
 */
export function buildDependencyGraph(items: AiConfigItem[]): SkillDependency[] {
  const skills = items.filter(i => i.type === 'skill')
  const allSlugs = skills.map(i => i.slug)
  const deps: SkillDependency[] = []
  const seen = new Set<string>()

  for (const item of skills) {
    const parsed = parseSkillFrontmatter(item.content)
    if (!parsed) continue

    const explicit = parseDependsOn(parsed.frontmatter)
    for (const target of explicit) {
      if (allSlugs.includes(target)) {
        const key = `${item.slug}->${target}`
        if (!seen.has(key)) {
          seen.add(key)
          deps.push({ sourceSlug: item.slug, targetSlug: target, type: 'explicit' })
        }
      }
    }

    const implicit = extractImplicitReferences(parsed.body, allSlugs, item.slug)
    for (const target of implicit) {
      const key = `${item.slug}->${target}`
      if (!seen.has(key)) {
        seen.add(key)
        deps.push({ sourceSlug: item.slug, targetSlug: target, type: 'implicit' })
      }
    }
  }

  return deps
}
