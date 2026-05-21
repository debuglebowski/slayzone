import { build } from 'esbuild'

// Single self-contained bundle. better-sqlite3 + ws native deps stay external
// (loaded via createRequire at runtime). bin.ts pulls in the whole src/ graph.
await build({
  entryPoints: ['src/bin.ts'],
  outfile: 'dist/bin.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['better-sqlite3', 'bufferutil', 'utf-8-validate'],
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);"
  }
})
