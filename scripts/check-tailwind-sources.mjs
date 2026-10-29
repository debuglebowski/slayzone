#!/usr/bin/env node
/**
 * Every class string a renderer shell renders must be in a file Tailwind scans.
 *
 *   node scripts/check-tailwind-sources.mjs                  check (`pnpm lint:theme`, part of `pnpm lint`/CI)
 *   node scripts/check-tailwind-sources.mjs --root <dir>     check another workspace (tests)
 *
 * WHY. Tailwind 4 generates a utility only when it finds the class in a scanned file.
 * The shells (the Electron renderer, the chromium-shell fork, the web shell) import
 * `@slayzone/theme-css`; their Vite root auto-scans only their OWN package. Every
 * workspace package they render arrives through node_modules, which Tailwind skips,
 * so its classes are generated only when an `@source` line names its files. A class
 * used only in an unnamed file is silently never generated: the build stays green and
 * the element renders without it. MediaView's toolbar shipped see-through that way —
 * its `bg-popover/90` was never generated because only GhMarkdown.tsx of
 * `@slayzone/markdown` was named. (Theme tokens take alpha modifiers fine: every
 * `--color-*` maps to a full CSS color, so `bg-<token>/NN` compiles to a
 * `color-mix(… var(--<token>) NN%, transparent)` for any theme's values.)
 *
 * THE RULE. For each shell — the package owning a CSS file that imports
 * `@slayzone/theme-css` — walk its workspace dependency closure: the shell's
 * dependencies + devDependencies (it bundles both), then each reached package's
 * dependencies + peerDependencies + optionalDependencies. In every reached package,
 * each non-test module that carries class strings (mentions `className` / `class=`)
 * must lie under an `@source` path — one in theme-css's index.css or in the shell's
 * own CSS, each resolved against the CSS file declaring it, as Tailwind does. The
 * shell's own package counts as covered (its Vite root). Process-side modules
 * (`server/`, `electron/` dirs: hub routes, main-process code) render no renderer
 * markup and are not required — e.g. hub-auth's server-rendered device page.
 *
 * A guard that cannot read the workspace fails (exit 2) rather than passing.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootArg = process.argv.indexOf('--root')
const root =
  rootArg === -1
    ? join(dirname(fileURLToPath(import.meta.url)), '..')
    : resolve(process.argv[rootArg + 1])

const THEME_PACKAGE = '@slayzone/theme-css'
const THEME_CSS = 'src/index.css'
/** Dependency and build-output dirs (never source), plus process-side code (never renderer markup). */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  'server',
  'electron'
])
const SOURCE_FILE = /\.[cm]?[jt]sx?$/
const TEST_FILE = /\.(test|spec|stories)\.[cm]?[jt]sx?$/
const CLASS_MENTION = /className|\bclass=/i

/** A guard that cannot read the workspace must fail, not pass as "all scanned". */
function fail(message) {
  console.error(`✖ tailwind sources: ${message} — cannot verify, failing.`)
  process.exit(2)
}

/** Workspace package dirs. Only `dir` and `dir/*` patterns are supported. */
function packageDirs() {
  const yamlPath = join(root, 'pnpm-workspace.yaml')
  if (!existsSync(yamlPath)) fail(`${yamlPath} does not exist`)
  const block = readFileSync(yamlPath, 'utf8').match(/^packages:\n((?:[ \t]+-[^\n]*\n?)+)/m)
  if (!block) fail('pnpm-workspace.yaml has no `packages:` list')
  const patterns = [...block[1].matchAll(/-\s*['"]?([^'"\n]+?)['"]?\s*$/gm)].map((m) => m[1])
  const dirs = []
  for (const pattern of patterns) {
    if (/^[^*]+\/\*$/.test(pattern)) {
      const dir = join(root, pattern.slice(0, -2))
      if (!existsSync(dir)) fail(`workspace pattern '${pattern}': ${dir} does not exist`)
      for (const entry of readdirSync(dir, { withFileTypes: true }))
        if (entry.isDirectory() && existsSync(join(dir, entry.name, 'package.json')))
          dirs.push(join(dir, entry.name))
    } else if (!pattern.includes('*')) {
      if (!existsSync(join(root, pattern, 'package.json')))
        fail(`workspace pattern '${pattern}': ${join(root, pattern)} has no package.json`)
      dirs.push(join(root, pattern))
    } else {
      fail(`workspace pattern '${pattern}' is not supported — teach packageDirs() it`)
    }
  }
  return dirs
}

/** Files under `dir`, recursively, minus dot-dirs and SKIP_DIRS. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

const cssText = (file) => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** The `@source` paths a CSS file declares, resolved against that file (as Tailwind does). */
function sourcePaths(cssFile) {
  return [...cssText(cssFile).matchAll(/@source\s+["']([^"']+)["']/g)].map((m) =>
    resolve(dirname(cssFile), m[1])
  )
}

const importsTheme = (cssFile) =>
  new RegExp(`@import\\s+["']${THEME_PACKAGE}["']`).test(cssText(cssFile))

const isUnder = (file, path) => file === path || file.startsWith(path + sep)

/** A package's non-test modules that carry class strings. */
const classFiles = (pkgDir) =>
  walk(pkgDir).filter(
    (file) =>
      SOURCE_FILE.test(file) &&
      !TEST_FILE.test(file) &&
      CLASS_MENTION.test(readFileSync(file, 'utf8'))
  )

const packages = new Map() // name → { dir, manifest }
for (const dir of packageDirs()) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  packages.set(manifest.name, { dir, manifest })
}

const theme = packages.get(THEME_PACKAGE)
if (!theme) fail(`no workspace package is named ${THEME_PACKAGE}`)
const themeCss = join(theme.dir, THEME_CSS)
if (!existsSync(themeCss)) fail(`${themeCss} does not exist`)
const themeSources = sourcePaths(themeCss)
if (themeSources.length === 0) fail(`${relative(root, themeCss)} declares no @source paths`)

const missing = themeSources.filter((p) => !existsSync(p))
if (missing.length > 0) {
  console.error(`${relative(root, themeCss)} names @source path(s) that do not exist:`)
  for (const p of missing) console.error(`  ${relative(root, p)}`)
  console.error('\nRepoint or drop them — a dangling @source scans nothing.')
  process.exit(1)
}

const workspaceDeps = (manifest, fields) =>
  fields.flatMap((f) => Object.keys(manifest[f] ?? {})).filter((d) => packages.has(d))

const shells = []
for (const [name, { dir }] of packages) {
  if (name === THEME_PACKAGE) continue
  const cssFiles = walk(dir).filter((f) => f.endsWith('.css') && importsTheme(f))
  if (cssFiles.length > 0) shells.push({ name, dir, cssFiles })
}
if (shells.length === 0) fail(`no workspace CSS file imports ${THEME_PACKAGE}`)

const unscanned = new Map() // relative file → Set of shell names rendering it
let checked = 0
for (const shell of shells) {
  const covered = [shell.dir, ...themeSources, ...shell.cssFiles.flatMap(sourcePaths)]
  const reached = new Set()
  const queue = workspaceDeps(packages.get(shell.name).manifest, [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies'
  ])
  while (queue.length > 0) {
    const name = queue.shift()
    if (reached.has(name) || name === shell.name || name === THEME_PACKAGE) continue
    reached.add(name)
    queue.push(
      ...workspaceDeps(packages.get(name).manifest, [
        'dependencies',
        'peerDependencies',
        'optionalDependencies'
      ])
    )
  }
  for (const name of reached) {
    for (const file of classFiles(packages.get(name).dir)) {
      checked++
      if (covered.some((p) => isUnder(file, p))) continue
      const rel = relative(root, file)
      if (!unscanned.has(rel)) unscanned.set(rel, new Set())
      unscanned.get(rel).add(shell.name)
    }
  }
}

if (unscanned.size > 0) {
  console.error(
    `${unscanned.size} file(s) render class strings Tailwind never scans — classes used only there are never generated:`
  )
  for (const [file, by] of [...unscanned].sort())
    console.error(`  ${file}  (rendered by ${[...by].sort().join(', ')})`)
  console.error(
    `\nAdd an @source line for the package's source dir to ${relative(root, themeCss)}.`
  )
  process.exit(1)
}
console.log(
  `tailwind-sources: ${shells.length} shells, ${checked} class-bearing files, all scanned`
)
