import { build } from 'esbuild'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
// Externalize third-party deps and Electron-coupled workspace pkgs that should
// fail at runtime if reached in standalone mode (try/catch in transport routers).
// Bundle other workspace @slayzone/* pkgs so their TS imports are resolved at
// build time (Node ESM doesn't auto-add .ts extensions).
const ELECTRON_COUPLED_WORKSPACE = [
  '@slayzone/task/electron',
  '@slayzone/task/electron/artifact-export',
  '@slayzone/terminal/electron',
  '@slayzone/settings/electron',
  '@slayzone/file-editor/electron',
  '@slayzone/integrations/electron',
  '@slayzone/diagnostics/electron',
  '@slayzone/automations/electron',
  '@slayzone/projects/electron',
  '@slayzone/worktrees/electron',
  '@slayzone/ai-config/electron',
]
const thirdParty = Object.keys(allDeps).filter((d) => !d.startsWith('@slayzone/'))
const electron = ['electron']

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outdir: 'dist',
  splitting: true,
  banner: { js: '#!/usr/bin/env node' },
  external: [...thirdParty, ...electron, ...ELECTRON_COUPLED_WORKSPACE],
  define: { __SERVER_VERSION__: JSON.stringify(pkg.version) },
})
