#!/usr/bin/env tsx
/**
 * Mojo TS bindings generator.
 *
 * Wraps Chromium's two-phase pipeline:
 *   1. mojom_parser.py   → parses .mojom into a *-module binary description.
 *   2. mojom_bindings_generator.py -g typescript → emits *-webui.ts.
 *
 * Templates must be precompiled once before step 2; we cache them under
 * .bytecode/ next to this script.
 *
 * Output is checked in under src/generated/ so downstream consumers don't
 * need a Chromium checkout to typecheck. Re-run this script whenever a
 * .mojom file changes:
 *   pnpm --filter @slayzone/mojo-bindings generate
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const repoRoot = resolve(pkgRoot, '../../..')
const chromiumSrc = resolve(repoRoot, 'chromium/src')

const parserPy = join(chromiumSrc, 'mojo/public/tools/mojom/mojom_parser.py')
const generatorPy = join(chromiumSrc, 'mojo/public/tools/bindings/mojom_bindings_generator.py')

if (!existsSync(parserPy) || !existsSync(generatorPy)) {
  console.error(`Chromium src not found at ${chromiumSrc}. Run gclient sync first.`)
  process.exit(1)
}

const mojomDir = join(pkgRoot, 'mojom')
const outDir = join(pkgRoot, 'src/generated')
const bytecodeDir = join(pkgRoot, '.bytecode')
const workDir = join(pkgRoot, '.work')

// Reset work area.
for (const d of [outDir, workDir]) {
  rmSync(d, { recursive: true, force: true })
  mkdirSync(d, { recursive: true })
}
mkdirSync(bytecodeDir, { recursive: true })

// Step 0: precompile Jinja templates (cached).
const tsTemplatesZip = join(bytecodeDir, 'ts_templates.zip')
if (!existsSync(tsTemplatesZip)) {
  console.log('Precompiling Mojo bindings templates…')
  execFileSync('python3', [generatorPy, '--use_bundled_pylibs', '-o', bytecodeDir, 'precompile'], { stdio: 'inherit' })
}

// Collect .mojom inputs.
const mojoms = readdirSync(mojomDir)
  .filter((f) => f.endsWith('.mojom'))
  .map((f) => join(mojomDir, f))

if (mojoms.length === 0) {
  console.error('No .mojom files in mojom/')
  process.exit(1)
}

// Step 1: parse .mojom → -module files.
// webui_module_path is the resource path each generated *-webui.ts will use
// when imported by a real chrome:// page. The WebUI resource map maps this to
// the actual served file.
console.log(`Parsing ${mojoms.length} mojom file(s)…`)
execFileSync(
  'python3',
  [
    parserPy,
    '--input-root', pkgRoot,
    '--output-root', workDir,
    '--add-module-metadata', 'webui_module_path=/resources/mojo/slayzone',
    '--mojoms', ...mojoms,
  ],
  { stdio: 'inherit' }
)

// Step 2: generate TypeScript bindings.
console.log('Generating TypeScript bindings…')
execFileSync(
  'python3',
  [
    generatorPy,
    '--use_bundled_pylibs',
    '-o', workDir,
    'generate',
    '-g', 'typescript',
    '--bytecode_path', bytecodeDir,
    '-d', pkgRoot,
    '-I', pkgRoot,
    ...mojoms,
  ],
  { stdio: 'inherit' }
)

// Step 3: relocate generated files from .work/mojom/*.ts to src/generated/*.ts.
const workMojomDir = join(workDir, 'mojom')
if (!existsSync(workMojomDir)) {
  console.error('Generator produced no output under .work/mojom/')
  process.exit(1)
}
for (const entry of readdirSync(workMojomDir)) {
  if (!entry.endsWith('.ts')) continue
  const src = join(workMojomDir, entry)
  const dst = join(outDir, entry)
  renameSync(src, dst)
  const size = statSync(dst).size
  console.log(`  → src/generated/${entry} (${size} bytes)`)
}
rmSync(workDir, { recursive: true, force: true })
console.log('Done.')
