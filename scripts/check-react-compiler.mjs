#!/usr/bin/env node
/**
 * Ratchet on React Compiler coverage.
 *
 *   node scripts/check-react-compiler.mjs            check (CI: `pnpm lint:react-compiler`)
 *   node scripts/check-react-compiler.mjs --update   rewrite the baseline
 *
 * The renderer build runs babel-plugin-react-compiler on every component and hook.
 * A function the compiler cannot handle (a `try/finally`, a ref read during render,
 * manual memo deps it cannot preserve, an `eslint-disable` of a hooks rule…) is
 * skipped SILENTLY: it ships unmemoized and the build stays green. That is how the
 * whole task-tab tree (App, TaskDetailPage, …) went uncompiled and every tab switch
 * re-rendered every open tab.
 *
 * This runs the same compiler (resolved from the app, so the build's version and
 * defaults) over the renderer sources and compares the skipped functions with
 * scripts/react-compiler-baseline.json:
 *   - a skip not in the baseline fails (new code must compile);
 *   - a baseline entry that now compiles fails too, until the baseline is
 *     updated — so the baseline only ever shrinks.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { availableParallelism } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE = join(root, 'scripts/react-compiler-baseline.json')

/** Sources the renderer builds (electron app + web shell) run through the compiler. */
function sourceFiles() {
  const tracked = execFileSync(
    'git',
    [
      'ls-files',
      // Untracked-but-not-ignored too, so a new file is checked before its first commit.
      '--cached',
      '--others',
      '--exclude-standard',
      'packages/domains/*/src/**',
      'packages/shared/*/src/**',
      'packages/apps/app/src/renderer/**',
      'packages/apps/web-shell/src/**'
    ],
    { cwd: root, encoding: 'utf8' }
  )
  return tracked
    .split('\n')
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .filter((f) => !/\.(test|spec|stories|d)\.tsx?$/.test(f))
    .filter((f) => !/\/(server|main|electron|e2e|__tests__|test-utils)\//.test(f))
}

/** Name of the function at `loc` — its own id, or the binding/property it is assigned to. */
function functionNames(babel, ast) {
  const names = new Map()
  const key = (loc) => `${loc.start.line}:${loc.start.column}`
  const visit = (path) => {
    let name = path.node.id?.name
    for (let p = path.parentPath; !name && p; p = p.parentPath) {
      if (p.isVariableDeclarator()) name = p.node.id.name
      else if (p.isObjectProperty() || p.isClassMethod() || p.isObjectMethod())
        name = p.node.key.name
      else if (p.isExportDefaultDeclaration()) name = 'default'
      else if (!p.isCallExpression() && !p.isTSAsExpression()) break
    }
    if (path.node.loc) names.set(key(path.node.loc), name ?? '(anonymous)')
  }
  babel.traverse(ast, {
    FunctionDeclaration: visit,
    FunctionExpression: visit,
    ArrowFunctionExpression: visit,
    ObjectMethod: visit,
    ClassMethod: visit
  })
  return (loc) => (loc ? (names.get(key(loc)) ?? '(anonymous)') : '(unknown)')
}

/** Skipped functions in one file: `[{ fn, line, reason }]`. */
function skippedIn(babel, compiler, file) {
  const code = readFileSync(join(root, file), 'utf8')
  const parserOpts = { plugins: ['typescript', 'jsx'] }
  const events = []
  babel.transformSync(code, {
    filename: file,
    babelrc: false,
    configFile: false,
    sourceType: 'module',
    parserOpts,
    plugins: [[compiler, { logger: { logEvent: (_file, event) => events.push(event) } }]]
  })
  const errors = events.filter((e) => e.kind === 'CompileError' || e.kind === 'PipelineError')
  if (errors.length === 0) return []
  const nameAt = functionNames(babel, babel.parseSync(code, { filename: file, parserOpts }))
  const byFn = new Map()
  for (const e of errors) {
    const fnKey = e.fnLoc ? `${e.fnLoc.start.line}:${e.fnLoc.start.column}` : 'file'
    if (byFn.has(fnKey)) continue
    const detail = e.detail?.options ?? e.detail ?? {}
    byFn.set(fnKey, {
      fn: nameAt(e.fnLoc),
      line: e.fnLoc?.start.line ?? 0,
      reason: String(detail.reason ?? e.data ?? 'unknown').split('\n')[0]
    })
  }
  return [...byFn.values()].sort((a, b) => a.line - b.line)
}

if (!isMainThread) {
  const appRequire = createRequire(join(root, 'packages/apps/app/package.json'))
  const babel = appRequire('@babel/core')
  const compiler = appRequire.resolve('babel-plugin-react-compiler')
  const out = {}
  for (const file of workerData.files) {
    const skipped = skippedIn(babel, compiler, file)
    if (skipped.length > 0) out[file] = skipped
  }
  parentPort.postMessage(out)
} else {
  const files = sourceFiles()
  const workers = Math.max(1, Math.min(availableParallelism() - 1, 8))
  const chunks = Array.from({ length: workers }, (_, i) =>
    files.filter((_, j) => j % workers === i)
  )
  const results = await Promise.all(
    chunks.map(
      (chunk) =>
        new Promise((resolve, reject) => {
          const w = new Worker(fileURLToPath(import.meta.url), { workerData: { files: chunk } })
          w.once('message', resolve)
          w.once('error', reject)
        })
    )
  )
  const current = Object.assign({}, ...results)

  // Baseline entries are `name` per skipped function; a repeated name gets `#2`, `#3`.
  const entriesOf = (skipped) => {
    const seen = new Map()
    return skipped.map(({ fn }) => {
      const n = (seen.get(fn) ?? 0) + 1
      seen.set(fn, n)
      return n === 1 ? fn : `${fn}#${n}`
    })
  }
  const currentEntries = Object.fromEntries(
    Object.entries(current)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, skipped]) => [file, entriesOf(skipped)])
  )
  const total = Object.values(currentEntries).reduce((n, e) => n + e.length, 0)

  if (process.argv.includes('--update')) {
    writeFileSync(BASELINE, `${JSON.stringify(currentEntries, null, 2)}\n`)
    console.log(`react-compiler baseline: ${total} skipped functions in ${files.length} files`)
    process.exit(0)
  }

  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
  const added = []
  const fixed = []
  for (const [file, skipped] of Object.entries(current)) {
    const allowed = new Set(baseline[file] ?? [])
    entriesOf(skipped).forEach((entry, i) => {
      if (!allowed.has(entry)) added.push({ file, ...skipped[i] })
    })
  }
  for (const [file, entries] of Object.entries(baseline)) {
    const now = new Set(currentEntries[file] ?? [])
    for (const entry of entries) if (!now.has(entry)) fixed.push(`${file}: ${entry}`)
  }

  if (added.length > 0) {
    console.error(
      `React Compiler skips ${added.length} function(s) not in the baseline — they ship unmemoized:`
    )
    for (const s of added) console.error(`  ${s.file}:${s.line} ${s.fn} — ${s.reason}`)
    console.error(
      '\nFix the cause (see https://react.dev/learn/react-compiler) — the baseline only shrinks.'
    )
  }
  if (fixed.length > 0) {
    console.error(
      `${fixed.length} baseline entr(y/ies) now compile — remove them from the baseline:`
    )
    for (const f of fixed) console.error(`  ${f}`)
    console.error('\nRun `node scripts/check-react-compiler.mjs --update`.')
  }
  if (added.length > 0 || fixed.length > 0) process.exit(1)
  console.log(`react-compiler: ${total} known skips, no new ones (${files.length} files)`)
}
