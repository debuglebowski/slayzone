/**
 * The client entry must run in Node, browsers AND React Native, so its source may import
 * only its own siblings and touch no platform global. This scans every non-test module in
 * `src/client/` for both. (Platform code lives in `src/client-node/` or the app.)
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = import.meta.dirname
const modules = readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))

/** Source without comments, so prose may mention `window` or `node:http`. */
function code(file: string): string {
  return readFileSync(join(DIR, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

/** Node / Electron / DOM globals that do not exist on every platform. */
const PLATFORM_GLOBALS =
  /\b(Buffer|process|require|module|exports|__dirname|__filename|global|window|document|navigator|location|localStorage|sessionStorage|XMLHttpRequest|fetch)\b/

describe('@slayzone/hub-auth/client is platform-neutral', () => {
  it('has modules to check', () => {
    expect(modules).toContain('index.ts')
    expect(modules.length).toBeGreaterThan(5)
  })

  it.each(modules)('%s imports only sibling modules', (file) => {
    const specifiers = [...code(file).matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!)
    expect(specifiers.filter((s) => !s.startsWith('./'))).toEqual([])
    expect(code(file)).not.toMatch(/\bimport\s*\(|\brequire\s*\(/)
  })

  it.each(modules)('%s uses no platform global', (file) => {
    const hits = code(file)
      .split('\n')
      .filter((line) => PLATFORM_GLOBALS.test(line.replace(/(['"`])(?:(?!\1).)*\1/g, '""')))
    expect(hits).toEqual([])
  })
})
