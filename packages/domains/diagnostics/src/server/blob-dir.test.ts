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
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
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
  expect(json, 'expected a payload').toBeTruthy()
  return (JSON.parse(json!) as { screenshotDataUrl: string }).screenshotDataUrl
}

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('diagnosticsBlobDirBeside', () => {
  test('blobs live in diagnostics/ beside the diagnostics DB', () => {
    expect(diagnosticsBlobDirBeside(join('/root', 'hub', 'slayzone.diagnostics.sqlite'))).toBe(
      join('/root', 'hub', 'diagnostics')
    )
  })
})

describe('createFilesystemBlobFs', () => {
  test('lists files with size + mtime, skips subdirectories, removes by name', () => {
    const dir = join(scratch, 'fs')
    mkdirSync(join(dir, 'nested'), { recursive: true })
    writeFileSync(join(dir, 'a.png'), Buffer.alloc(10))
    writeFileSync(join(dir, 'b.png'), Buffer.alloc(20))
    const fs = createFilesystemBlobFs(dir)
    const listed = fs.list().sort((x, y) => x.name.localeCompare(y.name))
    expect(listed.map((f) => `${f.name}:${f.sizeBytes}`).join(',')).toBe('a.png:10,b.png:20')
    for (const f of listed) expect(f.mtimeMs, `mtime of ${f.name}`).toBeGreaterThan(0)
    fs.remove('a.png')
    expect(existsSync(join(dir, 'a.png')), 'a.png should be removed').toBe(false)
  })
})

describe('before bind — no dir, no disk, no log line', () => {
  test('no blob dir is bound', () => {
    expect(getDiagnosticsBlobDir()).toBe(null)
  })

  test('offload degrades to a marker instead of writing anywhere', () => {
    const field = screenshotField(buildPayloadJson({ screenshotDataUrl: screenshot }))
    expect(field).toBe(`[BLOB_WRITE_FAILED:${PNG_BYTES}B]`)
    expect(
      existsSync(process.env.SLAYZONE_ROOT!),
      'nothing may be created under the ambient root'
    ).toBe(false)
  })

  test('retention is a silent no-op', () => {
    let result: ReturnType<typeof runBlobRetention> | undefined
    const logged = captureErrors(() => {
      result = runBlobRetention(CONFIG, Date.now())
    })
    expect(logged.join('\n')).toBe('')
    expect(result!.deleted).toBe(0)
  })
})

describe('after bind — the bound dir, and only it', () => {
  const blobDir = join(scratch, 'hub-root', 'diagnostics')
  const noopDiagDb = {
    prepare: () => ({ get: async () => undefined, run: async () => ({}) })
  }
  // Binds AFTER the "before bind" tests have run (a describe-level hook, not
  // collection-time code).
  beforeAll(() => {
    bindDiagnosticsDbs({
      diagnosticsDb: noopDiagDb as unknown as SlayzoneDb,
      localConfig: () => ({}),
      saveLocalConfig: async () => {},
      blobDir
    })
  })

  test('the bound dir is reported', () => {
    expect(getDiagnosticsBlobDir()).toBe(blobDir)
  })

  test('offload writes the whole image into the bound dir and records its path', () => {
    const field = screenshotField(buildPayloadJson({ screenshotDataUrl: screenshot }))
    expect(field.startsWith(blobDir), `expected a path under ${blobDir}, got ${field}`).toBe(true)
    expect(statSync(field).size).toBe(PNG_BYTES)
    expect(
      existsSync(process.env.SLAYZONE_ROOT!),
      'nothing may be created under the ambient root'
    ).toBe(false)
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
    expect(logged.join('\n')).toBe('')
    expect(result!.deleted).toBe(1)
    expect(existsSync(old), 'old.png should be pruned').toBe(false)
    expect(readdirSync(blobDir).length, 'fresh blobs kept').toBe(before - 1)
  })
})
