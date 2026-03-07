import { readdir } from 'fs/promises'
import { join, relative } from 'path'
import picomatch from 'picomatch'
import type { TestCategory, TestFileMatch, ScanResult } from '../shared/types'

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  'coverage',
  '.e2e-runtime',
  '.e2e-userdata'
])

function shouldSkip(name: string): boolean {
  return IGNORED_DIRS.has(name) || (name.startsWith('.') && name !== '.')
}

export async function scanTestFiles(projectPath: string, categories: TestCategory[]): Promise<ScanResult> {
  if (categories.length === 0) return { matches: [], totalScanned: 0 }

  const matchers = categories.map((c) => {
    try {
      return { id: c.id, isMatch: picomatch(c.pattern) }
    } catch {
      return null
    }
  }).filter((m): m is { id: string; isMatch: picomatch.Matcher } => m !== null)

  const matches: TestFileMatch[] = []
  let totalScanned = 0

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (shouldSkip(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else {
        totalScanned++
        const rel = relative(projectPath, full)
        for (const { id, isMatch } of matchers) {
          if (isMatch(rel)) {
            matches.push({ path: rel, categoryId: id })
            break
          }
        }
      }
    }
  }

  await walk(projectPath)
  return { matches, totalScanned }
}
