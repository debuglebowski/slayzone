export const DEFAULT_WORKTREE_BASE_PATH_TEMPLATE = '../{project-folder-name}-workspaces'

/**
 * Expands user template tokens in worktree base path.
 *
 * Supported tokens:
 *   {project}              → full project path (e.g. /repo/myapp)
 *   {project-folder-name}  → project basename (e.g. myapp)
 *
 * Relative templates resolve against the project path.
 *
 * "../{project-folder-name}-workspaces" with "/repo/myapp"
 *   → "/repo/myapp-workspaces"
 */
export function resolveWorktreeBasePathTemplate(template: string, projectPath: string): string {
  const normalizedProject = projectPath.replace(/[\\/]+$/, '')
  const sep = normalizedProject.includes('\\') ? '\\' : '/'
  const projectFolderName = normalizedProject.split(/[\\/]/).filter(Boolean).pop() ?? ''
  // Replace {project-folder-name} BEFORE {project} — {project} is a substring of the longer token.
  const resolved = template
    .replaceAll('{project-folder-name}', projectFolderName)
    .replaceAll('{project}', normalizedProject)
  const normalized = normalizePath(resolved)

  // Relative templates are treated as project-relative
  if (normalized && !isAbsolutePath(normalized)) {
    return normalizePath(`${normalizedProject}${sep}${normalized}`)
  }

  return normalized
}

/**
 * Joins worktree base path and branch with a consistent path separator.
 */
export function joinWorktreePath(basePath: string, branch: string): string {
  const separator = basePath.includes('\\') ? '\\' : '/'
  const trimmedBase = basePath.replace(/[\\/]+$/, '')
  return `${trimmedBase}${separator}${branch}`
}

function isAbsolutePath(input: string): boolean {
  if (!input) return false
  if (input.startsWith('/')) return true
  if (/^[A-Za-z]:[\\/]/.test(input)) return true
  if (input.startsWith('\\\\')) return true
  return false
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
