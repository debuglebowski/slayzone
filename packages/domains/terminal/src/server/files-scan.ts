import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'
import type { FileMatch } from '../shared/types'

const execFileAsync = promisify(execFile)

/**
 * List project files for `@file` autocomplete.
 * Prefers `git ls-files` (honors `.gitignore`, deterministic).
 * Falls back to depth-limited fs walk if not a git repo.
 */
export async function listProjectFiles(
  cwd: string,
  query: string,
  limit = 50
): Promise<FileMatch[]> {
  const gitResults = await tryGitLs(cwd, query, limit)
  if (gitResults !== null) return gitResults
  return fsWalk(cwd, query, limit)
}

async function tryGitLs(cwd: string, query: string, limit: number): Promise<FileMatch[] | null> {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
    })
    const q = query.toLowerCase()
    const out: FileMatch[] = []
    const seenDirs = new Set<string>()
    for (const line of stdout.split('\n')) {
      const p = line.trim()
      if (!p) continue
      if (q && !p.toLowerCase().includes(q)) continue
      out.push({ path: p, isDirectory: false })
      const dir = path.dirname(p)
      if (dir !== '.' && !seenDirs.has(dir)) {
        seenDirs.add(dir)
        if (q && dir.toLowerCase().includes(q)) {
          out.push({ path: dir + '/', isDirectory: true })
        }
      }
      if (out.length >= limit) break
    }
    return rankFiles(out, query).slice(0, limit)
  } catch {
    return null
  }
}

async function fsWalk(cwd: string, query: string, limit: number): Promise<FileMatch[]> {
  const q = query.toLowerCase()
  const out: FileMatch[] = []
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'coverage', '.cache'])
  const maxDepth = 4

  async function walk(dir: string, relDir: string, depth: number): Promise<void> {
    if (out.length >= limit || depth > maxDepth) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= limit) break
      if (entry.name.startsWith('.')) continue
      if (skip.has(entry.name)) continue
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!q || rel.toLowerCase().includes(q)) {
          out.push({ path: rel + '/', isDirectory: true })
        }
        await walk(abs, rel, depth + 1)
      } else if (entry.isFile()) {
        if (!q || rel.toLowerCase().includes(q)) {
          out.push({ path: rel, isDirectory: false })
        }
      }
    }
  }

  await walk(cwd, '', 0)
  return rankFiles(out, query).slice(0, limit)
}

function rankFiles(files: FileMatch[], query: string): FileMatch[] {
  if (!query) return files
  const q = query.toLowerCase()
  return files
    .map((f) => {
      const p = f.path.toLowerCase()
      const base = path.basename(f.path).toLowerCase()
      let score = 0
      if (base.startsWith(q)) score = 3
      else if (base.includes(q)) score = 2
      else if (p.includes(q)) score = 1
      return { f, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.f.path.localeCompare(b.f.path))
    .map((x) => x.f)
}
