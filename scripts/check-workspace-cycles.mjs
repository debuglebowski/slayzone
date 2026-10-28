#!/usr/bin/env node
/**
 * Ratchet on dependency cycles between workspace packages.
 *
 *   node scripts/check-workspace-cycles.mjs            check (`pnpm lint:workspace-cycles`; not in `pnpm lint`/CI until the cycles are gone)
 *   node scripts/check-workspace-cycles.mjs --update   rewrite the baseline
 *   node scripts/check-workspace-cycles.mjs --root <dir>   check another workspace (tests)
 *
 * Packages depend on each other in loops (transport ↔ every domain, settings ↔ task…),
 * which is why pnpm-workspace.yaml needs `ignoreWorkspaceCycles` and why no tool that
 * orders or caches per package (Turborepo, `tsc -b` project references) can be used.
 *
 * The graph is the workspace packages and the `@workspace` dependencies their
 * package.json files declare (all dependency fields) — the same graph pnpm and
 * Turborepo see. An edge is a cycle edge when both ends are in the same strongly
 * connected component. Those edges are compared with
 * scripts/workspace-cycles-baseline.json:
 *   - a cycle edge not in the baseline fails (no new cycles, no new edges inside one);
 *   - a baseline entry that is no longer a cycle edge fails too, until the baseline
 *     is updated — so the baseline only ever shrinks.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootArg = process.argv.indexOf('--root')
const root =
  rootArg === -1 ? join(dirname(fileURLToPath(import.meta.url)), '..') : process.argv[rootArg + 1]
const BASELINE = join(root, 'scripts/workspace-cycles-baseline.json')

/** package.json paths of the workspace packages. Only `dir` and `dir/*` patterns are supported. */
function packageJsonPaths() {
  const yaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
  const block = yaml.match(/^packages:\n((?:[ \t]+-[^\n]*\n?)+)/m)
  if (!block) fail('pnpm-workspace.yaml has no `packages:` list')
  const patterns = [...block[1].matchAll(/-\s*['"]?([^'"\n]+?)['"]?\s*$/gm)].map((m) => m[1])
  const paths = []
  for (const pattern of patterns) {
    if (/^[^*]+\/\*$/.test(pattern)) {
      const dir = join(root, pattern.slice(0, -2))
      if (!existsSync(dir)) fail(`workspace pattern '${pattern}': ${dir} does not exist`)
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name, 'package.json')
        if (entry.isDirectory() && existsSync(p)) paths.push(p)
      }
    } else if (!pattern.includes('*')) {
      const p = join(root, pattern, 'package.json')
      if (!existsSync(p)) fail(`workspace pattern '${pattern}': ${p} does not exist`)
      paths.push(p)
    } else {
      fail(`workspace pattern '${pattern}' is not supported — teach packageJsonPaths() it`)
    }
  }
  return paths
}

/** A guard that cannot read the workspace must fail, not pass as "no cycles". */
function fail(message) {
  console.error(`✖ workspace cycles: ${message} — cannot verify, failing.`)
  process.exit(2)
}

/** name → names of the workspace packages it declares a dependency on. */
function dependencyGraph() {
  const manifests = packageJsonPaths().map((p) => JSON.parse(readFileSync(p, 'utf8')))
  const names = new Set(manifests.map((m) => m.name))
  const graph = new Map()
  for (const m of manifests) {
    const deps = new Set()
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies'
    ])
      for (const dep of Object.keys(m[field] ?? {})) if (names.has(dep)) deps.add(dep)
    graph.set(m.name, [...deps].sort())
  }
  return graph
}

/** Tarjan's strongly connected components: name → component id. */
function components(graph) {
  const index = new Map()
  const low = new Map()
  const component = new Map()
  const stack = []
  let next = 0
  const visit = (v) => {
    index.set(v, next)
    low.set(v, next)
    next++
    stack.push(v)
    for (const w of graph.get(v)) {
      if (!index.has(w)) {
        visit(w)
        low.set(v, Math.min(low.get(v), low.get(w)))
      } else if (!component.has(w)) low.set(v, Math.min(low.get(v), index.get(w)))
    }
    if (low.get(v) === index.get(v)) {
      let w
      do {
        w = stack.pop()
        component.set(w, v)
      } while (w !== v)
    }
  }
  for (const v of graph.keys()) if (!index.has(v)) visit(v)
  return component
}

const graph = dependencyGraph()
const component = components(graph)
const current = []
for (const [from, deps] of graph)
  for (const to of deps)
    if (component.get(from) === component.get(to)) current.push(`${from} -> ${to}`)
current.sort()
const cyclicPackages = new Set(current.map((e) => e.split(' -> ')[0])).size

if (process.argv.includes('--update')) {
  writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`)
  console.log(
    `workspace-cycles baseline: ${current.length} cycle edges, ${cyclicPackages} packages`
  )
  process.exit(0)
}

const baseline = new Set(existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : [])
const now = new Set(current)
const added = current.filter((e) => !baseline.has(e))
const fixed = [...baseline].filter((e) => !now.has(e))

if (added.length > 0) {
  console.error(
    `${added.length} dependency edge(s) form or join a cycle between workspace packages:`
  )
  for (const e of added) console.error(`  ${e}`)
  console.error(
    '\nDepend in one direction only: move the shared code down into a package both can use.'
  )
}
if (fixed.length > 0) {
  console.error(`${fixed.length} baseline edge(s) are no longer part of a cycle — remove them:`)
  for (const e of fixed) console.error(`  ${e}`)
  console.error('\nRun `node scripts/check-workspace-cycles.mjs --update`.')
}
if (added.length > 0 || fixed.length > 0) process.exit(1)
console.log(
  `workspace-cycles: ${current.length} known cycle edges in ${cyclicPackages} packages, no new ones (${graph.size} packages)`
)
