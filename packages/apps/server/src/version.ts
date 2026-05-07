import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let cached: string | null = null

export function getServerVersion(): string {
  if (cached) return cached
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkgPath = join(here, '..', 'package.json')
    const raw = readFileSync(pkgPath, 'utf-8')
    const parsed = JSON.parse(raw) as { version?: string }
    cached = parsed.version ?? '0.0.0'
  } catch {
    cached = '0.0.0'
  }
  return cached
}
