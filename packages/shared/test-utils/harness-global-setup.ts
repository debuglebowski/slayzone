/**
 * globalSetup for vitest.harness.config.ts: runs ONCE, before any worker starts.
 *
 * Many suites spawn a built bin (hub/computer `dist/bin.cjs`, CLI `dist/slay.js`) and
 * each guards it with its own `ensureBuilt()` — rebuild when older than its src. Run
 * in parallel, every worker that saw a stale bin would rebuild into the SAME `dist/`
 * at once. Building here first makes the bins newer than every source file, so those
 * per-file guards are no-ops (they stay as the guard for a single-file run).
 *
 * The esbuild bundles take well under a second each, so they always rebuild. The web
 * shell (vite) builds only when absent, the same rule its suites apply.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { stripVitestInjectedEnv } from './vitest-injected-env'

const rootDir = resolve(import.meta.dirname, '../../..')

export default function setup(): void {
  // This runs in vitest's own process, which has the same injected NODE_ENV/TEST.
  const env = { ...process.env }
  stripVitestInjectedEnv(env)
  for (const pkg of ['hub', 'computer', 'cli']) {
    execFileSync('node', ['build.mjs'], {
      cwd: join(rootDir, 'packages/apps', pkg),
      stdio: 'inherit',
      env
    })
  }
  if (!existsSync(join(rootDir, 'packages/apps/hub/dist/web/index.html'))) {
    execFileSync('pnpm', ['--filter', '@slayzone/web-shell', 'build'], {
      cwd: rootDir,
      stdio: 'inherit',
      env
    })
  }
}
