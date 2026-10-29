#!/usr/bin/env node
/**
 * Every workspace package's typecheck must be hermetic: the files a package's
 * tsconfig(s) and sources bring into its program come from the package itself or
 * from a workspace package in its declared dependency closure.
 *
 *   node scripts/check-tsconfig-hermetic.mjs               check (`pnpm lint:tsconfig-hermetic`, part of `pnpm lint`/CI)
 *   node scripts/check-tsconfig-hermetic.mjs --root <dir>  check another workspace (tests)
 *
 * Why: a package's typecheck result is then a function of its own files plus its
 * dependencies' — exactly the inputs a per-package cache (Turborepo) hashes. A
 * tsconfig that reaches into a package it does not depend on makes the result
 * depend on files the cache never sees (stale hits), and usually hides a cycle:
 * the reached package typically depends on the reacher.
 *
 * Checked, in every `tsconfig*.json` under a workspace package (node_modules and
 * dot-directories skipped):
 *   - `include` / `files` (the static part of a glob, before the first wildcard)
 *   - `references[].path`
 *   - `extends` — a relative path, or a bare specifier naming a workspace package;
 *     the repo-root tsconfig.base.json is always allowed (settings only, no files)
 *   - `compilerOptions.paths` targets, `compilerOptions.typeRoots`
 *   - `compilerOptions.types` entries naming a workspace package
 * and, in the package's typechecked sources (the TypeScript files under those
 * in-package include/files bases; node_modules, dist, out, build skipped), each
 * RELATIVE module specifier that leaves the package (`../../../shared/x/…`):
 * `import`/`export … from`, `import()` (also `typeof import()`), `require()`,
 * `/// <reference path>`. (Bare specifiers of undeclared packages: `pnpm lint:deps`.)
 * Each must resolve inside the package or inside a workspace package reachable
 * through its package.json dependencies (all dependency fields, transitively).
 *
 * NON_PACKAGE_INPUTS lists the repo-root directories that are not workspace
 * packages but that a typecheck may read. Each one (as `<dir>/**`), and
 * tsconfig.base.json, must be in turbo.json `globalDependencies` — checked here —
 * so the per-package cache re-runs typechecks when they change. Keep it short.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkspaceError, workspacePackages } from './lib/workspace-packages.mjs'

const rootArg = process.argv.indexOf('--root')
const root = resolve(
  rootArg === -1 ? join(dirname(fileURLToPath(import.meta.url)), '..') : process.argv[rootArg + 1]
)

/**
 * `convex/`: the Convex backend. Its CLI owns the directory layout (functions +
 * the generated `convex/_generated/api.d.ts`, which imports every function module),
 * so it is not a pnpm package; the client packages reach the generated API through
 * a `convex/_generated/*` path alias.
 */
const NON_PACKAGE_INPUTS = ['convex']

const BASE_CONFIG = join(root, 'tsconfig.base.json')

/** A guard that cannot read its inputs must fail, not pass as "nothing to check". */
function fail(message) {
  console.error(`✖ tsconfig hermetic: ${message} — cannot verify, failing.`)
  process.exit(2)
}

/** JSON with comments and trailing commas (what tsc accepts) → value. */
function parseJsonc(text, file) {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 1
    } else out += c
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
  } catch (e) {
    fail(`${relative(root, file)} is not valid JSON(C): ${e.message}`)
  }
}

/** Files under `dir` whose name matches `name`, skipping `skipDirs` and dot-directories. */
function findFiles(dir, name, skipDirs) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name) || entry.name.startsWith('.')) continue
    const p = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...findFiles(p, name, skipDirs))
    else if (name.test(entry.name)) found.push(p)
  }
  return found
}
const tsconfigFiles = (dir) => findFiles(dir, /^tsconfig.*\.json$/, new Set(['node_modules']))
const SOURCE = /\.(?:[cm]?ts|tsx)$/
const sourceFiles = (dir) =>
  findFiles(dir, SOURCE, new Set(['node_modules', 'dist', 'out', 'build']))

/**
 * Relative module specifiers a TypeScript source can load: static `import`/`export
 * … from` (single- or multi-line), side-effect `import '…'`, `import(…)` (also in
 * `typeof import(…)`), `require(…)`, `/// <reference path>`.
 */
const RELATIVE_SPECIFIERS = [
  /^\s*(?:import|export)\b[^'"]*?\bfrom\s*(['"])(\.\.?\/[^'"]*)\1/gm,
  /^\s*\}\s*from\s*(['"])(\.\.?\/[^'"]*)\1/gm,
  /^\s*import\s*(['"])(\.\.?\/[^'"]*)\1/gm,
  /\b(?:import|require)\s*\(\s*(['"])(\.\.?\/[^'"]*)\1\s*\)/g,
  /^\/\/\/\s*<reference\s+path\s*=\s*(['"])([^'"]+)\1/gm
]
function relativeSpecifiers(text) {
  const found = new Set()
  for (const pattern of RELATIVE_SPECIFIERS) for (const m of text.matchAll(pattern)) found.add(m[2])
  return found
}

function isInside(dir, p) {
  const rel = relative(dir, p)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** The path a glob can match under: its segments up to the first wildcard. */
function staticBase(pattern) {
  const segments = pattern.split('/')
  const firstGlob = segments.findIndex((s) => /[*?[{]/.test(s))
  return (firstGlob === -1 ? segments : segments.slice(0, firstGlob)).join('/')
}

let packages
try {
  packages = workspacePackages(root)
} catch (e) {
  if (e instanceof WorkspaceError) fail(e.message)
  throw e
}
const byName = new Map(packages.map((p) => [p.name, p]))

/** Names of the workspace packages `name` depends on, transitively. */
function closure(name) {
  const seen = new Set()
  const stack = [...byName.get(name).deps]
  while (stack.length > 0) {
    const dep = stack.pop()
    if (seen.has(dep)) continue
    seen.add(dep)
    stack.push(...byName.get(dep).deps)
  }
  return seen
}

/** The workspace package a bare specifier (`@scope/name/sub`) names, if any. */
function workspacePackageOf(specifier) {
  const parts = specifier.split('/')
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  return byName.get(name)
}

const violations = []

for (const pkg of packages) {
  const deps = closure(pkg.name)
  const allowedDirs = [
    pkg.dir,
    ...[...deps].map((d) => byName.get(d).dir),
    ...NON_PACKAGE_INPUTS.map((d) => join(root, d))
  ]
  const allowed = (p) => allowedDirs.some((dir) => isInside(dir, p))
  const notInClosure = (p) =>
    `resolves to ${relative(root, p) || '.'}, outside ${pkg.name} and its workspace dependencies`
  /** Where this package's own typechecked sources live: the in-package include/files bases. */
  const sourceRoots = new Set()

  for (const file of tsconfigFiles(pkg.dir)) {
    const configDir = dirname(file)
    const config = parseJsonc(readFileSync(file, 'utf8'), file)
    const options = config.compilerOptions ?? {}
    const where = relative(root, file)
    const report = (field, value, why) =>
      violations.push(`  ${where}  ${field}: ${JSON.stringify(value)} — ${why}`)
    const checkPath = (field, value, base = configDir) => {
      const p = resolve(base, staticBase(value.replaceAll('${configDir}', configDir)))
      if (!allowed(p)) report(field, value, notInClosure(p))
    }
    const checkSpecifier = (field, value) => {
      const target = workspacePackageOf(value)
      if (target && target.name !== pkg.name && !deps.has(target.name))
        report(field, value, `${target.name} is not a dependency of ${pkg.name}`)
    }

    const extendsList = [config.extends ?? []].flat()
    for (const ext of extendsList) {
      if (ext.startsWith('.') || isAbsolute(ext)) {
        const p = resolve(configDir, ext)
        const target = existsSync(p) || p.endsWith('.json') ? p : `${p}.json`
        if (target !== BASE_CONFIG && !allowed(target)) report('extends', ext, notInClosure(target))
      } else checkSpecifier('extends', ext)
    }
    for (const field of ['include', 'files'])
      for (const value of config[field] ?? []) checkPath(field, value)
    // No `include` and no `files` = everything under the config's directory (tsc's default).
    const sources = config.include ?? (config.files ? [] : ['**/*'])
    for (const value of [...sources, ...(config.files ?? [])]) {
      const base = resolve(configDir, staticBase(value.replaceAll('${configDir}', configDir)))
      if (isInside(pkg.dir, base)) sourceRoots.add(base)
    }
    for (const ref of config.references ?? []) checkPath('references', ref.path)

    const pathsBase = options.baseUrl ? resolve(configDir, options.baseUrl) : configDir
    for (const [alias, targets] of Object.entries(options.paths ?? {}))
      for (const target of targets) checkPath(`compilerOptions.paths[${alias}]`, target, pathsBase)
    for (const value of options.typeRoots ?? []) checkPath('compilerOptions.typeRoots', value)
    for (const value of options.types ?? []) checkSpecifier('compilerOptions.types', value)
  }

  const files = new Set()
  for (const base of sourceRoots) {
    if (!existsSync(base)) continue
    if (statSync(base).isDirectory()) for (const f of sourceFiles(base)) files.add(f)
    else if (SOURCE.test(base)) files.add(base)
  }
  for (const file of files) {
    for (const specifier of relativeSpecifiers(readFileSync(file, 'utf8'))) {
      const p = resolve(dirname(file), specifier)
      if (!allowed(p))
        violations.push(
          `  ${relative(root, file)}  import: ${JSON.stringify(specifier)} — ${notInClosure(p)}`
        )
    }
  }
}

// The per-package cache only re-runs a typecheck when an input it hashes changed, so
// every allowed input outside the packages must be hashed globally.
const TURBO_CONFIG = join(root, 'turbo.json')
if (existsSync(TURBO_CONFIG)) {
  const globals =
    parseJsonc(readFileSync(TURBO_CONFIG, 'utf8'), TURBO_CONFIG).globalDependencies ?? []
  for (const required of ['tsconfig.base.json', ...NON_PACKAGE_INPUTS.map((d) => `${d}/**`)])
    if (!globals.includes(required))
      violations.push(
        `  turbo.json globalDependencies: missing ${JSON.stringify(required)} — a typecheck reads it, so the cache must hash it`
      )
}

if (violations.length > 0) {
  console.error(
    `${violations.length} typecheck input${violations.length === 1 ? ' reaches' : 's reach'} outside the package and its workspace dependencies:`
  )
  for (const v of violations) console.error(v)
  console.error(
    '\nA package typecheck may only read its own files and those of the workspace packages it' +
      '\ndepends on. Import what you need from a declared dependency (adding the dependency if' +
      "\nit doesn't close a cycle — `pnpm lint:workspace-cycles`), or move the file into the package."
  )
  process.exit(1)
}
console.log(
  `tsconfig-hermetic: ${packages.length} packages, every tsconfig entry and relative import in-closure`
)
