export const MARKDOWN_FILE_TEXT_EXTENSIONS = new Set([
  'md',
  'mdx',
  'markdown',
  'txt',
  'rst',
  'js',
  'jsx',
  'ts',
  'tsx',
  'mjs',
  'cjs',
  'json',
  'yaml',
  'yml',
  'toml',
  'xml',
  'html',
  'css',
  'scss',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'c',
  'cpp',
  'h',
  'hpp',
  'sh',
  'env'
])

export function posixDirname(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

export function posixResolve(...parts: string[]): string {
  const segments: string[] = []
  for (const part of parts.join('/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') segments.pop()
    else segments.push(part)
  }
  return '/' + segments.join('/')
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024).toFixed(0)} KB`
}
