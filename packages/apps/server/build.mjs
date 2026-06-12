import { build } from 'esbuild'

// Single self-contained CJS bundle. Native deps (better-sqlite3, node-pty) +
// ws's optional accelerators stay external and resolve via require() at
// runtime — CJS so that BOTH the node_modules walk-up (dev: repo root) AND
// NODE_PATH (packaged: app.asar.unpacked/node_modules, set by the supervisor)
// work. An ESM bundle would import externals with the ESM resolver, which
// ignores NODE_PATH entirely — that broke the packaged side-car. `.cjs`
// extension because package.json is "type": "module".
await build({
  entryPoints: ['src/bin.ts'],
  outfile: 'dist/bin.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['better-sqlite3', 'bufferutil', 'utf-8-validate', 'node-pty']
})
