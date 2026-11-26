#!/usr/bin/env node
/**
 * Client ↔ hub API compatibility check (docs/plans/client-hub-compat.md).
 *
 *   node scripts/check-api-compat.mjs                 compare HEAD with the latest release
 *   node scripts/check-api-compat.mjs --base v0.42.0  … with another ref
 *   node scripts/check-api-compat.mjs --explain       also say WHY each violation breaks
 *   node scripts/check-api-compat.mjs --prune         drop acknowledgements nothing needs
 *
 * A remote hub and its apps update independently, so this release's app will meet the
 * previous release's hub, and this release's hub the previous release's app. This
 * compares HEAD's tRPC `AppRouter` with the base release's, procedure by procedure, at
 * the type level (inputs AND outputs — most outputs have no runtime schema), in both
 * directions, and fails on a break the contract does not cover:
 *
 *  - an older client → this hub (a procedure removed; an input it sends no longer
 *    accepted; an output it reads changed) — covered when `MIN_CLIENT_API` excludes the
 *    base's API version: the hub then refuses that app with "update SlayZone";
 *  - this client → an older hub (an input the older hub rejects or silently drops; an
 *    output this client reads that the older hub does not produce) — covered when
 *    `MIN_HUB_API` excludes it: the app then shows "hub needs update" and sends nothing.
 *
 * A break that is fine (the client tolerates the missing field, the feature is gated
 * with `hubHasFeature`, …) is acknowledged with its reason in
 * packages/apps/api/api-compat.json. Constants: packages/shared/trpc-server/src/api-version.ts.
 *
 * The base release's sources are unpacked (git archive) and installed once per commit
 * under node_modules/.cache/api-compat/, so its types resolve against its own deps.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkSource,
  evaluate,
  explainSource,
  parseContract,
  parseVerdict,
  pickBaseTag,
  pruneAcks
} from './api-compat/lib.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const API_DIR = join(root, 'packages/apps/api')
const ROUTER = 'packages/apps/api/src/router.ts'
const CONTRACT = 'packages/shared/trpc-server/src/api-version.ts'
const ACKS = join(API_DIR, 'api-compat.json')
const CACHE = join(root, 'node_modules/.cache/api-compat')
// Inside the api package, so the generated file resolves types (`node`, `vite/client`)
// and HEAD's router exactly as the package's own typecheck does.
const WORK = join(API_DIR, 'node_modules/.cache/api-compat')

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? null : args[i + 1]
}

const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim()

function resolveBase() {
  const explicit = option('--base')
  if (explicit) return explicit
  const head = git('rev-parse', 'HEAD')
  const tags = git('tag', '-l', 'v*', '--format=%(refname:short) %(objectname) %(*objectname)')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [tag, obj, peeled] = line.split(' ')
      return { tag, sha: peeled || obj }
    })
  const base = pickBaseTag(tags, head)
  if (!base) {
    console.error('api-compat: no release tag to compare with (fetch tags: git fetch --tags)')
    process.exit(2)
  }
  return base
}

/** The base's sources with its own dependencies installed; reused per commit. */
function prepareBase(ref) {
  const sha = git('rev-parse', `${ref}^{commit}`)
  const dir = join(CACHE, sha)
  const ready = join(dir, '.api-compat-ready')
  if (!existsSync(ready)) {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    console.log(`api-compat: unpacking ${ref} (${sha.slice(0, 9)}) …`)
    execFileSync('sh', ['-c', `git archive ${sha} | tar -x -C "${dir}"`], { cwd: root })
    console.log('api-compat: installing its dependencies (types only, no scripts) …')
    // Types only: no install scripts, no native builds. Its own lockfile, so its
    // types resolve as that release built them.
    execFileSync('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts', '--prefer-offline'], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, CI_SKIP_POSTINSTALL: '1' }
    })
    writeFileSync(ready, `${ref}\n`)
  }
  if (!existsSync(join(dir, ROUTER))) {
    console.error(`api-compat: ${ref} has no ${ROUTER}; pass --base with a newer release`)
    process.exit(2)
  }
  return { sha, dir }
}

function readIf(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

/** Typecheck `source` as `name` in the work dir; tsgo's full output. */
function tsgo(name, source, { truncate = false } = {}) {
  mkdirSync(WORK, { recursive: true })
  writeFileSync(join(WORK, name), source)
  const tsconfig = `tsconfig.${name.replace(/\.ts$/, '')}.json`
  writeFileSync(
    join(WORK, tsconfig),
    `${JSON.stringify(
      {
        extends: relative(WORK, join(API_DIR, 'tsconfig.json')),
        compilerOptions: { noErrorTruncation: !truncate },
        include: [name]
      },
      null,
      2
    )}\n`
  )
  const res = spawnSync('pnpm', ['exec', 'tsgo', '-p', join(WORK, tsconfig), '--pretty', 'false'], {
    cwd: API_DIR,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  })
  return `${res.stdout}${res.stderr}`
}

const baseRef = resolveBase()
const base = prepareBase(baseRef)
const contracts = {
  base: parseContract(readIf(join(base.dir, CONTRACT))),
  head: parseContract(readFileSync(join(root, CONTRACT), 'utf8'))
}
const acksRaw = readIf(ACKS)
const acks = acksRaw ? JSON.parse(acksRaw) : { oldClient: {}, newClient: {} }

const rel = (p) => {
  const r = relative(WORK, p)
  return r.startsWith('.') ? r : `./${r}`
}
const check = checkSource({
  newRouter: rel(join(root, ROUTER)).replace(/\.ts$/, ''),
  oldRouter: rel(join(base.dir, ROUTER)).replace(/\.ts$/, '')
})
console.log(`api-compat: comparing HEAD with ${baseRef} …`)
const out = tsgo('check.ts', check.source)
const checkFile = relative(API_DIR, join(WORK, 'check.ts'))
const { found, unexpected } = parseVerdict(out, checkFile, check.lineOf)
if (unexpected.length) {
  console.error('api-compat: the comparison itself failed — its verdict cannot be trusted:')
  for (const line of unexpected) console.error(`  ${line.slice(0, 2000)}`)
  process.exit(2)
}

const verdict = evaluate({ found, base: contracts.base, head: contracts.head, acks })
const { HUB_API_VERSION, MIN_CLIENT_API, MIN_HUB_API } = contracts.head
console.log(
  `api-compat: ${baseRef} is API ${contracts.base.HUB_API_VERSION}; HEAD is API ${HUB_API_VERSION} ` +
    `(serves clients ≥ ${MIN_CLIENT_API}, works with hubs ≥ ${MIN_HUB_API})`
)
const DIR_TEXT = {
  oldClient: `a ${baseRef} app on this release's hub`,
  newClient: `this release's app on a ${baseRef} hub`
}
for (const dir of ['oldClient', 'newClient']) {
  const n = verdict.breaks[dir].length
  if (verdict.covered[dir]) {
    console.log(`  ${DIR_TEXT[dir]}: refused by the contract (${n} break(s) not checked)`)
    continue
  }
  console.log(
    `  ${DIR_TEXT[dir]}: ${n} break(s), ${verdict.acked[dir].length} acknowledged, ` +
      `${verdict.violations[dir].length} not`
  )
}
for (const e of verdict.errors) console.error(`  ✗ ${e}`)

const stale = verdict.stale.oldClient.length + verdict.stale.newClient.length
if (stale) {
  if (flag('--prune')) {
    writeFileSync(ACKS, `${JSON.stringify(pruneAcks(acks, verdict.stale), null, 2)}\n`)
    console.log(`  pruned ${stale} acknowledgement(s) nothing needs any more`)
  } else {
    console.log(`  ${stale} acknowledgement(s) no longer needed — run with --prune to drop them`)
  }
}

if (!verdict.ok) {
  for (const dir of ['oldClient', 'newClient']) {
    if (!verdict.violations[dir].length) continue
    console.error(`\n✗ Breaks ${DIR_TEXT[dir]}:`)
    for (const v of verdict.violations[dir]) console.error(`    ${v}`)
  }
  if (flag('--explain')) {
    const ex = explainSource(check.prelude, verdict.violations)
    const exOut = tsgo('explain.ts', ex.source, { truncate: true })
    const exFile = relative(API_DIR, join(WORK, 'explain.ts'))
    let current = null
    for (const line of exOut.split('\n')) {
      const m = new RegExp(`^${exFile.replace(/[.]/g, '\\.')}\\((\\d+),`).exec(line)
      if (m) {
        current = ex.lineOf[Number(m[1])] ?? null
        if (current) console.error(`\n  ${current}\n    ${line.replace(/^.*?error /, 'error ')}`)
      } else if (current && /^\s/.test(line)) console.error(`    ${line.trim()}`)
      else current = null
    }
  }
  console.error(`
Each break is one of:
  - fix it: keep the old shape working (add, don't rename or retype; make a new input optional);
  - gate it: a client feature an older hub lacks checks \`hubHasFeature\` (HUB_FEATURES);
  - accept it: add it to packages/apps/api/api-compat.json under "${verdict.violations.oldClient.length ? 'oldClient' : 'newClient'}" with the reason;
  - refuse the pairing: raise HUB_API_VERSION and MIN_CLIENT_API (old apps on this hub) or
    MIN_HUB_API (this app on old hubs) above ${contracts.base.HUB_API_VERSION} in ${CONTRACT} —
    a narrower support window: those users see "update" instead of broken calls.
${flag('--explain') ? '' : 'Run with --explain to see why each one breaks.\n'}`)
  process.exit(1)
}
console.log('api-compat: ok')
