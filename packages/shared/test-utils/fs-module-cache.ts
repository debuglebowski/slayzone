/**
 * Vitest's fs module cache (`fsModuleCache`) for the run-all.sh vitest invocations:
 * transformed modules persist on disk between runs, so a warm run skips the transform
 * (the React Compiler's Babel pass above all), which was most of the jsdom suites' time.
 *
 * Vitest keys a cached module by its own content, its id and the environment config.
 * Not by how its imports resolve — yet the cached code holds them RESOLVED
 * (`@slayzone/ui` → `/packages/shared/ui/src/index.ts`). So a change that moves where an
 * UNCHANGED import resolves would serve a stale path: a file moved to `foo/index.ts`, a
 * file added next to one an import used to reach, an `exports` map edited. The plugin
 * below adds exactly those inputs to each module's key, per module, so the cache stays
 * correct without going cold on every commit that adds a file somewhere:
 *
 *  - the file list of the module's own package (any relative import resolves inside
 *    it), and the resolution fields of that package's package.json;
 *  - the file list of every OTHER package a relative or alias import reaches;
 *  - the resolution fields of every workspace package imported by name — plus its file
 *    list when its `exports`/`imports` use a `*` pattern, which resolves by file name.
 *
 * Dependencies in node_modules need nothing: Vitest clears the whole cache when the
 * lockfile changes. A template-literal `import()` resolves against a directory listing,
 * so such a module is not cached at all. Without git (no file list) nothing is cached.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, posix, relative, resolve, sep } from 'node:path'
import type { Plugin } from 'vitest/config'

/** The workspace as the key sees it: every source file, repo-relative, posix. */
export interface WorkspaceLayout {
  files: string[]
  /** A package.json by its repo-relative directory ('' = the root), or null. */
  readPackageJson: (dir: string) => Record<string, unknown> | null
}

export interface ResolutionAlias {
  find: string | RegExp
  replacement: string
}

/** The package.json fields that decide how an import of (or inside) a package resolves. */
const RESOLUTION_FIELDS = ['name', 'type', 'main', 'module', 'browser', 'exports', 'imports']

/** Static, export-from, side-effect, dynamic, require, vi.mock and `new URL` specifiers. */
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bvi\.(?:mock|doMock|importActual)\s*\(\s*|\bnew\s+URL\s*\(\s*)(['"])([^'"\n]+)\1/g

const TEMPLATE_IMPORT = /\bimport\s*\(\s*`/

const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex')

/** `(id, sourceCode) => key part`, '' for a module outside the workspace sources, false = never cache. */
export function createResolutionKey(
  rootDir: string,
  layout: WorkspaceLayout,
  aliases: ResolutionAlias[] = []
): (id: string, sourceCode: string) => string | false {
  const pkgDirs = layout.files
    .filter((f) => f === 'package.json' || f.endsWith('/package.json'))
    .map((f) => posix.dirname(f))
    .map((d) => (d === '.' ? '' : d))
    // Longest first, so a nested package wins over the one around it.
    .sort((a, b) => b.length - a.length)
  const pkgOf = (rel: string): string =>
    pkgDirs.find((d) => d === '' || rel === d || rel.startsWith(`${d}/`)) ?? ''

  const filesByPkg = new Map<string, string[]>()
  for (const f of layout.files) {
    const p = pkgOf(f)
    const list = filesByPkg.get(p)
    if (list) list.push(f)
    else filesByPkg.set(p, [f])
  }
  const fileHash = new Map<string, string>()
  const filesOf = (pkg: string): string => {
    let h = fileHash.get(pkg)
    if (h === undefined) {
      h = sha1([...(filesByPkg.get(pkg) ?? [])].sort().join('\n'))
      fileHash.set(pkg, h)
    }
    return h
  }

  const fieldHash = new Map<string, string>()
  const byName = new Map<string, string>()
  const wildcard = new Set<string>()
  for (const dir of pkgDirs) {
    const json = layout.readPackageJson(dir) ?? {}
    const fields = Object.fromEntries(RESOLUTION_FIELDS.map((k) => [k, json[k] ?? null]))
    fieldHash.set(dir, sha1(JSON.stringify(fields)))
    if (typeof json.name === 'string') byName.set(json.name, dir)
    if (JSON.stringify([json.exports, json.imports]).includes('*')) wildcard.add(dir)
  }

  const root = resolve(rootDir)
  const toRel = (abs: string): string | null => {
    const rel = relative(root, abs)
    if (rel === '' || rel.startsWith('..') || resolve(root, rel) !== resolve(abs)) return null
    return rel.split(sep).join('/')
  }
  const aliasTarget = (spec: string): string | null => {
    for (const { find, replacement } of aliases) {
      if (typeof find === 'string') {
        if (spec === find) return replacement
        if (spec.startsWith(`${find}/`)) return replacement + spec.slice(find.length)
      } else if (find.test(spec)) {
        return spec.replace(find, replacement)
      }
    }
    return null
  }

  return (id, sourceCode) => {
    const file = id.split('?')[0]
    if (file.includes('\0') || file.includes('/node_modules/')) return ''
    const rel = toRel(file)
    if (rel === null) return ''
    if (TEMPLATE_IMPORT.test(sourceCode)) return false

    const own = pkgOf(rel)
    const parts = new Set([`own:${own}:${filesOf(own)}:${fieldHash.get(own) ?? ''}`])
    const reach = (abs: string, how: string): void => {
      const targetRel = toRel(abs)
      // Outside the workspace, or a dependency: the lockfile covers those.
      if (targetRel === null || targetRel.split('/').includes('node_modules')) return
      const pkg = pkgOf(targetRel)
      if (pkg !== own) parts.add(`${how}:${pkg}:${filesOf(pkg)}`)
    }
    for (const match of sourceCode.matchAll(SPECIFIER)) {
      const spec = match[2]
      if (spec.startsWith('./') || spec.startsWith('../')) {
        reach(join(dirname(file), spec), 'rel')
        continue
      }
      const aliased = aliasTarget(spec)
      if (aliased !== null) {
        reach(aliased, 'alias')
        continue
      }
      const segments = spec.split('/')
      const name = spec.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
      const pkg = byName.get(name)
      if (pkg === undefined) continue
      parts.add(`pkg:${pkg}:${fieldHash.get(pkg) ?? ''}`)
      if (wildcard.has(pkg)) parts.add(`pkgfiles:${pkg}:${filesOf(pkg)}`)
    }
    return [...parts].sort().join('|')
  }
}

/** Every file git knows under `rootDir` that exists now (tracked + untracked, not ignored). */
export function readWorkspaceLayout(rootDir: string): WorkspaceLayout {
  const git = (...args: string[]): string[] =>
    execFileSync('git', ['ls-files', '-z', ...args], {
      cwd: rootDir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    })
      .split('\0')
      .filter(Boolean)
  const deleted = new Set(git('--deleted'))
  const files = [...new Set(git('--cached', '--others', '--exclude-standard'))].filter(
    (f) => !deleted.has(f)
  )
  return {
    files,
    readPackageJson: (dir) => {
      try {
        return JSON.parse(readFileSync(join(rootDir, dir, 'package.json'), 'utf8')) as Record<
          string,
          unknown
        >
      } catch {
        return null
      }
    }
  }
}

/**
 * The cache on, in its own directory per invocation: Vitest clears a cache directory
 * when the lockfile changes, and run-all.sh runs invocations side by side — one must
 * never clear the directory another is reading.
 */
export function fsModuleCacheOptions(
  rootDir: string,
  name: string
): { fsModuleCache: true; fsModuleCachePath: string } {
  return {
    fsModuleCache: true,
    fsModuleCachePath: join(rootDir, 'node_modules', '.vitest-cache', name)
  }
}

/** Adds the resolution inputs above to every module's cache key (see the file header). */
export function fsModuleCacheResolutionKey(rootDir: string): Plugin {
  return {
    name: 'slayzone:fs-module-cache-resolution-key',
    configureVitest({ project, defineCacheKeyGenerator }) {
      let key: ((id: string, sourceCode: string) => string | false) | null = null
      try {
        const alias = project.vite.config.resolve.alias
        key = createResolutionKey(
          rootDir,
          readWorkspaceLayout(rootDir),
          Array.isArray(alias) ? (alias as ResolutionAlias[]) : []
        )
      } catch (err) {
        console.warn(`[fs-module-cache] no workspace file list, caching nothing: ${String(err)}`)
      }
      defineCacheKeyGenerator(({ id, sourceCode }) => (key ? key(id, sourceCode) : false))
    }
  }
}
