/**
 * Bundle the runner into a single self-contained dist/bin.cjs (node target).
 * Not wired into the app build pipeline — build on demand:
 *   pnpm --filter @slayzone/runner build
 */
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import * as esbuild from 'esbuild'

const require = createRequire(import.meta.url)

/**
 * Teach esbuild Vite's `?raw` suffix: `import x from 'pkg/file.sh?raw'` inlines
 * the file's text at build time.
 *
 * The runner installs the SAME agent hooks the desktop app does, from the same
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

await esbuild.build({
  entryPoints: ['src/bin.ts'],
  outfile: 'dist/bin.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  plugins: [rawImportPlugin],
  // node-pty is a native addon (loads a prebuilt .node binary) and cannot be
  // bundled; keep it external and resolve it from node_modules at runtime.
  // bufferutil/utf-8-validate are optional native ws accelerators.
  external: ['node-pty', 'bufferutil', 'utf-8-validate'],
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info'
})
