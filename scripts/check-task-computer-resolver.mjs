#!/usr/bin/env node
// One answer to "which computer is this task's?" (review 2, S5). It is
// TASK_COMPUTER_EXPR / TASK_COMPUTER_SQL in packages/domains/computers/src/server/store.ts:
// the folder's holder while the task has one, else its pin, else its project's default.
// Copies drifted before: the session ledger and the local-roots sync kept
// `COALESCE(t.computer_id, p.default_computer_id)` after the resolver learned the
// holder, so the terminal start gate asked a computer that did not hold the task's
// sessions. This guard refuses a second copy of the resolution logic in source:
//
//   - a SQL `COALESCE(...)` naming a task's computer (`computer_id` or
//     `worktree_computer_id`) together with a fallback (`default_computer_id`, or
//     both task columns);
//   - the same chain in TypeScript (`x.worktree_computer_id ?? x.computer_id`,
//     `x.computer_id ?? y.default_computer_id`).
//
// Use the resolver (`resolveTaskComputerId`, `TASK_COMPUTER_SQL`, `TASK_COMPUTER_EXPR`
// from '@slayzone/computers/server'). A file that answers a DIFFERENT question goes in
// ALLOWLIST with why; an allowlist entry that no longer matches fails too, so the list
// cannot rot. Tests, e2e specs and the frozen migrations are not scanned.
//
// Usage: node scripts/check-task-computer-resolver.mjs [repo root]  (`pnpm lint:task-computer`)
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)))

/** Repo-relative file → why it may hold its own resolution. */
const ALLOWLIST = {
  'packages/domains/computers/src/server/store.ts': 'THE resolver (TASK_COMPUTER_EXPR)',
  'packages/domains/content-erasure/src/server/worker-db.ts':
    "the computer holding a worktree to delete, not the task's computer: a holder removed for good is kept so the erasure reports WORKTREE_COMPUTER_GONE instead of asking another computer",
  'packages/domains/task/src/client/useTaskPath.ts':
    'display only: which computer to name in an offline banner when the hub could not name the holder'
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'build', 'e2e', '.turbo', '.git'])
const isScanned = (name) =>
  /\.(ts|tsx|mts|cts|js|mjs)$/.test(name) &&
  !/\.(test|spec)\.[cm]?[jt]sx?$/.test(name) &&
  !/\.d\.ts$/.test(name)
/** Frozen history: a shipped migration is never edited. */
const isFrozen = (rel) =>
  rel === 'packages/shared/db-migrations/src/migrations.ts' ||
  /^packages\/shared\/db-migrations\/src\/v\d+/.test(rel)

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const path = join(dir, name)
    const st = statSync(path)
    if (st.isDirectory()) yield* walk(path)
    else if (isScanned(name)) yield path
  }
}

/** Argument text of every `coalesce(` call (balanced parens), lower-cased. */
function coalesceArgs(source) {
  const out = []
  const re = /coalesce\s*\(/gi
  for (let m = re.exec(source); m; m = re.exec(source)) {
    let depth = 1
    let i = re.lastIndex
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === '(') depth++
      else if (source[i] === ')') depth--
    }
    out.push({ at: m.index, args: source.slice(re.lastIndex, i - 1).toLowerCase() })
  }
  return out
}

const TASK_PIN = /(?<![a-z_])computer_id\b/
const HOLDER = /\bworktree_computer_id\b/
const PROJECT_DEFAULT = /\bdefault_computer_id\b/
const TS_CHAINS = [
  /\bworktree_computer_id\s*\?\?\s*[\w.?]*\bcomputer_id\b/,
  /(?<![a-z_])computer_id\s*\?\?\s*[\w.?]*\bdefault_computer_id\b/
]

/** Line numbers (1-based) of resolution copies in `source`. */
export function findCopies(source) {
  const lines = []
  const lineOf = (at) => source.slice(0, at).split('\n').length
  for (const { at, args } of coalesceArgs(source)) {
    const pin = TASK_PIN.test(args.replace(/\b(worktree|default)_computer_id\b/g, ''))
    const holder = HOLDER.test(args)
    const fallback = PROJECT_DEFAULT.test(args)
    if ((pin || holder) && (fallback || (pin && holder))) lines.push(lineOf(at))
  }
  source.split('\n').forEach((line, i) => {
    if (TS_CHAINS.some((re) => re.test(line))) lines.push(i + 1)
  })
  return [...new Set(lines)].sort((a, b) => a - b)
}

const hits = new Map()
for (const pkgRoot of ['packages', 'scripts']) {
  let dir
  try {
    dir = join(ROOT, pkgRoot)
    statSync(dir)
  } catch {
    continue
  }
  for (const file of walk(dir)) {
    const rel = relative(ROOT, file).replaceAll('\\', '/')
    if (rel === 'scripts/check-task-computer-resolver.mjs' || isFrozen(rel)) continue
    const lines = findCopies(readFileSync(file, 'utf8'))
    if (lines.length) hits.set(rel, lines)
  }
}

let fail = false
for (const [file, lines] of [...hits].sort()) {
  if (Object.hasOwn(ALLOWLIST, file)) continue
  fail = true
  console.error(
    `${file}:${lines.join(',')}: a second copy of "which computer is this task's". Use resolveTaskComputerId / TASK_COMPUTER_SQL / TASK_COMPUTER_EXPR from '@slayzone/computers/server'.`
  )
}
for (const file of Object.keys(ALLOWLIST)) {
  if (hits.has(file)) continue
  try {
    statSync(join(ROOT, file))
  } catch {
    // A fixture root (the guard's own test) carries only some of the files.
    if (process.argv[2]) continue
  }
  fail = true
  console.error(
    `${file}: allowlisted but holds no resolution copy any more — remove it from ALLOWLIST.`
  )
}
if (fail) process.exit(1)
console.log('task computer resolver: one copy')
