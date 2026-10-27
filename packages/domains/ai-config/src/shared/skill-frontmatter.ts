import { CORE_SCHEMA, loadAll, mergeTag } from 'js-yaml'
import type { SkillValidationIssue, SkillValidationState } from './types'

export interface ParsedSkillFrontmatter {
  frontmatter: Record<string, string>
  body: string
  issues: SkillValidationIssue[]
}

interface YamlExceptionLike extends Error {
  reason?: string
  mark?: { line?: number }
}

// js-yaml 5's loader schema dropped merge keys (`<<: *anchor`); keep them working.
const FRONTMATTER_SCHEMA = CORE_SCHEMA.withTags(mergeTag)

function normalizeFrontmatterValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function parseSkillFrontmatter(content: string): ParsedSkillFrontmatter | null {
  const normalized = content.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '')
  const lines = normalized.split('\n')
  let startLine = 0
  while (startLine < lines.length && lines[startLine].trim().length === 0) {
    startLine += 1
  }
  if (lines[startLine]?.trim() !== '---') return null

  const frontmatter: Record<string, string> = {}
  const issues: SkillValidationIssue[] = []
  let closingLine = -1
  for (let i = startLine + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---' || lines[i].trim() === '...') {
      closingLine = i
      break
    }
  }

  if (closingLine === -1) {
    issues.push({
      code: 'frontmatter_unclosed',
      severity: 'error',
      message: 'Frontmatter starts with "---" but has no closing delimiter.',
      line: startLine + 1
    })
    return { frontmatter, body: normalized, issues }
  }

  const rawFrontmatter = lines.slice(startLine + 1, closingLine).join('\n')
  try {
    // `loadAll`, not `load`: js-yaml 5's `load` throws on a source with no document
    // (blank or comment-only frontmatter), which is valid empty frontmatter. A
    // second document can't occur — the first `---` line already ended the block.
    const [parsed] = loadAll(rawFrontmatter, { schema: FRONTMATTER_SCHEMA })
    if (parsed === null || parsed === undefined) {
      // empty frontmatter is valid
    } else if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      issues.push({
        code: 'frontmatter_invalid_line',
        severity: 'error',
        message: 'Frontmatter must be a YAML object (key: value pairs).',
        line: startLine + 2
      })
    } else {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        frontmatter[key] = normalizeFrontmatterValue(value)
      }
    }
  } catch (error) {
    const yamlError = error as YamlExceptionLike
    const reason =
      typeof yamlError.reason === 'string'
        ? yamlError.reason
        : yamlError.message || 'Invalid YAML frontmatter.'
    const markLine =
      typeof yamlError.mark?.line === 'number' ? startLine + yamlError.mark.line + 2 : null
    if (/duplicated mapping key/i.test(reason)) {
      issues.push({
        code: 'frontmatter_duplicate_key',
        severity: 'error',
        message: 'Duplicate frontmatter key.',
        line: markLine
      })
    } else {
      issues.push({
        code: 'frontmatter_invalid_line',
        severity: 'error',
        message: `Invalid YAML frontmatter: ${reason}`,
        line: markLine
      })
    }
  }

  return {
    frontmatter,
    body: lines.slice(closingLine + 1).join('\n'),
    issues
  }
}

export function missingSkillFrontmatterValidation(): SkillValidationState {
  return {
    status: 'invalid',
    issues: [
      {
        code: 'frontmatter_missing',
        severity: 'error',
        message: 'Skill content must start with YAML frontmatter delimited by "---".',
        line: 1
      }
    ]
  }
}

export function validateSkillFrontmatter(
  slug: string,
  parsedFrontmatter: ParsedSkillFrontmatter | null
): SkillValidationState {
  if (!parsedFrontmatter) return missingSkillFrontmatterValidation()

  const issues: SkillValidationIssue[] = [...parsedFrontmatter.issues]
  const parsedName = parsedFrontmatter.frontmatter.name?.trim() ?? ''
  if (parsedName && parsedName !== slug) {
    issues.push({
      code: 'frontmatter_name_mismatch',
      severity: 'warning',
      message: `Frontmatter name "${parsedName}" does not match skill slug "${slug}".`,
      line: null
    })
  }

  if (!parsedFrontmatter.frontmatter.description?.trim()) {
    issues.push({
      code: 'frontmatter_description_missing',
      severity: 'error',
      message: 'Skill frontmatter must include a "description" field.',
      line: null
    })
  }

  const hasErrors = issues.some((issue) => issue.severity === 'error')
  const hasWarnings = issues.some((issue) => issue.severity === 'warning')
  return {
    status: hasErrors ? 'invalid' : hasWarnings ? 'warning' : 'valid',
    issues
  }
}

export function deriveSkillValidation(slug: string, content: string): SkillValidationState {
  return validateSkillFrontmatter(slug, parseSkillFrontmatter(content))
}

function escapeYamlDoubleQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function toYamlKey(key: string): string {
  if (/^[A-Za-z0-9_.-]+$/.test(key)) return key
  return `"${escapeYamlDoubleQuoted(key)}"`
}

function toYamlLine(key: string, value: string): string {
  const yamlKey = toYamlKey(key)
  if (value.includes('\n')) {
    const indented = value
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n')
    return `${yamlKey}: |\n${indented}`
  }
  if (key === 'name' && /^[a-z0-9][a-z0-9._-]*$/i.test(value)) return `${yamlKey}: ${value}`
  if (key === 'description') return `${yamlKey}: "${escapeYamlDoubleQuoted(value)}"`
  if (/^[a-z0-9][a-z0-9._-]*$/i.test(value)) return `${yamlKey}: ${value}`
  return `${yamlKey}: "${escapeYamlDoubleQuoted(value)}"`
}

export function renderSkillFrontmatter(frontmatter: Record<string, string>): string {
  const lines: string[] = ['---']
  if (frontmatter.name) lines.push(toYamlLine('name', frontmatter.name))
  if (frontmatter.description !== undefined)
    lines.push(toYamlLine('description', frontmatter.description))

  for (const key of Object.keys(frontmatter).sort()) {
    if (key === 'name' || key === 'description') continue
    const value = frontmatter[key] ?? ''
    // Render JSON-encoded arrays as YAML block sequences
    if (value.startsWith('[')) {
      try {
        const arr = JSON.parse(value)
        if (Array.isArray(arr) && arr.length > 0) {
          lines.push(`${toYamlKey(key)}:`)
          for (const item of arr) lines.push(`  - ${item}`)
          continue
        }
      } catch {
        /* fall through to default rendering */
      }
    }
    lines.push(toYamlLine(key, value))
  }

  lines.push('---', '')
  return lines.join('\n')
}

export function buildDefaultSkillContent(slug: string, body = ''): string {
  const normalizedBody = body.replace(/\r\n/g, '\n').replace(/^\n+/, '')
  const rendered = renderSkillFrontmatter({
    name: slug,
    description: slug,
    trigger: 'auto'
  })
  return normalizedBody ? `${rendered}\n${normalizedBody}` : `${rendered}\n`
}

export function repairSkillFrontmatter(slug: string, content: string): string {
  const normalized = content.replace(/\r\n/g, '\n')
  const parsed = parseSkillFrontmatter(normalized)
  const frontmatter = {
    ...(parsed?.frontmatter ?? {})
  }
  frontmatter.name = slug
  if (!frontmatter.description?.trim()) frontmatter.description = slug
  if (!Object.hasOwn(frontmatter, 'trigger')) frontmatter.trigger = 'auto'

  const body = (() => {
    if (!parsed) return normalized.replace(/^\n+/, '')
    if (parsed.issues.some((issue) => issue.code === 'frontmatter_unclosed')) {
      return normalized.split('\n').slice(1).join('\n').replace(/^\n+/, '')
    }
    return parsed.body.replace(/^\n+/, '')
  })()

  const rendered = renderSkillFrontmatter(frontmatter)
  return body ? `${rendered}\n${body}` : `${rendered}\n`
}
