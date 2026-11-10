// Bundle harness/main.ts (and the app/platform sources it imports) into one CJS file.
// Native modules stay external and resolve from the repo's node_modules at run time.
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
await build({
  entryPoints: [join(here, 'main.ts')],
  outfile: join(here, 'dist', 'harness.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['better-sqlite3', 'node-pty', 'electron', 'bufferutil', 'utf-8-validate'],
  logLevel: 'warning'
})
