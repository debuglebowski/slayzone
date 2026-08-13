/**
 * Shared computer-bundle builder for e2e.
 *
 * The computer bundle is NOT part of the app build pipeline (it has its own
 * `packages/apps/computer/build.mjs`), but e2e now boots computer-ON by default —
 * every worker's app spawns the co-located computer from `dist/bin.cjs`. So the
 * bundle has to exist before ANY spec launches, which is why `global-setup.ts`
 * calls this once per run rather than each computer spec doing it itself.
 *
 * Lifted verbatim from `e2e/computers/110-computer-loopback.spec.ts`, which still
 * calls it directly (it spawns its own explicit loopback computer and must not
 * depend on global-setup ordering).
 */

import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_DIR = path.resolve(__dirname, '..', '..')
const RUNNER_DIR = path.resolve(APP_DIR, '..', 'computer')

/** Absolute path to the bundle the local-computer supervisor spawns. */
export const RUNNER_BIN = path.join(RUNNER_DIR, 'dist', 'bin.cjs')

function newestMtime(dir: string): number {
  let newest = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full))
    } else {
      newest = Math.max(newest, fs.statSync(full).mtimeMs)
    }
  }
  return newest
}

/** Build the computer bundle on demand. Idempotent: skip when the bundle is
 *  present AND newer than every computer source file, else (re)build. */
export function ensureComputerBuilt(): void {
  let needsBuild = !fs.existsSync(RUNNER_BIN)
  if (!needsBuild) {
    const binMtime = fs.statSync(RUNNER_BIN).mtimeMs
    const srcDir = path.join(RUNNER_DIR, 'src')
    const newest = newestMtime(srcDir)
    if (newest > binMtime) needsBuild = true
  }
  if (!needsBuild) return
  execFileSync('node', ['build.mjs'], { cwd: RUNNER_DIR, stdio: 'inherit' })
  if (!fs.existsSync(RUNNER_BIN)) {
    throw new Error(`computer build did not produce ${RUNNER_BIN}`)
  }
}
