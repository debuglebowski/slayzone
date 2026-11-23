import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { gitCommand } from '@slayzone/platform/resolve-command'
import ignore from 'ignore'
import type {
  DirEntry,
  ReadFileResult,
  TextEdit,
  FileSearchResult,
  FileSearchMatch,
  SearchFilesOptions,
  GitStatusMap,
  GitFileStatus
} from '../shared'
import {
  PathTraversalError,
  WORKSPACE_READ_BYTES_MAX_CHUNK,
  type ReadBytesResult
} from './workspace-bytes'

export {
  PathTraversalError,
  isPathTraversalError,
  WORKSPACE_READ_BYTES_MAX_CHUNK,
  type ReadBytesResult
} from './workspace-bytes'

export const ALWAYS_IGNORED = new Set(['.git', '.DS_Store'])
export const MAX_FILE_SIZE = 1 * 1024 * 1024 // 1 MB
export const FORCE_MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

export function assertWithinRoot(root: string, target: string): string {
  const resolved = path.resolve(root, target)
  if (!resolved.startsWith(path.resolve(root) + path.sep) && resolved !== path.resolve(root)) {
    throw new PathTraversalError()
  }
  return resolved
}

const ignoreCache = new Map<string, { ig: ReturnType<typeof ignore>; mtime: number }>()

export function getIgnoreFilter(rootPath: string): ReturnType<typeof ignore> {
  const root = path.resolve(rootPath)
  const gitignorePath = path.join(root, '.gitignore')
  let mtime = 0
  try {
    mtime = fs.statSync(gitignorePath).mtimeMs
  } catch {
    /* no .gitignore */
  }

  const cached = ignoreCache.get(root)
  if (cached && cached.mtime === mtime) return cached.ig

  const ig = ignore()
  try {
    ig.add(fs.readFileSync(gitignorePath, 'utf-8'))
  } catch {
    /* no .gitignore */
  }
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

const errnoError = (code: string, message: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: ${message}`), { code })

/**
 * Read `length` bytes at `offset` of the file at `absPath` — through one fd, never
 * the whole file. A directory (or any non-regular file: a FIFO would block the read)
 * is refused `EISDIR`; a missing one is the fs's own `ENOENT`. Containment is the
 * caller's: `absPath` must already be judged.
 */
export async function readBytesAt(
  absPath: string,
  offset: number,
  length: number
): Promise<ReadBytesResult> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError(`bad offset ${offset}`)
  if (!Number.isSafeInteger(length) || length < 1 || length > WORKSPACE_READ_BYTES_MAX_CHUNK)
    throw new RangeError(`bad length ${length} (1..${WORKSPACE_READ_BYTES_MAX_CHUNK})`)
  // Stat before open: opening a FIFO for reading blocks until a writer appears.
  if (!(await fs.promises.stat(absPath)).isFile())
    throw errnoError('EISDIR', `not a regular file, read '${absPath}'`)
  const fh = await fs.promises.open(absPath, 'r')
  try {
    const st = await fh.stat()
    if (!st.isFile()) throw errnoError('EISDIR', `not a regular file, read '${absPath}'`)
    const want = Math.max(0, Math.min(length, st.size - offset))
    const buf = Buffer.alloc(want)
    let got = 0
    while (got < want) {
      const { bytesRead } = await fh.read(buf, got, want - got, offset + got)
      if (bytesRead === 0) break
      got += bytesRead
    }
    return {
      bytes: buf.subarray(0, got),
      size: st.size,
      mtimeMs: st.mtimeMs,
      eof: offset + got >= st.size
    }
  } finally {
    await fh.close()
  }
}

/** {@link readBytesAt} for a path relative to `rootPath`, contained to it. */
export function readBytes(
  rootPath: string,
  filePath: string,
  offset: number,
  length: number
): Promise<ReadBytesResult> {
  try {
    return readBytesAt(assertWithinRoot(rootPath, filePath), offset, length)
  } catch (err) {
    return Promise.reject(err)
  }
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
        try {
          isDir = fs.statSync(path.join(abs, e.name)).isDirectory()
        } catch {
          return null
        }
      }
      const ignored = isIgnored(rootPath, relPath, isDir)
      return {
        name: e.name,
        path: relPath,
        type: isDir ? ('directory' as const) : ('file' as const),
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

export function textRevision(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export function readFile(
  rootPath: string,
  filePath: string,
  force?: boolean,
  knownRevision?: string
): ReadFileResult {
  const abs = assertWithinRoot(rootPath, filePath)
  const stat = fs.statSync(abs)
  if (stat.size > FORCE_MAX_FILE_SIZE) {
    return { content: null, tooLarge: true, sizeBytes: stat.size }
  }
  if (!force && stat.size > MAX_FILE_SIZE) {
    return { content: null, tooLarge: true, sizeBytes: stat.size }
  }
  const content = fs.readFileSync(abs, 'utf-8')
  if (!knownRevision) return { content }
  const revision = textRevision(content)
  return revision === knownRevision
    ? { content: null, revision, unchanged: true }
    : { content, revision }
}

export function listAllFiles(rootPath: string): string[] {
  const root = path.resolve(rootPath)
  const ig = getIgnoreFilter(rootPath)
  const results: string[] = []

  function walk(dir: string, prefix: string): void {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
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

/** Apply one replacement to an open regular file, checking its complete base. */
export function applyTextEdit(fd: number, edit: TextEdit): string {
  const before = fs.fstatSync(fd, { bigint: true })
  if (!before.isFile() || before.size > FORCE_MAX_FILE_SIZE)
    throw new Error('Cannot edit this file')
  const buf = Buffer.alloc(Number(before.size))
  for (let offset = 0; offset < buf.length; ) {
    const size = fs.readSync(fd, buf, offset, buf.length - offset, offset)
    if (size === 0) throw new Error('File changed on disk before save')
    offset += size
  }
  const content = buf.toString('utf8')
  const after = fs.fstatSync(fd, { bigint: true })
  if (
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    textRevision(content) !== edit.revision
  )
    throw new Error('File changed on disk before save')
  if (edit.from > edit.to || edit.to > content.length) throw new Error('Invalid editor range')
  const next = Buffer.from(content.slice(0, edit.from) + edit.text + content.slice(edit.to))
  if (next.length > FORCE_MAX_FILE_SIZE) throw new Error('Edited file is too large')
  for (let offset = 0; offset < next.length; ) {
    const size = fs.writeSync(fd, next, offset, next.length - offset, offset)
    if (size === 0) throw new Error('Could not write edited file')
    offset += size
  }
  fs.ftruncateSync(fd, next.length)
  return createHash('sha256').update(next).digest('hex')
}

export function writeFile(rootPath: string, filePath: string, content: string | TextEdit): string {
  const abs = assertWithinRoot(rootPath, filePath)
  if (typeof content !== 'string') {
    const fd = fs.openSync(
      abs,
      fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0) | fs.constants.O_NONBLOCK
    )
    try {
      return applyTextEdit(fd, content)
    } finally {
      fs.closeSync(fd)
    }
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf-8')
  return textRevision(content)
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
    const proc = spawn(gitCommand(), ['status', '--porcelain'], { cwd: root })
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    proc.on('error', () => resolve({ files: {}, isGitRepo: false }))
    proc.on('close', (code) => {
      if (code !== 0) {
        resolve({ files: {}, isGitRepo: true })
        return
      }
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
        if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
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

/**
 * Server-side limits on what a search may read (not on the wire). `readLink`: a
 * symlink in the tree is read only through this — the path to read, or null to skip
 * it. The computer passes its path jail: a link out of the root, or onto its own
 * protected state, is never read (K8). Absent: links are followed, as before.
 */
export interface SearchFilesGuard {
  readLink?: (absPath: string) => string | null
}

export function searchFiles(
  rootPath: string,
  query: string,
  options?: SearchFilesOptions,
  guard: SearchFilesGuard = {}
): FileSearchResult[] {
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
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (totalMatches >= maxResults) return
      const relPath = prefix ? `${prefix}/${e.name}` : e.name
      if (ALWAYS_IGNORED.has(e.name)) continue
      if (ig.ignores(e.isDirectory() ? relPath + '/' : relPath)) continue
      if (e.isDirectory()) {
        walk(path.join(dir, e.name), relPath)
      } else if (e.isSymbolicLink() && guard.readLink) {
        const target = guard.readLink(path.join(dir, e.name))
        if (target !== null) searchFile(root, relPath, pattern, results, target)
      } else {
        searchFile(root, relPath, pattern, results)
      }
    }
  }

  function searchFile(
    rootDir: string,
    relPath: string,
    re: RegExp,
    out: FileSearchResult[],
    readFrom?: string
  ): void {
    if (totalMatches >= maxResults) return
    const abs = readFrom ?? path.join(rootDir, relPath)
    let stat: fs.Stats
    try {
      stat = fs.statSync(abs)
    } catch {
      return
    }
    if (stat.size > MAX_FILE_SIZE) return

    let content: string
    try {
      content = fs.readFileSync(abs, 'utf-8')
    } catch {
      return
    }

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
