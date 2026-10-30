/** `path` relative to the session's working directory when inside it, else as is. */
export function relativeToCwd(path: string, cwd: string | undefined): string {
  if (!cwd) return path
  const base = cwd.endsWith('/') ? cwd : `${cwd}/`
  return path.startsWith(base) ? path.slice(base.length) : path
}
