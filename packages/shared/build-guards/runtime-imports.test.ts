/**
 * Tests for the runtime-imports guard — real Rollup and esbuild builds of small
 * fixtures, so the plugin hooks run exactly as they do in the app builds.
 *
 * The bug this guards against: Rollup does not bundle a `require()` inside ESM
 * source, so `require('@slayzone/platform')` survived into out/main and Node
 * loaded the package's raw TS source at runtime → ERR_MODULE_NOT_FOUND, caught
 * and logged every retention tick.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/build-guards/runtime-imports.test.ts
 */
import { afterAll, describe, expect, test } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rollup } from 'rollup'
import { build as esbuild } from 'esbuild'
import {
  runtimeImportsEsbuildPlugin,
  runtimeImportsRollupPlugin,
  type RuntimeImportsGuardOptions
} from './runtime-imports.mjs'

const root = mkdtempSync(join(tmpdir(), 'slz-build-guards-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let fixtureSeq = 0

function fixture(source: string): string {
  const dir = join(root, String(fixtureSeq++))
  mkdirSync(dir)
  const entry = join(dir, 'entry.js')
  writeFileSync(entry, source)
  return entry
}

const isBare = (id: string): boolean =>
  !id.startsWith('.') && !id.startsWith('/') && !id.includes('\0')

/** Resolves to the guard's error message, or null when the build passed. */
async function rollupGuard(
  source: string,
  opts: RuntimeImportsGuardOptions
): Promise<string | null> {
  const bundle = await rollup({
    input: fixture(source),
    external: isBare,
    plugins: [runtimeImportsRollupPlugin(opts)],
    onwarn: () => {}
  })
  try {
    await bundle.generate({ format: 'es' })
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  } finally {
    await bundle.close()
  }
}

async function esbuildGuard(
  source: string,
  external: string[],
  opts: RuntimeImportsGuardOptions
): Promise<string | null> {
  const entry = fixture(source)
  try {
    await esbuild({
      entryPoints: [entry],
      outfile: join(entry, '..', 'out.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external,
      metafile: true,
      logLevel: 'silent',
      plugins: [runtimeImportsEsbuildPlugin(opts)]
    })
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

const app = (extra: Partial<RuntimeImportsGuardOptions> = {}): RuntimeImportsGuardOptions => ({
  bundleName: 'fixture',
  packageJson: {
    name: '@slayzone/fixture-app',
    dependencies: { 'declared-dep': '^1.0.0', '@slayzone/platform': 'workspace:*' },
    optionalDependencies: { 'optional-dep': '^1.0.0' }
  },
  ...extra
})

describe('runtime-imports guard — Rollup', () => {
  test('rejects require() of a workspace package left in ESM output (the shipped bug)', async () => {
    const err = await rollupGuard(
      `export function dir() { return require('@slayzone/platform').getStorageDir() }`,
      app()
    )
    expect(err, 'expected the build to fail').not.toBeNull()
    expect(err, 'error should name the specifier').toContain('@slayzone/platform')
    expect(err, 'error should name the output file').toContain('entry.js')
  })

  test('rejects a workspace package even when declared as a dependency', async () => {
    const err = await rollupGuard(`import { x } from '@slayzone/platform'\nexport { x }`, app())
    expect(err, 'expected workspace import rejected').toContain('@slayzone/platform')
  })

  test('rejects require.resolve() of an undeclared package', async () => {
    const err = await rollupGuard(
      `export const p = () => require.resolve('mermaid/dist/mermaid.min.js')`,
      app()
    )
    expect(err, 'expected mermaid rejected').toContain('mermaid/dist/mermaid.min.js')
  })

  test('rejects a call through a createRequire()-bound name (electron-vite shim)', async () => {
    const err = await rollupGuard(
      `import __cjs_mod__ from 'node:module'\nconst require2 = __cjs_mod__.createRequire(import.meta.url)\nexport const f = () => require2('left-pad')`,
      app()
    )
    expect(err, 'expected left-pad rejected').toContain('left-pad')
  })

  test('rejects an immediately-invoked createRequire(...)(...)', async () => {
    const err = await rollupGuard(
      `import { createRequire } from 'node:module'\nexport const f = () => createRequire(import.meta.url)('left-pad')`,
      app()
    )
    expect(err, 'expected left-pad rejected').toContain('left-pad')
  })

  test('rejects undeclared static and dynamic external imports', async () => {
    const err = await rollupGuard(
      `import a from 'undeclared-static'\nexport const f = () => import('undeclared-dynamic')\nexport { a }`,
      app()
    )
    expect(err, 'expected static import rejected').toContain('undeclared-static')
    expect(err, 'expected dynamic import rejected').toContain('undeclared-dynamic')
  })

  test('allows builtins, declared and optional dependencies', async () => {
    const err = await rollupGuard(
      [
        `import { join } from 'node:path'`,
        `import fs from 'fs'`,
        `import dep from 'declared-dep'`,
        `import sub from 'declared-dep/sub/path.js'`,
        `export const f = () => [require('node:os'), require('optional-dep'), require.resolve('declared-dep/x.js'), join, fs, dep, sub]`
      ].join('\n'),
      app()
    )
    expect(err).toBeNull()
  })

  test('ignores require-looking text inside string literals (ajv codegen)', async () => {
    const err = await rollupGuard(`export const code = 'require("ajv/dist/runtime/equal")'`, app())
    expect(err).toBeNull()
  })

  test('ignores non-literal specifiers', async () => {
    const err = await rollupGuard(`export const f = (m) => [require(m), import(m)]`, app())
    expect(err).toBeNull()
  })

  test('electron is allowed only for Electron bundles', async () => {
    const src = `export const f = () => require('electron')`
    expect(
      await rollupGuard(src, app({ electron: true })),
      'expected pass with electron: true'
    ).toBeNull()
    const err = await rollupGuard(src, app())
    expect(err, 'expected electron rejected without electron: true').toContain('electron')
  })

  test('optionalExternals are allowed', async () => {
    const err = await rollupGuard(
      `export const f = () => require('bufferutil')`,
      app({ optionalExternals: ['bufferutil'] })
    )
    expect(err).toBeNull()
  })

  test('lists every violation in one error', async () => {
    const err = await rollupGuard(
      `export const f = () => [require('@slayzone/a'), require('@slayzone/b'), require('nope')]`,
      app()
    )
    for (const s of ['@slayzone/a', '@slayzone/b', 'nope']) {
      expect(err, `expected ${s} in error`).toContain(s)
    }
  })
})

describe('runtime-imports guard — esbuild', () => {
  test('rejects an undeclared external', async () => {
    const err = await esbuildGuard(`require('undeclared')`, ['undeclared'], app())
    expect(err, 'expected undeclared rejected').toContain('undeclared')
  })

  test('rejects an externalized workspace package', async () => {
    const err = await esbuildGuard(`require('@slayzone/platform')`, ['@slayzone/platform'], app())
    expect(err, 'expected workspace rejected').toContain('@slayzone/platform')
  })

  test('allows builtins, declared deps and optionalExternals', async () => {
    const err = await esbuildGuard(
      `require('node:fs'); require('path'); require('declared-dep'); require('bufferutil')`,
      ['declared-dep', 'bufferutil'],
      app({ optionalExternals: ['bufferutil'] })
    )
    expect(err).toBeNull()
  })
})
