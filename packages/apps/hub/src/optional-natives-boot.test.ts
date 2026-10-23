/**
 * The REAL built hub (dist/bin.cjs) boots with none of its optional natives — node-pty,
 * bufferutil, utf-8-validate — the way `npm install @slayzone/hub` leaves it on a machine
 * without a compiler (T-30). Before T-30 the bundle required node-pty at its top level
 * (pty-manager.ts / pty-backend.ts imports) and died before listening.
 *
 * "Missing" = a `--require` preload that makes those three unresolvable and logs every
 * attempt. Then:
 *   - processes off (a hosted hub): /health ok, and node-pty is never even requested;
 *   - processes on: still boots, node-pty still not requested — it is required on the
 *     first hub-local spawn (node-pty-optional.test.ts covers that refusal).
 * ws asks for bufferutil at load and falls back when it is missing, so that one is
 * expected in the log; utf-8-validate is never asked for on node >= 18.14.
 *
 * The published tarball itself is installed with `--omit=optional` and booted the same
 * way by scripts/smoke-hub-no-natives.sh, from scripts/publish-npm.sh.
 *
 * Isolation as in hub-boot.test.ts: throwaway SLAYZONE_ROOT, SLAYZONE_/ELECTRON_ env
 * scrubbed, port :0. better-sqlite3 needs Electron's ABI, hence the strict loader.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *   packages/apps/hub/src/optional-natives-boot.test.ts
 */
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const HUB_DIR = join(__dirname, '..')
const HUB_BIN = join(HUB_DIR, 'dist', 'bin.cjs')
const ELECTRON_BIN = require('electron') as unknown as string

let passed = 0
let failed = 0
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    failed++
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

function newestMtime(dir: string): number {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs)
  }
  return newest
}

/** Rebuild when the bin is missing or older than ANY workspace source it bundles. */
function ensureBuilt(): void {
  const sources = ['apps/hub/src', 'domains/terminal/src'].map((d) => join(HUB_DIR, '..', '..', d))
  const stale =
    !existsSync(HUB_BIN) || sources.some((d) => newestMtime(d) > statSync(HUB_BIN).mtimeMs)
  if (!stale) return
  console.log('  … building hub bundle (bin missing or stale)')
  execFileSync('node', ['build.mjs'], { cwd: HUB_DIR, stdio: 'inherit' })
}

function scrubbedEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null || /^(SLAYZONE_|ELECTRON_)/.test(k) || k === 'NODE_PATH' || k === 'NODE_OPTIONS')
      continue
    out[k] = v
  }
  return out
}

const BLOCKER = `
const Module = require('module')
const fs = require('fs')
const blocked = new Set(['node-pty', 'bufferutil', 'utf-8-validate'])
const resolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (blocked.has(request)) {
    fs.appendFileSync(process.env.SLZ_TEST_BLOCKED_LOG, request + '\\n')
    throw Object.assign(new Error("Cannot find module '" + request + "'"), { code: 'MODULE_NOT_FOUND' })
  }
  return resolve.call(this, request, ...rest)
}
`

const roots: string[] = []

/** Boot the bin with the natives blocked; resolve with /health + what was requested. */
async function bootWithoutNatives(processes: '0' | '1'): Promise<{
  health: { ok?: boolean; switches?: { enableProcesses?: boolean } }
  requested: string[]
}> {
  const root = mkdtempSync(join(tmpdir(), 'slz-hub-no-natives-'))
  roots.push(root)
  const blocker = join(root, 'block-natives.cjs')
  const log = join(root, 'blocked.log')
  writeFileSync(blocker, BLOCKER)
  writeFileSync(log, '')
  const logs: string[] = []
  // stdin held open: a hub started by the desktop app treats stdin EOF as parent death.
  const proc = spawn(ELECTRON_BIN, ['--require', blocker, HUB_BIN], {
    cwd: root,
    env: {
      ...scrubbedEnv(),
      ELECTRON_RUN_AS_NODE: '1',
      SLAYZONE_ROOT: root,
      SLAYZONE_HUB_LISTEN_ADDRESS: '127.0.0.1:0',
      SLAYZONE_HUB_ENABLE_PROCESSES: processes,
      SLZ_TEST_BLOCKED_LOG: log
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const cap = (b: Buffer): void => {
    for (const line of b.toString().split('\n')) if (line.trim()) logs.push(line)
  }
  proc.stdout?.on('data', cap)
  proc.stderr?.on('data', cap)
  try {
    const start = Date.now()
    let port = 0
    while (!port) {
      assert(proc.exitCode === null, `hub exited during boot:\n${logs.join('\n')}`)
      assert(Date.now() - start < 30_000, `hub did not listen within 30s:\n${logs.join('\n')}`)
      const m = logs.join('\n').match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)
      if (m) port = Number(m[1])
      else await new Promise((r) => setTimeout(r, 150))
    }
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(5_000)
    })
    assert(res.ok, `/health ${res.status}`)
    const health = (await res.json()) as { ok?: boolean; switches?: { enableProcesses?: boolean } }
    const requested = readFileSync(log, 'utf8').split('\n').filter(Boolean)
    return { health, requested }
  } finally {
    await new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
      const t = setTimeout(() => proc.kill('SIGKILL'), 3_000)
      proc.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
      proc.kill('SIGTERM')
    })
  }
}

console.log('\nthe built hub without its optional natives (node-pty, bufferutil, utf-8-validate)\n')
ensureBuilt()

try {
  await test('processes off: boots, /health ok, node-pty never requested', async () => {
    const { health, requested } = await bootWithoutNatives('0')
    assert(health.ok === true, `/health ok: ${JSON.stringify(health)}`)
    assert(health.switches?.enableProcesses === false, 'processes reported off')
    assert(!requested.includes('node-pty'), `node-pty requested: ${requested.join(', ')}`)
  })

  await test('processes on: still boots, node-pty not requested at boot', async () => {
    const { health, requested } = await bootWithoutNatives('1')
    assert(health.ok === true, `/health ok: ${JSON.stringify(health)}`)
    assert(health.switches?.enableProcesses === true, 'processes reported on')
    assert(!requested.includes('node-pty'), `node-pty requested: ${requested.join(', ')}`)
  })
} finally {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
process.exit(0)
