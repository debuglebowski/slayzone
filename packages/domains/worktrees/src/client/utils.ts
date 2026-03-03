/**
 * Convert a string to a URL/branch-friendly slug
 * "Fix Login Bug" → "fix-login-bug"
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '') // remove special chars
    .replace(/[\s_]+/g, '-') // spaces/underscores to hyphens
    .replace(/-+/g, '-') // collapse multiple hyphens
    .replace(/^-|-$/g, '') // trim leading/trailing hyphens
}

export const DEFAULT_WORKTREE_BASE_PATH_TEMPLATE = '{project}/..'

function isAbsolutePath(input: string): boolean {
  if (!input) return false
  // POSIX absolute (/tmp)
  if (input.startsWith('/')) return true
  // Windows drive absolute (C:\tmp or C:/tmp)
  if (/^[A-Za-z]:[\\/]/.test(input)) return true
  // UNC path (\\server\share)
  if (input.startsWith('\\\\')) return true
  return false
}

/**
 * Expands user template tokens in worktree base path.
 * "{project}/.." with "/repo/slayzone" -> "/repo"
 */
export function resolveWorktreeBasePathTemplate(template: string, projectPath: string): string {
  const normalizedProjectPath = normalizePath(projectPath.replace(/[\\/]+$/, ''))
  const replacedTemplate = template.replaceAll('{project}', normalizedProjectPath)
  const normalizedTemplate = normalizePath(replacedTemplate)

  // Treat relative templates as project-relative for deterministic absolute cwd.
  if (isAbsolutePath(normalizedTemplate)) return normalizedTemplate

  const separator = normalizedProjectPath.includes('\\') ? '\\' : '/'
  const relativePart = normalizedTemplate.replace(/^[\\/]+/, '')
  return normalizePath(`${normalizedProjectPath}${separator}${relativePart}`)
}

/**
 * Joins worktree base path and branch with a consistent path separator.
 */
export function joinWorktreePath(basePath: string, branch: string): string {
  const separator = basePath.includes('\\') ? '\\' : '/'
  const trimmedBase = basePath.replace(/[\\/]+$/, '')
  return `${trimmedBase}${separator}${branch}`
}

function normalizePath(input: string): string {
  if (!input) return input

  const separator = input.includes('\\') ? '\\' : '/'
  const unified = separator === '\\' ? input.replaceAll('/', '\\') : input.replaceAll('\\', '/')

  let prefix = ''
  let rest = unified

  const windowsDrive = rest.match(/^[A-Za-z]:[\\/]?/)
  if (windowsDrive) {
    prefix = `${windowsDrive[0].slice(0, 2)}${separator}`
    rest = rest.slice(windowsDrive[0].length)
  } else if (rest.startsWith(separator)) {
    prefix = separator
    rest = rest.replace(new RegExp(`^\\${separator}+`), '')
  }

  const rawParts = rest.split(separator).filter(Boolean)
  const parts: string[] = []
  for (const part of rawParts) {
    if (part === '.') continue
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') {
        parts.pop()
      } else if (!prefix) {
        parts.push(part)
      }
      continue
    }
    parts.push(part)
  }

  const normalized = parts.join(separator)
  if (!prefix) return normalized
  return normalized ? `${prefix}${normalized}` : prefix
}
