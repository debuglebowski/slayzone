import {
  parseSkillFrontmatter,
  renderSkillFrontmatter,
  deriveSkillValidation,
  type SkillValidationState
} from '../shared'

export const SKILL_VALIDATION_METADATA_KEY = 'skillValidation'

export function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // ignore malformed JSON
  }
  return {}
}

export function stripCanonicalSkillMetadata(metadataJson: string): string {
  const parsed = parseJsonObject(metadataJson)
  delete parsed.skillCanonical
  return JSON.stringify(parsed)
}

export function writeSkillValidationMetadata(metadataJson: string, validation: SkillValidationState): string {
  const parsed = parseJsonObject(metadataJson)
  parsed[SKILL_VALIDATION_METADATA_KEY] = validation
  return JSON.stringify(parsed)
}

export function normalizeSkillForPersistence(
  slug: string,
  rawContent: string,
  metadataJson: string,
  previousSlug?: string
): {
  content: string
  metadataJson: string
} {
  const normalizedContent = rawContent.replace(/\r\n/g, '\n')
  const parsedFrontmatter = parseSkillFrontmatter(normalizedContent)
  let persistedContent = normalizedContent

  if (parsedFrontmatter && !parsedFrontmatter.issues.some((issue) => issue.severity === 'error')) {
    const previous = previousSlug ?? slug
    const nextFrontmatter = { ...parsedFrontmatter.frontmatter }
    if (!nextFrontmatter.name || nextFrontmatter.name === previous) {
      nextFrontmatter.name = slug
      persistedContent = renderSkillFrontmatter(nextFrontmatter)
      const body = parsedFrontmatter.body.replace(/^\n+/, '')
      persistedContent = body ? `${persistedContent}\n${body}` : `${persistedContent}\n`
    }
  }

  const validation = deriveSkillValidation(slug, persistedContent)
  const metadataWithoutCanonical = stripCanonicalSkillMetadata(metadataJson)

  return {
    content: persistedContent,
    metadataJson: writeSkillValidationMetadata(metadataWithoutCanonical, validation)
  }
}
