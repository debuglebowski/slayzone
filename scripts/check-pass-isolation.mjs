#!/usr/bin/env node
/**
 * Ratchet: one bad item never stops a whole pass (robustness principle P3).
 *
 *   node scripts/check-pass-isolation.mjs            check (`pnpm lint:pass-isolation`)
 *   node scripts/check-pass-isolation.mjs --update   rewrite the baseline
 *
 * A "pass" walks a list of independent items: recovery, cleanup, sync, drain,
 * sweep, retry, migrate, refresh, reconcile, prune, collect, scrub, erase — by
 * function name, or any function whose doc comment says `@pass`. A loop in one
 * that awaits, touches files or parses JSON aborts on its first bad item and
 * leaves every later item stuck (a corrupt journal kept a computer from booting;
 * one unreadable backup blocked every blob cleanup and erasure).
 *
 * Every such loop must instead be ONE of:
 *   - `forEachIsolated` / `forEachIsolatedSync` (@slayzone/platform/isolation) —
 *     not a loop, so never flagged;
 *   - a loop whose whole body is a try/catch;
 *   - a loop preceded by `// isolation: fatal — <reason>`: any failure stops the
 *     pass on purpose (e.g. all-or-nothing work, or the items are not independent).
 *
 * Existing violations are listed in scripts/pass-isolation-baseline.json. A new
 * one fails; a baseline entry that no longer exists fails too, until the baseline
 * is updated — so it only ever shrinks.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE = join(root, 'scripts/pass-isolation-baseline.json')
const require = createRequire(import.meta.url)
const { parse } = require('@babel/parser')
const traverse = require('@babel/traverse').default

const PASS_NAME =
  /^(recover|cleanup|sync|drain|sweep|retry|migrate|refresh|reconcile|prune|collect|scrub|erase)/i
const FS_CALLS = new Set([
  'readFileSync',
  'writeFileSync',
  'unlinkSync',
  'rmSync',
  'renameSync',
  'readdirSync',
  'statSync',
  'lstatSync',
  'mkdirSync',
  'copyFileSync',
  'openSync',
  'fsyncSync'
])
const FATAL_MARK = /isolation:\s*fatal\s*[—-]+\s*\S/

function sourceFiles() {
  const listed = execFileSync(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      'packages/apps/*/src/**',
      'packages/domains/*/src/**',
      'packages/shared/*/src/**'
    ],
    { cwd: root, encoding: 'utf8' }
  )
  return listed
    .split('\n')
    .filter((f) => /\.(ts|tsx|mts)$/.test(f))
    .filter((f) => existsSync(join(root, f)))
    .filter((f) => !/\.(test|spec|stories|d|audit\.test)\.tsx?$/.test(f))
    .filter((f) => !/\/(e2e|__tests__|test-utils|client|renderer)\//.test(f))
}

function functionName(path) {
  const node = path.node
  if (node.id?.name) return node.id.name
  if (node.key?.name) return node.key.name
  const parent = path.parentPath?.node
  if (parent?.type === 'VariableDeclarator' && parent.id?.name) return parent.id.name
  if ((parent?.type === 'ObjectProperty' || parent?.type === 'ClassProperty') && parent.key?.name)
    return parent.key.name
  return null
}

function hasPassTag(path) {
  const comments = [
    ...(path.node.leadingComments ?? []),
    ...(path.parentPath?.node?.leadingComments ?? []),
    ...(path.parentPath?.parentPath?.node?.leadingComments ?? [])
  ]
  return comments.some((c) => /@pass\b/.test(c.value))
}

const isFunction = (node) =>
  [
    'FunctionDeclaration',
    'FunctionExpression',
    'ArrowFunctionExpression',
    'ObjectMethod',
    'ClassMethod'
  ].includes(node.type)

/** Does this subtree (not descending into nested functions) await, touch files or parse JSON? */
function risky(node) {
  let found = false
  const visit = (n) => {
    if (found || !n || typeof n.type !== 'string') return
    if (isFunction(n)) return
    if (n.type === 'AwaitExpression' || (n.type === 'ForOfStatement' && n.await)) found = true
    if (n.type === 'CallExpression') {
      const c = n.callee
      const name =
        c.type === 'Identifier' ? c.name : c.type === 'MemberExpression' ? c.property?.name : null
      if (name && FS_CALLS.has(name)) found = true
      if (
        c.type === 'MemberExpression' &&
        c.object?.type === 'Identifier' &&
        c.object.name === 'JSON' &&
        c.property?.name === 'parse'
      )
        found = true
    }
    for (const key of Object.keys(n)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue
      const v = n[key]
      if (Array.isArray(v)) v.forEach(visit)
      else if (v && typeof v.type === 'string') visit(v)
    }
  }
  visit(node)
  return found
}

/** The loop body is one try/catch (the whole iteration is isolated). */
function wrapped(body) {
  if (!body) return false
  const stmts = body.type === 'BlockStatement' ? body.body : [body]
  return stmts.length === 1 && stmts[0].type === 'TryStatement' && !!stmts[0].handler
}

function markedFatal(path, source) {
  const comments = path.node.leadingComments ?? []
  if (comments.some((c) => FATAL_MARK.test(c.value))) return true
  // Comment on the line right above (babel may attach it elsewhere).
  const line = path.node.loc?.start.line
  if (!line) return false
  const lines = source.split('\n')
  for (let i = line - 2; i >= 0 && i >= line - 4; i--) {
    if (FATAL_MARK.test(lines[i])) return true
    if (lines[i].trim() && !lines[i].trim().startsWith('//')) break
  }
  return false
}

function violationsIn(file) {
  return violationsInSource(file, readFileSync(join(root, file), 'utf8'))
}

/** The non-isolated pass loops of one source file (exported for the test). */
export function violationsInSource(file, source) {
  let ast
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: ['typescript', ...(file.endsWith('x') ? ['jsx'] : []), 'decorators-legacy']
    })
  } catch {
    return []
  }
  const out = []
  traverse(ast, {
    Function(path) {
      const name = functionName(path)
      if (!(name && PASS_NAME.test(name)) && !hasPassTag(path)) return
      let ordinal = 0
      path.traverse({
        Function(inner) {
          // A nested named pass is checked on its own; other nested functions
          // (loop callbacks) belong to this pass.
          const innerName = functionName(inner)
          if ((innerName && PASS_NAME.test(innerName)) || hasPassTag(inner)) inner.skip()
        },
        'ForStatement|ForOfStatement|ForInStatement|WhileStatement|DoWhileStatement'(loop) {
          if (!risky(loop.node.body) || wrapped(loop.node.body) || markedFatal(loop, source)) return
          out.push({ fn: name ?? '(@pass)', ordinal: ++ordinal, line: loop.node.loc?.start.line })
        },
        CallExpression(call) {
          const c = call.node.callee
          if (c.type !== 'MemberExpression' || c.property?.name !== 'forEach') return
          const fn = call.node.arguments[0]
          if (!fn || !isFunction(fn)) return
          if (!risky(fn.body) || wrapped(fn.body) || markedFatal(call.parentPath, source)) return
          out.push({ fn: name ?? '(@pass)', ordinal: ++ordinal, line: call.node.loc?.start.line })
        }
      })
    }
  })
  return out
}

/**
 * Files a process reads while it starts (computer host + connector, hub boot). A
 * corrupt state file there must never keep the process down: read it through
 * `readJsonTolerant` / `readJsonArraySalvage` (@slayzone/platform/quarantine), or
 * mark a deliberate strict read `// startup-json: strict — <why>`.
 */
const STARTUP_FILES = [
  'packages/apps/computer/src/bin.ts',
  'packages/apps/computer/src/session-host.ts',
  'packages/apps/computer/src/hook-journal.ts',
  'packages/apps/computer/src/connector.ts',
  'packages/apps/computer/src/main.ts',
  'packages/apps/hub/src/bin.ts',
  'packages/apps/hub/src/server.ts',
  'packages/apps/hub/src/bootstrap-schema.ts'
]
const BARE_JSON_READ = /JSON\.parse\(\s*(?:fs\.)?readFileSync\(/

/** Bare `JSON.parse(readFileSync(…))` in a startup file without a strict marker. */
export function strictStartupReads(source) {
  const lines = source.split('\n')
  const out = []
  lines.forEach((line, i) => {
    if (!BARE_JSON_READ.test(line)) return
    for (let j = i - 1; j >= 0 && j >= i - 3; j--)
      if (/startup-json:\s*strict\s*[—-]+\s*\S/.test(lines[j])) return
    out.push(i + 1)
  })
  return out
}

function main() {
  const startup = STARTUP_FILES.filter((f) => existsSync(join(root, f))).flatMap((f) =>
    strictStartupReads(readFileSync(join(root, f), 'utf8')).map((line) => `${f}:${line}`)
  )
  if (startup.length) {
    console.error(
      'Startup files read JSON without the tolerant reader (a corrupt file would stop boot):'
    )
    for (const s of startup) console.error(`  ${s}`)
    console.error(
      '\nUse readJsonTolerant / readJsonArraySalvage (@slayzone/platform/quarantine), or mark' +
        ' `// startup-json: strict — <why a bad file must refuse>`.'
    )
    process.exit(1)
  }
  const files = sourceFiles()
  const current = {}
  for (const file of files) {
    const v = violationsIn(file)
    if (v.length) current[file] = v
  }
  const entriesOf = (list) => list.map((v) => `${v.fn}#${v.ordinal}`)
  const currentEntries = Object.fromEntries(
    Object.entries(current)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([f, v]) => [f, entriesOf(v)])
  )
  const total = Object.values(currentEntries).reduce((n, e) => n + e.length, 0)

  if (process.argv.includes('--update')) {
    writeFileSync(BASELINE, `${JSON.stringify(currentEntries, null, 2)}\n`)
    console.log(
      `pass-isolation baseline: ${total} non-isolated pass loops in ${Object.keys(currentEntries).length} files`
    )
    process.exit(0)
  }

  const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {}
  const added = []
  const fixed = []
  for (const [file, list] of Object.entries(current)) {
    const allowed = new Set(baseline[file] ?? [])
    entriesOf(list).forEach((entry, i) => {
      if (!allowed.has(entry)) added.push(`${file}:${list[i].line} ${entry}`)
    })
  }
  for (const [file, entries] of Object.entries(baseline)) {
    const now = new Set(currentEntries[file] ?? [])
    for (const entry of entries) if (!now.has(entry)) fixed.push(`${file}: ${entry}`)
  }
  if (added.length) {
    console.error(`${added.length} pass loop(s) stop on their first bad item:`)
    for (const a of added) console.error(`  ${a}`)
    console.error(
      '\nUse forEachIsolated (@slayzone/platform/isolation), wrap the whole body in try/catch,' +
        ' or mark the loop `// isolation: fatal — <why any failure must stop the pass>`.'
    )
  }
  if (fixed.length) {
    console.error(
      `${fixed.length} baseline entr(y/ies) no longer exist — remove them from the baseline:`
    )
    for (const f of fixed) console.error(`  ${f}`)
    console.error('\nRun `node scripts/check-pass-isolation.mjs --update`.')
  }
  if (added.length || fixed.length) process.exit(1)
  console.log(
    `pass-isolation: ${total} known non-isolated pass loops, no new ones (${files.length} files)`
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
