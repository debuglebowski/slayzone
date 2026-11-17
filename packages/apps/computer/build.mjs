/**
 * Bundle the computer into a single self-contained dist/bin.cjs (node target).
 *   pnpm --filter @slayzone/computer build      one build (app `prebuild` runs it)
 *   node build.mjs --watch [--no-initial]       dev: rebuild on any bundle-input
 *                                                change (the app's dev.mjs runs it)
 */
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import * as esbuild from 'esbuild'
import { runtimeImportsEsbuildPlugin } from '@slayzone/build-guards/runtime-imports'
import { watchBundleInputs } from '@slayzone/build-guards/watch-inputs'

const require = createRequire(import.meta.url)
const pkg = require('./package.json')
// Paths below resolve against this package, whoever imports this module.
const here = fileURLToPath(new URL('.', import.meta.url))

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
  absWorkingDir: here,
  entryPoints: ['src/bin.ts'],
  outfile: 'dist/bin.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  define: { __SLAYZONE_COMPUTER_VERSION__: JSON.stringify(pkg.version) },
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
  // node-datachannel (WebRTC, docs/direct-link.md) is native too, and optional at
  // runtime: without it the computer offers no WebRTC (rtc-runtime.ts).
  external: ['node-pty', 'better-sqlite3', 'node-datachannel', 'bufferutil', 'utf-8-validate'],
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
  // Exact input list for the dev watcher.
  metafile: true
}

/**
 * The computer bundle, built exactly as it is published. The worker is pure
 * projection code (it never opens another SQLite connection): its source is
 * inlined into the one executable, and its inputs are watched too.
 *
 * Tests building a release candidate pass `version` and extra `plugins` (run
 * before the build's own) instead of re-declaring these options.
 */
export async function buildComputer({ write = true, version = pkg.version, plugins = [] } = {}) {
  const worker = await esbuild.build({
    absWorkingDir: here,
    entryPoints: ['../../domains/terminal/src/server/runtime/chat-timeline-worker-entry.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    write: false,
    metafile: true
  })
  const result = await esbuild.build({
    ...options,
    write,
    plugins: [...plugins, ...options.plugins],
    define: {
      ...options.define,
      __SLAYZONE_COMPUTER_VERSION__: JSON.stringify(version),
      __SLAYZONE_COMPUTER_BUILD_ID__: JSON.stringify(randomUUID()),
      __SLAYZONE_TIMELINE_WORKER_SOURCE__: JSON.stringify(worker.outputFiles[0].text)
    }
  })
  result.metafile.inputs = { ...result.metafile.inputs, ...worker.metafile.inputs }
  return result
}

// Only when run as the build script (`node build.mjs`), not when imported.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const initialMetafile = process.argv.includes('--no-initial')
    ? null
    : (await buildComputer()).metafile

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
        watcher.update((await buildComputer()).metafile)
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
        (await buildComputer({ write: false }).then(
          (r) => r.metafile,
          () => null
        ))
    )
    process.stdout.write('[build] computer: watching bundle inputs for changes…\n')
  }
}
