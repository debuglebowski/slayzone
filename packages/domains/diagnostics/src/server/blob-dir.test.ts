/**
 * Payload blobs live in a directory the HOST binds — never one resolved from the
 * ambient environment inside this package.
 *
 * Both halves used to resolve `<storage>/diagnostics/` themselves through a lazy
 * `require('@slayzone/platform')`. In the Electron main bundle Rollup left that
 * require unbundled, so it failed on every retention tick (ERR_MODULE_NOT_FOUND,
 * logged each minute) and every offload degraded to a marker. And had it worked,
 * it would have been the wrong dir: main never sets SLAYZONE_ROOT, so platform's
 * `getStorageDir()` there is `~/.slayzone` — shared across release channels —
 * while the hub writes the real blobs beside the diagnostics DB in the hub root.
 *
 * Run with: pnpm exec tsx packages/domains/diagnostics/src/server/blob-dir.test.ts
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SlayzoneDb } from '@slayzone/platform'
import type { DiagnosticsConfig } from '../shared'

const scratch = mkdtempSync(join(tmpdir(), 'slz-diag-blob-dir-'))
// Defense in depth: nothing here may touch the real ~/.slayzone, whatever the code
// under test resolves.
process.env.SLAYZONE_ROOT = join(scratch, 'ambient-root')

const { createFilesystemBlobFs, diagnosticsBlobDirBeside } = await import('./blob-retention')
const { bindDiagnosticsDbs, buildPayloadJson, getDiagnosticsBlobDir } = await import(
  './diagnostics-store'
)
const { runBlobRetention } = await import('./retention')

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? e.message : String(e)}`)
    failed++
  }
}

function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

function eq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

/** Runs `fn` and returns everything it wrote through console.error / console.warn. */
function captureErrors(fn: () => void): string[] {
  const lines: string[] = []
  const { error, warn } = console
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(' '))
  console.warn = (...args: unknown[]) => lines.push(args.map(String).join(' '))
  try {
    fn()
  } finally {
    console.error = error
    console.warn = warn
  }
  return lines
}

const CONFIG: DiagnosticsConfig = {
  enabled: true,
  verbose: false,
  includePtyOutput: false,
  retentionDays: 14
}
const DAY_MS = 24 * 60 * 60 * 1000
const PNG_BYTES = 3000
const screenshot = `data:image/png;base64,${Buffer.alloc(PNG_BYTES, 7).toString('base64')}`

function screenshotField(json: string | null): string {
  ok(json, 'expected a payload')
  return (JSON.parse(json!) as { screenshotDataUrl: string }).screenshotDataUrl
}

console.log('diagnosticsBlobDirBeside')

test('blobs live in diagnostics/ beside the diagnostics DB', () => {
  eq(
    diagnosticsBlobDirBeside(join('/root', 'hub', 'slayzone.diagnostics.sqlite')),
    join('/root', 'hub', 'diagnostics'),
    'blob dir'
  )
})

console.log('createFilesystemBlobFs')

test('lists files with size + mtime, skips subdirectories, removes by name', () => {
  const dir = join(scratch, 'fs')
  mkdirSync(join(dir, 'nested'), { recursive: true })
  writeFileSync(join(dir, 'a.png'), Buffer.alloc(10))
  writeFileSync(join(dir, 'b.png'), Buffer.alloc(20))
  const fs = createFilesystemBlobFs(dir)
  const listed = fs.list().sort((x, y) => x.name.localeCompare(y.name))
  eq(listed.map((f) => `${f.name}:${f.sizeBytes}`).join(','), 'a.png:10,b.png:20', 'listing')
  ok(
    listed.every((f) => f.mtimeMs > 0),
    'expected mtimes'
  )
  fs.remove('a.png')
  ok(!existsSync(join(dir, 'a.png')), 'a.png should be removed')
})

console.log('before bind — no dir, no disk, no log line')

test('no blob dir is bound', () => {
  eq(getDiagnosticsBlobDir(), null, 'blob dir')
})

test('offload degrades to a marker instead of writing anywhere', () => {
  const field = screenshotField(buildPayloadJson({ screenshotDataUrl: screenshot }))
  eq(field, `[BLOB_WRITE_FAILED:${PNG_BYTES}B]`, 'field')
  ok(!existsSync(process.env.SLAYZONE_ROOT!), 'nothing may be created under the ambient root')
})

test('retention is a silent no-op', () => {
  let result: ReturnType<typeof runBlobRetention> | undefined
  const logged = captureErrors(() => {
    result = runBlobRetention(CONFIG, Date.now())
  })
  eq(logged.join('\n'), '', 'console output')
  eq(result!.deleted, 0, 'deleted')
})

console.log('after bind — the bound dir, and only it')

const blobDir = join(scratch, 'hub-root', 'diagnostics')
const noopDiagDb = { prepare: () => ({ get: async () => undefined, run: async () => ({}) }) }
bindDiagnosticsDbs({
  diagnosticsDb: noopDiagDb as unknown as SlayzoneDb,
  localConfig: () => ({}),
  saveLocalConfig: async () => {},
  blobDir
})

test('the bound dir is reported', () => {
  eq(getDiagnosticsBlobDir(), blobDir, 'blob dir')
})

test('offload writes the whole image into the bound dir and records its path', () => {
  const field = screenshotField(buildPayloadJson({ screenshotDataUrl: screenshot }))
  ok(field.startsWith(blobDir), `expected a path under ${blobDir}, got ${field}`)
  eq(statSync(field).size, PNG_BYTES, 'blob size')
  ok(!existsSync(process.env.SLAYZONE_ROOT!), 'nothing may be created under the ambient root')
})

test('retention prunes expired blobs in the bound dir, keeps fresh ones, logs nothing', () => {
  const now = Date.now()
  mkdirSync(blobDir, { recursive: true })
  const old = join(blobDir, 'old.png')
  writeFileSync(old, Buffer.alloc(5))
  const oldSeconds = (now - 20 * DAY_MS) / 1000
  utimesSync(old, oldSeconds, oldSeconds)
  const before = readdirSync(blobDir).length

  let result: ReturnType<typeof runBlobRetention> | undefined
  const logged = captureErrors(() => {
    result = runBlobRetention(CONFIG, now)
  })
  eq(logged.join('\n'), '', 'console output')
  eq(result!.deleted, 1, 'deleted')
  ok(!existsSync(old), 'old.png should be pruned')
  eq(readdirSync(blobDir).length, before - 1, 'fresh blobs kept')
})

rmSync(scratch, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
