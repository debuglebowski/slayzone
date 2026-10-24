/**
 * Tests for the runtime-imports guard — real Rollup and esbuild builds of small
 * fixtures, so the plugin hooks run exactly as they do in the app builds.
 *
 * The bug this guards against: Rollup does not bundle a `require()` inside ESM
 * source, so `require('@slayzone/platform')` survived into out/main and Node
 * loaded the package's raw TS source at runtime → ERR_MODULE_NOT_FOUND, caught
 * and logged every retention tick.
 *
 * Run with: pnpm exec tsx packages/shared/build-guards/runtime-imports.test.ts
 */
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

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? e.message : String(e)}`)
    failed++
  }
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = mkdtempSync(join(tmpdir(), 'slz-build-guards-'))
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

async function main(): Promise<void> {
  console.log('runtime-imports guard — Rollup')

  await test('rejects require() of a workspace package left in ESM output (the shipped bug)', async () => {
    const err = await rollupGuard(
      `export function dir() { return require('@slayzone/platform').getStorageDir() }`,
      app()
    )
    assert(err, 'expected the build to fail')
    assert(err!.includes('@slayzone/platform'), `error should name the specifier: ${err}`)
    assert(err!.includes('entry.js'), `error should name the output file: ${err}`)
  })

  await test('rejects a workspace package even when declared as a dependency', async () => {
    const err = await rollupGuard(`import { x } from '@slayzone/platform'\nexport { x }`, app())
    assert(err?.includes('@slayzone/platform'), `expected workspace import rejected: ${err}`)
  })

  await test('rejects require.resolve() of an undeclared package', async () => {
    const err = await rollupGuard(
      `export const p = () => require.resolve('mermaid/dist/mermaid.min.js')`,
      app()
    )
    assert(err?.includes('mermaid/dist/mermaid.min.js'), `expected mermaid rejected: ${err}`)
  })

  await test('rejects a call through a createRequire()-bound name (electron-vite shim)', async () => {
    const err = await rollupGuard(
      `import __cjs_mod__ from 'node:module'\nconst require2 = __cjs_mod__.createRequire(import.meta.url)\nexport const f = () => require2('left-pad')`,
      app()
    )
    assert(err?.includes('left-pad'), `expected left-pad rejected: ${err}`)
  })

  await test('rejects an immediately-invoked createRequire(...)(...)', async () => {
    const err = await rollupGuard(
      `import { createRequire } from 'node:module'\nexport const f = () => createRequire(import.meta.url)('left-pad')`,
      app()
    )
    assert(err?.includes('left-pad'), `expected left-pad rejected: ${err}`)
  })

  await test('rejects undeclared static and dynamic external imports', async () => {
    const err = await rollupGuard(
      `import a from 'undeclared-static'\nexport const f = () => import('undeclared-dynamic')\nexport { a }`,
      app()
    )
    assert(err?.includes('undeclared-static'), `expected static import rejected: ${err}`)
    assert(err?.includes('undeclared-dynamic'), `expected dynamic import rejected: ${err}`)
  })

  await test('allows builtins, declared and optional dependencies', async () => {
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
    assert(err === null, `expected pass, got: ${err}`)
  })

  await test('ignores require-looking text inside string literals (ajv codegen)', async () => {
    const err = await rollupGuard(`export const code = 'require("ajv/dist/runtime/equal")'`, app())
    assert(err === null, `expected pass, got: ${err}`)
  })

  await test('ignores non-literal specifiers', async () => {
    const err = await rollupGuard(`export const f = (m) => [require(m), import(m)]`, app())
    assert(err === null, `expected pass, got: ${err}`)
  })

  await test('electron is allowed only for Electron bundles', async () => {
    const src = `export const f = () => require('electron')`
    assert(
      (await rollupGuard(src, app({ electron: true }))) === null,
      'expected pass with electron: true'
    )
    const err = await rollupGuard(src, app())
    assert(err?.includes('electron'), `expected electron rejected without electron: true: ${err}`)
  })

  await test('optionalExternals are allowed', async () => {
    const err = await rollupGuard(
      `export const f = () => require('bufferutil')`,
      app({ optionalExternals: ['bufferutil'] })
    )
    assert(err === null, `expected pass, got: ${err}`)
  })

  await test('lists every violation in one error', async () => {
    const err = await rollupGuard(
      `export const f = () => [require('@slayzone/a'), require('@slayzone/b'), require('nope')]`,
      app()
    )
    for (const s of ['@slayzone/a', '@slayzone/b', 'nope']) {
      assert(err?.includes(s), `expected ${s} in error: ${err}`)
    }
  })

  console.log('runtime-imports guard — esbuild')

  await test('rejects an undeclared external', async () => {
    const err = await esbuildGuard(`require('undeclared')`, ['undeclared'], app())
    assert(err?.includes('undeclared'), `expected undeclared rejected: ${err}`)
  })

  await test('rejects an externalized workspace package', async () => {
    const err = await esbuildGuard(`require('@slayzone/platform')`, ['@slayzone/platform'], app())
    assert(err?.includes('@slayzone/platform'), `expected workspace rejected: ${err}`)
  })

  await test('allows builtins, declared deps and optionalExternals', async () => {
    const err = await esbuildGuard(
      `require('node:fs'); require('path'); require('declared-dep'); require('bufferutil')`,
      ['declared-dep', 'bufferutil'],
      app({ optionalExternals: ['bufferutil'] })
    )
    assert(err === null, `expected pass, got: ${err}`)
  })

  rmSync(root, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
