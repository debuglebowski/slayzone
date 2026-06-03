import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import ignore from 'ignore'
import type {
  DirEntry,
  ReadFileResult,
  FileSearchResult,
  FileSearchMatch,
  SearchFilesOptions,
  GitStatusMap,
  GitFileStatus,
} from '../shared'

export const ALWAYS_IGNORED = new Set(['.git', '.DS_Store'])
export const MAX_FILE_SIZE = 1 * 1024 * 1024 // 1 MB
export const FORCE_MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

export function assertWithinRoot(root: string, target: string): string {
  const resolved = path.resolve(root, target)
  if (!resolved.startsWith(path.resolve(root) + path.sep) && resolved !== path.resolve(root)) {
    throw new Error('Path traversal denied')
  }
  return resolved
}

const ignoreCache = new Map<string, { ig: ReturnType<typeof ignore>; mtime: number }>()

export function getIgnoreFilter(rootPath: string): ReturnType<typeof ignore> {
  const root = path.resolve(rootPath)
  const gitignorePath = path.join(root, '.gitignore')
  let mtime = 0
  try { mtime = fs.statSync(gitignorePath).mtimeMs } catch { /* no .gitignore */ }

  const cached = ignoreCache.get(root)
  if (cached && cached.mtime === mtime) return cached.ig

  const ig = ignore()
  try {
    ig.add(fs.readFileSync(gitignorePath, 'utf-8'))
  } catch { /* no .gitignore */ }
  ignoreCache.set(root, { ig, mtime })
  return ig
}

export function invalidateIgnoreCache(rootPath: string): void {
  ignoreCache.delete(path.resolve(rootPath))
}

export function clearIgnoreCache(): void {
  ignoreCache.clear()
}

export function isIgnored(rootPath: string, relativePath: string, isDir: boolean): boolean {
  if (ALWAYS_IGNORED.has(path.basename(relativePath))) return true
  const ig = getIgnoreFilter(rootPath)
  return ig.ignores(isDir ? relativePath + '/' : relativePath)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function readDir(rootPath: string, dirPath: string): DirEntry[] {
  const abs = dirPath ? assertWithinRoot(rootPath, dirPath) : path.resolve(rootPath)
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    throw error
  }
  return entries
    .filter((e) => !ALWAYS_IGNORED.has(e.name))
    .map((e) => {
      const relPath = dirPath ? `${dirPath}/${e.name}` : e.name
      const symlink = e.isSymbolicLink()
      let isDir = e.isDirectory()
      if (symlink) {
        try { isDir = fs.statSync(path.join(abs, e.name)).isDirectory() } catch { return null }
      }
      const ignored = isIgnored(rootPath, relPath, isDir)
      return {
        name: e.name,
        path: relPath,
        type: isDir ? 'directory' as const : 'file' as const,
        ...(ignored && { ignored: true }),
        ...(symlink && { isSymlink: true })
      }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
}

export function readFile(rootPath: string, filePath: string, force?: boolean): ReadFileResult {
  const abs = assertWithinRoot(rootPath, filePath)
  const stat = fs.statSync(abs)
  if (stat.size > FORCE_MAX_FILE_SIZE) {
    return { content: null, tooLarge: true, sizeBytes: stat.size }
  }
  if (!force && stat.size > MAX_FILE_SIZE) {
    return { content: null, tooLarge: true, sizeBytes: stat.size }
  }
  return { content: fs.readFileSync(abs, 'utf-8') }
}

export function listAllFiles(rootPath: string): string[] {
  const root = path.resolve(rootPath)
  const ig = getIgnoreFilter(rootPath)
  const results: string[] = []

  function walk(dir: string, prefix: string): void {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const relPath = prefix ? `${prefix}/${e.name}` : e.name
      if (ALWAYS_IGNORED.has(e.name)) continue
      if (ig.ignores(e.isDirectory() ? relPath + '/' : relPath)) continue
      if (e.isDirectory()) {
        walk(path.join(dir, e.name), relPath)
      } else {
        results.push(relPath)
      }
    }
  }

  walk(root, '')
  return results
}

export function writeFile(rootPath: string, filePath: string, content: string): void {
  const abs = assertWithinRoot(rootPath, filePath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf-8')
}

export function createFile(rootPath: string, filePath: string): void {
  const abs = assertWithinRoot(rootPath, filePath)
  if (fs.existsSync(abs)) throw new Error('File already exists')
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, '', 'utf-8')
}

export function createDir(rootPath: string, dirPath: string): void {
  const abs = assertWithinRoot(rootPath, dirPath)
  fs.mkdirSync(abs, { recursive: true })
}

export function renamePath(rootPath: string, oldPath: string, newPath: string): void {
  const absOld = assertWithinRoot(rootPath, oldPath)
  const absNew = assertWithinRoot(rootPath, newPath)
  if (fs.existsSync(absNew)) throw new Error('Target already exists')
  fs.renameSync(absOld, absNew)
}

export function deletePath(rootPath: string, targetPath: string): void {
  const abs = assertWithinRoot(rootPath, targetPath)
  fs.rmSync(abs, { recursive: true })
}

export function copyIn(rootPath: string, absoluteSrc: string, targetDir?: string): string {
  const srcResolved = path.resolve(absoluteSrc)
  if (!fs.existsSync(srcResolved) || !fs.statSync(srcResolved).isFile()) {
    throw new Error('Source is not a file')
  }
  const ext = path.extname(srcResolved)
  const stem = path.basename(srcResolved, ext)
  const baseName = path.basename(srcResolved)
  const dirRel = (targetDir ?? '').trim()
  if (dirRel) assertWithinRoot(rootPath, dirRel)
  let relPath = dirRel ? `${dirRel}/${baseName}` : baseName
  let dest = assertWithinRoot(rootPath, relPath)
  let i = 1
  while (fs.existsSync(dest)) {
    const candidate = `${stem} (${i})${ext}`
    relPath = dirRel ? `${dirRel}/${candidate}` : candidate
    dest = assertWithinRoot(rootPath, relPath)
    i++
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(srcResolved, dest)
  return relPath
}

export function copy(rootPath: string, srcPath: string, destPath: string): void {
  const absSrc = assertWithinRoot(rootPath, srcPath)
  const absDest = assertWithinRoot(rootPath, destPath)
  fs.cpSync(absSrc, absDest, { recursive: true })
}

export function gitStatus(rootPath: string): Promise<GitStatusMap> {
  const root = path.resolve(rootPath)
  if (!fs.existsSync(path.join(root, '.git'))) {
    return Promise.resolve({ files: {}, isGitRepo: false })
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    const proc = spawn('git', ['status', '--porcelain'], { cwd: root })
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    proc.on('error', () => resolve({ files: {}, isGitRepo: false }))
    proc.on('close', (code) => {
      if (code !== 0) { resolve({ files: {}, isGitRepo: true }); return }
      const output = Buffer.concat(chunks).toString('utf-8')
      const files: Record<string, GitFileStatus> = {}
      for (const line of output.split('\n')) {
        if (line.length < 4) continue
        const x = line[0]
        const y = line[1]
        let filePath = line.slice(3)
        const arrow = filePath.indexOf(' -> ')
        if (arrow !== -1) filePath = filePath.slice(arrow + 4)

        let status: GitFileStatus
        if ((x === 'U' || y === 'U') || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
          status = 'conflicted'
        } else if (x === '?' && y === '?') {
          status = 'untracked'
        } else if (y !== ' ') {
          status = y === 'D' ? 'deleted' : 'modified'
        } else {
          if (x === 'A') status = 'added'
          else if (x === 'D') status = 'deleted'
          else if (x === 'R') status = 'renamed'
          else status = 'staged'
        }
        files[filePath] = status
      }
      resolve({ files, isGitRepo: true })
    })
  })
}

export function searchFiles(rootPath: string, query: string, options?: SearchFilesOptions): FileSearchResult[] {
  if (!query) return []
  const root = path.resolve(rootPath)
  const ig = getIgnoreFilter(rootPath)
  const matchCase = options?.matchCase ?? false
  const useRegex = options?.regex ?? false
  const maxResults = options?.maxResults ?? 500
  let totalMatches = 0

  let pattern: RegExp
  try {
    const flags = matchCase ? 'g' : 'gi'
    pattern = useRegex ? new RegExp(query, flags) : new RegExp(escapeRegExp(query), flags)
  } catch {
    return []
  }

  const results: FileSearchResult[] = []

  function walk(dir: string, prefix: string): void {
    if (totalMatches >= maxResults) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (totalMatches >= maxResults) return
      const relPath = prefix ? `${prefix}/${e.name}` : e.name
      if (ALWAYS_IGNORED.has(e.name)) continue
      if (ig.ignores(e.isDirectory() ? relPath + '/' : relPath)) continue
      if (e.isDirectory()) {
        walk(path.join(dir, e.name), relPath)
      } else {
        searchFile(root, relPath, pattern, results)
      }
    }
  }

  function searchFile(rootDir: string, relPath: string, re: RegExp, out: FileSearchResult[]): void {
    if (totalMatches >= maxResults) return
    const abs = path.join(rootDir, relPath)
    let stat: fs.Stats
    try { stat = fs.statSync(abs) } catch { return }
    if (stat.size > MAX_FILE_SIZE) return

    let content: string
    try { content = fs.readFileSync(abs, 'utf-8') } catch { return }

    if (content.slice(0, 8192).includes('\0')) return

    const matches: FileSearchMatch[] = []
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (totalMatches >= maxResults) break
      re.lastIndex = 0
      const m = re.exec(lines[i])
      if (m) {
        matches.push({ line: i + 1, col: m.index, lineText: lines[i].slice(0, 500) })
        totalMatches++
      }
    }
    if (matches.length > 0) {
      out.push({ path: relPath, matches })
    }
  }

  walk(root, '')
  return results
}
