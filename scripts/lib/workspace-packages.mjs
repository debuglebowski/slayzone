/**
 * The pnpm workspace as the repo's guards see it: every package listed by
 * pnpm-workspace.yaml and the workspace dependencies its package.json declares.
 * Shared by scripts/check-workspace-cycles.mjs and scripts/check-tsconfig-hermetic.mjs.
 *
 * Throws `WorkspaceError` when the workspace can't be read; a guard must turn that
 * into a failure, never into "nothing to check".
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export class WorkspaceError extends Error {}

/** Every field that makes pnpm (and Turborepo) treat a workspace package as a dependency. */
export const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies'
]

/** package.json paths of the workspace packages. Only `dir` and `dir/*` patterns are supported. */
export function workspacePackageJsonPaths(root) {
  const yaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
  const block = yaml.match(/^packages:\n((?:[ \t]+-[^\n]*\n?)+)/m)
  if (!block) throw new WorkspaceError('pnpm-workspace.yaml has no `packages:` list')
  const patterns = [...block[1].matchAll(/-\s*['"]?([^'"\n]+?)['"]?\s*$/gm)].map((m) => m[1])
  const paths = []
  for (const pattern of patterns) {
    if (/^[^*]+\/\*$/.test(pattern)) {
      const dir = join(root, pattern.slice(0, -2))
      if (!existsSync(dir))
        throw new WorkspaceError(`workspace pattern '${pattern}': ${dir} does not exist`)
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name, 'package.json')
        if (entry.isDirectory() && existsSync(p)) paths.push(p)
      }
    } else if (!pattern.includes('*')) {
      const p = join(root, pattern, 'package.json')
      if (!existsSync(p))
        throw new WorkspaceError(`workspace pattern '${pattern}': ${p} does not exist`)
      paths.push(p)
    } else {
      throw new WorkspaceError(
        `workspace pattern '${pattern}' is not supported — teach workspacePackageJsonPaths() it`
      )
    }
  }
  return paths
}

/**
 * The workspace packages: `{ name, dir, deps }`, `deps` being the sorted names of the
 * workspace packages its package.json declares in any dependency field.
 */
export function workspacePackages(root) {
  const manifests = workspacePackageJsonPaths(root).map((p) => ({
    dir: dirname(p),
    manifest: JSON.parse(readFileSync(p, 'utf8'))
  }))
  const names = new Set(manifests.map((m) => m.manifest.name))
  return manifests.map(({ dir, manifest }) => {
    const deps = new Set()
    for (const field of DEPENDENCY_FIELDS)
      for (const dep of Object.keys(manifest[field] ?? {})) if (names.has(dep)) deps.add(dep)
    return { name: manifest.name, dir, deps: [...deps].sort() }
  })
}
