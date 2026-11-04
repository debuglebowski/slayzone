import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib'
import { runtimeImportsEsbuildPlugin } from '@slayzone/build-guards/runtime-imports'

const appPkg = JSON.parse(readFileSync(new URL('../app/package.json', import.meta.url), 'utf-8'))
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

/**
 * Inlines mermaid's browser build (artifact PDF/PNG/HTML export of mermaid diagrams)
 * by swapping src/export/mermaid-js-source.ts — which reads it from node_modules for
 * source runs — for a module carrying the file brotli-compressed + base64. Keeps the
 * shipped CLI one self-contained file; see mermaid-js-source.ts for why compressed.
 * Quality 9: 0.4 s at build time for ~1.3 MB (11 saves 10% for 25x the time).
 */
const inlineMermaid = {
  name: 'slayzone:inline-mermaid',
  setup(b) {
    b.onLoad({ filter: /[\\/]src[\\/]export[\\/]mermaid-js-source\.ts$/ }, () => {
      const file = createRequire(import.meta.url).resolve('mermaid/dist/mermaid.min.js')
      const raw = readFileSync(file)
      const br = brotliCompressSync(raw, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 9,
          [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length
        }
      })
      return {
        loader: 'js',
        watchFiles: [file],
        contents: [
          "import { brotliDecompressSync } from 'node:zlib'",
          `const MERMAID_JS_BR64 = ${JSON.stringify(br.toString('base64'))}`,
          'export function readMermaidJs() {',
          "  return brotliDecompressSync(Buffer.from(MERMAID_JS_BR64, 'base64')).toString('utf8')",
          '}'
        ].join('\n')
      }
    })
  }
}

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  // Package is `type: module` (ESM source, required so tsx resolves CLI .ts cleanly
  // in tests under Node's require(esm) cycle rules). The bundle stays CJS — emit it
  // explicitly and pin dist/ to commonjs below so Node reads slay.js as CJS.
  format: 'cjs',
  outfile: 'dist/slay.js',
  banner: { js: '#!/usr/bin/env node' },
  external: ['node:sqlite'],
  // Fails the build if an external would not resolve where `slay` runs. See build-guards.
  plugins: [inlineMermaid, runtimeImportsEsbuildPlugin({ bundleName: 'cli', packageJson: pkg })],
  define: { __APP_VERSION__: JSON.stringify(appPkg.version) }
})

// Pin the output dir to CommonJS so the CJS bundle is not reinterpreted as ESM
// under the package's `type: module`.
writeFileSync(new URL('dist/package.json', import.meta.url), '{\n  "type": "commonjs"\n}\n')
