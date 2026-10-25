/**
 * Bundle the computer into a single self-contained dist/bin.cjs (node target).
 *   pnpm --filter @slayzone/computer build      one build (app `prebuild` runs it)
 *   node build.mjs --watch [--no-initial]       dev: rebuild on any bundle-input
 *                                                change (the app's dev.mjs runs it)
 */
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { runtimeImportsEsbuildPlugin } from '@slayzone/build-guards/runtime-imports'
import { watchBundleInputs } from '@slayzone/build-guards/watch-inputs'

const require = createRequire(import.meta.url)
const pkg = require('./package.json')

/**
 * Teach esbuild Vite's `?raw` suffix: `import x from 'pkg/file.sh?raw'` inlines
 * the file's text at build time.
 *
 * The computer installs the SAME agent hooks the desktop app does, from the same
 * shared installers, so both need the same two file bodies inlined — and the
 * shared code deliberately takes them as parameters rather than importing them,
 * so it carries no bundler syntax. Implementing Vite's spelling here means the
 * two composition roots' source seams are written identically.
 *
 * Inlining is not a preference: `@slayzone/hooks` is a private workspace package
 * that is never published, and this bundle ships to npm as one self-contained
 * file — so there is nothing on disk to read at runtime on an operator's box.
 *
 * A global `text` loader would not work either: it is keyed by extension, and
 * `.js` must keep its normal loader or the whole bundle breaks.
 */
const rawImportPlugin = {
  name: 'raw-import',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: require.resolve(args.path.slice(0, -'?raw'.length), { paths: [args.resolveDir] }),
      namespace: 'raw-import'
    }))
    build.onLoad({ filter: /.*/, namespace: 'raw-import' }, async (args) => ({
      contents: await readFile(args.path, 'utf8'),
      loader: 'text'
    }))
  }
}

const options = {
  entryPoints: ['src/bin.ts'],
  outfile: 'dist/bin.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  plugins: [
    rawImportPlugin,
    // Fails the build if an external would not resolve where the computer runs.
    // bufferutil/utf-8-validate stay undeclared on purpose: ws probes bufferutil in
    // try/catch and runs without it, and requires utf-8-validate only when
    // buffer.isUtf8 is missing (Node < 18.14). See build-guards.
    runtimeImportsEsbuildPlugin({
      bundleName: 'computer',
      packageJson: pkg,
      optionalExternals: ['bufferutil', 'utf-8-validate']
    })
  ],
  // node-pty is a native addon (loads a prebuilt .node binary) and cannot be
  // bundled; keep it external and resolve it from node_modules at runtime.
  // bufferutil/utf-8-validate are optional native ws accelerators.
  external: ['node-pty', 'bufferutil', 'utf-8-validate'],
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
  // Exact input list for the dev watcher.
  metafile: true
}

const initialMetafile = process.argv.includes('--no-initial')
  ? null
  : (await esbuild.build(options)).metafile

// Dev watch: rebuild when any bundled input changes — computer/src AND the
// workspace code it inlines. Same shape as hub/build.mjs. A running computer
// keeps its loaded code; the next spawn picks up the fresh bin.cjs.
if (process.argv.includes('--watch')) {
  let building = false
  let pending = false
  const watcher = watchBundleInputs({
    onChange: () => void rebuild(),
    fallbackDir: fileURLToPath(new URL('./src/', import.meta.url))
  })
  async function rebuild() {
    if (building) {
      pending = true
      return
    }
    building = true
    try {
      watcher.update((await esbuild.build(options)).metafile)
    } catch (err) {
      process.stderr.write(
        `[build] computer rebuild failed: ${err instanceof Error ? err.message : err}\n`
      )
    } finally {
      building = false
      if (pending) {
        pending = false
        void rebuild()
      }
    }
  }
  // With --no-initial the caller just built bin.cjs: learn the inputs from a
  // write:false analysis build instead of rewriting the bundle. If even that
  // fails (src is mid-edit), watch src/ until a build succeeds.
  watcher.update(
    initialMetafile ??
      (await esbuild.build({ ...options, write: false, logLevel: 'silent' }).then(
        (r) => r.metafile,
        () => null
      ))
  )
  process.stdout.write('[build] computer: watching bundle inputs for changes…\n')
}
